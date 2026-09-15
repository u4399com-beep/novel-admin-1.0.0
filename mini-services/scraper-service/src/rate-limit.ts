/**
 * 网络纪律模块：域名级限速 + robots.txt 检查（提示不阻断）+ 重试退避工具 + SSRF 防护。
 *
 * 合规边界（硬编码红线）：
 * - 默认每域名请求间隔 >= 1200ms（±抖动），即 < 1 req/s，任何配置不得低于 1000ms；
 * - robots.txt 仅提示不强制阻断，但必须在响应 warnings 中明确告知调用方；
 * - 不提供任何验证码破解、账号伪装、登录态伪造能力。
 */
import { execFile } from 'node:child_process'
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
  tail: Promise<void>
}

const hostSlots = new Map<string, HostSlot>()

/**
 * 获取指定域名的请求槽位。同域名的并发请求会串行排队，并保证相邻两次
 * 请求之间至少间隔 getMinIntervalMs() ± 抖动。不同域名互不影响。
 */
export async function acquireDomainSlot(host: string): Promise<void> {
  let slot = hostSlots.get(host)
  if (!slot) {
    slot = { nextAt: 0, tail: Promise.resolve() }
    hostSlots.set(host, slot)
  }
  const run = slot.tail.then(async () => {
    const now = Date.now()
    const base = Math.max(now, slot!.nextAt)
    const wait = base - now
    slot!.nextAt = base + getMinIntervalMs() + Math.round(Math.random() * JITTER_MS)
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

/** 文本级内网地址检查（不做 DNS 解析，DNS rebinding 属已知局限，见 docs） */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === '::1' || h === '0.0.0.0') return true
  if (/^127(\.\d+){1,3}$/.test(h)) return true
  if (/^10(\.\d+){3}$/.test(h)) return true
  if (/^192\.168(\.\d+){2}$/.test(h)) return true
  if (/^172\.(1[6-9]|2\d|3[01])(\.\d+){2}$/.test(h)) return true
  if (/^169\.254(\.\d+){2}$/.test(h)) return true
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])(\.\d+){2}$/.test(h)) return true
  if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true
  return false
}

export function privateHostAllowed(): boolean {
  return ALLOW_PRIVATE
}

export { execP }
