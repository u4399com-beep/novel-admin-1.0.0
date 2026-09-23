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
	// Task 26-d（任务 41 trxsw 实证：IP 被封后 curl 全策略连接层 EOF，链级失败每秒数百次）：
	// 连续「纯网络级错误」更快熔断——连接层被拒意味着源站已拒绝本机，多试只会加重封禁；
	// 2 次整链全网络错误即熔断（普通混合失败仍 3 次）。
	netBreakerStrikes = 2
	// 网络级失败后的温和退避：首败 1.5s，每连败翻倍，上界 8s（与 429/503 penalty 共用字段，
	// fetchPage 进链前等待；成功即随健康度整体清零）
	netFailPenaltyBaseMS = 1_500
	netFailPenaltyMaxMS  = 8_000
)

type hostHealth struct {
	strikes      int
	netStreak    int // 连续「纯网络级错误」整链失败计数（连接层被拒/EOF）
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

// hostPenaltyMs 当前限流退避剩余毫秒（0 = 无需退避）。
// 字段读取必须在锁内：h.penaltyUntil 会被 noteRateLimited 在并发请求下写入，
// 锁外读是无同步的数据竞争（go race detector 实证点，int64 撕裂读在 32 位平台为真风险）。
func hostPenaltyMs(host string) int64 {
	healthMu.Lock()
	defer healthMu.Unlock()
	h, ok := healthMap[host]
	if !ok || h.penaltyUntil <= nowMs() {
		return 0
	}
	return h.penaltyUntil - nowMs()
}

// hostCircuitOpenMs 当前熔断剩余毫秒（0 = 未熔断/已到半开时刻）。字段读取必须在锁内（同上）。
func hostCircuitOpenMs(host string) int64 {
	healthMu.Lock()
	defer healthMu.Unlock()
	h, ok := healthMap[host]
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

// noteChainFailure 记录一次整链失败：达阈值后进入熔断（冷却指数增长）。
// allNetErr=本次链上所有真实网络尝试均为网络级错误（status=0，连接层被拒/超时/EOF）。
// Task 26-d 增强：
//  1. 连败温和退避：失败后给主机记一拍 penalty（网络级 1.5s 起步指数增长上界 8s；
//     其他失败 1s 起步），fetchPage 进链前会先等待——对已受刺激的站点少突击；
//  2. 纯网络级连败 2 次即熔断（netBreakerStrikes）：连接层被拒＝源站拒绝本机，
//     3 次阈值会让全链多空烧一整轮；
//  3. 冷却指数增长口径不变（60s→120s→…上界 10min），成功一次整体清零。
func noteChainFailure(host string, allNetErr bool) {
	if host == "" {
		return
	}
	healthMu.Lock()
	defer healthMu.Unlock()
	h := touchHealth(host)
	h.strikes++
	if allNetErr {
		h.netStreak++
	} else {
		h.netStreak = 0
	}
	// 失败温和退避：取「既有 penalty」与「本次建议」较大者（不打断 429/503 的指数路径）
	suggest := int64(1_000)
	if allNetErr {
		suggest = netFailPenaltyBaseMS
		for i := 1; i < h.netStreak && suggest < netFailPenaltyMaxMS; i++ {
			suggest *= 2
		}
		if suggest > netFailPenaltyMaxMS {
			suggest = netFailPenaltyMaxMS
		}
	}
	if suggest > h.penaltyMs {
		h.penaltyMs = suggest
	}
	if h.penaltyMs > maxPenaltyMS {
		h.penaltyMs = maxPenaltyMS
	}
	h.penaltyUntil = nowMs() + h.penaltyMs
	// 熔断：普通连败 3 次；连续纯网络级错误 2 次即熔断
	if h.strikes >= breakerStrikes || (allNetErr && h.netStreak >= netBreakerStrikes) {
		exp := h.strikes - breakerStrikes
		if exp < 0 {
			exp = 0
		}
		cooldown := int64(baseCooldownMS) << uint(exp)
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
