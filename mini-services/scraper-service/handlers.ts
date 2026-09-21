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
import { browserSessionStats } from './src/strategies/browser'
import { cookieStats } from './src/strategies/cookies'
import { hostHealthStats } from './src/strategies/host-health'
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
  'catalogLinkSelector', 'excludeSelector', 'chapterListApi',
] as const
const CHAPTER_KEYS = ['titleSelector', 'contentSelector', 'nextSelector', 'excludeSelector'] as const

function sanitizeRule<T extends object>(keys: readonly string[], raw: unknown): T {
  const out: Record<string, string> = {}
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const k of keys) {
      const v = (raw as Record<string, unknown>)[k]
      if (typeof v === 'string' && v.trim()) {
        // chapterListApi 为 JSON 配置字符串（url/字段名/模板等十几字段），普通选择器 300 字符不够用
        const cap = k === 'chapterListApi' ? 1200 : 300
        out[k] = v.trim().slice(0, cap)
      }
    }
  }
  return out as T
}

function strField(v: unknown, maxLen = 64): string | null {
  if (typeof v !== 'string' || !v.trim()) return null
  return v.trim().slice(0, maxLen)
}

/**
 * 可选 referer 参数解析：仅接受合法 http(s) URL（≤2048 字符），
 * 非法/缺失返回 null（保持与「不传时行为不变」完全一致）。
 */
function parseReferer(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s || s.length > 2048) return null
  try {
    const u = new URL(s)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.toString()
  } catch {
    return null
  }
}

/**
 * 站点级出口代理解析（规则配置）：支持逗号分隔多个代理（故障轮换），
 * 每个仅接受 http/https/socks5/socks5h/socks4 形态 URL（≤512 字符），
 * 非法/缺失返回 null（直连，与不传时行为一致）。代理地址含凭证时原样透传（不回显到日志）。
 */
function parseProxy(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s || s.length > 1024) return null
  const parts = s.split(',').map((p) => p.trim()).filter(Boolean)
  const ok: string[] = []
  for (const p of parts) {
    try {
      const u = new URL(p)
      if (!['http:', 'https:', 'socks5:', 'socks5h:', 'socks4:'].includes(u.protocol)) return null
      if (!u.host) return null
      ok.push(p)
    } catch {
      return null
    }
  }
  return ok.length ? ok.join(',') : null
}

/** 软 404/空壳标题特征（配合「HTTP 200 + 正文为空」判定；不用裸 404 数字防「第404章」误伤由调用处另行排除） */
const SOFT404_TITLE_RE = /404|not\s*found|不存在|找不到|已删除|无法访问|访问出错|页面出错|加载失败/i

export function parseBody(req: Request): Promise<Record<string, unknown> | null> {
  // 请求体上限 1MB：现有最大载荷是整目章节列表（数百条 {title,url}），留足余量；
  // 超限直接按「请求体错误」处理，防异常大包拖垮内存
  const declaredLen = Number(req.headers.get('content-length') ?? 0)
  if (Number.isFinite(declaredLen) && declaredLen > MAX_BODY_BYTES) return Promise.resolve(null)
  // chunked / 未声明长度（Task 24-a 修复）：旧实现直接 req.json() 无上限，
  // 异常大包（无 Content-Length 头）可整体进内存；改为流式限量读取后超限即拒绝
  if (!Number.isFinite(declaredLen) || declaredLen <= 0) return readJsonCapped(req)
  return req
    .json()
    .then((v) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null))
    .catch(() => null)
}

const MAX_BODY_BYTES = 1_048_576

/** 流式限量读 JSON 请求体：超过 MAX_BODY_BYTES 立即断开并拒绝（用于无 Content-Length 的 chunked 请求） */
async function readJsonCapped(req: Request): Promise<Record<string, unknown> | null> {
  try {
    if (!req.body) return null
    const reader = req.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
    await reader.cancel().catch(() => {})
    const v = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
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
    // Task 23-a 新增（向后兼容的追加字段）：按主机 Cookie 会话持久化说明
    cookieSession: {
      description:
        '按主机 Cookie 会话持久化：捕获各策略响应的 Set-Cookie 按主机存储（含重定向中间跳），该主机后续请求自动回放，覆盖「首访种 cookie、二访才放行」的站点；仅进程内存不落盘，LRU 上限与 TTL 见下；Secure 属性 cookie 仅在 https 请求回放',
      ...cookieStats(),
    },
    // Task 24-a 新增（向后兼容的追加字段）：按主机健康度记忆说明
    hostHealth: {
      description:
        '按主机健康度记忆：429/503 后下一次抓取先主动退避（Retry-After 优先，指数增长上界 15s，成功即清零）；连续整链失败达阈值的主机熔断快速失败（冷却 60s 起指数增长上界 10min，半开自动恢复；显式指定 strategy 时跳过熔断）',
      ...hostHealthStats(),
    },
    // Task 13-a 新增（向后兼容的追加字段）：browser 策略共享 Chromium 会话说明
    browserSession: {
      description:
        'browser 策略共享 Chromium：无代理请求复用进程级实例（每请求独立 context 隔离），按请求数阈值定期关闭重建防长跑内存膨胀，空闲自动关闭释放常驻内存，渲染级错误即弃即重建；带代理请求维持单次 launch+close',
      ...browserSessionStats(),
    },
    compliance: {
      rateLimit: '默认每域名 1200ms±300ms（< 1 req/s），环境变量 SCRAPER_MIN_INTERVAL_MS 可调但不允许低于 1000ms；跨域重定向跳同样逐跳限速',
      robotsCheck: 'warn-only：解析 robots.txt，命中 Disallow 时在 warnings 中提示，不强制阻断',
      ssrfGuard: '文本层（IPv4 全形态/IPv6 内网段）+ DNS 尽力校验 + fetch redirect:manual 逐跳校验',
      maxResponseBytes: 8 * 1024 * 1024,
      challengeDetection:
        '四层检测：反爬平台强特征（任意体积，扫描前 32KB，含国产 WAF JS 挑战壳 token acw_sc__v2/__jsl_clearance/__jsluid/yunsuo/wzws）→ 近空可见正文（<80 字符）JS 跳板/「JS 计算 cookie + 原地 reload」壳/需启用 JS 壳（任意体积，覆盖 HTTP 200 伪装）→ 极小页(<3KB)挑战关键词（latin1/UTF-8/GB18030 三解码匹配，含中文关键词）→ 极小页 0 秒 meta-refresh 跳板；命中即标记 blocked 并按失败处理',
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
  // 可选 referer 链（Task 23-a 新增，向后兼容：不传时为 null，策略层维持原行为）
  const referer = parseReferer(body.referer)
  // 站点级出口代理（规则配置，向后兼容：不传/非法时为 null → 直连）
  const proxy = parseProxy(body.proxy)
  // 自签/裸 IP 站点 TLS 旁路（规则配置，向后兼容：不传时 false，各策略维持证书校验）
  const insecureTLS = body.insecureTLS === true
  const page = await fetchPage(t.url.toString(), {
    requestedStrategy: strategy,
    forcedCharset: charset,
    timeoutMs,
    referer,
    proxy,
    insecureTLS,
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
  // 调试开关（可选，向后兼容）：includeHtml=true 时响应附带原始 HTML（截断到上限），
  // 供规则编辑器/人工分析 DOM 结构使用；默认关闭，不影响既有响应结构
  const includeHtml = body.includeHtml === true
  const htmlDebug = includeHtml ? page.html.slice(0, HTML_DEBUG_LIMIT) : undefined

  const warnings = [...page.warnings]
  const $ = cheerio.load(page.html)
  const data: Record<string, unknown> = {}

  if (Object.keys(listRule).length) data.list = extractList($, listRule, baseUrl, warnings)
  if (Object.keys(bookRule).length) data.book = await extractBook($, bookRule, baseUrl, warnings)
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
    ...(includeHtml ? { html: htmlDebug, htmlTruncated: page.html.length > (htmlDebug?.length ?? 0) } : {}),
    robots: page.robots,
    attempts: page.attempts,
    data,
    warnings,
  })
}

/** includeHtml 调试模式下单次返回的 HTML 上限（约 300K 字符，覆盖绝大多数列表/书页） */
const HTML_DEBUG_LIMIT = 300_000

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

  // 软 404/空壳质量哨兵（Task 23-a）：HTTP 200 但正文为空的伪装页。
  // 纯提示（ok 仍为 true，不改变既有成功语义），把「200 伪装」暴露给调用方可观测。
  if (page.status === 200 && !data.content) {
    // 标题呈 404/空壳特征时更明确；排除「第404章」这类标题里的数字巧合
    const soft404Title =
      SOFT404_TITLE_RE.test(data.title) && !/^第\s*[0-9〇零一二两三四五六七八九十百千万]/.test(data.title)
    warnings.push(
      soft404Title
        ? 'HTTP 200 但正文为空且标题呈 404/空壳特征，疑似软 404（目标站用 200 状态码伪装错误页）'
        : 'HTTP 200 但正文提取为空：疑似 JS 渲染空壳或软 404，建议用 browser 策略复核该 URL',
    )
  }

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
