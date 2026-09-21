/**
 * 有界并发池（采集两阶段共用）：固定车道数循环取件，绝不无界 Promise.all。
 *
 * - worker 抛错由调用方约定：单件失败应在 worker 内部 catch（不中止整个池）；
 *   未捕获异常会 reject 整个 runPool，由上层按致命错误处理
 * - shouldStop 协作式停止（任务取消）：每个车道取下一件前检查，命中即提前收工
 */
export interface PoolOutcome {
  processed: number
  stoppedEarly: boolean
}

export async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
  shouldStop?: () => Promise<boolean> | boolean,
): Promise<PoolOutcome> {
  let next = 0
  let processed = 0
  let stoppedEarly = false
  const lanes = Math.max(1, Math.min(limit, items.length))
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      for (;;) {
        if (stoppedEarly) return
        if (shouldStop && (await shouldStop())) {
          stoppedEarly = true
          return
        }
        const i = next++
        if (i >= items.length) return
        await worker(items[i], i)
        processed++
      }
    }),
  )
  return { processed, stoppedEarly }
}

/**
 * 高频取消检查节流包装：limit 并发下逐件查 DB 会放大查询量，
 * 包装后至多每 intervalMs 做一次真实检查，其余命中缓存结果。
 */
export function throttledCheck(check: () => Promise<boolean>, intervalMs = 250): () => Promise<boolean> {
  let lastAt = 0
  let lastVal = false
  return async () => {
    const now = Date.now()
    if (now - lastAt < intervalMs) return lastVal
    lastAt = now
    lastVal = await check()
    return lastVal
  }
}
