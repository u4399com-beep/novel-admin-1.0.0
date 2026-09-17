/**
 * browser 策略：Playwright + Chromium 真实渲染（优先 Node 包，缺失时经 Python Playwright
 * 桥接 scripts/render.py），对抗 JS 挑战/动态渲染；环境不可用时优雅跳过。
 * 渲染期每个子请求做 SSRF 校验（私网主机拦截+去重告警）、协议白名单、MAX_BYTES 上限。
 * （自 strategies.ts 巨石拆分而来，代码逐行原样迁移；仅 render.py 相对路径随目录调整）
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertHostPublic, execP } from '../rate-limit'
import { assess, MAX_BYTES } from './http'
import { CHROME_UA } from './profiles'
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

interface RenderPayload {
  status: number
  html: string
  error?: string
}

async function renderViaPython(url: string, timeoutMs: number, warnings: string[]): Promise<AttemptResult> {
  // 参数经 argv 传递（URL 不含换行；UA 含空格由 execFile 正确转义）。
  // render.py 自带 SIGALRM 看门狗（timeout+3s 强制输出 JSON），exec 超时只是兜底；
  // 余量不能给太大，否则策略链 55s 预算会被单次渲染突破（实测旧值 +15s 最坏可拖到 ~70s）
  const { stdout } = await execP(
    'python3',
    [RENDER_PY, url, String(timeoutMs), CHROME_UA],
    { timeout: timeoutMs + 4000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PYTHONUNBUFFERED: '1' } },
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

export const browserStrategy: StrategyDef = {
  name: 'browser',
  description:
    'Playwright + Chromium 真实渲染（Node 包缺失时自动经 Python Playwright 桥接），对抗 JS 挑战/动态渲染；环境不可用时优雅跳过',
  probe: probeBrowser,
  selfRetrying: true,
  async run(url, timeoutMs, warnings) {
    warnings.push('browser 策略为完整浏览器渲染，成本最高（约 1-5s），仅建议前序策略失败时使用')
    const subAttempts: SubAttempt[] = []
    const s0 = Date.now()
    // 渲染期被拦截的私网主机去重（每个 host 只告警一次）
    const warnedHosts = new Set<string>()

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
        const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
        // content() 也受默认超时约束，最坏可再等一个 timeoutMs 导致策略链预算超支；加 race 硬上限
        let contentTimer: ReturnType<typeof setTimeout> | undefined
        let html: string
        try {
          html = await Promise.race([
            page.content() as Promise<string>,
            new Promise<string>((_, rej) => {
              contentTimer = setTimeout(() => rej(new Error('page content 超时')), Math.min(5000, Math.max(1000, timeoutMs)))
            }),
          ])
        } finally {
          clearTimeout(contentTimer)
        }
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
