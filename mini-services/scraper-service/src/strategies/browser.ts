/**
 * browser 策略：Playwright + Chromium 真实渲染（优先 Node 包，缺失时经 Python Playwright
 * 桥接 scripts/render.py），对抗 JS 挑战/动态渲染；环境不可用时优雅跳过。
 * 渲染期每个子请求做 SSRF 校验（私网主机拦截+去重告警）、协议白名单、MAX_BYTES 上限。
 * （自 strategies.ts 巨石拆分而来，代码逐行原样迁移；仅 render.py 相对路径随目录调整）
 *
 * Task 13-a 内存治理：无代理请求走进程级共享 Chromium（每请求独立 context 隔离），
 * 按请求数阈值定期关闭重建（防 Chromium 长跑内存膨胀）+ 空闲 TTL 自动关闭（释放常驻内存）；
 * 带代理的请求维持旧「单次 launch+close」路径（per-context 代理需浏览器级 proxy 启动，
 * 且代理按站点配置各异，罕见路径不引入共享缓存复杂度）。见下方会话管理器注释。
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertHostPublic, execP } from '../rate-limit'
import { assess, MAX_BYTES } from './http'
import { looksLikeChallenge } from './challenge'
import { CHROME_UA } from './profiles'
import { cookieHeaderFor, cookiesForPlaywright, recordPlaywrightCookies } from './cookies'
import type { AttemptResult, StrategyDef, SubAttempt } from './types'

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

// Python 桥接脚本路径（src/strategies/ → ../../scripts/render.py）
const RENDER_PY = fileURLToPath(new URL('../../scripts/render.py', import.meta.url))

// ==================== 共享浏览器会话管理（Task 13-a 内存治理） ====================

/**
 * 旧实现：每次 browser 策略调用都 launch+close 一个独立 Chromium —— 无泄漏，但：
 * ① 并发场景（Phase 2 章节并发回落 browser 策略时）会同时拉起 N 个实例，
 *    内存尖峰 N×(150-300MB)，正是「堆内存堆崩服务器」的高危点；
 * ② 每次冷启动 1-3s，拖慢策略链。
 * 现改为进程级共享实例 + 每请求独立 context（cookie/存储隔离）：
 * - 按请求数阈值定期关闭重建（Chromium 长跑内存缓慢膨胀的防泄漏手段）
 * - 空闲 TTL 自动关闭（无请求一段时间后释放常驻内存）
 * - 渲染级致命错误（browser 崩溃/断连）→ 丢弃共享实例，下次请求自动重建
 * - 带 proxy 的请求不走共享池（见文件头说明），维持旧路径
 * - Python 桥接路径不经过本管理器（子进程独立浏览器，天然无泄漏）
 */
const SHARED_BROWSER_MAX_USES = 20
const SHARED_BROWSER_IDLE_MS = 3 * 60_000

interface SharedBrowserState {
  browser: any
  uses: number
}

let sharedBrowser: SharedBrowserState | null = null
let sharedBrowserRecreating: Promise<any> | null = null
let sharedBrowserIdleTimer: ReturnType<typeof setTimeout> | null = null

/** 空闲 TTL 关闭（每次使用后重置计时） */
function scheduleSharedBrowserIdleClose(): void {
  if (sharedBrowserIdleTimer) clearTimeout(sharedBrowserIdleTimer)
  sharedBrowserIdleTimer = setTimeout(() => {
    sharedBrowserIdleTimer = null
    void closeSharedBrowser()
  }, SHARED_BROWSER_IDLE_MS)
}

async function closeSharedBrowser(): Promise<void> {
  if (sharedBrowserIdleTimer) {
    clearTimeout(sharedBrowserIdleTimer)
    sharedBrowserIdleTimer = null
  }
  const cur = sharedBrowser
  sharedBrowser = null
  if (cur) await cur.browser?.close?.().catch(() => {})
}

/** 获取共享浏览器（无代理路径专用）：阈值到期则后台关闭旧实例并重建 */
async function acquireSharedBrowser(pw: any): Promise<any> {
  if (sharedBrowser && sharedBrowser.uses < SHARED_BROWSER_MAX_USES) {
    sharedBrowser.uses++
    scheduleSharedBrowserIdleClose()
    return sharedBrowser.browser
  }
  if (sharedBrowser) {
    const stale = sharedBrowser
    sharedBrowser = null
    void stale.browser?.close?.().catch(() => {})
  }
  if (!sharedBrowserRecreating) {
    sharedBrowserRecreating = pw.chromium
      .launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] })
      .finally(() => {
        sharedBrowserRecreating = null
      })
  }
  const browser = await sharedBrowserRecreating
  sharedBrowser = { browser, uses: 1 }
  scheduleSharedBrowserIdleClose()
  return browser
}

/** 丢弃共享浏览器（渲染级错误后调用）；传入实例非当前共享实例时直接关闭该实例 */
async function discardSharedBrowser(browser: any): Promise<void> {
  if (sharedBrowser && sharedBrowser.browser === browser) await closeSharedBrowser()
  else await browser?.close?.().catch(() => {})
}

/** 会话概况（供 GET /api/strategies 的 browserSession 字段使用） */
export function browserSessionStats(): {
  reuseEnabled: boolean
  maxUsesPerInstance: number
  idleCloseMs: number
  uses: number
  alive: boolean
} {
  return {
    reuseEnabled: true,
    maxUsesPerInstance: SHARED_BROWSER_MAX_USES,
    idleCloseMs: SHARED_BROWSER_IDLE_MS,
    uses: sharedBrowser?.uses ?? 0,
    alive: sharedBrowser !== null,
  }
}

/** 渲染后挑战自动通过的等待上限：Cloudflare 托管挑战等在真实浏览器上通常 3-8s 内自解 */
const CHALLENGE_WAIT_MS = 10_000
/** 挑战等待轮询间隔 */
const CHALLENGE_POLL_MS = 1_500

/**
 * 渲染后挑战等待（反反爬增强）：真实浏览器导航到带托管挑战（Cloudflare "Just a moment" 等）
 * 的页面时，挑战页先返回、自解后跳到真实内容。旧实现在 domcontentloaded 后立即抓 content，
 * 会把 38KB 的挑战页当渲染结果交回 → 被挑战检测判死，browser 策略形同虚设。
 * 现在渲染结果命中挑战特征时，在剩余预算内轮询等待其自动通过，通过后取真实内容返回；
 * 等待不改变任何合规语义（仍是单次导航 + 真实渲染，不破解任何交互式验证码）。
 */
async function captureAfterChallengeResolve(
  page: { content: () => Promise<string> },
  initialHtml: string,
  budgetMs: number,
  warnings: string[],
): Promise<string> {
  if (!looksLikeChallenge(Buffer.from(initialHtml, 'utf8'))) return initialHtml
  const deadline = Date.now() + Math.min(CHALLENGE_WAIT_MS, Math.max(2000, budgetMs))
  warnings.push(
    `[browser] 渲染捕获到挑战/拦截页，等待其自动通过（最多 ${Math.max(1, Math.round((deadline - Date.now()) / 1000))}s；不适用于交互式验证码）`,
  )
  for (;;) {
    await new Promise((r) => setTimeout(r, CHALLENGE_POLL_MS))
    if (Date.now() >= deadline) return initialHtml
    try {
      const html = await Promise.race([
        page.content(),
        new Promise<string>((_, rej) => setTimeout(() => rej(new Error('content 轮询超时')), 3000)),
      ])
      if (!looksLikeChallenge(Buffer.from(html, 'utf8'))) return html
    } catch {
      // content 偶发超时（挑战跳转中 document 正在替换）→ 继续轮询
    }
  }
}

interface RenderPayload {
  status: number
  html: string
  error?: string
  /** Task 23-a：渲染会话 cookie 回传（{name,value,expires,secure} 子集），供引擎 jar 回存 */
  cookies?: Array<{ name?: unknown; value?: unknown; expires?: unknown; secure?: unknown }>
}

async function renderViaPython(url: string, timeoutMs: number, warnings: string[], explicitReferer: string | null, cookieEnv: string | null, proxy: string | null): Promise<AttemptResult> {
  // 参数经 argv 传递（URL 不含换行；UA 含空格由 execFile 正确转义）；
  // cookie/referer/proxy 走环境变量（cookie 头值可能较长，不适合 argv）。
  // render.py 自带 SIGALRM 看门狗（timeout+3s 强制输出 JSON），exec 超时只是兜底；
  // 余量不能给太大，否则策略链 55s 预算会被单次渲染突破（实测旧值 +15s 最坏可拖到 ~70s）
  const env: Record<string, string | undefined> = { ...process.env, PYTHONUNBUFFERED: '1' }
  if (cookieEnv) env.SCRAPER_COOKIES = cookieEnv
  if (explicitReferer) env.SCRAPER_REFERER = explicitReferer
  if (proxy) env.SCRAPER_PROXY = proxy
  const { stdout } = await execP(
    'python3',
    [RENDER_PY, url, String(timeoutMs), CHROME_UA],
    // next-env.d.ts 对 ProcessEnv 增强了必填 NODE_ENV；运行时经 ...process.env 必然携带，此处断言对齐
    { timeout: timeoutMs + 4000, maxBuffer: 64 * 1024 * 1024, env: env as NodeJS.ProcessEnv },
  )
  const payload = JSON.parse(stdout) as RenderPayload
  if (payload.error) {
    warnings.push(`Python Playwright 渲染失败: ${payload.error}`)
    return { ok: false, status: 0, bytes: new Uint8Array(0), contentType: '', warnings, note: 'render-error' }
  }
  // 渲染会话 cookie 回存（浏览器自己收到的新 cookie 也进入引擎 jar）
  try {
    const target = new URL(url)
    if (payload.cookies?.length) recordPlaywrightCookies(target.host, payload.cookies)
  } catch { /* url 解析失败忽略 */ }
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

export const browserStrategy: StrategyDef = {
  name: 'browser',
  description:
    'Playwright + Chromium 真实渲染（Node 包缺失时自动经 Python Playwright 桥接），对抗 JS 挑战/动态渲染；环境不可用时优雅跳过',
  probe: probeBrowser,
  selfRetrying: true,
  async run(url, timeoutMs, warnings, ctx) {
    warnings.push('browser 策略为完整浏览器渲染，成本最高（约 1-5s），仅建议前序策略失败时使用')
    const explicitReferer = ctx?.referer ?? null
    const subAttempts: SubAttempt[] = []
    const s0 = Date.now()
    // 渲染期被拦截的私网主机去重（每个 host 只告警一次）
    const warnedHosts = new Set<string>()

    // Cookie 会话：渲染前注入引擎 jar 中该主机的 cookie，渲染后把浏览器上下文 cookie 回存。
    // 命中「首访种 cookie、二访放行」的站点时，前序 fetch 策略种下的会话在这里直接生效。
    let targetUrl: URL | null = null
    try {
      targetUrl = new URL(url)
    } catch { /* fetchPage 已校验过，防御性容错 */ }
    const https = targetUrl?.protocol === 'https:'
    const injectedCookies = targetUrl ? cookiesForPlaywright(targetUrl.host, https) : []
    const cookieEnv = targetUrl ? cookieHeaderFor(targetUrl.host, https) : null

    // 1) Node playwright：模块导入失败才降级到 Python 桥接；
    //    导入成功后的导航/渲染错误属于站点网络问题，直接返回结构化结果（避免无谓的双倍渲染耗时）
    const pw = await importNodePlaywright()
    if (pw) {
      let browser: any = null
      let context: any = null
      let shared = false // 是否使用共享实例（决定收尾方式）
      try {
        if (ctx?.proxy) {
          // 带代理路径：per-context 代理需浏览器级 proxy 启动，且代理按站点各异 → 单次 launch+close
          browser = await pw.chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
            // 站点级出口代理（规则配置）：http/socks5 均由 Chromium 处理；代理失效走导航失败自然降级
            proxy: { server: ctx.proxy },
          })
        } else {
          // 无代理（绝大多数请求）：共享实例复用，按请求数阈值/空闲 TTL/致命错误三种方式重建
          browser = await acquireSharedBrowser(pw)
          shared = true
        }
        // 显式 context：支持 addCookies 注入引擎 cookie 会话（newPage 直开是隐式 context，无法注入）；
        // ignoreHTTPSErrors：自签/裸 IP 站点（规则 insecureTLS）跳过证书错误（context 级，不影响共享实例）
        context = await browser.newContext({ userAgent: CHROME_UA, locale: 'zh-CN', viewport: { width: 1366, height: 900 }, ...(ctx?.insecureTLS ? { ignoreHTTPSErrors: true } : {}) })
        if (injectedCookies.length) {
          try {
            await context.addCookies(injectedCookies)
          } catch (cookieErr) {
            warnings.push(`[browser] cookie 会话注入失败（不阻塞渲染）: ${cookieErr instanceof Error ? cookieErr.message : 'unknown'}`)
          }
        }
        const page = await context.newPage()
        page.setDefaultTimeout(timeoutMs)
        try {
          // 屏蔽重资源 + 渲染期 SSRF 守卫（与 render.py 同语义）。
          // Chromium 内部跟随重定向/页面 JS 发起的子请求、XHR、WebSocket 均经过此拦截器：
          // 非 http(s) 协议与私网/内网地址一律 abort（旧实现只拦截重资源，渲染路径是整条链路里
          // 唯一没有逐请求 SSRF 校验的通道）。
          // Node Playwright 的 Request 用 resourceType() 方法，Python 桥接对象才是 resource_type 属性，
          // 两者兼容判断（旧代码只读属性导致 Node 路径拦截永不生效）
          await page.route('**/*', async (route: { request: () => any; abort: () => unknown; continue: () => unknown }) => {
            try {
              const req = route.request()
              const t = typeof req.resourceType === 'function' ? req.resourceType() : req.resource_type
              if (t === 'image' || t === 'media' || t === 'font') {
                void route.abort()
                return
              }
              let target: URL
              try {
                target = new URL(req.url())
              } catch {
                void route.abort()
                return
              }
              // 网络可达协议白名单：阻断 file/ftp/ws/wss 等可达本机或内网的协议；
              // blob:/data:/about: 属于页面内部资源，放行
              if (!['http:', 'https:', 'blob:', 'data:', 'about:'].includes(target.protocol)) {
                void route.abort()
                return
              }
              if (target.protocol === 'http:' || target.protocol === 'https:') {
                const check = await assertHostPublic(target.hostname)
                if (!check.ok) {
                  if (!warnedHosts.has(target.host)) {
                    warnedHosts.add(target.host)
                    warnings.push(`[browser] SSRF 防护: 已拦截渲染期对 ${target.host} 的请求（${check.reason}）`)
                  }
                  void route.abort()
                  return
                }
              }
              void route.continue()
            } catch {
              try {
                void route.abort()
              } catch { /* ignore */ }
            }
          })
        } catch { /* 路由拦截失败不阻塞主流程 */ }
        const res = await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: timeoutMs,
          ...(explicitReferer ? { referer: explicitReferer } : {}),
        })
        // content() 也受默认超时约束，最坏可再等一个 timeoutMs 导致策略链预算超支；加 race 硬上限。
        // race 超时后 content() 仍在后台执行：先挂上 catch 防未处理 rejection（错误处理：未捕获 promise）
        let contentTimer: ReturnType<typeof setTimeout> | undefined
        let html: string
        const contentPromise = page.content() as Promise<string>
        contentPromise.catch(() => {})
        try {
          html = await Promise.race([
            contentPromise,
            new Promise<string>((_, rej) => {
              contentTimer = setTimeout(() => rej(new Error('page content 超时')), Math.min(5000, Math.max(1000, timeoutMs)))
            }),
          ])
        } finally {
          clearTimeout(contentTimer)
        }
        // 挑战自动通过等待（Task 3-a 反反爬增强）：渲染结果命中挑战特征（Cloudflare 托管挑战等）
        // 时轮询等待其自解，取真实内容；等待消耗本策略剩余预算（不超过 challenge-wait 上限）
        html = await captureAfterChallengeResolve(page, html, timeoutMs - (Date.now() - s0), warnings)
        const status = res?.status() ?? 0
        const bytes = new Uint8Array(Buffer.from(html, 'utf8'))
        if (bytes.byteLength > MAX_BYTES) {
          // 渲染结果超过全链路统一上限：按 too-large 失败（旧实现无上限检查）
          subAttempts.push({ profile: 'node-playwright', ok: false, status, ms: Date.now() - s0, blocked: false, bytes: bytes.byteLength, note: 'too-large' })
          warnings.push(`[browser] 渲染结果超过 ${MAX_BYTES}B 上限，已放弃`)
          return { ok: false, status, bytes: new Uint8Array(0), contentType: '', warnings, note: 'too-large', subAttempts }
        }
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
        // 浏览器上下文 cookie 回存引擎 jar（含站点渲染期间新种下的 cookie）
        try {
          const stored = (await context.cookies()) as Array<{ name?: unknown; value?: unknown; expires?: unknown; secure?: unknown }>
          if (targetUrl && Array.isArray(stored) && stored.length) recordPlaywrightCookies(targetUrl.host, stored)
        } catch { /* 回存失败不影响抓取结果 */ }
        return { ok: a.ok, status, bytes, contentType: 'text/html; charset=utf-8', warnings, note: a.note, subAttempts }
      } catch (nodeErr) {
        // 共享实例在渲染中发生致命错误（崩溃/断连）→ 丢弃待下次请求重建，避免坏实例持续 infect 后续请求
        if (shared && browser) void discardSharedBrowser(browser)
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
        // 每请求只关 context（释放页面/路由处理器/存储隔离面）；共享实例由阈值/空闲/错误策略负责回收
        await context?.close?.().catch(() => {})
        if (!shared) await browser?.close?.().catch(() => {})
      }
    }

    warnings.push('Node Playwright 模块不可用，尝试 Python Playwright 桥接')
    // 2) Python Playwright 桥接（cookie/referer 经环境变量透传）
    try {
      return await renderViaPython(url, timeoutMs, warnings, explicitReferer, cookieEnv, ctx?.proxy ?? null)
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
