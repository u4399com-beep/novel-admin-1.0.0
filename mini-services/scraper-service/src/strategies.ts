/**
 * 可插拔抓取策略层（反反爬增强版）。
 *
 * 策略链顺序（依次尝试直到成功）：
 *   1) fetch-browser     —— 原生 fetch + 完整 Chrome 桌面请求头（UA/Accept/Accept-Language/Sec-Fetch 族/客户端提示 + Referer 链）
 *   2) fetch-ua-rotate   —— UA 轮换：Firefox → Safari → Edge 桌面画像（其中 Safari 不带 Referer，覆盖"无 Referer"变体）
 *   3) fetch-mobile      —— 移动端画像：Android Chrome（带 Referer）→ iPhone Safari（无 Referer）
 *   4) fetch-spider      —— 搜索引擎 spider UA 降级：Googlebot → Baiduspider（仅用于公开内容，不伪造登录态）
 *   5) curl-impersonate  —— 系统 curl_chrome* 二进制（TLS/JA3 指纹级伪装），HTTP/2 失败自动降级 --http1.1
 *   6) got-scraping      —— header-generator 随机真实头 + HTTP/2，失败自动降级 HTTP/1.1（覆盖协议指纹差异）
 *   7) browser           —— Playwright + Chromium 真实渲染（优先 Node 包，缺失时经 Python Playwright 桥接），不可用时优雅跳过
 *
 * 通用能力：
 * - 所有 fetch 走 redirect:'manual' 逐跳 SSRF 校验（内网/重定向后内网跳转一律拒绝，运行时不支持 manual 时降级为 follow+最终 URL 校验）；
 * - 挑战页检测：响应体 <3KB 且含 verify/challenge/captcha/javascript 关键词 → 标记 blocked，视为失败并继续下一策略；
 * - 每次网络尝试（含策略内部子尝试）都经过域名限速，并结构化记录到 attempts 明细；
 * - 整体时间预算（默认上限 55s），超预算后停止尝试并给出 budget-exhausted 备注。
 *
 * 合规边界：本层只做"请求头/指纹/渲染"层面的通用反反爬增强，
 * 不包含也不预留任何验证码破解、账号登录态伪造、付费内容绕过逻辑。
 */
import { access, constants as fsConstants, readFile, readdir, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquireDomainSlot, assertHostPublic, backoffDelay, checkRobots, execP, isRetryableStatus, MAX_ATTEMPTS, sleep } from './rate-limit'
import { charsetFromContentType, decodeHtml } from './charset'
import type { AttemptSummary, RobotsSummary, StrategyInfo, SubAttempt } from './types'

const MAX_BYTES = 8 * 1024 * 1024
const MAX_REDIRECT_HOPS = 5
const CHAIN_BUDGET_MS = 55_000
const CHROME_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const RENDER_PY = fileURLToPath(new URL('../scripts/render.py', import.meta.url))

export interface AttemptResult {
  ok: boolean
  status: number
  bytes: Uint8Array
  contentType: string
  warnings: string[]
  note?: string
  /** 策略内部的子尝试明细（UA 轮换画像 / h2→h1 降级等），fetchPage 会摊平进 attempts */
  subAttempts?: SubAttempt[]
}

export interface FetchPageOptions {
  requestedStrategy?: string | null
  forcedCharset?: string | null
  timeoutMs?: number
}

export interface FetchPageResult {
  ok: boolean
  html: string
  encoding: string
  strategy: string
  status: number
  warnings: string[]
  attempts: AttemptSummary[]
  robots: RobotsSummary
  elapsedMs: number
  error?: string
  detail?: string
}

interface StrategyDef {
  name: string
  description: string
  probe(): Promise<boolean>
  run(url: string, timeoutMs: number, warnings: string[]): Promise<AttemptResult>
  /** true = 策略内部已自带多画像/多协议重试梯子，外层不再按 MAX_ATTEMPTS 重试 */
  selfRetrying?: boolean
}

// ==================== 头部画像（Header Profiles） ====================

export interface HeaderProfile {
  id: string
  label: string
  /** 是否携带 Referer（覆盖"带 Referer/无 Referer"变体） */
  referer: boolean
  headers(url: string, withReferer: boolean): Record<string, string>
}

const ACCEPT_HTML =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7'
const ACCEPT_LANG_ZH = 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7'
const ACCEPT_LANG_BOT = 'en-US,en;q=0.9'

function baseHeaders(url: string, withReferer: boolean, ua: string, extra: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = {
    'user-agent': ua,
    accept: ACCEPT_HTML,
    'accept-language': ACCEPT_LANG_ZH,
    'upgrade-insecure-requests': '1',
    ...extra,
  }
  if (withReferer) {
    // Referer 链：以目标站自身首页为来源，模拟从站内导航进入
    h.referer = `${new URL(url).origin}/`
  }
  return h
}

/** a) Chrome 桌面：全套 Sec-Fetch-* + 客户端提示 */
const chromeDesktopProfile: HeaderProfile = {
  id: 'chrome-desktop',
  label: 'Chrome 桌面（完整 Sec-Fetch/客户端提示 + Referer）',
  referer: true,
  headers(url, withReferer) {
    return baseHeaders(url, withReferer, CHROME_UA, {
      'cache-control': 'no-cache',
      pragma: 'no-cache',
      'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Linux"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-user': '?1',
    })
  },
}

/** b) Firefox 桌面：不发客户端提示，保留 Sec-Fetch */
const firefoxDesktopProfile: HeaderProfile = {
  id: 'firefox-desktop',
  label: 'Firefox 桌面（无客户端提示 + Referer）',
  referer: true,
  headers(url, withReferer) {
    return baseHeaders(
      url,
      withReferer,
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
      {
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-user': '?1',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    )
  },
}

/** b) Safari 桌面（无 Referer 变体） */
const safariDesktopProfile: HeaderProfile = {
  id: 'safari-desktop',
  label: 'Safari 桌面（无客户端提示、无 Referer）',
  referer: false,
  headers(url, withReferer) {
    return baseHeaders(
      url,
      withReferer,
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
      {
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
      },
    )
  },
}

/** b) Edge 桌面 */
const edgeDesktopProfile: HeaderProfile = {
  id: 'edge-desktop',
  label: 'Edge 桌面（Chromium 内核 + Edge 品牌 + Referer）',
  referer: true,
  headers(url, withReferer) {
    return baseHeaders(
      url,
      withReferer,
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
      {
        'sec-ch-ua': '"Chromium";v="124", "Microsoft Edge";v="124", "Not-A.Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-user': '?1',
      },
    )
  },
}

/** d) Android Chrome 移动端 */
const androidChromeProfile: HeaderProfile = {
  id: 'android-chrome',
  label: 'Android Chrome 移动端（sec-ch-ua-mobile=?1 + Referer）',
  referer: true,
  headers(url, withReferer) {
    return baseHeaders(
      url,
      withReferer,
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
      {
        'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'sec-ch-ua-mobile': '?1',
        'sec-ch-ua-platform': '"Android"',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-user': '?1',
      },
    )
  },
}

/** d) iPhone Safari 移动端（无客户端提示、无 Referer） */
const iphoneSafariProfile: HeaderProfile = {
  id: 'iphone-safari',
  label: 'iPhone Safari 移动端（无 Referer）',
  referer: false,
  headers(url, withReferer) {
    return baseHeaders(
      url,
      withReferer,
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
      {
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
      },
    )
  },
}

/** c) Googlebot 降级 */
const googlebotProfile: HeaderProfile = {
  id: 'googlebot',
  label: 'Googlebot 桌面降级（无 Referer）',
  referer: false,
  headers(url, withReferer) {
    const h = baseHeaders(
      url,
      withReferer,
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/124.0.0.0 Safari/537.36',
      { 'accept-language': ACCEPT_LANG_BOT },
    )
    h.accept = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'
    return h
  },
}

/** c) Baiduspider 降级 */
const baiduspiderProfile: HeaderProfile = {
  id: 'baiduspider',
  label: 'Baiduspider 降级（无 Referer）',
  referer: false,
  headers(url, withReferer) {
    const h = baseHeaders(
      url,
      withReferer,
      'Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)',
      { 'accept-language': ACCEPT_LANG_ZH },
    )
    h.accept = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'
    return h
  },
}

// ==================== 公共工具 ====================

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export interface RawResponse {
  ok: boolean
  status: number
  bytes: Uint8Array
  contentType: string
  finalUrl?: string
  note?: string
  warning?: string
}

/**
 * 挑战页检测：响应体 <3KB 且含 verify/challenge/captcha/javascript 关键词 → 疑似反爬挑战页。
 * （latin1 嗅探即可 —— 这些关键词均为 ASCII，与页面编码无关）
 */
export function looksLikeChallenge(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0 || bytes.byteLength >= 3072) return false
  const head = Buffer.from(bytes.subarray(0, 3072)).toString('latin1')
  return /verify|challenge|captcha|javascript/i.test(head)
}

/** 统一的响应评估：ok 判定 + 挑战页标记 + 结构化 note，各执行器共用保证一致 */
function assess(status: number, bytes: Uint8Array, contentType: string): { ok: boolean; blocked: boolean; size: number; note?: string; warning?: string } {
  const size = bytes.byteLength
  if (looksLikeChallenge(bytes)) {
    return {
      ok: false,
      blocked: true,
      size,
      note: 'challenge-page',
      warning: `疑似挑战/验证页（响应 ${size}B < 3KB 且含 verify/challenge/captcha/javascript 关键词），已按失败处理`,
    }
  }
  if (status >= 400) return { ok: false, blocked: false, size, note: `http-${status}` }
  if (status === 0) return { ok: false, blocked: false, size, note: 'network-error' }
  if (size === 0) return { ok: false, blocked: false, size, note: 'empty-body' }
  return { ok: true, blocked: false, size }
}

async function readBody(res: Response): Promise<{ bytes: Uint8Array; contentType: string; note?: string; warning?: string }> {
  const contentType = res.headers.get('content-type') ?? ''
  const declaredLen = Number(res.headers.get('content-length') ?? 0)
  if (declaredLen > MAX_BYTES) {
    return { bytes: new Uint8Array(0), contentType, note: 'too-large', warning: `响应过大（Content-Length ${declaredLen}B > 上限 ${MAX_BYTES}B），已放弃` }
  }
  const buf = await res.arrayBuffer()
  const bytes = new Uint8Array(buf)
  if (bytes.byteLength > MAX_BYTES) {
    return { bytes: new Uint8Array(0), contentType, note: 'too-large', warning: `响应实际大小 ${bytes.byteLength}B 超上限 ${MAX_BYTES}B，已放弃` }
  }
  return { bytes, contentType }
}

/**
 * 带逐跳 SSRF 校验的 fetch：redirect:'manual' 手动跟随重定向，每一跳都做
 * 文本层 + DNS 尽力校验；运行时把 manual 实现为 opaque（status 0）时自动降级
 * 为 follow + 最终 URL 校验。
 */
export async function fetchWithRedirectGuard(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  warnings: string[],
): Promise<RawResponse> {
  const deadline = Date.now() + timeoutMs
  let current = url
  let hops = 0

  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining < 500) {
      return { ok: false, status: 0, bytes: new Uint8Array(0), contentType: '', note: 'timeout' }
    }

    let target: URL
    try {
      target = new URL(current)
    } catch {
      return { ok: false, status: 0, bytes: new Uint8Array(0), contentType: '', note: 'bad-url' }
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return { ok: false, status: 0, bytes: new Uint8Array(0), contentType: '', note: 'bad-scheme', warning: `重定向到非 http/https 协议已拒绝: ${target.protocol}` }
    }
    const check = await assertHostPublic(target.hostname)
    if (!check.ok) {
      return { ok: false, status: 0, bytes: new Uint8Array(0), contentType: '', note: 'ssrf-blocked', warning: `SSRF 防护: ${check.reason}` }
    }
    if (check.warning) warnings.push(`[ssrf] ${check.warning}`)

    let res: Response
    try {
      res = await fetch(current, { headers, redirect: 'manual', signal: AbortSignal.timeout(remaining) })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        ok: false,
        status: 0,
        bytes: new Uint8Array(0),
        contentType: '',
        note: /abort|timeout/i.test(msg) ? 'timeout' : 'network-error',
        warning: `网络错误: ${msg}`,
      }
    }

    // 运行时把 redirect:'manual' 实现为 opaque-redirect（status 0）→ 降级为 follow + 最终 URL 校验
    if (res.status === 0 && (res as Response & { type?: string }).type === 'opaqueredirect') {
      warnings.push('运行时未暴露 manual 重定向详情，降级为 follow 模式 + 最终 URL 校验')
      try {
        const follow = await fetch(current, {
          headers,
          redirect: 'follow',
          signal: AbortSignal.timeout(Math.max(500, deadline - Date.now())),
        })
        const finalUrl = follow.url || current
        const finalCheck = await assertHostPublic(new URL(finalUrl).hostname)
        if (!finalCheck.ok) {
          follow.body?.cancel().catch(() => {})
          return { ok: false, status: 0, bytes: new Uint8Array(0), contentType: '', note: 'ssrf-blocked', warning: `SSRF 防护: 重定向终点 ${finalCheck.reason}` }
        }
        const body = await readBody(follow)
        return { ok: follow.ok, status: follow.status, ...body, finalUrl }
      } catch (e) {
        return { ok: false, status: 0, bytes: new Uint8Array(0), contentType: '', note: 'network-error', warning: `网络错误: ${e instanceof Error ? e.message : String(e)}` }
      }
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location')
      res.body?.cancel().catch(() => {})
      if (!loc) {
        return { ok: false, status: res.status, bytes: new Uint8Array(0), contentType: '', note: 'redirect-no-location' }
      }
      let next: URL
      try {
        next = new URL(loc, current)
      } catch {
        return { ok: false, status: res.status, bytes: new Uint8Array(0), contentType: '', note: 'redirect-bad-location', warning: `非法 Location 头: ${loc.slice(0, 200)}` }
      }
      hops++
      if (hops > MAX_REDIRECT_HOPS) {
        return { ok: false, status: res.status, bytes: new Uint8Array(0), contentType: '', note: 'too-many-redirects', warning: `重定向超过 ${MAX_REDIRECT_HOPS} 跳，已停止` }
      }
      current = next.toString()
      continue
    }

    const body = await readBody(res)
    return { ok: res.ok, status: res.status, ...body, finalUrl: current }
  }
}

// ==================== fetch 系策略工厂（a/b/c/d/e 组能力） ====================

function makeFetchStrategy(cfg: { name: string; description: string; profiles: HeaderProfile[] }): StrategyDef {
  return {
    name: cfg.name,
    description: cfg.description,
    probe: async () => typeof fetch === 'function',
    selfRetrying: true, // 内部画像梯子即是重试路径，外层不再重复重试
    async run(url, timeoutMs, warnings) {
      const subAttempts: SubAttempt[] = []
      const deadline = Date.now() + timeoutMs
      let last: AttemptResult | null = null

      for (const profile of cfg.profiles) {
        const remaining = deadline - Date.now()
        if (remaining < 1000) {
          subAttempts.push({ profile: profile.id, ok: false, status: 0, ms: 0, blocked: false, bytes: 0, note: 'timeout-budget' })
          break
        }
        await acquireDomainSlot(hostOf(url)) // 每个画像的请求同样受域名限速约束
        const s0 = Date.now()
        const r = await fetchWithRedirectGuard(url, profile.headers(url, profile.referer), remaining, warnings)
        const a = assess(r.status, r.bytes, r.contentType)
        const ms = Date.now() - s0
        subAttempts.push({ profile: profile.id, ok: a.ok, status: r.status, ms, blocked: a.blocked, bytes: a.size, note: r.note ?? a.note })
        if (r.warning || a.warning) warnings.push(`[${profile.id}] ${r.warning ?? a.warning}`)

        if (a.ok) {
          return { ok: true, status: r.status, bytes: r.bytes, contentType: r.contentType, warnings, subAttempts }
        }
        last = { ok: false, status: r.status, bytes: r.bytes, contentType: r.contentType, warnings, note: r.note ?? a.note, subAttempts }
      }
      return (
        last ?? {
          ok: false,
          status: 0,
          bytes: new Uint8Array(0),
          contentType: '',
          warnings,
          note: 'no-profile-attempted',
          subAttempts,
        }
      )
    },
  }
}

const fetchBrowserStrategy = makeFetchStrategy({
  name: 'fetch-browser',
  description: '原生 fetch + 完整 Chrome 桌面请求头（UA/Accept/Accept-Language/Referer 链/Sec-Fetch 族/客户端提示），最快最稳的默认策略',
  profiles: [chromeDesktopProfile],
})

const fetchUaRotateStrategy = makeFetchStrategy({
  name: 'fetch-ua-rotate',
  description: 'UA 轮换：Firefox → Safari（无 Referer 变体）→ Edge 桌面画像，对抗 UA 白名单类拦截',
  profiles: [firefoxDesktopProfile, safariDesktopProfile, edgeDesktopProfile],
})

const fetchMobileStrategy = makeFetchStrategy({
  name: 'fetch-mobile',
  description: '移动端画像：Android Chrome（带 Referer）→ iPhone Safari（无 Referer），部分站点仅放行移动端 UA',
  profiles: [androidChromeProfile, iphoneSafariProfile],
})

const fetchSpiderStrategy = makeFetchStrategy({
  name: 'fetch-spider',
  description: '搜索引擎 spider UA 降级：Googlebot → Baiduspider（仅采集公开内容，不伪造登录态/不破解验证码）',
  profiles: [googlebotProfile, baiduspiderProfile],
})

// ==================== curl-impersonate ====================

const CURL_IMPERSONATE_RE =
  /^(curl_chrome[\w.]*|curl_ff[\w.]*|curl_edge[\w.]*|curl_safari[\w.]*|curl-impersonate(?:-(?:chrome|ff|firefox|edge|safari)[\w.-]*)?)$/i

function binScore(name: string): number {
  // chrome 最新版优先，其次 firefox，再次 edge/safari
  const browser = /chrome/i.test(name) ? 3 : /ff|firefox/i.test(name) ? 2 : 1
  const ver = Number((/(\d{2,4})/.exec(name)?.[1] ?? '0'))
  return browser * 10000 + ver
}

let curlBinPromise: Promise<string | null> | null = null

function detectCurlImpersonate(): Promise<string | null> {
  if (!curlBinPromise) {
    curlBinPromise = (async () => {
      const dirs = (process.env.PATH ?? '').split(':').filter(Boolean)
      const candidates: Array<{ path: string; name: string }> = []
      for (const dir of dirs) {
        let entries: string[]
        try {
          entries = await readdir(dir)
        } catch {
          continue
        }
        for (const name of entries) {
          if (!CURL_IMPERSONATE_RE.test(name)) continue
          const full = join(dir, name)
          try {
            await access(full, fsConstants.X_OK) // 存在且可执行
            candidates.push({ path: full, name })
          } catch {
            continue
          }
        }
      }
      candidates.sort((a, b) => binScore(b.name) - binScore(a.name))
      return candidates[0]?.path ?? null
    })().catch(() => null)
  }
  return curlBinPromise
}

const curlImpersonateStrategy: StrategyDef = {
  name: 'curl-impersonate',
  description:
    '调用系统 curl_chrome*/curl-impersonate-* 二进制（TLS/JA3 指纹级浏览器伪装），HTTP/2 失败自动降级 --http1.1；需另行安装二进制，检测不到则不可用',
  probe: () => detectCurlImpersonate().then((p) => p !== null),
  selfRetrying: true,
  async run(url, timeoutMs, warnings) {
    const bin = await detectCurlImpersonate()
    if (!bin) {
      return { ok: false, status: 0, bytes: new Uint8Array(0), contentType: '', warnings: ['未找到 curl-impersonate 二进制'], note: 'missing-binary' }
    }
    const subAttempts: SubAttempt[] = []
    const deadline = Date.now() + timeoutMs

    // 子尝试梯子：默认（HTTP/2）→ --http1.1（覆盖协议指纹差异）
    const variants: Array<{ profile: string; extraArgs: string[] }> = [
      { profile: 'h2-default', extraArgs: [] },
      { profile: 'http1.1', extraArgs: ['--http1.1'] },
    ]

    for (const variant of variants) {
      const remaining = deadline - Date.now()
      if (remaining < 1000) {
        subAttempts.push({ profile: variant.profile, ok: false, status: 0, ms: 0, blocked: false, bytes: 0, note: 'timeout-budget' })
        break
      }
      await acquireDomainSlot(hostOf(url))
      const s0 = Date.now()
      const tmpOut = join(tmpdir(), `scraper-${Date.now()}-${Math.random().toString(36).slice(2)}.body`)
      const args: string[] = [
        '--silent', '--show-error', '--location', '--max-redirs', String(MAX_REDIRECT_HOPS),
        '--max-time', String(Math.max(1, Math.ceil(remaining / 1000))),
        '--compressed',
        '--output', tmpOut,
        '--write-out', '%{http_code}\t%{content_type}\t%{url_effective}',
      ]
      for (const [k, v] of Object.entries(chromeDesktopProfile.headers(url, true))) args.push('--header', `${k}: ${v}`)
      args.push(...variant.extraArgs, url)
      try {
        const { stdout } = await execP(bin, args, { timeout: remaining + 3000, maxBuffer: 1024 * 1024 })
        const [code, ctype, effective] = stdout.trim().split('\t')
        const status = Number.parseInt(code, 10) || 0
        const bytes = new Uint8Array(await readFile(tmpOut))
        const a = assess(status, bytes, ctype ?? '')
        subAttempts.push({ profile: variant.profile, ok: a.ok, status, ms: Date.now() - s0, blocked: a.blocked, bytes: a.size, note: a.note })

        // 重定向终点 SSRF 校验（curl 内部跟随，事后校验最终 URL）
        if (effective) {
          try {
            const finalCheck = await assertHostPublic(new URL(effective).hostname)
            if (!finalCheck.ok) {
              warnings.push(`SSRF 防护: 重定向终点 ${finalCheck.reason}`)
              return { ok: false, status, bytes: new Uint8Array(0), contentType: '', warnings, note: 'ssrf-blocked', subAttempts }
            }
          } catch { /* url_effective 解析失败忽略 */ }
        }
        if (a.warning) warnings.push(`[${variant.profile}] ${a.warning}`)
        if (status >= 400) warnings.push(`curl-impersonate 收到 HTTP ${status}`)

        if (a.ok) {
          return { ok: true, status, bytes, contentType: ctype ?? '', warnings, subAttempts }
        }
      } catch (e) {
        const err = e as (Error & { stderr?: string; code?: number | string }) | null
        subAttempts.push({ profile: variant.profile, ok: false, status: 0, ms: Date.now() - s0, blocked: false, bytes: 0, note: 'exec-error' })
        warnings.push(`curl-impersonate 执行失败: ${err?.message ?? 'unknown'}${err?.stderr ? ` / ${err.stderr.trim().slice(0, 200)}` : ''}`)
        break // 二进制级失败，HTTP/1.1 降级无意义
      } finally {
        unlink(tmpOut).catch(() => {})
      }
    }
    return { ok: false, status: 0, bytes: new Uint8Array(0), contentType: '', warnings, note: 'all-variants-failed', subAttempts }
  },
}

// ==================== got-scraping ====================

type GotScrapingFn = (options: Record<string, unknown>) => Promise<{
  statusCode: number
  body: Uint8Array
  url?: string
  headers: Record<string, string | string[] | undefined>
}>

let gotFnPromise: Promise<GotScrapingFn | null> | null = null

function loadGotScraping(): Promise<GotScrapingFn | null> {
  if (!gotFnPromise) {
    gotFnPromise = (async () => {
      const mod: unknown = await import('got-scraping' as string)
      const m = mod as { gotScraping?: GotScrapingFn; default?: { gotScraping?: GotScrapingFn } }
      const fn = m?.gotScraping ?? m?.default?.gotScraping
      return typeof fn === 'function' ? fn : null
    })().catch(() => null)
  }
  return gotFnPromise
}

const gotScrapingStrategy: StrategyDef = {
  name: 'got-scraping',
  description:
    'got-scraping（header-generator 生成真实浏览器头）HTTP/2 失败自动降级 HTTP/1.1，对抗请求头/协议指纹拦截；依赖未安装则不可用',
  probe: () => loadGotScraping().then((f) => f !== null),
  selfRetrying: true,
  async run(url, timeoutMs, warnings) {
    const gotScraping = await loadGotScraping()
    if (!gotScraping) {
      return { ok: false, status: 0, bytes: new Uint8Array(0), contentType: '', warnings: ['got-scraping 模块不可用'], note: 'module-missing' }
    }
    const subAttempts: SubAttempt[] = []
    const deadline = Date.now() + timeoutMs

    // 子尝试梯子：HTTP/2 → HTTP/1.1（协议指纹差异）
    const variants: Array<{ profile: string; http2: boolean }> = [
      { profile: 'h2', http2: true },
      { profile: 'http1.1', http2: false },
    ]

    for (const variant of variants) {
      const remaining = deadline - Date.now()
      if (remaining < 1000) {
        subAttempts.push({ profile: variant.profile, ok: false, status: 0, ms: 0, blocked: false, bytes: 0, note: 'timeout-budget' })
        break
      }
      await acquireDomainSlot(hostOf(url))
      const s0 = Date.now()
      try {
        const res = await gotScraping({
          url,
          method: 'GET',
          responseType: 'buffer',
          http2: variant.http2,
          followRedirect: true,
          maxRedirects: MAX_REDIRECT_HOPS,
          retry: { limit: 0 }, // 重试由本服务统一编排，避免双重重试
          timeout: { request: remaining },
          headers: { referer: `${new URL(url).origin}/` },
          context: {
            headerGeneratorOptions: {
              browsers: [{ name: 'chrome' }, { name: 'edge' }],
              devices: ['desktop'],
              locale: 'zh-CN',
            },
          },
        })
        const bytes = new Uint8Array(res.body ?? new Uint8Array(0))
        const status = res.statusCode
        const contentType = String(Array.isArray(res.headers['content-type']) ? res.headers['content-type'][0] : res.headers['content-type'] ?? '')
        const a = assess(status, bytes, contentType)
        subAttempts.push({ profile: variant.profile, ok: a.ok, status, ms: Date.now() - s0, blocked: a.blocked, bytes: a.size, note: a.note })

        // 最终 URL SSRF 校验
        if (res.url) {
          try {
            const finalCheck = await assertHostPublic(new URL(res.url).hostname)
            if (!finalCheck.ok) {
              warnings.push(`SSRF 防护: 重定向终点 ${finalCheck.reason}`)
              return { ok: false, status, bytes: new Uint8Array(0), contentType: '', warnings, note: 'ssrf-blocked', subAttempts }
            }
          } catch { /* 最终 URL 解析失败忽略 */ }
        }
        if (a.warning) warnings.push(`[${variant.profile}] ${a.warning}`)
        if (status >= 400) warnings.push(`got-scraping 收到 HTTP ${status}`)

        if (a.ok) {
          return { ok: true, status, bytes, contentType, warnings, subAttempts }
        }
      } catch (rawErr) {
        const e = rawErr as (Error & { response?: { statusCode: number; body?: Uint8Array; headers?: Record<string, string> }; code?: string }) | null
        if (e?.response) {
          const status = e.response.statusCode
          const bytes = new Uint8Array(e.response.body ?? new Uint8Array(0))
          const contentType = e.response.headers?.['content-type'] ?? ''
          const a = assess(status, bytes, contentType)
          subAttempts.push({ profile: variant.profile, ok: false, status, ms: Date.now() - s0, blocked: a.blocked, bytes: a.size, note: a.note ?? `http-${status}` })
          warnings.push(`got-scraping 收到 HTTP ${status}（got 对非 2xx 抛错，已转为结构化失败）`)
          if (a.warning) warnings.push(`[${variant.profile}] ${a.warning}`)
          // got 对网络层错误才需要降级重试，HTTP 状态码失败直接结束
          if (!isRetryableStatus(status)) break
        } else {
          subAttempts.push({ profile: variant.profile, ok: false, status: 0, ms: Date.now() - s0, blocked: false, bytes: 0, note: e?.code ?? 'network-error' })
          warnings.push(`got-scraping 网络错误（${variant.profile}）: ${e?.code ?? e?.message ?? 'unknown'}`)
        }
      }
    }
    return { ok: false, status: 0, bytes: new Uint8Array(0), contentType: '', warnings, note: 'all-variants-failed', subAttempts }
  },
}

// ==================== browser（Playwright 渲染） ====================

let browserProbePromise: Promise<boolean> | null = null

// 变量形式的模块说明符：避免 bun build 静态内联 playwright（运行时按 NODE_PATH/全局目录解析）
const PW_SPEC = 'play' + 'wright'

async function importNodePlaywright(): Promise<any | null> {
  try {
    return await import(/* bun-ignore */ PW_SPEC)
  } catch {
    return null
  }
}

async function detectBrowser(): Promise<boolean> {
  // 1) Node playwright 包
  if (await importNodePlaywright()) return true
  // 2) Python Playwright + Chromium（Node 包缺失时的桥接路径）
  try {
    await execP('python3', ['-c', 'import playwright'], { timeout: 10000 })
    const cacheDir = join(process.env.HOME ?? '/root', '.cache', 'ms-playwright')
    const entries = await readdir(cacheDir).catch(() => [] as string[])
    return entries.some((n) => n.startsWith('chromium'))
  } catch {
    return false
  }
}

function probeBrowser(): Promise<boolean> {
  if (!browserProbePromise) browserProbePromise = detectBrowser().catch(() => false)
  return browserProbePromise
}

interface RenderPayload {
  status: number
  html: string
  error?: string
}

async function renderViaPython(url: string, timeoutMs: number, warnings: string[]): Promise<AttemptResult> {
  // 参数经 argv 传递（URL 不含换行；UA 含空格由 execFile 正确转义）
  const { stdout } = await execP(
    'python3',
    [RENDER_PY, url, String(timeoutMs), CHROME_UA],
    { timeout: timeoutMs + 15000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PYTHONUNBUFFERED: '1' } },
  )
  const payload = JSON.parse(stdout) as RenderPayload
  if (payload.error) {
    warnings.push(`Python Playwright 渲染失败: ${payload.error}`)
    return { ok: false, status: 0, bytes: new Uint8Array(0), contentType: '', warnings, note: 'render-error' }
  }
  const bytes = new Uint8Array(Buffer.from(payload.html ?? '', 'utf8'))
  const a = assess(payload.status, bytes, 'text/html; charset=utf-8')
  if (a.warning) warnings.push(a.warning)
  return {
    ok: a.ok,
    status: payload.status,
    bytes,
    contentType: 'text/html; charset=utf-8',
    warnings,
    note: a.note,
    subAttempts: [{ profile: 'python-playwright', ok: a.ok, status: payload.status, ms: 0, blocked: a.blocked, bytes: a.size, note: a.note }],
  }
}

const browserStrategy: StrategyDef = {
  name: 'browser',
  description:
    'Playwright + Chromium 真实渲染（Node 包缺失时自动经 Python Playwright 桥接），对抗 JS 挑战/动态渲染；环境不可用时优雅跳过',
  probe: probeBrowser,
  selfRetrying: true,
  async run(url, timeoutMs, warnings) {
    warnings.push('browser 策略为完整浏览器渲染，成本最高（约 1-5s），仅建议前序策略失败时使用')
    const subAttempts: SubAttempt[] = []
    const s0 = Date.now()

    // 1) Node playwright：模块导入失败才降级到 Python 桥接；
    //    导入成功后的导航/渲染错误属于站点网络问题，直接返回结构化结果（避免无谓的双倍渲染耗时）
    const pw = await importNodePlaywright()
    if (pw) {
      let browser: any = null
      try {
        browser = await pw.chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] })
        const page = await browser.newPage({ userAgent: CHROME_UA, locale: 'zh-CN', viewport: { width: 1366, height: 900 } })
        page.setDefaultTimeout(timeoutMs)
        try {
          // 屏蔽重资源，加速渲染（与 render.py 行为一致）
          await page.route('**/*', (route: { request: () => { resource_type?: string }; abort: () => unknown; continue: () => unknown }) => {
            const t = route.request().resource_type
            if (t === 'image' || t === 'media' || t === 'font') route.abort()
            else route.continue()
          })
        } catch { /* 路由拦截失败不阻塞主流程 */ }
        const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
        const html = await page.content()
        const status = res?.status() ?? 0
        const bytes = new Uint8Array(Buffer.from(html, 'utf8'))
        const a = assess(status, bytes, 'text/html; charset=utf-8')
        subAttempts.push({ profile: 'node-playwright', ok: a.ok, status, ms: Date.now() - s0, blocked: a.blocked, bytes: a.size, note: a.note })
        if (a.warning) warnings.push(a.warning)
        // 渲染结果最终 URL 校验
        const finalUrl = res?.url() ?? url
        try {
          const finalCheck = await assertHostPublic(new URL(finalUrl).hostname)
          if (!finalCheck.ok) {
            warnings.push(`SSRF 防护: 渲染终点 ${finalCheck.reason}`)
            return { ok: false, status, bytes: new Uint8Array(0), contentType: '', warnings, note: 'ssrf-blocked', subAttempts }
          }
        } catch { /* 忽略解析失败 */ }
        return { ok: a.ok, status, bytes, contentType: 'text/html; charset=utf-8', warnings, note: a.note, subAttempts }
      } catch (nodeErr) {
        subAttempts.push({ profile: 'node-playwright', ok: false, status: 0, ms: Date.now() - s0, blocked: false, bytes: 0, note: 'render-error' })
        return {
          ok: false,
          status: 0,
          bytes: new Uint8Array(0),
          contentType: '',
          warnings: [`[browser] Node Playwright 渲染失败: ${nodeErr instanceof Error ? nodeErr.message.split('\n')[0] : 'unknown'}`],
          note: 'render-error',
          subAttempts,
        }
      } finally {
        await browser?.close?.().catch(() => {})
      }
    }

    warnings.push('Node Playwright 模块不可用，尝试 Python Playwright 桥接')
    // 2) Python Playwright 桥接
    try {
      return await renderViaPython(url, timeoutMs, warnings)
    } catch (pyErr) {
      subAttempts.push({ profile: 'python-playwright', ok: false, status: 0, ms: Date.now() - s0, blocked: false, bytes: 0, note: 'bridge-error' })
      return {
        ok: false,
        status: 0,
        bytes: new Uint8Array(0),
        contentType: '',
        warnings: [...warnings, `Python Playwright 桥接失败: ${pyErr instanceof Error ? pyErr.message.split('\n')[0] : 'unknown'}`],
        note: 'render-error',
        subAttempts,
      }
    }
  },
}

// ==================== 策略编排 ====================

const STRATEGIES: StrategyDef[] = [
  fetchBrowserStrategy,
  fetchUaRotateStrategy,
  fetchMobileStrategy,
  fetchSpiderStrategy,
  curlImpersonateStrategy,
  gotScrapingStrategy,
  browserStrategy,
]

export const STRATEGY_NAMES = STRATEGIES.map((s) => s.name)

export async function listStrategies(): Promise<StrategyInfo[]> {
  return Promise.all(
    STRATEGIES.map(async (s) => ({
      name: s.name,
      description: s.description,
      available: await s.probe().catch(() => false),
    })),
  )
}

async function pickOrder(requested: string | null | undefined, warnings: string[]): Promise<StrategyDef[]> {
  if (requested) {
    const found = STRATEGIES.find((s) => s.name === requested)
    if (!found) {
      warnings.push(`指定策略 "${requested}" 不存在（可选: ${STRATEGY_NAMES.join(', ')}），回退默认顺序`)
    } else if (await found.probe().catch(() => false)) {
      return [found]
    } else {
      warnings.push(`指定策略 "${requested}" 当前不可用，回退默认顺序`)
    }
  }
  return STRATEGIES
}

export function clampTimeout(ms: unknown): number {
  const n = Number(ms)
  if (!Number.isFinite(n)) return 20_000
  return Math.min(60_000, Math.max(2_000, Math.floor(n)))
}

/**
 * 抓取主入口：SSRF 校验 → robots 检查 → 按序尝试策略链（域名限速 + 指数退避重试 + 整体时间预算）
 * → 字符集解码。永不 throw，全部失败时返回结构化错误。
 */
export async function fetchPage(url: string, opts: FetchPageOptions = {}): Promise<FetchPageResult> {
  const t0 = Date.now()
  const warnings: string[] = []
  const attempts: AttemptSummary[] = []
  const timeoutMs = clampTimeout(opts.timeoutMs)
  // 整体预算：单策略超时再多给余量，硬上限 55s（主站代理 60s 超时之内）
  const budgetMs = Math.min(CHAIN_BUDGET_MS, Math.max(timeoutMs + 8_000, Math.floor(timeoutMs * 2.5)))
  const deadline = t0 + budgetMs

  let host = ''
  try {
    const u = new URL(url)
    host = u.host
  } catch {
    return {
      ok: false, html: '', encoding: '', strategy: '', status: 0, warnings: ['URL 无法解析'],
      attempts: [], robots: { checked: false, disallowed: false, crawlDelayMs: null },
      elapsedMs: Date.now() - t0, error: 'URL 无法解析', detail: url,
    }
  }

  // 入口 SSRF 校验（文本层 + DNS 尽力）——重定向逐跳校验在各策略的 fetchWithRedirectGuard 中
  const entryCheck = await assertHostPublic(new URL(url).hostname)
  if (!entryCheck.ok) {
    return {
      ok: false, html: '', encoding: '', strategy: '', status: 0, warnings,
      attempts, robots: { checked: false, disallowed: false, crawlDelayMs: null },
      elapsedMs: Date.now() - t0, error: 'SSRF 防护拦截', detail: entryCheck.reason ?? '目标主机被拒绝',
    }
  }
  if (entryCheck.warning) warnings.push(`[ssrf] ${entryCheck.warning}`)

  const robots = await checkRobots(url)
  warnings.push(...robots.warnings)

  const order = await pickOrder(opts.requestedStrategy, warnings)
  let lastStatus = 0
  let lastNote = ''
  let sawChallenge = false

  for (const strat of order) {
    if (Date.now() > deadline - 1500) {
      attempts.push({ strategy: strat.name, ok: false, status: 0, ms: 0, note: 'budget-exhausted（整体时间预算耗尽，停止尝试后续策略）' })
      break
    }
    const available = await strat.probe().catch(() => false)
    if (!available) {
      attempts.push({ strategy: strat.name, ok: false, status: 0, ms: 0, note: 'unavailable（探测失败，跳过）' })
      continue
    }
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const remaining = deadline - Date.now()
      if (remaining < 1500) {
        attempts.push({ strategy: strat.name, ok: false, status: 0, ms: 0, note: 'budget-exhausted（整体时间预算耗尽）' })
        break
      }
      await acquireDomainSlot(host)
      const effTimeout = Math.min(timeoutMs, Math.max(1000, remaining - 500))
      const s0 = Date.now()
      let res: AttemptResult
      try {
        res = await strat.run(url, effTimeout, [])
      } catch (e) {
        res = {
          ok: false, status: 0, bytes: new Uint8Array(0), contentType: '',
          warnings: [`策略内部异常: ${e instanceof Error ? e.message : String(e)}`],
          note: 'internal-error',
        }
      }
      const ms = Date.now() - s0

      // 子尝试摊平进 attempts（每次真实网络请求一条记录），无子尝试时记录策略级条目
      if (res.subAttempts && res.subAttempts.length > 0) {
        for (const sub of res.subAttempts) {
          attempts.push({
            strategy: strat.name, profile: sub.profile, ok: sub.ok, status: sub.status,
            ms: sub.ms, note: sub.note, blocked: sub.blocked, bytes: sub.bytes,
          })
          if (sub.blocked) sawChallenge = true
        }
      } else {
        attempts.push({ strategy: strat.name, ok: res.ok, status: res.status, ms, note: res.note })
      }
      for (const w of res.warnings) if (!warnings.includes(w)) warnings.push(`[${strat.name}] ${w}`)

      if (res.ok) {
        const dec = decodeHtml(res.bytes, {
          headerCharset: charsetFromContentType(res.contentType),
          forcedCharset: opts.forcedCharset ?? null,
        })
        warnings.push(...dec.warnings.map((w) => `[charset] ${w}`))
        return {
          ok: true,
          html: dec.text,
          encoding: dec.encoding,
          strategy: strat.name,
          status: res.status,
          warnings,
          attempts,
          robots: { checked: robots.checked, disallowed: robots.disallowed, crawlDelayMs: robots.crawlDelayMs },
          elapsedMs: Date.now() - t0,
        }
      }

      lastStatus = res.status
      lastNote = res.note ?? ''
      if (lastNote === 'challenge-page') sawChallenge = true
      // selfRetrying 策略内部已有多画像/多协议重试梯子，外层不再重复重试
      if (!strat.selfRetrying && isRetryableStatus(res.status) && attempt < MAX_ATTEMPTS) {
        const delay = backoffDelay(attempt)
        warnings.push(`[${strat.name}] 第 ${attempt} 次尝试失败（${res.status === 0 ? '网络错误' : `HTTP ${res.status}`}），${delay}ms 后重试`)
        await sleep(delay)
        continue
      }
      break
    }
  }

  return {
    ok: false,
    html: '',
    encoding: '',
    strategy: opts.requestedStrategy ?? '',
    status: lastStatus,
    warnings,
    attempts,
    robots: { checked: robots.checked, disallowed: robots.disallowed, crawlDelayMs: robots.crawlDelayMs },
    elapsedMs: Date.now() - t0,
    error: '全部可用策略均抓取失败',
    detail:
      (attempts.map((a) => `${a.strategy}${a.profile ? `/${a.profile}` : ''}: ${a.note ?? (a.blocked ? 'challenge-page' : `HTTP ${a.status}`)}`).join('; ') ||
        '无可用策略（所有策略探测失败）') + (lastNote ? `，最后备注: ${lastNote}` : '') + (sawChallenge ? '；检测到疑似挑战页，目标站可能有反爬防护' : ''),
  }
}
