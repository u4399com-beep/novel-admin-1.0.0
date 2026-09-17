/**
 * curl-impersonate 策略：系统 curl_chrome* / curl-impersonate-* 二进制（TLS/JA3 指纹级伪装），
 * HTTP/2 失败自动降级 --http1.1；二进制缺失时 probe 失败优雅跳过。
 * （自 strategies.ts 巨石拆分而来，代码逐行原样迁移）
 */
import { access, constants as fsConstants, readFile, readdir, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireDomainSlot, assertHostPublic, execP } from '../rate-limit'
import { assess, hostOf, MAX_BYTES, MAX_REDIRECT_HOPS } from './http'
import { chromeDesktopProfile } from './profiles'
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

export const curlImpersonateStrategy: StrategyDef = {
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
      await acquireDomainSlot(hostOf(url))
      // 限速等待后再计算剩余预算（与 makeFetchStrategy 同理，避免超时穿透 deadline）
      const remaining = deadline - Date.now()
      if (remaining < 1000) {
        subAttempts.push({ profile: variant.profile, ok: false, status: 0, ms: 0, blocked: false, bytes: 0, note: 'timeout-budget' })
        break
      }
      const s0 = Date.now()
      const tmpOut = join(tmpdir(), `scraper-${Date.now()}-${Math.random().toString(36).slice(2)}.body`)
      const args: string[] = [
        '--silent', '--show-error', '--location', '--max-redirs', String(MAX_REDIRECT_HOPS),
        '--max-time', String(Math.max(1, Math.ceil(remaining / 1000))),
        '--max-filesize', String(MAX_BYTES), // 恶意超大响应在 curl 层直接中止（exit 63），不等下载完
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
        const raw = await readFile(tmpOut)
        if (raw.byteLength > MAX_BYTES) {
          subAttempts.push({ profile: variant.profile, ok: false, status, ms: Date.now() - s0, blocked: false, bytes: raw.byteLength, note: 'too-large' })
          warnings.push(`curl-impersonate 响应超过 ${MAX_BYTES}B 上限，已放弃`)
          break
        }
        const bytes = new Uint8Array(raw)
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
        // exit code 63 = curl --max-filesize 超限：单独标记，避免被误报为二进制级失败
        subAttempts.push({ profile: variant.profile, ok: false, status: 0, ms: Date.now() - s0, blocked: false, bytes: 0, note: err?.code === 63 ? 'too-large' : 'exec-error' })
        warnings.push(`curl-impersonate 执行失败: ${err?.message ?? 'unknown'}${err?.stderr ? ` / ${err.stderr.trim().slice(0, 200)}` : ''}`)
        break // 二进制级失败，HTTP/1.1 降级无意义
      } finally {
        unlink(tmpOut).catch(() => {})
      }
    }
    return { ok: false, status: 0, bytes: new Uint8Array(0), contentType: '', warnings, note: 'all-variants-failed', subAttempts }
  },
}
