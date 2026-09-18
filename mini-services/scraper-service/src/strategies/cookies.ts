/**
 * 按主机 Cookie 会话持久化（Task 23-a 反反爬增强）。
 *
 * 语义：
 * - 捕获各策略响应的 Set-Cookie，按 host 存入进程内 jar；该主机后续请求自动回放；
 *   覆盖「首访种 cookie（如安全检查/频控种子）、二访才放行」的站点；
 * - 仅进程内存，不落盘；仅回放本 host 自己收到的 cookie（不实现 Domain 跨子域传播，收窄误发面）；
 * - 容量上界：host 数 ≤ MAX_HOSTS（LRU：读写均刷新淘汰序），单 host cookie 数 ≤ MAX_COOKIES_PER_HOST（先到先淘汰）；
 * - 过期：Max-Age/Expires 照 RFC 6265 解析（过期即删），无过期属性的会话 cookie 按默认 TTL 存活；
 * - Secure 属性 cookie 只在 https 请求上回放；
 * - 并发安全：Bun 单线程事件循环，Map 读写天然原子（跨 await 不持有中间态）。
 *
 * 合规边界：本模块只回放目标站自己下发的公开访问 cookie（等价于浏览器正常会话行为），
 * 不注入任何登录态/凭证，不伪造身份。
 */

const MAX_HOSTS = 128
const MAX_COOKIES_PER_HOST = 50
/** 无过期属性的会话 cookie 在进程内的存活时间 */
const SESSION_TTL_MS = 30 * 60 * 1000
/** 显式 Max-Age/Expires 的上界（防止站点设置 10 年期 cookie 长期占据内存） */
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface StoredCookie {
  value: string
  expiresAt: number
  /** Secure 属性：仅 https 回放 */
  secureOnly: boolean
}

/** host（含端口，如 example.com:8080）→ (cookie name → cookie) */
const jar = new Map<string, Map<string, StoredCookie>>()

/** 取/建 host 桶并刷新 LRU 淘汰序（Map 迭代按插入序，重新插入 = 最新） */
function touchHost(host: string): Map<string, StoredCookie> {
  let bucket = jar.get(host)
  if (bucket) {
    jar.delete(host)
  } else {
    bucket = new Map()
  }
  jar.set(host, bucket)
  while (jar.size > MAX_HOSTS) {
    const oldest = jar.keys().next()
    if (oldest.done) break
    jar.delete(oldest.value)
  }
  return bucket
}

function capBucket(bucket: Map<string, StoredCookie>): void {
  while (bucket.size > MAX_COOKIES_PER_HOST) {
    const oldest = bucket.keys().next()
    if (oldest.done) break
    bucket.delete(oldest.value)
  }
}

/** cookie-name 必须是合法 token（RFC 6265 cookie-name），防解析产物污染回放头 */
const COOKIE_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9a-zA-Z]+$/

interface ParsedCookie {
  name: string
  value: string
  expiresAt: number
  secureOnly: boolean
  /** true = 该 Set-Cookie 要求删除/已过期，应从 jar 移除 */
  remove: boolean
}

function parseSetCookieLine(line: string, now: number): ParsedCookie | null {
  const semi = line.indexOf(';')
  const pair = (semi === -1 ? line : line.slice(0, semi)).trim()
  const eq = pair.indexOf('=')
  if (eq <= 0) return null // RFC 6265 5.2：无 '=' 的整条忽略
  const name = pair.slice(0, eq).trim()
  const value = pair.slice(eq + 1).trim()
  if (!COOKIE_NAME_RE.test(name) || name.length > 128 || value.length > 2048) return null
  if (/[\r\n\0]/.test(value)) return null

  let expiresAt = now + SESSION_TTL_MS
  let secureOnly = false
  let remove = false
  for (const attr of semi === -1 ? [] : line.slice(semi + 1).split(';')) {
    const aeq = attr.indexOf('=')
    const key = (aeq === -1 ? attr : attr.slice(0, aeq)).trim().toLowerCase()
    const val = aeq === -1 ? '' : attr.slice(aeq + 1).trim()
    if (key === 'max-age') {
      const sec = Number(val)
      if (!Number.isFinite(sec)) continue
      if (sec <= 0) {
        remove = true
      } else {
        expiresAt = Math.min(expiresAt, now + Math.min(sec * 1000, MAX_TTL_MS))
      }
    } else if (key === 'expires') {
      const t = Date.parse(val)
      if (Number.isFinite(t)) {
        if (t <= now) remove = true
        else expiresAt = Math.min(expiresAt, Math.min(t, now + MAX_TTL_MS))
      }
    } else if (key === 'secure') {
      secureOnly = true
    }
  }
  return { name, value, expiresAt, secureOnly, remove }
}

/**
 * 记录一批 Set-Cookie 行（来自 fetch getSetCookie()/got headers/curl 抓包文本）。
 * 返回实际入库条数（删除指令不计）。
 */
export function recordSetCookieLines(host: string, lines: readonly string[], https: boolean): number {
  if (!host || !lines.length) return 0
  const bucket = touchHost(host)
  const now = Date.now()
  let stored = 0
  for (const line of lines) {
    if (!line) continue
    const parsed = parseSetCookieLine(line, now)
    if (!parsed) continue
    bucket.delete(parsed.name)
    if (!parsed.remove) {
      bucket.set(parsed.name, { value: parsed.value, expiresAt: parsed.expiresAt, secureOnly: parsed.secureOnly })
      stored++
    }
  }
  capBucket(bucket)
  void https // https 参数仅供调用方语义清晰；Secure 判定在回放侧进行
  return stored
}

/** Headers.getSetCookie() 缺失时的兜底拆分：仅在「逗号后紧跟 token=」处切分（避开 Expires=Wed, 21 Oct… 中的逗号） */
function splitSetCookieFallback(raw: string): string[] {
  return raw.split(/,(?=\s*[^;,=\s]+=)/).map((s) => s.trim()).filter(Boolean)
}

/** 从 fetch 的 Response 捕获 Set-Cookie（manual 重定向每一跳都会经过这里） */
export function recordResponseCookies(host: string, res: Response, https: boolean): void {
  if (!host) return
  const h = res.headers as Headers & { getSetCookie?: () => string[] }
  let lines: string[]
  if (typeof h.getSetCookie === 'function') {
    lines = h.getSetCookie() ?? []
  } else {
    const raw = res.headers.get('set-cookie')
    lines = raw ? splitSetCookieFallback(raw) : []
  }
  if (lines.length) recordSetCookieLines(host, lines, https)
}

/** 从 got-scraping 的 headers 对象捕获 Set-Cookie（成功/3xx/错误响应三条路径共用） */
export function recordHeaderCookies(
  host: string,
  headers: Record<string, string | string[] | undefined> | undefined,
  https: boolean,
): void {
  if (!host || !headers) return
  const v = headers['set-cookie']
  if (!v) return
  const lines = Array.isArray(v) ? v : [v]
  if (lines.length) recordSetCookieLines(host, lines, https)
}

/**
 * 为某 host 构造回放用的 Cookie 头值（如 "a=1; b=2"）；无可回放 cookie 返回 null。
 * 过期条目顺手清除；Secure cookie 仅在 https 请求上回放。
 */
export function cookieHeaderFor(host: string, https: boolean): string | null {
  const bucket = jar.get(host)
  if (!bucket || bucket.size === 0) return null
  const now = Date.now()
  const parts: string[] = []
  for (const [name, c] of bucket) {
    if (c.expiresAt <= now) {
      bucket.delete(name)
      continue
    }
    if (c.secureOnly && !https) continue
    parts.push(`${name}=${c.value}`)
  }
  if (!parts.length) return null
  // 读取也刷新 LRU 淘汰序（正在使用的 host 优先保留）
  jar.delete(host)
  jar.set(host, bucket)
  return parts.join('; ')
}

/** Playwright 注入格式（{name,value,url} 简写，domain/path/secure 由 url 推导）；无 cookie 返回空数组 */
export function cookiesForPlaywright(
  host: string,
  https: boolean,
): Array<{ name: string; value: string; url: string; expires: number }> {
  const bucket = jar.get(host)
  if (!bucket || bucket.size === 0) return []
  const now = Date.now()
  const origin = `${https ? 'https' : 'http'}://${host}`
  const out: Array<{ name: string; value: string; url: string; expires: number }> = []
  for (const [name, c] of bucket) {
    if (c.expiresAt <= now) {
      bucket.delete(name)
      continue
    }
    if (c.secureOnly && !https) continue
    out.push({ name, value: c.value, url: origin, expires: -1 })
  }
  if (out.length) {
    jar.delete(host)
    jar.set(host, bucket)
  }
  return out
}

interface PlaywrightCookie {
  name?: unknown
  value?: unknown
  expires?: unknown
  secure?: unknown
}

/** 渲染完成后把浏览器上下文的 cookie 回存引擎 jar（浏览器自收到的新 cookie 也进入会话） */
export function recordPlaywrightCookies(host: string, cookies: readonly PlaywrightCookie[]): void {
  if (!host || !Array.isArray(cookies) || cookies.length === 0) return
  const bucket = touchHost(host)
  const now = Date.now()
  for (const c of cookies) {
    if (typeof c?.name !== 'string' || typeof c?.value !== 'string') continue
    if (!COOKIE_NAME_RE.test(c.name) || c.value.length > 2048) continue
    const expires = typeof c.expires === 'number' && Number.isFinite(c.expires) && c.expires > 0 ? c.expires * 1000 : now + SESSION_TTL_MS
    if (expires <= now) {
      bucket.delete(c.name)
      continue
    }
    bucket.delete(c.name)
    bucket.set(c.name, { value: c.value, expiresAt: Math.min(expires, now + MAX_TTL_MS), secureOnly: c.secure === true })
  }
  capBucket(bucket)
}

/** 会话概况（供 GET /api/strategies 的 cookieSession 说明字段使用） */
export function cookieStats(): { trackedHosts: number; maxHosts: number; maxCookiesPerHost: number; ttlMs: number } {
  return { trackedHosts: jar.size, maxHosts: MAX_HOSTS, maxCookiesPerHost: MAX_COOKIES_PER_HOST, ttlMs: SESSION_TTL_MS }
}

/** 清空会话（仅测试用） */
export function clearCookies(): void {
  jar.clear()
}
