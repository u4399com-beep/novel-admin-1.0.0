/**
 * HTTP 基础设施：流式限量读体 / 统一响应评估（含挑战页标记）/ 逐跳 SSRF 守卫 fetch。
 *
 * ⚠ fetchWithRedirectGuard 是安全代码：redirect:'manual' 逐跳校验（文本层 + DNS 尽力），
 *   每一跳的协议白名单、SSRF 拒绝、降级 follow + 终点校验逻辑一行语义都不能变。
 * （自 strategies.ts 巨石拆分而来，代码逐行原样迁移）
 */
import { assertHostPublic, parseRetryAfterMs } from '../rate-limit'
import { cookieHeaderFor, recordResponseCookies } from './cookies'
import { looksLikeChallenge } from './challenge'
import type { RawResponse } from './types'

export const MAX_BYTES = 8 * 1024 * 1024
export const MAX_REDIRECT_HOPS = 5

/** 取 URL 的 host（解析失败时原样返回，供限速 key 使用） */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** 统一的响应评估：ok 判定 + 挑战页标记 + 结构化 note，各执行器共用保证一致 */
export function assess(status: number, bytes: Uint8Array, contentType: string): { ok: boolean; blocked: boolean; size: number; note?: string; warning?: string } {
  const size = bytes.byteLength
  if (looksLikeChallenge(bytes)) {
    return {
      ok: false,
      blocked: true,
      size,
      note: 'challenge-page',
      warning: `疑似挑战/拦截页（命中反爬平台特征/小页挑战关键词/0秒跳板之一，响应 ${size}B），已按失败处理`,
    }
  }
  if (status >= 400) return { ok: false, blocked: false, size, note: `http-${status}` }
  if (status === 0) return { ok: false, blocked: false, size, note: 'network-error' }
  if (size === 0) return { ok: false, blocked: false, size, note: 'empty-body' }
  return { ok: true, blocked: false, size }
}

/**
 * 流式限量读取响应体：超过 MAX_BYTES 立即中断并按 too-large 失败，同时释放底层连接。
 * Content-Length 超限的响应在读取前就放弃；无 Content-Length 的流式响应靠实际字节计数兜底，
 * 两条路径都不会把超大响应整体读进内存。
 * （自 strategies.ts 巨石拆分而来，读取逻辑逐行原样迁移）
 */
async function readBody(res: Response): Promise<{ bytes: Uint8Array; contentType: string; note?: string; warning?: string }> {
  const contentType = res.headers.get('content-type') ?? ''
  const declaredLen = Number(res.headers.get('content-length') ?? 0)
  if (declaredLen > MAX_BYTES) {
    res.body?.cancel().catch(() => {}) // 主动释放连接
    return { bytes: new Uint8Array(0), contentType, note: 'too-large', warning: `响应过大（Content-Length ${declaredLen}B > 上限 ${MAX_BYTES}B），已放弃` }
  }
  if (!res.body) return { bytes: new Uint8Array(0), contentType }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let tooLarge = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > MAX_BYTES) {
        tooLarge = true
        break
      }
      chunks.push(value)
    }
  } catch (e) {
    return { bytes: new Uint8Array(0), contentType, note: 'network-error', warning: `响应体读取中断: ${e instanceof Error ? e.message : 'unknown'}` }
  } finally {
    // 无论读满/超限/中断都释放底层连接（读完后再 cancel 是无害 no-op）
    await reader.cancel().catch(() => {})
  }
  if (tooLarge) {
    return { bytes: new Uint8Array(0), contentType, note: 'too-large', warning: `响应实际大小超过上限 ${MAX_BYTES}B，已中途放弃并断开连接` }
  }
  return { bytes: new Uint8Array(Buffer.concat(chunks)), contentType }
}

/**
 * 带逐跳 SSRF 校验的 fetch：redirect:'manual' 手动跟随重定向，每一跳都做
 * 文本层 + DNS 尽力校验；运行时把 manual 实现为 opaque（status 0）时自动降级
 * 为 follow + 最终 URL 校验。
 * 每一跳按目标 host 回放引擎 cookie 会话，并把响应的 Set-Cookie 写回 jar
 * （含 3xx 中间跳——「首访种 cookie、二访放行」的种子正是种在这些跳上）。
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

    // Cookie 会话回放：合并该 host 的 cookie（调用方自身不设置 cookie 头，直接覆盖安全）
    const https = target.protocol === 'https:'
    const hopCookie = cookieHeaderFor(target.host, https)
    const hopHeaders = hopCookie ? { ...headers, cookie: hopCookie } : headers

    let res: Response
    try {
      res = await fetch(current, { headers: hopHeaders, redirect: 'manual', signal: AbortSignal.timeout(remaining) })
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
    recordResponseCookies(target.host, res, https)

    // 运行时把 redirect:'manual' 实现为 opaque-redirect（status 0）→ 降级为 follow + 最终 URL 校验
    if (res.status === 0 && (res as Response & { type?: string }).type === 'opaqueredirect') {
      warnings.push('运行时未暴露 manual 重定向详情，降级为 follow 模式 + 最终 URL 校验')
      try {
        const followCookie = cookieHeaderFor(target.host, https)
        const follow = await fetch(current, {
          headers: followCookie ? { ...headers, cookie: followCookie } : headers,
          redirect: 'follow',
          signal: AbortSignal.timeout(Math.max(500, deadline - Date.now())),
        })
        recordResponseCookies(target.host, follow, https)
        const finalUrl = follow.url || current
        const finalCheck = await assertHostPublic(new URL(finalUrl).hostname)
        if (!finalCheck.ok) {
          follow.body?.cancel().catch(() => {})
          return { ok: false, status: 0, bytes: new Uint8Array(0), contentType: '', note: 'ssrf-blocked', warning: `SSRF 防护: 重定向终点 ${finalCheck.reason}` }
        }
        const body = await readBody(follow)
        const followRetryAfter = follow.status === 429 || follow.status === 503 ? parseRetryAfterMs(follow.headers.get('retry-after')) : null
        return { ok: follow.ok, status: follow.status, ...body, finalUrl, retryAfterMs: followRetryAfter }
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

    // Retry-After 尊重：429/503 时解析站点给出的退避指引，供策略链退避时优先采用
    const retryAfterMs = res.status === 429 || res.status === 503 ? parseRetryAfterMs(res.headers.get('retry-after')) : null
    const body = await readBody(res)
    return { ok: res.ok, status: res.status, ...body, finalUrl: current, retryAfterMs }
  }
}
