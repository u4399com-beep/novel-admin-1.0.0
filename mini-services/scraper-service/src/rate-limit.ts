/**
 * 网络纪律模块：域名级限速 + robots.txt 检查（提示不阻断）+ 重试退避工具 + SSRF 防护。
 *
 * 合规边界（硬编码红线）：
 * - 默认每域名请求间隔 >= 1200ms（±抖动），即 < 1 req/s，任何配置不得低于 1000ms；
 * - robots.txt 仅提示不强制阻断，但必须在响应 warnings 中明确告知调用方；
 * - 不提供任何验证码破解、账号伪装、登录态伪造能力。
 *
 * SSRF 防护覆盖（文本层 + DNS 尽力校验）：
 * - IPv4 全部文本形态：点分十进制、短格式(127.1)、八进制(0177.0.0.1)、十六进制(0x7f000001)、纯十进制整数(2130706433)；
 * - IPv6：::1 / ::（未指定）、fc00::/7（ULA）、fe80::/10（链路本地）、::ffff:0:0/96（IPv4-mapped，递归检查内嵌 v4）、64:ff9b::/96（NAT64 内嵌 v4）；
 * - 主机名：node:dns 尽力解析（fail-open：解析失败放行，后续 fetch 自然失败）；
 * - 重定向：策略层使用 redirect:'manual' 逐跳校验（见 strategies.ts fetchWithRedirectGuard）。
 * 已知局限：DNS 解析与实际连接之间存在 TOCTOU 窗口（DNS rebinding 的完整防护需自定义 socket 层，超出本服务范围）。
 */
import { execFile } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { promisify } from 'node:util'

const execP = promisify(execFile)

// ==================== 限速 ====================

export const DEFAULT_MIN_INTERVAL_MS = 1200
export const JITTER_MS = 300

export function getMinIntervalMs(): number {
  const raw = Number(process.env.SCRAPER_MIN_INTERVAL_MS)
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_MIN_INTERVAL_MS
  // 合规下限：不允许配置成高于 1 req/s 的频率
  return Math.max(1000, Math.floor(raw))
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface HostSlot {
  nextAt: number
  lastUsedAt: number
  tail: Promise<void>
}

const hostSlots = new Map<string, HostSlot>()
const HOST_SLOT_GC_THRESHOLD = 64
const HOST_SLOT_IDLE_MS = 10 * 60 * 1000

/** 淘汰长期空闲的域名槽位，避免 Map 无限增长 */
function gcHostSlots(): void {
  if (hostSlots.size < HOST_SLOT_GC_THRESHOLD) return
  const now = Date.now()
  for (const [key, slot] of hostSlots) {
    if (now - slot.lastUsedAt > HOST_SLOT_IDLE_MS) hostSlots.delete(key)
  }
}

/**
 * 获取指定域名的请求槽位。同域名的并发请求会串行排队，并保证相邻两次
 * 请求之间至少间隔 getMinIntervalMs() ± 抖动。不同域名互不影响。
 */
export async function acquireDomainSlot(host: string): Promise<void> {
  let slot = hostSlots.get(host)
  if (!slot) {
    slot = { nextAt: 0, lastUsedAt: Date.now(), tail: Promise.resolve() }
    hostSlots.set(host, slot)
  }
  slot.lastUsedAt = Date.now()
  gcHostSlots()
  const run = slot.tail.then(async () => {
    const now = Date.now()
    const base = Math.max(now, slot!.nextAt)
    const wait = base - now
    slot!.nextAt = base + getMinIntervalMs() + Math.round(Math.random() * JITTER_MS)
    slot!.lastUsedAt = Date.now()
    if (wait > 0) await sleep(wait)
  })
  slot.tail = run.catch(() => {}) // 隔离失败，避免队列毒化
  await run
}

// ==================== 重试 ====================

export const MAX_ATTEMPTS = 3

export function isRetryableStatus(status: number): boolean {
  // 仅对网络错误(status=0)、429、5xx 重试；4xx 属于确定性失败不重试
  return status === 0 || status === 429 || status >= 500
}

export function backoffDelay(attempt: number): number {
  const base = 500 * 2 ** (attempt - 1)
  return base + Math.round(Math.random() * 250)
}

// ==================== robots.txt ====================

export interface RobotsInfo {
  checked: boolean
  disallowed: boolean
  crawlDelayMs: number | null
  warnings: string[]
}

const ROBOTS_TTL_MS = 10 * 60 * 1000
const robotsCache = new Map<string, { at: number; info: RobotsInfo }>()

interface RobotsGroup {
  agents: string[]
  disallow: string[]
  allow: string[]
  crawlDelayMs: number | null
}

function parseRobots(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = []
  let current: RobotsGroup | null = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line) continue
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const key = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()
    if (key === 'user-agent') {
      if (!current || current.disallow.length > 0 || current.allow.length > 0 || current.crawlDelayMs !== null) {
        current = { agents: [], disallow: [], allow: [], crawlDelayMs: null }
        groups.push(current)
      }
      current.agents.push(value.toLowerCase())
    } else if (current) {
      if (key === 'disallow') current.disallow.push(value)
      else if (key === 'allow') current.allow.push(value)
      else if (key === 'crawl-delay') {
        const sec = Number(value)
        if (Number.isFinite(sec) && sec >= 0) current.crawlDelayMs = sec * 1000
      }
    }
  }
  return groups
}

function pickGroup(groups: RobotsGroup[], agents: string[]): RobotsGroup | null {
  for (const agent of agents) {
    for (const g of groups) if (g.agents.includes(agent)) return g
  }
  for (const g of groups) if (g.agents.includes('*')) return g
  return null
}

/** 最长匹配规则优先（robots 协议惯例），Allow 优先于等长 Disallow */
function isPathDisallowed(group: RobotsGroup, pathname: string): boolean {
  let bestLen = -1
  let disallowed = false
  const check = (rules: string[], isDisallow: boolean) => {
    for (const rule of rules) {
      if (rule === '') continue // 空 Disallow = 全部允许
      if (pathname.startsWith(rule) && rule.length > bestLen) {
        bestLen = rule.length
        disallowed = isDisallow
      }
    }
  }
  check(group.allow, false)
  check(group.disallow, true)
  return disallowed
}

/**
 * 检查目标 URL 是否被 robots.txt 限制。
 * 永不 throw、永不阻断 —— 失败时降级为 warning。
 */
export async function checkRobots(targetUrl: string, agents: string[] = ['novel-admin-scraper', '*']): Promise<RobotsInfo> {
  let origin: string
  let pathname: string
  try {
    const u = new URL(targetUrl)
    origin = u.origin
    pathname = u.pathname || '/'
  } catch {
    return { checked: false, disallowed: false, crawlDelayMs: null, warnings: ['robots 检查：URL 无法解析，跳过'] }
  }

  const cached = robotsCache.get(origin)
  if (cached && Date.now() - cached.at < ROBOTS_TTL_MS) {
    const info = cached.info
    const warnings: string[] = []
    if (info.disallowed) warnings.push(`robots.txt 禁止抓取该路径 (${pathname})。本服务仅提示不阻断，请自行确认采集授权与合规性`)
    if (info.crawlDelayMs && info.crawlDelayMs > getMinIntervalMs()) {
      warnings.push(`robots.txt Crawl-delay=${Math.round(info.crawlDelayMs / 1000)}s 高于当前限速 ${getMinIntervalMs()}ms，建议降低采集频率`)
    }
    return { ...info, warnings }
  }

  const warnings: string[] = []
  let info: RobotsInfo
  try {
    await acquireDomainSlot(origin.replace(/^https?:\/\//, ''))
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { 'user-agent': 'novel-admin-scraper/1.0 (+robots-check)', accept: 'text/plain,*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) {
      info = { checked: false, disallowed: false, crawlDelayMs: null, warnings: [] }
      if (res.status !== 404) warnings.push(`robots.txt 获取失败（HTTP ${res.status}），未做 robots 校验，请自行确认目标站允许抓取`)
    } else {
      const text = await res.text()
      const groups = parseRobots(text)
      const group = pickGroup(groups, agents)
      const disallowed = group ? isPathDisallowed(group, pathname) : false
      const crawlDelayMs = group?.crawlDelayMs ?? null
      info = { checked: true, disallowed, crawlDelayMs, warnings: [] }
      if (disallowed) warnings.push(`robots.txt 禁止抓取该路径 (${pathname})。本服务仅提示不阻断，请自行确认采集授权与合规性`)
      if (crawlDelayMs && crawlDelayMs > getMinIntervalMs()) {
        warnings.push(`robots.txt Crawl-delay=${Math.round(crawlDelayMs / 1000)}s 高于当前限速 ${getMinIntervalMs()}ms，建议降低采集频率`)
      }
    }
  } catch (e) {
    info = { checked: false, disallowed: false, crawlDelayMs: null, warnings: [] }
    warnings.push(`robots.txt 获取异常（${e instanceof Error ? e.message : 'unknown'}），未做 robots 校验，请自行确认目标站允许抓取`)
  }

  robotsCache.set(origin, { at: Date.now(), info })
  return { ...info, warnings }
}

// ==================== SSRF 防护 ====================

const ALLOW_PRIVATE = process.env.SCRAPER_ALLOW_PRIVATE === '1'

export function privateHostAllowed(): boolean {
  return ALLOW_PRIVATE
}

/**
 * 解析 IPv4 文本的各种形态，返回 32 位无符号整数；无法识别返回 null。
 * 支持：
 *   1.2.3.4           标准点分十进制
 *   127.1             短格式（等价 127.0.0.1）
 *   0177.0.0.1        各段八进制（0 前缀）
 *   0x7f.0x0.0.1      各段十六进制
 *   2130706433        纯十进制整数（整体解释为 32 位地址）
 *   0x7f000001        纯十六进制整数
 *   017700000001      纯八进制整数
 */
export function parseIpv4Text(host: string): number | null {
  const h = host.trim().toLowerCase()
  if (!h) return null

  // 纯整数形态（十进制 / 0x 十六进制 / 0 八进制）
  if (/^\d+$/.test(h) || /^0x[0-9a-f]+$/.test(h) || /^0[0-7]+$/.test(h)) {
    const n = h.startsWith('0x') ? Number.parseInt(h.slice(2), 16) : /^0[0-7]+$/.test(h) && h.length > 1 ? Number.parseInt(h.slice(1), 8) : Number.parseInt(h, 10)
    if (!Number.isFinite(n) || n < 0 || n > 0xffffffff) return null
    return n >>> 0
  }

  const parts = h.split('.')
  if (parts.length < 1 || parts.length > 4) return null
  const nums: number[] = []
  for (const p of parts) {
    if (!p) return null
    let n: number
    if (/^0x[0-9a-f]+$/.test(p)) n = Number.parseInt(p.slice(2), 16)
    else if (/^0[0-7]*$/.test(p) && p.length > 1) n = Number.parseInt(p.slice(1), 8)
    else if (/^\d+$/.test(p)) n = Number.parseInt(p, 10)
    else return null
    if (!Number.isFinite(n) || n < 0 || n > 255) return null
    nums.push(n)
  }
  // 短格式：最后一段代表剩余字节（如 127.1 → 127.0.0.1；10.1.2 → 10.1.0.2）
  if (nums.length < 4) {
    const last = nums.pop()!
    const missing = 4 - nums.length - 1
    // 短格式语义要求最后一段能装下 missing+1 个字节
    if (missing > 0 && last >= 256 ** (missing + 1)) return null
    for (let i = missing; i >= 1; i--) nums.push(Math.floor(last / 256 ** i) % 256)
    nums.push(last % 256)
  }
  return ((nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3]) >>> 0
}

function ipv4IsPrivate(n: number): boolean {
  // 0.0.0.0/8 "本网络"、10/8、127/8、169.254/16、172.16/12、192.168/16、100.64/10（CGNAT）、198.18/15（基准测试保留）
  if ((n >>> 24) === 0 || (n >>> 24) === 10 || (n >>> 24) === 127) return true
  if ((n >>> 16) === 0xa9fe) return true // 169.254.x.x
  if ((n >>> 16) === 0xc0a8) return true // 192.168.x.x
  if ((n >>> 16) >= 0xac10 && (n >>> 16) <= 0xac1f) return true // 172.16.0.0/12
  if ((n >>> 24) === 100) {
    const second = (n >>> 16) & 0xff
    if (second >= 64 && second <= 127) return true
  }
  if ((n >>> 16) === 0xc612 || (n >>> 16) === 0xc613) return true // 198.18.0.0/15
  return false
}

/**
 * 把 IPv6 文本展开为 8 组 16 位十六进制数组；无法解析返回 null。
 * 支持 ::1、::、完整形式、::ffff:1.2.3.4 内嵌 IPv4。
 */
export function parseIpv6Text(host: string): number[] | null {
  let h = host.trim().toLowerCase()
  if (!h.includes(':')) return null
  // 内嵌 IPv4 尾部（::ffff:192.168.1.1）→ 转成两组十六进制
  const tailIpv4 = h.lastIndexOf(':')
  const tailStr = h.slice(tailIpv4 + 1)
  if (tailStr.includes('.')) {
    const n = parseIpv4Text(tailStr)
    if (n === null) return null
    h = h.slice(0, tailIpv4 + 1) + ((n >>> 16).toString(16)) + ':' + (n & 0xffff).toString(16)
  }
  if (!/^[0-9a-f:]+$/.test(h)) return null
  const halves = h.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':').filter(Boolean) : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':').filter(Boolean) : []
  if (left.some((g) => g.length > 4 || Number.isNaN(Number.parseInt(g, 16)))) return null
  if (right.some((g) => g.length > 4 || Number.isNaN(Number.parseInt(g, 16)))) return null
  const fill = 8 - left.length - right.length
  if (fill < 0) return null
  const groups = [...left, ...Array(Math.max(0, fill)).fill('0'), ...right]
  if (groups.length !== 8) return null
  return groups.map((g) => Number.parseInt(g || '0', 16))
}

function ipv6IsPrivate(groups: number[]): boolean {
  const allZero = groups.every((g) => g === 0)
  if (allZero) return true // ::（未指定地址）
  // ::1
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true
  // fc00::/7（ULA：fc/fd 开头）
  if ((groups[0] & 0xfe00) === 0xfc00) return true
  // fe80::/10（链路本地）
  if ((groups[0] & 0xffc0) === 0xfe80) return true
  // ::ffff:0:0/96 IPv4-mapped → 递归检查内嵌 IPv4
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const v4 = ((groups[6] << 16) | groups[7]) >>> 0
    return ipv4IsPrivate(v4)
  }
  // 64:ff9b::/96 NAT64（内嵌 IPv4 可能指向内网，同样检查）
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
    const v4 = ((groups[6] << 16) | groups[7]) >>> 0
    return ipv4IsPrivate(v4)
  }
  return false
}

/**
 * 文本层内网地址检查（覆盖 IPv4 全部文本形态 + IPv6 主流内网形态）。
 * 不做 DNS 解析 —— 主机名的 DNS 校验请用 assertHostPublic()。
 */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().trim().replace(/^\[|\]$/g, '').replace(/\.+$/, '')
  if (!h) return true
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  if (h.includes(':')) {
    const groups = parseIpv6Text(h)
    return groups ? ipv6IsPrivate(groups) : false // 无法解析的 IPv6 交由 DNS/fetch 层处理
  }
  const v4 = parseIpv4Text(h)
  if (v4 !== null) return ipv4IsPrivate(v4)
  return false
}

// ==================== DNS 尽力校验 ====================

const DNS_CACHE_TTL_MS = 5 * 60 * 1000
const dnsCache = new Map<string, { at: number; privateHit: boolean; warning?: string }>()

export interface HostCheckResult {
  ok: boolean
  reason?: string
  warning?: string
}

/**
 * 主机名/IPC 位置的 SSRF 校验入口：
 * - IP 字面量 → 纯文本检查；
 * - 主机名 → node:dns 解析后逐一检查（含 IPv6 结果）；解析失败 fail-open（放行，由 fetch 层暴露错误）。
 * SCRAPER_ALLOW_PRIVATE=1 时全部放行（本地调试用）。
 */
export async function assertHostPublic(hostname: string): Promise<HostCheckResult> {
  if (ALLOW_PRIVATE) return { ok: true }
  const h = hostname.toLowerCase().trim().replace(/^\[|\]$/g, '')
  if (!h) return { ok: false, reason: '空主机名' }

  // IP 字面量（含 IPv6）：文本检查即可，无需 DNS
  const v4 = parseIpv4Text(h)
  if (v4 !== null) {
    return ipv4IsPrivate(v4) ? { ok: false, reason: `内网 IPv4 地址被拒绝: ${h}` } : { ok: true }
  }
  if (h.includes(':')) {
    const groups = parseIpv6Text(h)
    if (groups) return ipv6IsPrivate(groups) ? { ok: false, reason: `内网 IPv6 地址被拒绝: ${h}` } : { ok: true }
  }

  // 主机名：DNS 尽力解析
  const cached = dnsCache.get(h)
  if (cached && Date.now() - cached.at < DNS_CACHE_TTL_MS) {
    return cached.privateHit ? { ok: false, reason: `域名 ${h} 解析到内网地址（DNS 层 SSRF 防护）` } : { ok: true, warning: cached.warning }
  }
  try {
    const addrs = await lookup(h, { all: true, verbatim: true })
    let privateHit = false
    let hitLabel = ''
    for (const a of addrs) {
      if (a.family === 4) {
        const n = parseIpv4Text(a.address)
        if (n !== null && ipv4IsPrivate(n)) {
          privateHit = true
          hitLabel = a.address
          break
        }
      } else {
        const groups = parseIpv6Text(a.address)
        if (groups && ipv6IsPrivate(groups)) {
          privateHit = true
          hitLabel = a.address
          break
        }
      }
    }
    const entry = { at: Date.now(), privateHit, warning: undefined as string | undefined }
    if (privateHit) {
      dnsCache.set(h, entry)
      return { ok: false, reason: `域名 ${h} 解析到内网地址 ${hitLabel}（DNS 层 SSRF 防护）` }
    }
    if (addrs.length === 0) entry.warning = `域名 ${h} DNS 解析结果为空`
    dnsCache.set(h, entry)
    return { ok: true, warning: entry.warning }
  } catch (e) {
    // fail-open：DNS 查询失败时放行，后续 fetch 会自然暴露连接错误
    const warning = `DNS 校验失败（${e instanceof Error ? e.message : 'unknown'}），已放行由请求层兜底`
    dnsCache.set(h, { at: Date.now(), privateHit: false, warning })
    return { ok: true, warning }
  }
}

export { execP }
