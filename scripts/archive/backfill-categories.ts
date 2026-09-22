/**
 * 存量未分类书籍分类回填脚本（Task 12-h）：
 *   bun scripts/backfill-categories.ts              # dry-run：打印「书 → 分类」计划（网络只读，不写库）
 *   bun scripts/backfill-categories.ts --apply      # 实际执行：更新 Novel.categoryId
 *   可选：--limit=N 只处理前 N 本；--sample=N 双路对比抽样数（默认 12）
 *
 * 流程（对未分类且 sourceRuleId 非空的书）：
 *   1. 由 remoteCoverUrl 反推源站书页 URL（23qb 形态 /files/article/image/{d}/{id}/{id}s.jpg → /book/{id}/）；
 *   2. 用修复后的规则 categorySelector（scripts/fix-category-selectors.ts 落库）经采集引擎
 *      （127.0.0.1:3030，站点级限速自动生效）重抓书页提取分类 → ensureCategorySmart 归并入库；
 *   3. 源站不可达/提取失败/分类为空 → ensureCategorySmart('', {title, description})
 *      按书名+简介调 LLM 推断（输出白名单=规范分类集+未分类，失败兜底「未分类」）。
 *
 * 低影响保证：并发 2；引擎侧每域名 ~1.2s 限速自动生效；LLM 回退路径内置 900ms 间距
 * （防网关 429）；dry-run 不产生任何 DB 写入。
 */
import { PrismaClient } from '@prisma/client'
import {
  ensureCategorySmart,
  inferCategoryName,
  resolveCategoryName,
  RESERVED_CATEGORY_NAME,
} from '../src/lib/scrape/category'

const apply = process.argv.includes('--apply')
const limitArg = process.argv.find((a) => /^--limit=\d+$/.test(a))
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : Infinity
const sampleArg = process.argv.find((a) => /^--sample=\d+$/.test(a))
const SAMPLE = sampleArg ? Number(sampleArg.split('=')[1]) : 12

const db = new PrismaClient()
const ENGINE = 'http://127.0.0.1:3030'
const BOOK_CONCURRENCY = 2
const LLM_GAP_MS = 900

/** 规则缓存（id → 解析后的 bookRule 字段与站点信息） */
interface LoadedRuleLite {
  id: number
  name: string
  charset?: string
  proxy?: string
  siteUrl: string
  categorySelector?: string
}
const ruleCache = new Map<number, LoadedRuleLite>()

async function loadRuleLite(ruleId: number): Promise<LoadedRuleLite | null> {
  if (ruleCache.has(ruleId)) return ruleCache.get(ruleId) ?? null
  const r = await db.scrapeRule.findUnique({ where: { id: ruleId } })
  if (!r) return null
  let book: Record<string, string> = {}
  try {
    book = JSON.parse(r.bookRule || '{}')
  } catch {
    book = {}
  }
  const lite: LoadedRuleLite = {
    id: r.id,
    name: r.name,
    charset: r.charset ? r.charset.toLowerCase() : undefined,
    proxy: r.proxy?.trim() || undefined,
    siteUrl: r.siteUrl,
    categorySelector: typeof book.categorySelector === 'string' && book.categorySelector.trim() ? book.categorySelector.trim() : undefined,
  }
  ruleCache.set(ruleId, lite)
  return lite
}

/**
 * 由 remoteCoverUrl 反推书页 URL。
 * 已知形态（23qb 杰奇新模板）：https://www.23qb.net/files/article/image/{d}/{id}/{id}s.jpg
 * → https://www.23qb.net/book/{id}/ 。用 $(id) 回引用保证目录/文件名自洽，避免误匹配。
 */
function deriveBookUrl(remoteCoverUrl: string, siteUrl: string): string | null {
  const m = /\/files\/article\/image\/(\d+)\/(\d+)\/\2s\.jpg$/.exec(remoteCoverUrl || '')
  if (!m) return null
  try {
    return new URL(`/book/${m[2]}/`, siteUrl).toString()
  } catch {
    return null
  }
}

/** 调引擎抓书页并只提取 category（bookRule 仅带 categorySelector，载荷最小化） */
async function fetchCategoryFromSite(
  url: string,
  rule: LoadedRuleLite,
): Promise<{ category: string; error?: string }> {
  try {
    const res = await fetch(`${ENGINE}/api/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        rule: { bookRule: { categorySelector: rule.categorySelector } },
        ...(rule.charset ? { charset: rule.charset } : {}),
        ...(rule.proxy ? { proxy: rule.proxy } : {}),
      }),
      signal: AbortSignal.timeout(60_000),
    })
    const json = (await res.json().catch(() => null)) as
      | { ok?: boolean; error?: string; detail?: string; data?: { book?: { category?: string } } }
      | null
    if (!json || res.status !== 200 || json.ok === false) {
      const detail = json?.detail ? `（${String(json.detail).slice(0, 120)}）` : ''
      return { category: '', error: `${json?.error ?? `HTTP ${res.status}`}${detail}` }
    }
    return { category: (json.data?.book?.category ?? '').trim() }
  } catch (e) {
    const timedOut = e instanceof Error && (/timeout|abort/i.test(e.message) || (e as { name?: string }).name === 'TimeoutError')
    return { category: '', error: timedOut ? '引擎请求超时(60s)' : '采集引擎不可达(3030)' }
  }
}

/** 简单并发池（顺序取任务，并发度 BOOK_CONCURRENCY） */
async function runPool<T>(items: T[], worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const runners = Array.from({ length: Math.min(BOOK_CONCURRENCY, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      await worker(items[i])
    }
  })
  await Promise.all(runners)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface PlanRow {
  bookId: number
  title: string
  via: 'site' | 'llm' | 'llm-empty' | 'none'
  /** 站点提取的原始分类名（via=site 时） */
  siteRaw?: string
  finalName: string
  note?: string
}

async function main() {
  console.log(apply ? '== 回填执行模式（--apply） ==' : '== dry-run（加 --apply 才写库） ==')
  const uncat = await db.category.findUnique({ where: { name: RESERVED_CATEGORY_NAME }, select: { id: true } })
  if (!uncat) {
    console.error('未分类分类不存在？异常退出')
    process.exit(1)
  }
  const books = await db.novel.findMany({
    where: { categoryId: uncat.id, sourceRuleId: { not: null } },
    select: { id: true, title: true, author: true, description: true, remoteCoverUrl: true, sourceRuleId: true },
    orderBy: { id: 'asc' },
  })
  const total = books.length
  console.log(`未分类且 sourceRuleId 非空：${total} 本${total > LIMIT ? `（--limit=${LIMIT} 只处理前 ${LIMIT} 本）` : ''}\n`)
  const targets = books.slice(0, Number.isFinite(LIMIT) ? LIMIT : undefined)

  const stats = { siteOk: 0, siteEmpty: 0, siteFail: 0, llmOk: 0, llmUncertain: 0, applied: 0 }
  const comparisons: { title: string; site: string; llm: string }[] = []
  let llmLastAt = 0

  const plan: PlanRow[] = []

  await runPool(targets, async (b) => {
    const rule = await loadRuleLite(b.sourceRuleId!)
    const bookUrl = rule ? deriveBookUrl(b.remoteCoverUrl, rule.siteUrl) : null
    const title = b.title.slice(0, 30)
    const desc = (b.description || '').trim()

    // ---- 路径 1：源站书页重抓提取分类 ----
    if (rule?.categorySelector && bookUrl) {
      const { category, error } = await fetchCategoryFromSite(bookUrl, rule)
      if (category) {
        const finalName = await resolveCategoryName(category)
        stats.siteOk++
        plan.push({ bookId: b.id, title, via: 'site', siteRaw: category, finalName })
        if (apply) {
          const id = await ensureCategorySmart(category)
          await db.novel.update({ where: { id: b.id }, data: { categoryId: id } })
          stats.applied++
        }
        // 双路对比抽样：site 成功的前 SAMPLE 本，再问一次 LLM 看两者是否一致（含 900ms 间距防 429）
        if (comparisons.length < SAMPLE) {
          const now = Date.now()
          if (now - llmLastAt < LLM_GAP_MS) await sleep(LLM_GAP_MS - (now - llmLastAt))
          llmLastAt = Date.now()
          const llm = await inferCategoryName(b.title, desc)
          comparisons.push({ title, site: finalName, llm })
        }
        return
      }
      if (error) stats.siteFail++
      else stats.siteEmpty++
      plan.push({
        bookId: b.id,
        title,
        via: 'none',
        finalName: RESERVED_CATEGORY_NAME,
        note: `site ${error ?? '分类为空'} → 转投 LLM`,
      })
    }

    // ---- 路径 2：LLM 按书名+简介推断（900ms 间距防 429；有缓存去重） ----
    const now = Date.now()
    if (now - llmLastAt < LLM_GAP_MS) await sleep(LLM_GAP_MS - (now - llmLastAt))
    llmLastAt = Date.now()
    if (!b.title.trim()) {
      plan.push({ bookId: b.id, title, via: 'none', finalName: RESERVED_CATEGORY_NAME, note: '无标题无 hint' })
      return
    }
    const llmName = await inferCategoryName(b.title, desc)
    const via = desc ? 'llm' : 'llm-empty'
    if (llmName === RESERVED_CATEGORY_NAME) stats.llmUncertain++
    else stats.llmOk++
    plan.push({ bookId: b.id, title, via, finalName: llmName, note: via === 'llm-empty' ? '简介为空，仅凭书名' : undefined })
    if (apply) {
      const id = await ensureCategorySmart('', { title: b.title, description: desc })
      await db.novel.update({ where: { id: b.id }, data: { categoryId: id } })
      stats.applied++
    }
  })

  // ---- 计划/结果输出 ----
  console.log(`\n共 ${plan.length} 条处理计划：`)
  for (const p of plan) {
    const viaLabel =
      p.via === 'site'
        ? `源站提取「${p.siteRaw}」`
        : p.via === 'llm'
          ? 'LLM 书名+简介推断'
          : p.via === 'llm-empty'
            ? 'LLM 仅凭书名（简介为空）'
            : '—'
    console.log(`  #${p.bookId} 《${p.title}》 → ${p.finalName}${p.finalName === RESERVED_CATEGORY_NAME ? '' : ''}  [${viaLabel}]${p.note ? ` ${p.note}` : ''}`)
  }

  const siteTotal = stats.siteOk + stats.siteEmpty + stats.siteFail
  console.log(
    `\n统计：源站提取成功 ${stats.siteOk}/${siteTotal}（空 ${stats.siteEmpty}/失败 ${stats.siteFail}），` +
      `LLM 推断有效 ${stats.llmOk} / 无法判断 ${stats.llmUncertain}` +
      (apply ? `，已更新 ${stats.applied} 本` : '（dry-run 未写库）'),
  )

  // ---- LLM vs 源站 抽样对比 ----
  if (comparisons.length > 0) {
    let agree = 0
    console.log(`\nLLM 推断 vs 源站提取 抽样对比（${comparisons.length} 本）：`)
    for (const c of comparisons) {
      const same = c.site === c.llm
      if (same) agree++
      console.log(`  ${same ? '✓' : '✗'} 《${c.title}》 源站=${c.site} LLM=${c.llm}`)
    }
    console.log(`  一致率 ${agree}/${comparisons.length}`)
  }

  // ---- 前后未分类数量 ----
  const afterUncat = await db.novel.count({ where: { categoryId: uncat.id } })
  console.log(`\n未分类书籍数：${total} → ${afterUncat}（含真无信息书）`)
  if (apply) {
    const cats = await db.category.findMany({
      orderBy: { sort: 'asc' },
      include: { _count: { select: { novels: true } } },
    })
    console.log(`当前分类分布（${cats.length} 个）：`)
    for (const c of cats) console.log(`  #${c.id}\t${c.name}\t${c._count.novels} 本`)
  }
  await db.$disconnect()
}

main().catch(async (e) => {
  console.error('执行失败：', e instanceof Error ? e.message : e)
  await db.$disconnect().catch(() => {})
  process.exit(1)
})
