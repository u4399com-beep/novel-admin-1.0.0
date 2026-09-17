/**
 * curl-impersonate 策略：系统 curl_chrome* / curl-impersonate-* 二进制（TLS/JA3 指纹级伪装），
 * HTTP/2 失败自动降级 --http1.1；二进制缺失时 probe 失败优雅跳过。
 *
 * Task 23-a SSRF 加固：不再使用 --location 由 curl 内部跟随重定向（旧行为仅事后校验
 * url_effective 终点，中间跳会被诱导对内网发起 GET——重定向响应体与 Location 均已发生）。
 * 现改为手动逐跳：curl 不带 --location（默认不跟随），每跳解析 -D 抓包头中的 Status/Location，
 * 每一跳都做协议白名单 + SSRF 校验（含首跳），同时逐跳回放/捕获引擎 cookie 会话。
 * （自 strategies.ts 拆分而来；23-a 重写重定向处理）
 */
import { access, constants as fsConstants, readFile, readdir, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireDomainSlot, assertHostPublic, execP } from '../rate-limit'
import { assess, hostOf, MAX_BYTES, MAX_REDIRECT_HOPS } from './http'
import { chromeDesktopProfile } from './profiles'
import { cookieHeaderFor, recordSetCookieLines } from './cookies'
import type { StrategyDef, SubAttempt } from './types'

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

/** 从 -D 抓包文本提取响应头（HTTP/2 头为小写，大小写不敏感匹配；同名多头全量返回） */
function headerLines(hdrText: string, name: string): string[] {
  const re = new RegExp(`^${name}:\\s*(.*)$`, 'i')
  const out: string[] = []
  for (const line of hdrText.split(/\r?\n/)) {
    const m = re.exec(line)
    if (m) out.push(m[1].trim())
  }
  return out
}

export const curlImpersonateStrategy: StrategyDef = {
  name: 'curl-impersonate',
  description:
    '调用系统 curl_chrome*/curl-impersonate-* 二进制（TLS/JA3 指纹级浏览器伪装），HTTP/2 失败自动降级 --http1.1；需另行安装二进制，检测不到则不可用',
  probe: () => detectCurlImpersonate().then((p) => p !== null),
  selfRetrying: true,
  async run(url, timeoutMs, warnings, ctx) {
    const bin = await detectCurlImpersonate()
    if (!bin) {
      return { ok: false, status: 0, bytes: new Uint8Array(0), contentType: '', warnings: ['未找到 curl-impersonate 二进制'], note: 'missing-binary' }
    }
    const explicitReferer = ctx?.referer ?? null
    const subAttempts: SubAttempt[] = []
    const deadline = Date.now() + timeoutMs

    // 子尝试梯子：默认（HTTP/2）→ --http1.1（覆盖协议指纹差异）
    const variants: Array<{ profile: string; extraArgs: string[] }> = [
      { profile: 'h2-default', extraArgs: [] },
      { profile: 'http1.1', extraArgs: ['--http1.1'] },
    ]

    for (const variant of variants) {
      let current = url
      let hops = 0
      let stopVariants = false
      for (;;) {
        let target: URL
        try {
          target = new URL(current)
        } catch {
          subAttempts.push({ profile: variant.profile, ok: false, status: 0, ms: 0, blocked: false, bytes: 0, note: 'bad-url' })
          stopVariants = true
          break
        }
        if (target.protocol !== 'http:' && target.protocol !== 'https:') {
          subAttempts.push({ profile: variant.profile, ok: false, status: 0, ms: 0, blocked: false, bytes: 0, note: 'ssrf-blocked' })
          warnings.push(`SSRF 防护: 重定向到非 http/https 协议已拒绝: ${target.protocol}`)
          stopVariants = true
          break
        }
        // 逐跳 SSRF 校验（含首跳，DNS 结果走进程内缓存）
        const check = await assertHostPublic(target.hostname)
        if (!check.ok) {
          subAttempts.push({ profile: variant.profile, ok: false, status: 0, ms: 0, blocked: false, bytes: 0, note: 'ssrf-blocked' })
          warnings.push(`SSRF 防护: 重定向终点 ${check.reason}`)
          stopVariants = true
          break
        }
        if (check.warning) warnings.push(`[ssrf] ${check.warning}`)

        await acquireDomainSlot(hostOf(current))
        // 限速等待后再计算剩余预算（与 makeFetchStrategy 同理，避免超时穿透 deadline）
        const remaining = deadline - Date.now()
        if (remaining < 1000) {
          subAttempts.push({ profile: variant.profile, ok: false, status: 0, ms: 0, blocked: false, bytes: 0, note: 'timeout-budget' })
          stopVariants = true
          break
        }
        const s0 = Date.now()
        const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`
        const tmpOut = join(tmpdir(), `scraper-${tag}.body`)
        const tmpHdr = join(tmpdir(), `scraper-${tag}.hdr`)
        // 不带 --location：curl 默认不跟随重定向，3xx 原样返回（Status/Location 从 -D 抓包头解析），
        // 由本策略逐跳校验后再发下一跳
        const args: string[] = [
          '--silent', '--show-error',
          '--max-time', String(Math.max(1, Math.ceil(remaining / 1000))),
          '--max-filesize', String(MAX_BYTES), // 恶意超大响应在 curl 层直接中止（exit 63），不等下载完
          '--compressed',
          '--output', tmpOut,
          '--dump-header', tmpHdr,
          '--write-out', '%{http_code}\t%{content_type}',
        ]
        for (const [k, v] of Object.entries(chromeDesktopProfile.headers(url, true, explicitReferer))) args.push('--header', `${k}: ${v}`)
        // Cookie 会话回放（逐跳按目标 host）
        const https = target.protocol === 'https:'
        const cookie = cookieHeaderFor(target.host, https)
        if (cookie) args.push('--cookie', cookie)
        args.push(...variant.extraArgs, '--', current) // -- 防止 URL 被解析为选项
        try {
          const { stdout } = await execP(bin, args, { timeout: remaining + 3000, maxBuffer: 1024 * 1024 })
          const [code, ctype] = stdout.trim().split('\t')
          const status = Number.parseInt(code, 10) || 0
          const hdrText = await readFile(tmpHdr, 'utf8').catch(() => '')
          // Set-Cookie 捕获（每一跳都入会话——3xx 种子跳也在内）
          const scLines = headerLines(hdrText, 'Set-Cookie')
          if (scLines.length) recordSetCookieLines(target.host, scLines, https)

          if ([301, 302, 303, 307, 308].includes(status)) {
            const loc = headerLines(hdrText, 'Location')[0]
            if (!loc) {
              subAttempts.push({ profile: variant.profile, ok: false, status, ms: Date.now() - s0, blocked: false, bytes: 0, note: 'redirect-no-location' })
              break
            }
            let next: URL
            try {
              next = new URL(loc, current)
            } catch {
              subAttempts.push({ profile: variant.profile, ok: false, status, ms: Date.now() - s0, blocked: false, bytes: 0, note: 'redirect-bad-location' })
              warnings.push(`curl-impersonate 非法 Location 头: ${loc.slice(0, 200)}`)
              break
            }
            if (next.protocol !== 'http:' && next.protocol !== 'https:') {
              subAttempts.push({ profile: variant.profile, ok: false, status, ms: Date.now() - s0, blocked: false, bytes: 0, note: 'ssrf-blocked' })
              warnings.push(`SSRF 防护: 重定向到非 http/https 协议已拒绝: ${next.protocol}`)
              stopVariants = true
              break
            }
            hops++
            if (hops > MAX_REDIRECT_HOPS) {
              subAttempts.push({ profile: variant.profile, ok: false, status, ms: Date.now() - s0, blocked: false, bytes: 0, note: 'too-many-redirects' })
              warnings.push(`curl-impersonate 重定向超过 ${MAX_REDIRECT_HOPS} 跳，已停止`)
              stopVariants = true
              break
            }
            current = next.toString()
            continue
          }

          const raw = await readFile(tmpOut)
          if (raw.byteLength > MAX_BYTES) {
            subAttempts.push({ profile: variant.profile, ok: false, status, ms: Date.now() - s0, blocked: false, bytes: raw.byteLength, note: 'too-large' })
            warnings.push(`curl-impersonate 响应超过 ${MAX_BYTES}B 上限，已放弃`)
            stopVariants = true
            break
          }
          const bytes = new Uint8Array(raw)
          const a = assess(status, bytes, ctype ?? '')
          subAttempts.push({ profile: variant.profile, ok: a.ok, status, ms: Date.now() - s0, blocked: a.blocked, bytes: a.size, note: a.note })

          if (a.warning) warnings.push(`[${variant.profile}] ${a.warning}`)
          if (status >= 400) warnings.push(`curl-impersonate 收到 HTTP ${status}`)

          if (a.ok) {
            return { ok: true, status, bytes, contentType: ctype ?? '', warnings, subAttempts }
          }
          break // 非重定向且非 2xx：换 HTTP/1.1 画像重试（由外层 variants 循环继续）
        } catch (e) {
          const err = e as (Error & { stderr?: string; code?: number | string }) | null
          // exit code 63 = curl --max-filesize 超限：单独标记，避免被误报为二进制级失败
          subAttempts.push({ profile: variant.profile, ok: false, status: 0, ms: Date.now() - s0, blocked: false, bytes: 0, note: err?.code === 63 ? 'too-large' : 'exec-error' })
          warnings.push(`curl-impersonate 执行失败: ${err?.message ?? 'unknown'}${err?.stderr ? ` / ${err.stderr.trim().slice(0, 200)}` : ''}`)
          stopVariants = true // 二进制级失败，HTTP/1.1 降级无意义
          break
        } finally {
          unlink(tmpOut).catch(() => {})
          unlink(tmpHdr).catch(() => {})
        }
      }
      if (stopVariants) break
    }
    return { ok: false, status: 0, bytes: new Uint8Array(0), contentType: '', warnings, note: 'all-variants-failed', subAttempts }
  },
}
