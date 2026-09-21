/**
 * scraper-service（127.0.0.1:3030）HTTP 客户端封装。
 * 只依赖引擎的 HTTP 契约（/api/test、/api/chapter 的请求/响应结构），不依赖其内部实现，
 * 引擎并行重构不影响本模块。
 */
import type { Run } from './run-log'
import type { BookData, ChapterData, ChapterRef, LoadedRule, ListItem } from './types'

export const SCRAPER_BASE = 'http://127.0.0.1:3030'
// 引擎策略链整体预算 55s（CHAIN_BUDGET_MS），超时须 ≥ 预算否则慢站点会被提前切断；与 /api/scrape 代理的 60s 对齐
export const ENGINE_TIMEOUT_MS = 60_000

export type EngineResult<T> =
  | { ok: true; data: T; warnings: string[]; strategy?: string; attempts?: number }
  | { ok: false; error: string; warnings: string[] }

/**
 * 调用引擎；网络异常/超时/非 2xx 一律返回结构化失败，绝不 throw。
 * 成功时带回响应顶层 strategy（命中策略名）与 attempts（策略链尝试次数）供可观测性记录。
 *
 * return 路径可达性核对（12-g2）：①响应非合法 JSON/解析抛错 → 失败；②!res.ok 或引擎 ok:false
 * （策略链全败 502 / 参数 400，引擎失败响应均带 error）→ 失败；③成功但缺 data 对象
 * （如中间层回的 2xx 空 JSON）→ 失败（防止 ok:true + data:undefined 透传后在调用方抛 TypeError）；
 * ④正常成功。四条路径均可达，无死分支。
 */
async function callEngine<T>(path: string, body: Record<string, unknown>): Promise<EngineResult<T>> {
  try {
    const res = await fetch(`${SCRAPER_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS),
    })
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (!json) return { ok: false, error: `引擎响应解析失败(HTTP ${res.status})`, warnings: [] }
    const warnings = Array.isArray(json.warnings) ? json.warnings.map(String) : []
    if (!res.ok || json.ok === false) {
      const base = String(json.error ?? `HTTP ${res.status}`)
      const detail = json.detail ? String(json.detail).slice(0, 200) : ''
      return { ok: false, error: detail ? `${base}（${detail}）` : base, warnings }
    }
    // 成功响应必须携带 data 对象（引擎 handlers.ts 成功路径恒有）；
    // 缺失时此前会以 ok:true + data:undefined 透过类型断言，调用方 res.data.book/list 访问即 TypeError
    const data = json.data as T
    if (!data || typeof data !== 'object') {
      return { ok: false, error: `引擎响应缺少 data 字段(HTTP ${res.status})`, warnings }
    }
    return {
      ok: true,
      data,
      warnings,
      strategy: typeof json.strategy === 'string' ? json.strategy : undefined,
      attempts: Array.isArray(json.attempts) ? json.attempts.length : undefined,
    }
  } catch (e) {
    const timedOut =
      e instanceof Error && (/timeout|abort/i.test(e.message) || (e as { name?: string }).name === 'TimeoutError')
    return {
      ok: false,
      error: timedOut ? `引擎请求超时(${ENGINE_TIMEOUT_MS / 1000}s)` : '采集引擎不可达(3030)',
      warnings: [],
    }
  }
}

/**
 * 抓取并提取一个书页。每次调用（即每本书一次）在成功命中后记录一行
 * 「书页命中策略 fetch-browser（尝试 N 次）」级别的可观测性日志。
 *
 * Task 23-a 新增可选 referer（向后兼容：不传时请求体与原先完全一致）：
 * 列表页场景可把站点首页/上一页作为来路传入，配合引擎策略层的 Referer 链。
 * Task 13-a 新增可选 opts.quiet（默认 false）：Phase 2 目录重取等高频场景传 true
 * 抑制命中策略/警告日志（worker 的 100 行滚动日志不被逐本刷穿）。
 */
export async function fetchBookPage(
  run: Run,
  url: string,
  rule: LoadedRule,
  referer?: string,
  opts: { quiet?: boolean } = {},
): Promise<{ ok: true; book: BookData } | { ok: false; error: string }> {
  const quiet = opts.quiet === true
  const res = await callEngine<{ book?: BookData }>('/api/test', {
    url,
    rule: { bookRule: rule.bookRule },
    charset: rule.charset,
    ...(rule.proxy ? { proxy: rule.proxy } : {}),
    ...(referer ? { referer } : {}),
  })
  if (!res.ok) return { ok: false, error: res.error }
  if (res.warnings.length && !quiet) run.logWarnings(res.warnings)
  if (res.strategy && !quiet) {
    // 引擎成功响应恒带 attempts 数组（callEngine 折算为尝试次数），原先三分支写法中
    // 「无 attempts」路径实测不可达（12-g2 死分支清理）；?? '?' 兜底异常缺省，日志行为不变
    run.log(`书页命中策略 ${res.strategy}（尝试 ${res.attempts ?? '?'} 次）`)
  }
  const book = res.data.book
  if (!book || !book.title) return { ok: false, error: '未提取到书籍标题（规则与内置回退均未命中）' }
  return { ok: true, book }
}

/** 抓取并提取一个列表页；失败时记录日志并返回空数组（翻页场景失败可跳过）。referer 可选，同上向后兼容 */
export async function fetchListPage(run: Run, url: string, rule: LoadedRule, referer?: string): Promise<ListItem[]> {
  const res = await callEngine<{ list?: { items?: ListItem[] } }>('/api/test', {
    url,
    rule: { listRule: rule.listRule },
    charset: rule.charset,
    ...(rule.proxy ? { proxy: rule.proxy } : {}),
    ...(referer ? { referer } : {}),
  })
  if (!res.ok) {
    run.log(`列表页抓取失败(${url.slice(0, 100)}): ${res.error}`)
    return []
  }
  if (res.warnings.length) run.logWarnings(res.warnings)
  return (res.data.list?.items ?? []).filter((it) => !!it.url)
}

/**
 * 抓取完整目录页并提取章节链接（配合 bookRule.catalogLinkSelector）。
 * 目录页只需 chapterLinkSelector/excludeSelector，其余书籍字段选择器不参与；
 * 失败时记录日志并返回空数组（调用方回退书页章节链接，不视为致命错误）。
 * referer 可选（Task 23-a，向后兼容）：常传书页 URL 作为来路。
 * Task 13-a 新增可选 opts.quiet（默认 false）：Phase 2 目录重取等高频场景传 true
 * 抑制失败日志与引擎提示（避免冲刷 worker 的 100 行滚动日志；与 fetchBookPage 同哲学）。
 */
export async function fetchCatalogChapters(
  run: Run,
  url: string,
  rule: LoadedRule,
  referer?: string,
  opts: { quiet?: boolean } = {},
): Promise<ChapterRef[]> {
  const quiet = opts.quiet === true
  const bookRule: Record<string, string> = {}
  for (const key of ['chapterLinkSelector', 'excludeSelector'] as const) {
    const v = rule.bookRule[key]
    if (typeof v === 'string' && v) bookRule[key] = v
  }
  const res = await callEngine<{ book?: BookData }>('/api/test', {
    url,
    rule: { bookRule },
    charset: rule.charset,
    ...(rule.proxy ? { proxy: rule.proxy } : {}),
    ...(referer ? { referer } : {}),
  })
  if (!res.ok) {
    if (!quiet) run.log(`目录页抓取失败(${url.slice(0, 100)}): ${res.error}`)
    return []
  }
  if (res.warnings.length && !quiet) run.logWarnings(res.warnings)
  return res.data.book?.chapters ?? []
}

/** 抓取并提取一个章节；warnings 由调用方按存储成败决定是否记录（沿用原时序）。
 *  referer 可选（Task 23-a，向后兼容）：章节页常校验来路，传书页 URL 可提升通过率 */
export function fetchChapter(url: string, rule: LoadedRule, referer?: string): Promise<EngineResult<ChapterData>> {
  return callEngine<ChapterData>('/api/chapter', {
    url,
    rule: rule.chapterRule,
    charset: rule.charset,
    ...(rule.proxy ? { proxy: rule.proxy } : {}),
    ...(referer ? { referer } : {}),
  })
}

/**
 * 章节分页拼接上限（同一章最多翻 4 次内页，即 5 个分页；超出按单页截断，保持对目标站客气）
 */
const MAX_CHAPTER_PAGES = 4

/**
 * 判断 nextUrl 是否是「当前章节的下一分页」而非下一章：
 * 仅接受路径前缀续写形态（base_2.html / base/2.html / base?page=2），
 * 前缀后第一个字符必须是 _ / / ? # 之一，防止 /book/1/ 误匹配 /book/12/ 这类数字续写。
 * （Task 3 第二轮新增：huangjinwu /novel/{id}/{ch}/2.html、ggd66 /qu/{b}/{ch}_2.html 实测分页形态，
 *  旧逻辑只存第一分页导致长章节内容缺半）
 */
function isSameChapterPagination(base: string, next: string): boolean {
  try {
    const b = new URL(base)
    const n = new URL(next)
    // 同章分页必在同主机同路径空间（跨域/换路径视为另一页）
    if (b.host !== n.host) return false
    const np = n.pathname
    // 前缀匹配（允许 base 省略 .html 后缀的差异：xinjianpan /txt/x/vl7.html → vl7_2.html、
    // ggd66 /qu/x/y.html → y_2.html；前缀后第一个字符必须是 _ / ? #，防 /book/1/ 误匹配 /book/12/）
    const prefixes = [b.pathname.replace(/\/+$/, '')]
    if (/\.[sx]?html?$/i.test(prefixes[0])) {
      prefixes.push(prefixes[0].replace(/\.[sx]?html?$/i, ''))
    }
    for (const bp of prefixes) {
      if (!np.startsWith(bp) || np.length === bp.length) continue
      const sep = np[bp.length]
      if (!['_', '/', '?', '#'].includes(sep)) continue
      if (sep === '?') {
        // ?page=2 形态：要求 page 参数递增语义存在
        return /(?:^|[&?])page=\d+/.test(n.search)
      }
      return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * 抓取整章（含同章分页拼接）：首版 fetchChapter 后，若引擎返回的 nextUrl 是当前章节的
 * 下一分页（见 isSameChapterPagination），继续抓取并把正文按段落合并，直至无分页/达上限。
 * 任何一页失败都保留已抓到的部分（partial 内容优于整体失败）。
 * 返回值与 fetchChapter 同构；warnings 汇总各页（分页进度记入 pageWarnings 由调用方取舍）。
 */
export async function fetchChapterPaged(
  url: string,
  rule: LoadedRule,
  referer?: string,
): Promise<EngineResult<ChapterData>> {
  const first = await fetchChapter(url, rule, referer)
  if (!first.ok) return first
  const data = first.data
  const warnings = [...first.warnings]
  let strategy = first.strategy
  let attempts = first.attempts
  const visited = new Set<string>([url])
  let next = typeof data.nextUrl === 'string' ? data.nextUrl : null
  for (let page = 2; next && page <= MAX_CHAPTER_PAGES + 1; page++) {
    if (!isSameChapterPagination(url, next)) break
    if (visited.has(next)) break // 引擎 nextUrl 环路防御
    visited.add(next)
    const sub = await fetchChapter(next, rule, referer)
    if (!sub.ok || !sub.data.content?.trim()) break
    // 合并正文：分页边界按段落直接续接（各页正文已由引擎清洗过）
    data.content = `${data.content}\n${sub.data.content}`
    data.paragraphs = [...(data.paragraphs ?? []), ...(sub.data.paragraphs ?? [])]
    data.wordCount = (data.wordCount ?? 0) + (sub.data.wordCount ?? 0)
    data.nextUrl = sub.data.nextUrl
    warnings.push(...sub.warnings)
    strategy = sub.strategy
    attempts = sub.attempts
    next = typeof sub.data.nextUrl === 'string' ? sub.data.nextUrl : null
  }
  return { ok: true, data, warnings: [...new Set(warnings)], strategy, attempts }
}
