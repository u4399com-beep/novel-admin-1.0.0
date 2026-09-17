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
    return {
      ok: true,
      data: json.data as T,
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
 */
export async function fetchBookPage(
  run: Run,
  url: string,
  rule: LoadedRule,
  referer?: string,
): Promise<{ ok: true; book: BookData } | { ok: false; error: string }> {
  const res = await callEngine<{ book?: BookData }>('/api/test', {
    url,
    rule: { bookRule: rule.bookRule },
    charset: rule.charset,
    ...(referer ? { referer } : {}),
  })
  if (!res.ok) return { ok: false, error: res.error }
  if (res.warnings.length) run.logWarnings(res.warnings)
  if (res.strategy) {
    run.log(
      res.attempts !== undefined
        ? `书页命中策略 ${res.strategy}（尝试 ${res.attempts} 次）`
        : `书页命中策略 ${res.strategy}`,
    )
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
 */
export async function fetchCatalogChapters(run: Run, url: string, rule: LoadedRule, referer?: string): Promise<ChapterRef[]> {
  const bookRule: Record<string, string> = {}
  for (const key of ['chapterLinkSelector', 'excludeSelector'] as const) {
    const v = rule.bookRule[key]
    if (typeof v === 'string' && v) bookRule[key] = v
  }
  const res = await callEngine<{ book?: BookData }>('/api/test', {
    url,
    rule: { bookRule },
    charset: rule.charset,
    ...(referer ? { referer } : {}),
  })
  if (!res.ok) {
    run.log(`目录页抓取失败(${url.slice(0, 100)}): ${res.error}`)
    return []
  }
  if (res.warnings.length) run.logWarnings(res.warnings)
  return res.data.book?.chapters ?? []
}

/** 抓取并提取一个章节；warnings 由调用方按存储成败决定是否记录（沿用原时序）。
 *  referer 可选（Task 23-a，向后兼容）：章节页常校验来路，传书页 URL 可提升通过率 */
export function fetchChapter(url: string, rule: LoadedRule, referer?: string): Promise<EngineResult<ChapterData>> {
  return callEngine<ChapterData>('/api/chapter', {
    url,
    rule: rule.chapterRule,
    charset: rule.charset,
    ...(referer ? { referer } : {}),
  })
}
