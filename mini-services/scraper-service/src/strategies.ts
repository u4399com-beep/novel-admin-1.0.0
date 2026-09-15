/**
 * 可插拔抓取策略层。
 *
 * 策略顺序（依次尝试直到成功）：
 *   a) fetch-browser   —— 原生 fetch + 完整 Chrome 浏览器请求头（UA/Accept/Accept-Language/Referer 链）
 *   b) curl-impersonate—— 系统 PATH 中的 curl_chrome123 / curl-impersonate-chrome 等二进制（TLS/JA3 指纹伪装），探测不到则不可用
 *   c) got-scraping    —— header-generator 随机真实头 + HTTP/2；依赖安装失败则不可用
 *   d) browser         —— Playwright + Chromium 真实渲染（优先 Node 包，缺失时经 Python Playwright 桥接）
 *
 * 合规边界：本层只做"请求头/指纹/渲染"层面的通用反反爬增强，
 * 不包含也不预留任何验证码破解、账号登录态伪造、付费内容绕过逻辑。
 */
import { access, constants as fsConstants, readFile, readdir, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execP, acquireDomainSlot, backoffDelay, checkRobots, isRetryableStatus, MAX_ATTEMPTS, sleep } from './rate-limit'
import { charsetFromContentType, decodeHtml } from './charset'
import type { AttemptSummary, RobotsSummary, StrategyInfo } from './types'

const MAX_BYTES = 8 * 1024 * 1024
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
}

// ==================== 公共浏览器头（fetch-browser / curl 复用） ====================

export function browserHeaders(url: string): Record<string, string> {
  const origin = new URL(url).origin
  return {
    'user-agent': CHROME_UA,
    accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'accept-language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    'upgrade-insecure-requests': '1',
    // Referer 链：以目标站自身首页为来源，模拟从站内导航进入
    referer: `${origin}/`,
    'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Linux"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-user': '?1',
  }
}

// ==================== a) fetch-browser ====================

const fetchBrowserStrategy: StrategyDef = {
  name: 'fetch-browser',
  description:
    '原生 fetch + 完整 Chrome 请求头（UA/Accept/Accept-Language/Referer 链/Sec-Fetch 族），最快最稳的默认策略',
  async probe() {
    return typeof fetch === 'function'
  },
  async run(url, timeoutMs, warnings) {
    try {
      const res = await fetch(url, {
        headers: browserHeaders(url),
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      })
      const declaredLen = Number(res.headers.get('content-length') ?? 0)
      if (declaredLen > MAX_BYTES) {
        return {
          ok: false,
          status: res.status,
          bytes: new Uint8Array(0),
          contentType: '',
          warnings: [`响应过大（Content-Length ${declaredLen}B > 上限 ${MAX_BYTES}B），已放弃`],
        }
      }
      const bytes = new Uint8Array(await res.arrayBuffer())
      const contentType = res.headers.get('content-type') ?? ''
      if (!res.ok) {
        warnings.push(`HTTP ${res.status}${res.status === 403 ? '（疑似被反爬拦截，可尝试后续策略）' : ''}`)
      }
      if (res.ok && bytes.byteLength === 0) warnings.push('HTTP 200 但响应体为空')
      return {
        ok: res.ok && bytes.byteLength > 0,
        status: res.status,
        bytes,
        contentType,
        warnings,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        ok: false,
        status: 0,
        bytes: new Uint8Array(0),
        contentType: '',
        warnings: [`网络错误: ${msg}`],
        note: msg.includes('abort') || msg.includes('Timeout') ? 'timeout' : 'network-error',
      }
    }
  },
}

// ==================== b) curl-impersonate ====================

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
    '调用系统 curl_chrome*/curl-impersonate-* 二进制（TLS/JA3 指纹级浏览器伪装）；需另行安装二进制，检测不到则不可用',
  probe: () => detectCurlImpersonate().then((p) => p !== null),
  async run(url, timeoutMs, warnings) {
    const bin = await detectCurlImpersonate()
    if (!bin) return { ok: false, status: 0, bytes: new Uint8Array(0), contentType: '', warnings: ['未找到 curl-impersonate 二进制'], note: 'missing-binary' }
    const tmpOut = join(tmpdir(), `scraper-${Date.now()}-${Math.random().toString(36).slice(2)}.body`)
    const args: string[] = [
      '--silent', '--show-error', '--location',
      '--max-time', String(Math.ceil(timeoutMs / 1000)),
      '--compressed',
      '--output', tmpOut,
      '--write-out', '%{http_code}\t%{content_type}',
    ]
    for (const [k, v] of Object.entries(browserHeaders(url))) args.push('--header', `${k}: ${v}`)
    args.push(url)
    try {
      const { stdout } = await execP(bin, args, { timeout: timeoutMs + 3000, maxBuffer: 1024 * 1024 })
      const [code, ctype] = stdout.trim().split('\t')
      const status = Number.parseInt(code, 10) || 0
      const bytes = new Uint8Array(await readFile(tmpOut))
      return {
        ok: status >= 200 && status < 300 && bytes.byteLength > 0,
        status,
        bytes,
        contentType: ctype ?? '',
        warnings: status >= 400 ? [`curl-impersonate 收到 HTTP ${status}`] : [],
      }
    } catch (e) {
      const err = e as (Error & { stderr?: string; code?: number | string }) | null
      return {
        ok: false,
        status: 0,
        bytes: new Uint8Array(0),
        contentType: '',
        warnings: [`curl-impersonate 执行失败: ${err?.message ?? 'unknown'}${err?.stderr ? ` / ${err.stderr.trim().slice(0, 200)}` : ''}`],
        note: 'exec-error',
      }
    } finally {
      unlink(tmpOut).catch(() => {})
    }
  },
}

// ==================== c) got-scraping ====================

type GotScrapingFn = (options: Record<string, unknown>) => Promise<{
  statusCode: number
  body: Uint8Array
  headers: Record<string, string | string[] | undefined>
}>

let gotFnPromise: Promise<GotScrapingFn | null> | null = null

function loadGotScraping(): Promise<GotScrapingFn | null> {
  if (!gotFnPromise) {
    gotFnPromise = (async () => {
      const mod: any = await import('got-scraping' as string)
      const fn = mod?.gotScraping ?? mod?.default?.gotScraping
      return typeof fn === 'function' ? (fn as GotScrapingFn) : null
    })().catch(() => null)
  }
  return gotFnPromise
}

const gotScrapingStrategy: StrategyDef = {
  name: 'got-scraping',
  description:
    'got-scraping（header-generator 生成真实浏览器头 + HTTP/2 指纹），对抗基于请求头/协议指纹的拦截；依赖未安装则不可用',
  probe: () => loadGotScraping().then((f) => f !== null),
  async run(url, timeoutMs, warnings) {
    const gotScraping = await loadGotScraping()
    if (!gotScraping) {
      return { ok: false, status: 0, bytes: new Uint8Array(0), contentType: '', warnings: ['got-scraping 模块不可用'], note: 'module-missing' }
    }
    try {
      const res = await gotScraping({
        url,
        method: 'GET',
        responseType: 'buffer',
        http2: true,
        followRedirect: true,
        retry: { limit: 0 }, // 重试由本服务统一编排，避免双重重试
        timeout: { request: timeoutMs },
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
      if (status >= 400) warnings.push(`got-scraping 收到 HTTP ${status}`)
      return { ok: status >= 200 && status < 300 && bytes.byteLength > 0, status, bytes, contentType, warnings }
    } catch (rawErr) {
      const e = rawErr as (Error & { response?: { statusCode: number; body?: Uint8Array; headers?: Record<string, string> }; code?: string }) | null
      if (e?.response) {
        const status = e.response.statusCode
        warnings.push(`got-scraping 收到 HTTP ${status}（got 对非 2xx 抛错，已转为结构化失败）`)
        return {
          ok: false,
          status,
          bytes: new Uint8Array(e.response.body ?? new Uint8Array(0)),
          contentType: e.response.headers?.['content-type'] ?? '',
          warnings,
          note: `http-${status}`,
        }
      }
      return {
        ok: false,
        status: 0,
        bytes: new Uint8Array(0),
        contentType: '',
        warnings: [`got-scraping 网络错误: ${e?.code ?? e?.message ?? 'unknown'}`],
        note: e?.code ?? 'network-error',
      }
    }
  },
}

// ==================== d) browser（Playwright 渲染） ====================

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
  return {
    ok: payload.status > 0 && payload.status < 400 && bytes.byteLength > 0,
    status: payload.status,
    bytes,
    contentType: 'text/html; charset=utf-8',
    warnings,
  }
}

const browserStrategy: StrategyDef = {
  name: 'browser',
  description:
    'Playwright + Chromium 真实渲染（Node 包缺失时自动经 Python Playwright 桥接），对抗 JS 挑战/动态渲染；环境不可用则不可用',
  probe: probeBrowser,
  async run(url, timeoutMs, warnings) {
    warnings.push('browser 策略为完整浏览器渲染，成本最高（约 1-5s），仅建议前序策略失败时使用')
    // 1) Node playwright：模块导入失败才降级到 Python 桥接；
    //    导入成功后的导航/渲染错误属于站点网络问题，直接返回结构化结果（避免无谓的双倍渲染耗时）
    const pw = await importNodePlaywright()
    if (pw) {
      let browser: any = null
      try {
        browser = await pw.chromium.launch({ headless: true })
        const page = await browser.newPage({ userAgent: CHROME_UA, locale: 'zh-CN' })
        page.setDefaultTimeout(timeoutMs)
        const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
        const html = await page.content()
        const status = res?.status() ?? 0
        const bytes = new Uint8Array(Buffer.from(html, 'utf8'))
        return { ok: status > 0 && status < 400 && bytes.byteLength > 0, status, bytes, contentType: 'text/html; charset=utf-8', warnings }
      } catch (nodeErr) {
        return {
          ok: false,
          status: 0,
          bytes: new Uint8Array(0),
          contentType: '',
          warnings: [`[browser] Node Playwright 渲染失败: ${nodeErr instanceof Error ? nodeErr.message.split('\n')[0] : 'unknown'}`],
          note: 'render-error',
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
      return {
        ok: false,
        status: 0,
        bytes: new Uint8Array(0),
        contentType: '',
        warnings: [...warnings, `Python Playwright 桥接失败: ${pyErr instanceof Error ? pyErr.message.split('\n')[0] : 'unknown'}`],
        note: 'render-error',
      }
    }
  },
}

// ==================== 策略编排 ====================

const STRATEGIES: StrategyDef[] = [fetchBrowserStrategy, curlImpersonateStrategy, gotScrapingStrategy, browserStrategy]

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
 * 抓取主入口：robots 检查 → 按序尝试策略（域名限速 + 5xx/网络错误指数退避重试，最多 3 次）
 * → 字符集解码。永不 throw，全部失败时返回结构化错误。
 */
export async function fetchPage(url: string, opts: FetchPageOptions = {}): Promise<FetchPageResult> {
  const t0 = Date.now()
  const warnings: string[] = []
  const attempts: AttemptSummary[] = []
  const timeoutMs = clampTimeout(opts.timeoutMs)

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

  const robots = await checkRobots(url)
  warnings.push(...robots.warnings)

  const order = await pickOrder(opts.requestedStrategy, warnings)
  let lastStatus = 0
  let lastNote = ''

  for (const strat of order) {
    const available = await strat.probe().catch(() => false)
    if (!available) {
      attempts.push({ strategy: strat.name, ok: false, status: 0, ms: 0, note: 'unavailable（探测失败，跳过）' })
      continue
    }
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await acquireDomainSlot(host)
      const s0 = Date.now()
      let res: AttemptResult
      try {
        res = await strat.run(url, timeoutMs, [])
      } catch (e) {
        res = {
          ok: false, status: 0, bytes: new Uint8Array(0), contentType: '',
          warnings: [`策略内部异常: ${e instanceof Error ? e.message : String(e)}`],
          note: 'internal-error',
        }
      }
      const ms = Date.now() - s0
      attempts.push({ strategy: strat.name, ok: res.ok, status: res.status, ms, note: res.note })
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
      if (isRetryableStatus(res.status) && attempt < MAX_ATTEMPTS) {
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
      attempts.map((a) => `${a.strategy}: ${a.note ?? `HTTP ${a.status}`}`).join('; ') ||
      '无可用策略（所有策略探测失败）' + (lastNote ? `，最后备注: ${lastNote}` : ''),
  }
}
