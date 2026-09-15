/**
 * scraper-service —— 小说管理系统可插拔采集引擎 mini-service（Bun + TypeScript）
 *
 * 端口: 3030（与主站 src/app/api/scrape/route.ts 的代理目标一致）
 *
 * 路由:
 *   GET  /api/strategies  可用抓取策略及状态
 *   GET  /api/health      健康检查
 *   POST /api/test        { url, rule: { listRule?, bookRule?, chapterRule? }, strategy?, charset? }
 *   POST /api/chapter     { url, rule?: ChapterRule, charset? }
 *
 * 错误一律 JSON { error, detail }；策略全败返回结构化 502 而非 throw。
 *
 * 合规红线（不可移除）：
 * - 仅用于公开可访问内容，禁止采集需登录/付费内容；
 * - 内置 robots.txt 提示（warn-only）与默认低频限速（每域名 ≥1.2s）；
 * - 不含任何验证码破解、账号伪装、登录态伪造功能。
 */
import * as cheerio from 'cheerio'
import { clampTimeout, fetchPage, listStrategies, STRATEGY_NAMES } from './src/strategies'
import { extractBook, extractChapter, extractList } from './src/extract'
import { isPrivateHost, privateHostAllowed } from './src/rate-limit'
import type { BookRule, ChapterRule, ListRule } from './src/types'

const PORT = Number(process.env.SCRAPER_PORT ?? 3030)

// ==================== 通用工具 ====================

function json(data: unknown, status = 200): Response {
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

function fail(error: string, detail: unknown, status = 400): Response {
  return json({ error, detail }, status)
}

type TargetResult = { ok: true; url: URL } | { ok: false; message: string }

function parseTarget(raw: unknown): TargetResult {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, message: '缺少 url 参数' }
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return { ok: false, message: `URL 无法解析: ${raw}` }
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
      if (typeof v === 'string' && v.trim()) out[k] = v.trim()
    }
  }
  return out as T
}

function strField(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function parseBody(req: Request): Promise<Record<string, unknown> | null> {
  return req
    .json()
    .then((v) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null))
    .catch(() => null)
}

// ==================== 业务处理 ====================

async function handleStrategies(): Promise<Response> {
  const strategies = await listStrategies()
  return json({
    ok: true,
    service: 'scraper-service',
    strategies,
    compliance: {
      rateLimit: '默认每域名 1200ms±300ms（< 1 req/s），环境变量 SCRAPER_MIN_INTERVAL_MS 可调但不允许低于 1000ms',
      robotsCheck: 'warn-only：解析 robots.txt，命中 Disallow 时在 warnings 中提示，不强制阻断',
      maxResponseBytes: 8 * 1024 * 1024,
      captchaSolving: '禁止提供',
      loginContent: '禁止采集',
      accountSpoofing: '禁止提供',
    },
  })
}

interface PageFetchOutcome {
  response: Response
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
  return { response: json({}), page, target: t.url }
}

async function handleTest(body: Record<string, unknown>): Promise<Response> {
  const t0 = Date.now()
  const outcome = await fetchAndPrepare(body)
  if (!outcome.page || !outcome.target) return outcome.response
  const page = outcome.page
  const baseUrl = outcome.target.toString()

  if (!page.ok) {
    return json(
      {
        ok: false,
        url: baseUrl,
        error: page.error,
        detail: page.detail,
        attempts: page.attempts,
        robots: page.robots,
        warnings: page.warnings,
        elapsedMs: page.elapsedMs,
      },
      502,
    )
  }

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
    data,
    warnings,
  })
}

async function handleChapter(body: Record<string, unknown>): Promise<Response> {
  const t0 = Date.now()
  const rule = sanitizeRule<ChapterRule>(CHAPTER_KEYS, body.rule)
  const outcome = await fetchAndPrepare({ ...body, rule: {} })
  if (!outcome.page || !outcome.target) return outcome.response
  const page = outcome.page
  const baseUrl = outcome.target.toString()

  if (!page.ok) {
    return json(
      {
        ok: false,
        url: baseUrl,
        error: page.error,
        detail: page.detail,
        attempts: page.attempts,
        robots: page.robots,
        warnings: page.warnings,
        elapsedMs: page.elapsedMs,
      },
      502,
    )
  }

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
    data,
    warnings,
  })
}

// ==================== 路由 ====================

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname.replace(/\/+$/, '') || '/'
  const method = req.method.toUpperCase()

  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '86400',
      },
    })
  }

  if (method === 'GET' && (path === '/' || path === '')) {
    return json({
      ok: true,
      service: 'scraper-service',
      version: '1.0.0',
      endpoints: ['GET /api/strategies', 'GET /api/health', 'POST /api/test', 'POST /api/chapter'],
    })
  }

  if (method === 'GET' && path === '/api/health') {
    return json({ ok: true, service: 'scraper-service', port: PORT, time: new Date().toISOString() })
  }

  if (method === 'GET' && path === '/api/strategies') {
    return handleStrategies()
  }

  if (method === 'POST' && path === '/api/test') {
    const body = await parseBody(req)
    if (!body) return fail('请求体错误', '请求体必须是 JSON 对象，形如 { url, rule: { listRule?, bookRule?, chapterRule? }, strategy?, charset? }')
    return handleTest(body)
  }

  if (method === 'POST' && path === '/api/chapter') {
    const body = await parseBody(req)
    if (!body) return fail('请求体错误', '请求体必须是 JSON 对象，形如 { url, rule?: { titleSelector?, contentSelector?, nextSelector? }, charset? }')
    return handleChapter(body)
  }

  return fail('Not Found', `未知路由 ${method} ${path}。可用: GET /api/strategies, GET /api/health, POST /api/test, POST /api/chapter`, 404)
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    try {
      return await route(req)
    } catch (e) {
      return fail('服务器内部错误', e instanceof Error ? e.stack ?? e.message : String(e), 500)
    }
  },
  error(e) {
    return fail('服务器内部错误', e instanceof Error ? e.message : String(e), 500)
  },
})

console.log(`[scraper-service] listening on http://127.0.0.1:${server.port}`)
console.log(`[scraper-service] 合规约束: 域名限速≥1.2s | robots.txt warn-only | 禁验证码破解/账号伪装/付费内容`)
