/**
 * 按主机策略亲和缓存（Task 20-a 新增能力，策略链唯一的行为新增）。
 *
 * 语义：
 * - 某主机某策略最近一次成功后，后续对该主机的请求把该策略提到策略链首优先尝试；
 * - 亲和命中失败不影响既有行为：后续策略照旧全链回退，attempts 顺序照实记录；
 * - 进程内 Map<host, strategyName>，容量上限 256 条，超出淘汰最旧（Map 迭代按插入序）；
 * - 显式指定策略（requestedStrategy）时尊重用户意图，不做亲和提位。
 */

const MAX_AFFINITY_ENTRIES = 256

const affinityByHost = new Map<string, string>()

/** 查询某主机最近一次成功的策略名（无记录返回 null） */
export function getPreferredStrategy(host: string): string | null {
  return affinityByHost.get(host) ?? null
}

/** 记录某主机某策略成功（重新插入以刷新淘汰顺序：最旧条目 = 最先插入且未刷新者） */
export function recordStrategySuccess(host: string, strategy: string): void {
  if (!host || !strategy) return
  affinityByHost.delete(host)
  affinityByHost.set(host, strategy)
  if (affinityByHost.size > MAX_AFFINITY_ENTRIES) {
    const oldest = affinityByHost.keys().next().value
    if (oldest !== undefined) affinityByHost.delete(oldest)
  }
}

/** 亲和缓存概况（供 GET /api/strategies 的 affinity 说明字段使用） */
export function affinityStats(): { maxEntries: number; trackedHosts: number } {
  return { maxEntries: MAX_AFFINITY_ENTRIES, trackedHosts: affinityByHost.size }
}
