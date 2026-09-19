/**
 * 采集→搜索下拉词绑定（服务端专用，勿在客户端 import）。
 *
 * 书籍入库成功后（采集的同时）用 multi-search-engine（baidu/bing/duckduckgo/sogou/so360）
 * 取书名下拉词，然后：
 *   1. 绑定到书籍：Novel.suggestKeywords（逗号分隔，供书页「相关搜索」与后台展示）
 *   2. 每个词建一条 PseoKeyword（novelId 绑定该书），并立即生成 PSEO 形式的书籍页
 *      （pageData.novelIds 以绑定书置顶，落地页 /pseo/{词} 围绕该书聚合）——采集完成即铺词建页
 *
 * 安全边界：
 * - 全程不抛错：任何失败只记 run.log，绝不影响采集任务状态机
 * - 幂等：存量书已有 suggestKeywords 不重复取词；关键词已存在（唯一约束）不抢占
 * - 节制：仅调用搜索引擎公开 suggest 接口，单引擎独立超时 3.5s，词量受 perSeedLimit 约束
 */
import { db } from '@/lib/db'
import { getPseoConfig, matchNovels } from '@/lib/pseo'
import { renderTpl, sanitizeSeoConfig } from '@/lib/seo'
import { fetchSuggestionsMulti } from '@/lib/suggest'
import type { Run } from './run-log'

const SITE_NAME_FALLBACK = '青阅文学'

function parseSeoBlob(blob: string | null | undefined): Record<string, unknown> {
  try {
    return JSON.parse(blob || '{}') as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * 为刚入库/更新的书籍取下拉词并绑定 PSEO 书籍页（fire-and-forget 调用，内部吞错）。
 * @param createdNew 新书立即取词；存量书仅在 suggestKeywords 为空时补取
 */
export async function bindBookSuggestKeywords(
  run: Run,
  novelId: number,
  title: string,
  createdNew: boolean,
): Promise<void> {
  try {
    const cfg = await getPseoConfig()
    if (!cfg.collectBind) return
    const novel = await db.novel
      .findUnique({
        where: { id: novelId },
        select: { title: true, author: true, suggestKeywords: true },
      })
      .catch(() => null)
    if (!novel) return
    if (!createdNew && novel.suggestKeywords.trim()) return // 已铺过词，幂等跳过

    const seed = (title || novel.title).trim()
    if (!seed) return
    const agg = await fetchSuggestionsMulti(seed, cfg.sources, { timeoutMs: 3500 })
    if (!agg.words.length) {
      const failed = agg.results.filter((r) => !r.ok).map((r) => `${r.engine}:${r.error ?? '?'}`)
      run.log(`下拉词获取无结果${failed.length ? `（${failed.slice(0, 3).join('、')}）` : ''}`)
      return
    }
    // 过滤与书名完全相同的词（书名本身无需再建词页），限量 perSeedLimit
    const words = agg.words.filter((w) => w.word && w.word !== seed).slice(0, cfg.perSeedLimit)
    if (!words.length) return

    await db.novel
      .update({ where: { id: novelId }, data: { suggestKeywords: words.map((w) => w.word).join(',') } })
      .catch(() => null)
    run.log(
      `下拉词获取成功（${agg.results.filter((r) => r.ok).length} 引擎）：${words
        .slice(0, 4)
        .map((w) => w.word)
        .join(' / ')}${words.length > 4 ? ' …' : ''}`,
    )

    // TDK 模板：与 /api/pseo/generate 同源（seoConfig.pseo*），保证词页 TDK 口径一致
    const setting = await db.siteSetting.findUnique({ where: { id: 1 } }).catch(() => null)
    const seo = sanitizeSeoConfig(parseSeoBlob(setting?.seoConfig))
    const siteName = setting?.siteName || SITE_NAME_FALLBACK

    let bound = 0
    for (const w of words) {
      const exists = await db.pseoKeyword
        .findUnique({ where: { keyword: w.word }, select: { id: true } })
        .catch(() => null)
      if (exists) continue // 已有同名关键词（其他书的绑定词/通用词），不抢占

      // 聚合命中书单：绑定书置顶 + 关键词匹配书补位（matchNovels 自带热门兑底，页面永不空窗）
      let matchIds: number[] = []
      try {
        const matches = await matchNovels(w.word)
        matchIds = matches.map((m) => m.id)
      } catch {
        matchIds = []
      }
      const ids = [novelId, ...matchIds.filter((id) => id !== novelId)].slice(0, 12)
      const vars = {
        siteName,
        keyword: w.word,
        count: ids.length,
        novelTitle: novel.title,
        author: novel.author,
      }
      const pageData = JSON.stringify({
        novelIds: ids,
        title: renderTpl(seo.pseoTitle, vars),
        description: renderTpl(seo.pseoDescription, vars),
        keywords: renderTpl(seo.pseoKeywords, vars),
      })
      const ok = await db.pseoKeyword
        .create({
          data: {
            keyword: w.word,
            source: w.engine || 'manual',
            novelId,
            status: 'generated',
            pageData,
          },
        })
        .then(() => true)
        .catch(() => false) // 并发撞 UNIQUE：视为已存在
      if (ok) bound++
    }
    if (bound > 0) run.log(`PSEO 书籍页已生成 ${bound}/${words.length} 个（绑定书《${novel.title.slice(0, 20)}》置顶）`)
  } catch (e) {
    run.log(`下拉词绑定失败: ${e instanceof Error ? e.message.slice(0, 120) : '未知错误'}`)
  }
}

/** fire-and-forget 包装：worker 调用入口，绝不向下抛 */
export function scheduleBindBookSuggestKeywords(
  run: Run,
  novelId: number,
  title: string,
  createdNew: boolean,
): void {
  void bindBookSuggestKeywords(run, novelId, title, createdNew).catch(() => {})
}
