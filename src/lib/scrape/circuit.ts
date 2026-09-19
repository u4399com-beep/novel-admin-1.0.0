/**
 * 熔断感知等待重试（Task 36 复盘：ggd66 临时限流封禁导致 232 章被永久记失败）。
 *
 * 背景：引擎层（scraper-service host-health）对「连续整链失败」的主机熔断——冷却 60s 起指数
 * 增长上界 10min，期间 fetchPage 快速结构化失败（不发真实请求）。旧 worker 收到熔断失败后
 * 直接把章节/书籍记为失败继续派发下一单，于是站点一次临时限流封禁（往往几分钟内自愈）就
 * 会在几秒内把整本书甚至整个任务的剩余单据全部烧成失败（实测 127+105 章失败、9 本书失败）。
 *
 * 本模块在采集端（worker 侧）补上「等待冷却 → 自动重试」的弹性：
 * - 按主机共享等待门（gate）：同主机并发的多路 worker（章节并发/书籍并发/多个任务）合流到
 *   同一次冷却等待，冷却结束一起恢复重试；轮数只按「轮」计（发起者 +1，搭车者不计），
 *   不会因并发路数多而加速耗尽预算；日志由每轮发起者记一条，合流者静默跟随不刷屏；
 * - 等待分片：单次等待上界 4 分钟（< 僵尸任务回收阈值 5min；冷却剩余时长逐轮由引擎新鲜
 *   retryAfterMs 收敛，过早唤醒只触发引擎本地快速失败，零真实请求成本）；
 * - 轮数上限：自上次成功起最多 6 轮（≈24min，覆盖引擎 10min 冷却上界 + 反复封禁场景），
 *   超限且无活跃等待可搭车时放行失败（退回旧行为），并记录 exhaustedAt——5 分钟后重置计数，
 *   新任务不会永久继承历史放弃状态；
 * - 成功即复位：任一请求成功清空该主机全部熔断记忆（与引擎侧语义一致）。
 *
 * 识别方式：优先用引擎结构化字段 circuitRetryAfterMs（EngineResult 失败分支），
 * 对旧引擎/历史响应兜底解析 error 文案中的「剩余冷却 Xs」。
 *
 * 合规边界：本模块只让采集端「少发请求、等站点恢复」，等待期间不向源站发任何请求，
 * 与引擎熔断同为对目标站更客气的自保护逻辑。
 */

/** 自上次成功起，同一主机最多发起多少轮冷却等待（超限放行失败） */
export const MAX_CIRCUIT_WAITS = 6
/** 单轮等待分片上界（4min < 僵尸任务心跳阈值 5min；冷却剩余时长靠逐轮新鲜 retryAfterMs 收敛） */
export const CIRCUIT_WAIT_CHUNK_MS = 4 * 60_000
/** 单轮等待下界（避免对极短冷却的抖动） */
const MIN_WAIT_MS = 5_000
/** 等待附加余量（引擎冷却到点瞬间可能仍在半开窗口） */
const WAIT_BUFFER_MS = 2_000
/** 放行失败后多久重置连败计数（新任务不至于继承已冷却的历史计数） */
const RESET_AFTER_EXHAUSTED_MS = 5 * 60_000
/** 共享等待的内部睡眠分片（保留取消检查/进程退出的响应粒度） */
const SLEEP_SLICE_MS = 30_000

interface CircuitGate {
  /** 本轮共享等待的截止时刻（ms epoch；0=无等待） */
  waitUntil: number
  /** 共享唤醒 promise（所有等冷却的 worker 都 await 它） */
  waiter: Promise<void> | null
  /** 自上次成功以来发起的等待轮数 */
  waits: number
  /** 上次因轮数耗尽而放行的时刻（用于延时重置计数） */
  exhaustedAt: number
}

const gCircuit = globalThis as unknown as {
  __scrapeCircuitGates?: Map<string, CircuitGate>
}
const gates: Map<string, CircuitGate> = (gCircuit.__scrapeCircuitGates ??= new Map())

/** 从 URL 提取主机名作为 gate 键（解析失败返回空串 → 调用侧跳过熔断等待） */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

function touchGate(host: string): CircuitGate {
  let g = gates.get(host)
  if (!g) {
    g = { waitUntil: 0, waiter: null, waits: 0, exhaustedAt: 0 }
    gates.set(host, g)
  }
  return g
}

/** 请求成功：清空该主机全部熔断记忆（连败计数/等待状态，与引擎侧成功复位语义对齐） */
export function circuitReset(host: string): void {
  if (!host) return
  gates.delete(host)
}

/**
 * 从结构化字段/错误文案中识别「目标主机熔断中」并给出建议等待毫秒；
 * 非熔断错误返回 null（不触发等待重试）。
 * 兼容三种形态：① 引擎新字段 circuitRetryAfterMs；② error 文案「剩余冷却 Xs」；
 * ③ 仅含「熔断」无时长（按分片上界整片等待）。
 */
export function circuitWaitMs(error: string | undefined | null, retryAfterMs?: number): number | null {
  if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return retryAfterMs
  }
  const msg = String(error ?? '')
  if (!msg.includes('熔断')) return null
  const m = msg.match(/剩余冷却\s*(\d+)\s*s/)
  if (m) return Number(m[1]) * 1000
  return CIRCUIT_WAIT_CHUNK_MS
}

/** 熔断门运行概况（可观测性/调试用） */
export function circuitStats(): {
  trackedHosts: number
  maxWaits: number
  waitChunkMs: number
  hosts: { host: string; waits: number; waitUntil: number; exhaustedAt: number }[]
} {
  return {
    trackedHosts: gates.size,
    maxWaits: MAX_CIRCUIT_WAITS,
    waitChunkMs: CIRCUIT_WAIT_CHUNK_MS,
    hosts: [...gates.entries()].map(([host, g]) => ({
      host,
      waits: g.waits,
      waitUntil: g.waitUntil,
      exhaustedAt: g.exhaustedAt,
    })),
  }
}

export interface CircuitRetryOptions<T> {
  /**
   * 判定结果是否为「熔断失败」并给出建议等待毫秒；null = 非熔断（成功或普通失败），
   * 直接原样返回（普通失败不进等待门、不重试）。
   */
  detect: (result: T) => number | null
  /**
   * 结果是否视为「成功」（成功会复位该主机熔断门）。缺省按 (res as {ok}).ok !== false 判定；
   * 非 ok 形态的结果（如 {items, error}）应显式提供。
   */
  isSuccess?: (result: T) => boolean
  /** 存活检查（任务被取消/记录被删除时不该再睡等冷却），缺省始终存活 */
  isAlive?: () => Promise<boolean>
  /** 每轮等待发起时记一次日志（仅发起该轮等待的 worker 触发，合流者不打日志） */
  onWait?: (waitMs: number, cycle: number, maxCycles: number) => void
}

function defaultIsSuccess<T>(res: T): boolean {
  return (res as { ok?: boolean }).ok !== false
}

/**
 * 带熔断感知重试地执行 fn：
 * fn() → 熔断失败？→ 共享等待冷却 → 再 fn() → …直至成功 / 非熔断失败 / 轮数耗尽（放行原结果）。
 * - 成功即复位主机门；非熔断失败不碰门、不重试（保持既有失败语义）；
 * - 同主机多 worker 并发进入时合流同一次等待；轮数只在「发起」时 +1（搭车者不计），
 *   预算消耗与并发路数无关；
 * - 任何情况下不 throw：fn 自身约定不 throw（engine-client 已保证）。
 */
export async function withCircuitRetry<T>(host: string, fn: () => Promise<T>, opts: CircuitRetryOptions<T>): Promise<T> {
  let res = await fn()
  for (;;) {
    const suggested = host ? opts.detect(res) : null
    if (suggested === null || !host) {
      if (!host || (opts.isSuccess ?? defaultIsSuccess)(res)) circuitReset(host)
      return res
    }

    const g = touchGate(host)
    const now = Date.now()
    // 轮数耗尽后的延时重置：历史上确实封过很久，但新任务不该永久继承
    //（exhaustedAt=0 表示从未耗尽，不参与重置判定——epoch 差值恒大于阈值，曾致计数每轮清零、永不放行）
    if (g.exhaustedAt > 0 && g.waits >= MAX_CIRCUIT_WAITS && now - g.exhaustedAt > RESET_AFTER_EXHAUSTED_MS) {
      g.waits = 0
    }

    // 已有活跃等待轮 → 搭车（不消耗轮数预算、不打日志）
    const joinExisting = g.waiter !== null && g.waitUntil > now
    if (!joinExisting) {
      if (g.waits >= MAX_CIRCUIT_WAITS) {
        g.exhaustedAt = now
        g.waitUntil = 0
        g.waiter = null
        return res // 放行失败（退回旧行为），由调用方按普通失败记账
      }
      g.waits += 1
      g.waitUntil = now + Math.min(Math.max(suggested + WAIT_BUFFER_MS, MIN_WAIT_MS), CIRCUIT_WAIT_CHUNK_MS)
      opts.onWait?.(g.waitUntil - now, g.waits, MAX_CIRCUIT_WAITS)
      g.waiter = (async () => {
        while (Date.now() < g.waitUntil) {
          await new Promise<void>((r) => setTimeout(r, Math.min(g.waitUntil - Date.now(), SLEEP_SLICE_MS)))
        }
        g.waiter = null
        g.waitUntil = 0
      })()
    }
    await g.waiter
    if (opts.isAlive && !(await opts.isAlive())) return res

    res = await fn()
    // 循环回去重新 detect：成功 → 复位返回；仍熔断 → 搭车/发起下一轮（用新鲜剩余时长收敛）
  }
}
