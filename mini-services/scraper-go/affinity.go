/**
 * 按主机策略亲和缓存（移植自 strategies/affinity.ts，语义一致）：
 * 某主机某策略最近一次成功后，后续对该主机的请求把该策略提到策略链首优先尝试；
 * 亲和命中失败不影响既有行为：后续策略照旧全链回退，attempts 顺序照实记录；
 * 显式指定策略时尊重用户意图，不做亲和提位。
 */
package main

import "sync"

const maxAffinityEntries = 256

var (
	affinityMu    sync.Mutex
	affinityOrder []string
	affinityByHost = map[string]string{}
)

// getPreferredStrategy 查询某主机最近一次成功的策略名（无记录返回 ""）
func getPreferredStrategy(host string) string {
	affinityMu.Lock()
	defer affinityMu.Unlock()
	return affinityByHost[host]
}

// recordStrategySuccess 记录某主机某策略成功（重新插入刷新淘汰顺序：最旧条目先淘汰）
func recordStrategySuccess(host, strategy string) {
	if host == "" || strategy == "" {
		return
	}
	affinityMu.Lock()
	defer affinityMu.Unlock()
	if _, exists := affinityByHost[host]; exists {
		for i, h := range affinityOrder {
			if h == host {
				affinityOrder = append(affinityOrder[:i], affinityOrder[i+1:]...)
				break
			}
		}
	}
	affinityOrder = append(affinityOrder, host)
	affinityByHost[host] = strategy
	if len(affinityOrder) > maxAffinityEntries {
		oldest := affinityOrder[0]
		affinityOrder = affinityOrder[1:]
		delete(affinityByHost, oldest)
	}
}

func affinityStats() (trackedHosts, maxEntries int) {
	affinityMu.Lock()
	defer affinityMu.Unlock()
	return len(affinityByHost), maxAffinityEntries
}
