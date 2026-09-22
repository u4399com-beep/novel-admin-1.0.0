/**
 * 采集→搜索下拉词绑定（服务端专用，勿在客户端 import）。
 *
 * 【状态注记】TS worker（worker.ts）已退役，采集后端的 pseo 书名种子/富集由
 * backend-go 原生承担（pseo_book.go + enrich loop，source='book'）；本文件已无调用方，
 * 仅作静态类型依赖保留。schema 演进移除了 Novel.suggestKeywords 与 PseoKeyword.novelId，
 * 故绑定书的归属仅保留在 pageData.novelIds 首位（落地页「最佳匹配」卡即取首位）。
 *
 * 功能语义（保留）：书籍入库成功后用 multi-search-engine（baidu/bing/duckduckgo/sogou/so360）
 * 取书名下拉词，每个词建一条 PseoKeyword（status=generated），立即生成 PSEO 形式的书籍页
 * （pageData.novelIds 以绑定书置顶，落地页 /pseo/{词} 围绕该书聚合）。
 *
 * 安全边界：
 * - 全程不抛错：任何失败只记 run.log，绝不影响采集任务状态机
 * - 幂等：关键词已存在（唯一约束）不抢占
 * - 节制：仅调用搜索引擎公开 suggest 接口，单引擎独立超时 3.5s，词量受 perSeedLimit 约束
 */
import { db } from '@/lib/db'
import { getPseoConfig, matchNovels } from '@/lib/pseo'
import { renderTpl, sanitizeSeoConfig } from '@/lib/seo'
import { fetchSuggestionsMulti } from '@/lib/suggest'
import { MAX_LOG_LINES, type Run } from './run-log'

const SITE_NAME_FALLBACK = '青阅文学'

/**
 * P3-17：本函数由 worker fire-and-forget 调用，完成时任务可能已 finalize（Run 缓冲不再落盘），
 * 其间经 run.log 记录的行会丢失。完成后若任务已非 running（不再有常规 flush 携带），
 * 把本次新增日志行独立补写进 ScrapeTask.log（读-改-写，同 MAX_LOG_LINES 规约）；
 * 任务仍在 running 时跳过（后续 flush 会携带，避免与 flush 串行链互覆）。
 * 竞态窗口（P3 级无害，正常时序下日志完整）：多本并发 bind 同时补写/与 finalize 同刻
 * 并发时，最坏丢失某一次补写的少量行。
 */
async function persistLateLogLines(run: Run, startLineCount: number): Promise<void> {
  try {
    const added = run.linesSince(startLineCount)
    if (!added.length) return
    const task = await db.scrapeTask
      .findUnique({ where: { id: run.taskId }, select: { status: true, log: true } })
      .catch(() => null)
    if (!task || task.status === 'running') return
    const merged = [...(task.log ? task.log.split('\n') : []), ...added].slice(-MAX_LOG_LINES).join('\n')
    await db.scrapeTask
      .updateMany({ where: { id: run.taskId }, data: { log: merged } })
      .catch(() => undefined)
  } catch {
    // 补写失败静默：日志完整性属 P3 级，绝不影响采集状态机
  }
}

function parseSeoBlob(blob: string | null | undefined): Record<string, unknown> {
  try {
    return JSON.parse(blob || '{}') as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * 为刚入库/更新的书籍取下拉词并绑定 PSEO 书籍页（fire-and-forget 调用，内部吞错）。
 * @param createdNew 保留参数兼容原调用形态（开合闸已随 collectBind 配置项移除，当前恒取词）
 */
export async function bindBookSuggestKeywords(
  run: Run,
  novelId: number,
  title: string,
  createdNew: boolean,
): Promise<void> {
  void createdNew
  const startLineCount = run.lineCount // 快照：本次 bind 经 run.log 新增行的起点（完成后补写落盘）
  try {
    const cfg = await getPseoConfig()
    const novel = await db.novel
      .findUnique({
        where: { id: novelId },
        select: { title: true, author: true },
      })
      .catch(() => null)
    if (!novel) return

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
  } finally {
    // P3-17：finalize 晚于本函数启动时，上面的 run.log 行不会被常规 flush 携带，独立补写落盘
    await persistLateLogLines(run, startLineCount)
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
