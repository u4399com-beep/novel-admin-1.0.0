/**
 * 按主机健康度记忆（Task 24-a 反反爬/自保护增强）。
 *
 * 语义：
 * - 429/503 限流记忆：某主机最近一次被限流后，下一次抓取链开始前先「主动退避」
 *   （站点给出 Retry-After 时优先采用，缺省按指数增长 2s→4s→…，上界 15s；
 *   任何一次成功抓取即清零）。避免以固定 1.2s 限速节奏持续刺激限流中的站点，
 *   把「每个请求都吃 429」的死循环变成「退避一拍后通过」；
 * - 连败熔断：同一主机连续 CHAIN_BREAKER_STRIKES 次整条策略链失败
 *   （每条链最多耗时 55s）时进入熔断，fetchPage 快速结构化失败而不空烧预算；
 *   冷却 60s 起按连败次数指数增长（上界 10min），冷却结束自动「半开」恢复尝试，
 *   一次成功即完全复位。防死站/强反爬站把整批任务拖成 55s×N 的长尾；
 * - 显式指定策略（requestedStrategy）时尊重用户调试意图：跳过熔断（限流退避仍生效）；
 * - 进程内 Map，容量上界 256（LRU 淘汰）；单线程事件循环下同步读写无竞态（跨 await 不持有中间态）。
 *
 * 合规边界：本模块只做「对目标站更客气」的退避与自保护（少发请求），
 * 不涉及任何绕过反爬的行为；熔断/退避只会降低请求频率。
 */

const MAX_ENTRIES = 256
/** 单次限流退避上界（Retry-After 解析侧另有 30s 封顶，这里取更保守的 15s） */
const MAX_PENALTY_MS = 15_000
/** 缺省退避基数（无 Retry-After 时）：2s 起步 */
const BASE_PENALTY_MS = 2_000
/** 连续整链失败多少次后熔断 */
export const BREAKER_STRIKES = 3
/** 熔断冷却基数（第 3 次连败时） */
const BASE_COOLDOWN_MS = 60_000
/** 熔断冷却上界 */
const MAX_COOLDOWN_MS = 10 * 60_000

interface HostHealth {
  /** 连续整链失败次数（成功清零） */
  strikes: number
  /** 熔断窗口结束时刻（0 = 未熔断） */
  openUntil: number
  /** 限流退避时长（指数增长，成功清零） */
  penaltyMs: number
  /** 限流退避窗口结束时刻 */
  penaltyUntil: number
}

const health = new Map<string, HostHealth>()

function touch(host: string): HostHealth {
  let h = health.get(host)
  if (h) {
    health.delete(host)
  } else {
    h = { strikes: 0, openUntil: 0, penaltyMs: 0, penaltyUntil: 0 }
  }
  health.set(host, h)
  while (health.size > MAX_ENTRIES) {
    const oldest = health.keys().next()
    if (oldest.done) break
    health.delete(oldest.value)
  }
  return h
}

/** 当前限流退避剩余毫秒（0 = 无需退避） */
export function hostPenaltyMs(host: string): number {
  const h = health.get(host)
  if (!h || h.penaltyUntil <= Date.now()) return 0
  return h.penaltyUntil - Date.now()
}

/** 当前熔断剩余毫秒（0 = 未熔断/已到半开时刻） */
export function hostCircuitOpenMs(host: string): number {
  const h = health.get(host)
  if (!h || h.openUntil <= Date.now()) return 0
  return h.openUntil - Date.now()
}

/** 记录一次限流（429/503）：Retry-After 优先，缺省指数增长 */
export function noteRateLimited(host: string, retryAfterMs: number | null | undefined): void {
  if (!host) return
  const h = touch(host)
  const base =
    typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? retryAfterMs
      : h.penaltyMs > 0
        ? h.penaltyMs * 2
        : BASE_PENALTY_MS
  h.penaltyMs = Math.min(base, MAX_PENALTY_MS)
  h.penaltyUntil = Date.now() + h.penaltyMs
}

/** 记录一次整链失败：达阈值后进入熔断（冷却指数增长） */
export function noteChainFailure(host: string): void {
  if (!host) return
  const h = touch(host)
  h.strikes += 1
  if (h.strikes >= BREAKER_STRIKES) {
    const cooldown = Math.min(BASE_COOLDOWN_MS * 2 ** (h.strikes - BREAKER_STRIKES), MAX_COOLDOWN_MS)
    h.openUntil = Date.now() + cooldown
  }
}

/** 记录一次成功：健康度完全复位（熔断/退避/连败全部清零） */
export function noteChainSuccess(host: string): void {
  if (!host) return
  health.delete(host)
}

/** 健康度概况（供 GET /api/strategies 的 hostHealth 说明字段使用） */
export function hostHealthStats(): {
  trackedHosts: number
  maxEntries: number
  breakerStrikes: number
  baseCooldownMs: number
  maxCooldownMs: number
  maxPenaltyMs: number
} {
  return {
    trackedHosts: health.size,
    maxEntries: MAX_ENTRIES,
    breakerStrikes: BREAKER_STRIKES,
    baseCooldownMs: BASE_COOLDOWN_MS,
    maxCooldownMs: MAX_COOLDOWN_MS,
    maxPenaltyMs: MAX_PENALTY_MS,
  }
}

/** 清空（仅测试用） */
export function clearHostHealth(): void {
  health.clear()
}
