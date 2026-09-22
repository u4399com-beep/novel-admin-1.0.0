/**
 * 通用并发池（cursor 抢占式派发，12-g 从 worker.ts / suggest.ts 两套实现收敛而来）。
 *
 * - concurrency 路 worker 持续从共享 cursor 取件直至耗尽（先到先得，慢单元不阻塞快单元）；
 * - 并发度自动夹取到 [1, items.length]（items 为空时不派发任何 worker）；
 * - 返回结果数组：results[i] = 第 i 个元素的处理结果（fn 返回 void 时调用方忽略返回值）；
 * - 错误语义：单个 worker 内 fn 抛错不会让在途/未派发单元立刻变孤儿——等全部 worker
 *   结束后才把首个错误抛给调用方（与旧 worker 版 Promise.all「立即 reject、其余分支
 *   变僵尸继续跑」相比，错误传播时机更晚但绝不再留下未收尾的并行分支）。
 *   不希望错误中断批处理时，请在 fn 内部自行 try/catch（worker 与 suggest 均如此使用）。
 */

export async function runPool<T, R = void>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length) as R[]
  let cursor = 0
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    async () => {
      for (;;) {
        const i = cursor++
        if (i >= items.length) return
        results[i] = await fn(items[i], i)
      }
    },
  )
  const settled = await Promise.allSettled(workers)
  const firstError = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected')
  if (firstError) throw firstError.reason
  return results
}
