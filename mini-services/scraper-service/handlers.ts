/**
 * 采集引擎业务 handler 层：请求体解析/参数校验 + /api/strategies、/api/test、/api/chapter 的业务处理。
 * （自 index.ts 拆分而来，路由分发留在入口 index.ts）
 *
 * 对外 API 契约（字段名/错误结构 {error,detail}/CORS）与拆分前完全一致，主站 worker 与 UI 依赖之：
 * - 成功与失败响应都携带 attempts 明细（每次网络尝试的状态/耗时/画像/挑战页标记）便于调试；
 * - 策略链全败返回结构化 502 而非 throw；
 * - 内部异常只返回消息不返回堆栈（堆栈仅打印到服务端日志）。
 */
import * as cheerio from 'cheerio'
import { affinityStats, clampTimeout, fetchPage, listStrategies, STRATEGY_NAMES } from './src/strategies'
import { extractBook, extractChapter, extractList } from './src/extract'
import { isPrivateHost, privateHostAllowed } from './src/rate-limit'
import type { BookRule, ChapterRule, ListRule } from './src/types'

// ==================== 通用工具 ====================

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
    },
  })
}

export function fail(error: string, detail: unknown, status = 400): Response {
  return json({ error, detail }, status)
}

type TargetResult = { ok: true; url: URL } | { ok: false; message: string }

function parseTarget(raw: unknown): TargetResult {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, message: '缺少 url 参数' }
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return { ok: false, message: `URL 无法解析: ${String(raw).slice(0, 200)}` }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, message: `仅支持 http/https 协议（收到 ${u.protocol}）` }
  }
  if (!privateHostAllowed() && isPrivateHost(u.hostname)) {
    return { ok: false, message: '拒绝访问内网/本机地址（SSRF 防护）。如确有需要请设置环境变量 SCRAPER_ALLOW_PRIVATE=1' }
  }
  return { ok: true, url: u }
}

// ---- 规则白名单清洗：只接受已知字段且为非空字符串 ----

const LIST_KEYS = ['itemSelector', 'titleSelector', 'linkSelector', 'authorSelector', 'categorySelector'] as const
const BOOK_KEYS = [
  'titleSelector', 'authorSelector', 'descriptionSelector', 'coverSelector',
  'statusSelector', 'categorySelector', 'chapterLinkSelector', 'chapterTitleSelector',
] as const
const CHAPTER_KEYS = ['titleSelector', 'contentSelector', 'nextSelector'] as const

function sanitizeRule<T extends object>(keys: readonly string[], raw: unknown): T {
  const out: Record<string, string> = {}
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const k of keys) {
      const v = (raw as Record<string, unknown>)[k]
      if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, 300)
    }
  }
  return out as T
}

function strField(v: unknown, maxLen = 64): string | null {
  if (typeof v !== 'string' || !v.trim()) return null
  return v.trim().slice(0, maxLen)
}

export function parseBody(req: Request): Promise<Record<string, unknown> | null> {
  return req
    .json()
    .then((v) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null))
    .catch(() => null)
}

// ==================== 业务处理 ====================

export async function handleStrategies(): Promise<Response> {
  const strategies = await listStrategies()
  return json({
    ok: true,
    service: 'scraper-service',
    strategies,
    // Task 20-a 新增（向后兼容的追加字段）：按主机策略亲和缓存说明
    affinity: {
      description:
        '按主机策略亲和：某主机最近一次成功的策略会在后续对该主机的请求中被提到策略链首优先尝试（显式指定 strategy 时不生效；亲和命中失败照旧回退全链，attempts 顺序照实记录）',
      maxEntries: affinityStats().maxEntries,
      trackedHosts: affinityStats().trackedHosts,
    },
    compliance: {
      rateLimit: '默认每域名 1200ms±300ms（< 1 req/s），环境变量 SCRAPER_MIN_INTERVAL_MS 可调但不允许低于 1000ms',
      robotsCheck: 'warn-only：解析 robots.txt，命中 Disallow 时在 warnings 中提示，不强制阻断',
      ssrfGuard: '文本层（IPv4 全形态/IPv6 内网段）+ DNS 尽力校验 + fetch redirect:manual 逐跳校验',
      maxResponseBytes: 8 * 1024 * 1024,
      challengeDetection:
        '三层检测：反爬平台强特征（任意体积，扫描前 32KB）→ 极小页(<3KB)挑战关键词（latin1/UTF-8/GB18030 三解码匹配，含中文关键词）→ 极小页 0 秒 meta-refresh 跳板；命中即标记 blocked 并按失败处理',
      captchaSolving: '禁止提供',
      loginContent: '禁止采集',
      accountSpoofing: '禁止提供',
    },
  })
}

interface PageFetchOutcome {
  response?: Response
  page?: Awaited<ReturnType<typeof fetchPage>>
  target?: URL
}

async function fetchAndPrepare(body: Record<string, unknown>): Promise<PageFetchOutcome> {
  const t = parseTarget(body.url)
  if (!t.ok) return { response: fail('参数错误', t.message, 400) }
  const timeoutMs = clampTimeout(body.timeoutMs)
  const strategy = strField(body.strategy)
  const charset = strField(body.charset)
  if (strategy && !STRATEGY_NAMES.includes(strategy)) {
    return { response: fail('参数错误', `未知策略 "${strategy}"（可选: ${STRATEGY_NAMES.join(', ')}）`, 400) }
  }
  const page = await fetchPage(t.url.toString(), {
    requestedStrategy: strategy,
    forcedCharset: charset,
    timeoutMs,
  })
  return { page, target: t.url }
}

/** 策略链全败时的结构化 502 响应（含 attempts 明细与挑战页标记） */
function pageFailureResponse(page: NonNullable<Awaited<ReturnType<typeof fetchPage>>>, baseUrl: string): Response {
  const challengeSuspected = page.attempts.some((a) => a.blocked) || (page.detail ?? '').includes('挑战页')
  return json(
    {
      ok: false,
      url: baseUrl,
      error: page.error,
      detail: page.detail,
      challengeSuspected,
      attempts: page.attempts,
      robots: page.robots,
      warnings: page.warnings,
      elapsedMs: page.elapsedMs,
    },
    502,
  )
}

export async function handleTest(body: Record<string, unknown>): Promise<Response> {
  const t0 = Date.now()
  const outcome = await fetchAndPrepare(body)
  if (!outcome.page || !outcome.target) return outcome.response ?? fail('服务器内部错误', '抓取流程未返回结果', 500)
  const page = outcome.page
  const baseUrl = outcome.target.toString()

  if (!page.ok) return pageFailureResponse(page, baseUrl)

  const rawRule = (body.rule ?? {}) as Record<string, unknown>
  const listRule = sanitizeRule<ListRule>(LIST_KEYS, rawRule.listRule)
  const bookRule = sanitizeRule<BookRule>(BOOK_KEYS, rawRule.bookRule)
  const chapterRule = sanitizeRule<ChapterRule>(CHAPTER_KEYS, rawRule.chapterRule)
  const hasRule = Object.keys(listRule).length + Object.keys(bookRule).length + Object.keys(chapterRule).length > 0

  const warnings = [...page.warnings]
  const $ = cheerio.load(page.html)
  const data: Record<string, unknown> = {}

  if (Object.keys(listRule).length) data.list = extractList($, listRule, baseUrl, warnings)
  if (Object.keys(bookRule).length) data.book = extractBook($, bookRule, baseUrl, warnings)
  if (Object.keys(chapterRule).length) data.chapter = extractChapter($, chapterRule, baseUrl, warnings)
  if (!hasRule) {
    data.page = {
      url: baseUrl,
      title: $('title').first().text().trim(),
      htmlLength: page.html.length,
    }
    warnings.push('未提供任何提取规则（rule.listRule / bookRule / chapterRule），仅返回页面基础信息')
  }

  return json({
    ok: true,
    url: baseUrl,
    strategy: page.strategy,
    status: page.status,
    elapsedMs: Date.now() - t0,
    fetchElapsedMs: page.elapsedMs,
    encoding: page.encoding,
    htmlLength: page.html.length,
    robots: page.robots,
    attempts: page.attempts,
    data,
    warnings,
  })
}

export async function handleChapter(body: Record<string, unknown>): Promise<Response> {
  const t0 = Date.now()
  const rule = sanitizeRule<ChapterRule>(CHAPTER_KEYS, body.rule)
  const outcome = await fetchAndPrepare(body)
  if (!outcome.page || !outcome.target) return outcome.response ?? fail('服务器内部错误', '抓取流程未返回结果', 500)
  const page = outcome.page
  const baseUrl = outcome.target.toString()

  if (!page.ok) return pageFailureResponse(page, baseUrl)

  const warnings = [...page.warnings]
  const $ = cheerio.load(page.html)
  const data = extractChapter($, rule, baseUrl, warnings)

  return json({
    ok: true,
    url: baseUrl,
    strategy: page.strategy,
    status: page.status,
    elapsedMs: Date.now() - t0,
    fetchElapsedMs: page.elapsedMs,
    encoding: page.encoding,
    robots: page.robots,
    attempts: page.attempts,
    data,
    warnings,
  })
}
