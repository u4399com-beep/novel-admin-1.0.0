/**
 * bookRule.chapterListApi：JSON 目录接口支持。
 *
 * 背景：部分现代 CMS 书页只有最新 N 章 +「查看完整目录」按钮，完整目录由前端 AJAX 端点
 * （POST 表单 → JSON 数组）提供，页面中不存在全量 HTML 目录（实测 ixdzs8.com POST /novel/clist/）。
 * 此类站点无法用 chapterLinkSelector/catalogLinkSelector 表达，故新增本能力。
 *
 * 规则配置（RuleMap 值恒为字符串，故配置以 JSON 字符串透传，主站 ScrapeRule.bookRule JSON 列原样存储）：
 * {
 *   "url":  "/novel/clist/",                  // 必填：接口路径（相对书页）或绝对 URL，强制同源
 *   "method": "POST",                         // 可选：GET|POST，默认 POST
 *   "body": "bid={bookId}",                   // 可选：表单体，{bookId} 占位符
 *   "bookIdSelector": "#bid@value",           // 必填：书页内书籍 ID 提取（支持 @attr）
 *   "listPath": "data",                       // 可选：JSON 内数组路径（点分），默认顶层为数组
 *   "titleField": "title",                    // 必填：章节标题字段
 *   "orderField": "ordernum",                 // 可选：章节序号字段（用于 urlTemplate 的 {order}）
 *   "skipField": "ctype", "skipValue": "1",   // 可选：条目该字段==skipValue 时跳过（卷标记行）
 *   "urlTemplate": "/read/{bookId}/p{order}.html" // 必填：章节 URL 模板（{bookId}/{order} 占位）
 * }
 *
 * 安全边界：接口与书页必须同源（协议+主机一致，拒绝规则作者把请求导向内网/第三方）；
 * 仅 GET/POST 表单两种形态；不携带除引擎 cookie 会话（书页抓取时自然种下）外的任何凭据；
 * 响应体积走 MAX_BYTES 上限，条目数走 MAX_CHAPTER_REFS 上限。
 */
import { pickText } from './selectors'
import type { Scope } from './selectors'
import { cookieHeaderFor, recordSetCookieLines } from '../strategies/cookies'

/** JSON 目录条目上限（对齐 extract.ts 的 MAX_CHAPTER_REFS=10000 与 worker 单本章节上限） */
const MAX_TOC_ENTRIES = 10_000

const MAX_TOC_BYTES = 8 * 1024 * 1024
const TOC_TIMEOUT_MS = 15_000

/** 章节引用（与 extract.ts BookChapterRef 同构，此处独立声明避免循环依赖） */
export interface TocRef {
  title: string
  url: string
}

export interface ChapterListApiConfig {
  url: string
  method: 'GET' | 'POST'
  body: string
  bookIdSelector: string
  listPath: string
  titleField: string
  orderField: string
  skipField: string
  skipValue: string
  urlTemplate: string
}

/** 解析并校验配置 JSON；非法/缺关键字段时返回 null（附原因） */
export function parseChapterListApi(raw: unknown): { cfg: ChapterListApiConfig } | { error: string } {
  if (typeof raw !== 'string' || !raw.trim()) return { error: 'chapterListApi 为空' }
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return { error: 'chapterListApi 不是合法 JSON' }
  }
  const s = (k: string): string => (typeof obj[k] === 'string' ? (obj[k] as string).trim() : '')
  const url = s('url')
  const bookIdSelector = s('bookIdSelector')
  const titleField = s('titleField')
  const urlTemplate = s('urlTemplate')
  if (!url || !bookIdSelector || !titleField || !urlTemplate) {
    return { error: 'chapterListApi 缺少必填字段（url/bookIdSelector/titleField/urlTemplate）' }
  }
  const method = s('method').toUpperCase()
  return {
    cfg: {
      url,
      method: method === 'GET' ? 'GET' : 'POST',
      body: s('body'),
      bookIdSelector,
      listPath: s('listPath'),
      titleField,
      orderField: s('orderField'),
      skipField: s('skipField'),
      skipValue: s('skipValue'),
      urlTemplate,
    },
  }
}

/** 按点分路径取 JSON 值（"data" / "result.list"） */
function pickPath(obj: unknown, path: string): unknown {
  if (!path) return obj
  let cur: unknown = obj
  for (const seg of path.split('.')) {
    if (cur && typeof cur === 'object' && seg in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[seg]
    } else {
      return undefined
    }
  }
  return cur
}

/**
 * 提取 JSON 目录：返回章节引用数组（含解析失败时为空数组，原因写入 warnings）。
 * SSRF 安全：接口 URL 解析后必须与 baseUrl 同协议同主机；请求复用引擎 cookie 会话（同源才回放）。
 */
export async function extractJsonToc(
  root: Scope,
  cfg: ChapterListApiConfig,
  baseUrl: string,
  warnings: string[],
): Promise<TocRef[]> {
  // 1) 书页内提取 bookId
  const bookId = pickText(root, [cfg.bookIdSelector])
  if (!bookId) {
    warnings.push(`chapterListApi：bookIdSelector 未命中（${cfg.bookIdSelector}），跳过 JSON 目录提取`)
    return []
  }

  // 2) 接口 URL 同源校验
  let apiUrl: URL
  try {
    apiUrl = new URL(cfg.url, baseUrl)
  } catch {
    warnings.push('chapterListApi：接口 URL 无法解析')
    return []
  }
  let base: URL
  try {
    base = new URL(baseUrl)
  } catch {
    warnings.push('chapterListApi：书页 URL 无法解析')
    return []
  }
  if (apiUrl.protocol !== base.protocol || apiUrl.host !== base.host) {
    warnings.push(`chapterListApi：接口 ${apiUrl.host} 与书页 ${base.host} 非同源，已拒绝（SSRF 防护）`)
    return []
  }

  // 3) 请求（复用引擎 cookie 会话：书页抓取时种下的会话 cookie 是部分站点的放行条件）
  const https = apiUrl.protocol === 'https:'
  const cookie = cookieHeaderFor(apiUrl.host, https)
  const headers: Record<string, string> = {
    accept: 'application/json, text/plain, */*',
    'x-requested-with': 'XMLHttpRequest',
    ...(cookie ? { cookie } : {}),
  }
  let res: Response
  try {
    res = await fetch(apiUrl.toString(), {
      method: cfg.method,
      headers: cfg.method === 'POST' ? { ...headers, 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' } : headers,
      body: cfg.method === 'POST' ? cfg.body.replaceAll('{bookId}', encodeURIComponent(bookId)) : undefined,
      signal: AbortSignal.timeout(TOC_TIMEOUT_MS),
    })
  } catch (e) {
    warnings.push(`chapterListApi：接口请求失败 ${e instanceof Error ? e.message : 'unknown'}`)
    return []
  }
  if (!res.ok) {
    warnings.push(`chapterListApi：接口返回 HTTP ${res.status}`)
    return []
  }
  // 会话 cookie 持续回放：接口下发的 Set-Cookie 也入 jar（与策略层行为一致）
  try {
    const lines = res.headers.getSetCookie?.() ?? []
    if (lines.length) recordSetCookieLines(apiUrl.host, lines, https)
  } catch {
    /* getSetCookie 不可用时跳过 */
  }
  const declaredLen = Number(res.headers.get('content-length') ?? 0)
  if (declaredLen > MAX_TOC_BYTES) {
    warnings.push(`chapterListApi：响应过大（${declaredLen}B），已放弃`)
    return []
  }
  const raw = await res.text().catch(() => '')
  if (!raw || raw.length > MAX_TOC_BYTES) {
    warnings.push('chapterListApi：响应体为空或超限')
    return []
  }

  // 4) 解析 JSON → 章节引用
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    warnings.push('chapterListApi：响应不是合法 JSON')
    return []
  }
  const list = pickPath(json, cfg.listPath)
  if (!Array.isArray(list)) {
    warnings.push(`chapterListApi：listPath "${cfg.listPath || '(顶层)'}" 未命中数组`)
    return []
  }

  const refs: TocRef[] = []
  for (const entry of list.slice(0, MAX_TOC_ENTRIES)) {
    if (!entry || typeof entry !== 'object') continue
    const rec = entry as Record<string, unknown>
    if (cfg.skipField && cfg.skipValue !== '' && String(rec[cfg.skipField] ?? '') === cfg.skipValue) continue
    const title = String(rec[cfg.titleField] ?? '').trim()
    if (!title) continue
    let order = ''
    if (cfg.orderField) order = String(rec[cfg.orderField] ?? '').trim()
    const url = cfg.urlTemplate
      .replaceAll('{bookId}', encodeURIComponent(bookId))
      .replaceAll('{order}', encodeURIComponent(order))
    try {
      const u = new URL(url, baseUrl)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue
      refs.push({ title: title.slice(0, 200), url: u.toString() })
    } catch {
      continue
    }
  }
  if (refs.length === 0) {
    warnings.push('chapterListApi：JSON 目录解析结果为空（检查 titleField/skipField/urlTemplate 配置）')
  }
  return refs
}
