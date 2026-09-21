/**
 * 按主机健康度记忆（移植自 strategies/host-health.ts，语义一致）。
 *
 * - 429/503 限流记忆：某主机最近一次被限流后，下一次抓取链开始前先「主动退避」
 *   （站点给出 Retry-After 时优先采用，缺省按指数增长 2s→4s→…，上界 15s；任何一次成功即清零）；
 * - 连败熔断：同一主机连续 3 次整条策略链失败时进入熔断，fetchPage 快速结构化失败不空烧预算；
 *   冷却 60s 起按连败次数指数增长（上界 10min），冷却结束自动「半开」恢复尝试，一次成功即完全复位；
 * - 显式指定策略时尊重用户调试意图：跳过熔断（限流退避仍生效）；
 * - 合规边界：只做「对目标站更客气」的退避与自保护（少发请求），熔断/退避只会降低请求频率。
 */
package main

import "sync"

const (
	hostHealthMaxEntries = 256
	maxPenaltyMS         = 15_000
	basePenaltyMS        = 2_000
	breakerStrikes       = 3
	baseCooldownMS       = 60_000
	maxCooldownMS        = 10 * 60_000
)

type hostHealth struct {
	strikes      int
	openUntil    int64
	penaltyMs    int64
	penaltyUntil int64
}

var (
	healthMu    sync.Mutex
	healthOrder []string
	healthMap   = map[string]*hostHealth{}
)

func touchHealth(host string) *hostHealth {
	h, ok := healthMap[host]
	if ok {
		for i, n := range healthOrder {
			if n == host {
				healthOrder = append(healthOrder[:i], healthOrder[i+1:]...)
				break
			}
		}
	} else {
		h = &hostHealth{}
	}
	healthOrder = append(healthOrder, host)
	healthMap[host] = h
	for len(healthOrder) > hostHealthMaxEntries {
		oldest := healthOrder[0]
		healthOrder = healthOrder[1:]
		delete(healthMap, oldest)
	}
	return h
}

// hostPenaltyMs 当前限流退避剩余毫秒（0 = 无需退避）
func hostPenaltyMs(host string) int64 {
	healthMu.Lock()
	h, ok := healthMap[host]
	healthMu.Unlock()
	if !ok || h.penaltyUntil <= nowMs() {
		return 0
	}
	return h.penaltyUntil - nowMs()
}

// hostCircuitOpenMs 当前熔断剩余毫秒（0 = 未熔断/已到半开时刻）
func hostCircuitOpenMs(host string) int64 {
	healthMu.Lock()
	h, ok := healthMap[host]
	healthMu.Unlock()
	if !ok || h.openUntil <= nowMs() {
		return 0
	}
	return h.openUntil - nowMs()
}

// noteRateLimited 记录一次限流（429/503）：Retry-After 优先，缺省指数增长
func noteRateLimited(host string, retryAfterMs *int64) {
	if host == "" {
		return
	}
	healthMu.Lock()
	defer healthMu.Unlock()
	h := touchHealth(host)
	var base int64
	if retryAfterMs != nil && *retryAfterMs > 0 {
		base = *retryAfterMs
	} else if h.penaltyMs > 0 {
		base = h.penaltyMs * 2
	} else {
		base = basePenaltyMS
	}
	if base > maxPenaltyMS {
		base = maxPenaltyMS
	}
	h.penaltyMs = base
	h.penaltyUntil = nowMs() + h.penaltyMs
}

// noteChainFailure 记录一次整链失败：达阈值后进入熔断（冷却指数增长）
func noteChainFailure(host string) {
	if host == "" {
		return
	}
	healthMu.Lock()
	defer healthMu.Unlock()
	h := touchHealth(host)
	h.strikes++
	if h.strikes >= breakerStrikes {
		cooldown := int64(baseCooldownMS) << uint(h.strikes-breakerStrikes)
		if cooldown > maxCooldownMS || cooldown <= 0 {
			cooldown = maxCooldownMS
		}
		h.openUntil = nowMs() + cooldown
	}
}

// noteChainSuccess 记录一次成功：健康度完全复位
func noteChainSuccess(host string) {
	if host == "" {
		return
	}
	healthMu.Lock()
	defer healthMu.Unlock()
	if _, ok := healthMap[host]; ok {
		for i, n := range healthOrder {
			if n == host {
				healthOrder = append(healthOrder[:i], healthOrder[i+1:]...)
				break
			}
		}
		delete(healthMap, host)
	}
}

type hostHealthStatsOut struct {
	TrackedHosts   int `json:"trackedHosts"`
	MaxEntries     int `json:"maxEntries"`
	BreakerStrikes int `json:"breakerStrikes"`
	BaseCooldownMs int `json:"baseCooldownMs"`
	MaxCooldownMs  int `json:"maxCooldownMs"`
	MaxPenaltyMs   int `json:"maxPenaltyMs"`
}

func getHostHealthStats() hostHealthStatsOut {
	healthMu.Lock()
	defer healthMu.Unlock()
	return hostHealthStatsOut{
		TrackedHosts:   len(healthMap),
		MaxEntries:     hostHealthMaxEntries,
		BreakerStrikes: breakerStrikes,
		BaseCooldownMs: baseCooldownMS,
		MaxCooldownMs:  maxCooldownMS,
		MaxPenaltyMs:   maxPenaltyMS,
	}
}
