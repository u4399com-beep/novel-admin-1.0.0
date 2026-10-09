/**
 * P0-1（R107 章节采集提速·慢通道锁定与快速复探）——docs/perf-plan.md P0-1 落地。
 *
 * 背景：亲和机制（affinity.go）把主机最近一次成功的策略提到链首——挑战页站点被
 * browser/cloak（Tier 3 重渲染层）攻克一次后，慢策略永久占据链首且每次成功都刷新
 * 亲和记忆，毫秒级 HTTP 策略从此再无出场机会（「browser 提位窗口」永久锁定）。
 * 但很多「browser 站」的挑战是**一次性的**：首访 JS 种 cookie / IP 预热过关后，
 * 挑战 cookie 落入按 host 共享的 Cookie 会话桶（见 cookies.go），后续 curl/fetch
 * 系策略往往直接放行——网络时间 2.5s → 0.3s，单域瓶颈从网络侧回到 1.2s 合规间隔
 * 侧（实测 750 章/h 档位 → 理论 1200-1500 章/h）。
 *
 * 机制（三态自愈，双向都可逆）：
 *  - 慢锁标记：Tier 3 策略在某主机成功 → slowLockMark（刷新 markedAt）；
 *  - 周期复探：慢锁存续期间，每 slowLockProbeEvery 次链尝试（或锁龄超 TTL）把
 *    首个可用 Tier 1 HTTP 策略临时插到链首试一次——成功即由亲和自然接管
 *    （fast 策略升链首、slowLockClear）；失败则本轮照旧走慢策略出正文，
 *    仅多付一次毫秒级探测（≈每 30 章 +1.5s，4-5% 开销上限）；
 *  - 自愈清除：任何 Tier 1/2 策略成功即 slowLockClear；锁龄超 slowLockTTLMS
 *    无 Tier 3 成功续期自动作废（宿主机早已回到快通道，惰性清理）。
 *
 * 预算闸：链剩余预算 < slowLockProbeReserveMS 时不复探——复探绝不挤占本轮
 * 正章产出（复探失败后慢策略仍需足够预算完成抓取）。
 *
 * 开关：PROBE_SLOW_LOCK_OFF=1 停用（回退纯亲和行为，逐期独立开关可回退）。
 */
package main

import (
	"os"
	"sync"
)

const (
	// slowLockProbeEvery 慢锁存续期间每隔多少次链尝试插一次快通道复探。
	// 复探成本 ≈ 一次毫秒级 HTTP 尝试（与慢策略共享域槽：额外 ~1.2s 排队 + 0.3s 网络），
	// 每 30 章一次 ≈ 4-5% 吞吐开销；一旦命中收益 40-60%（网络时间 2.5s→0.3s，
	// 单域由网络瓶颈转回间隔瓶颈）。
	slowLockProbeEvery = 30
	// slowLockProbeMaxAgeMS 复探最大时间间隔：即便尝试次数未到，锁龄超 2 分钟也复探
	//（低频站点（长间隔抓封面/简介）按时间而非次数触发，防止复探永远排不上）。
	slowLockProbeMaxAgeMS = 2 * 60 * 1000
	// slowLockTTLMS 慢锁自然寿命：超过此时长无 Tier 3 成功续期即作废
	//（标记随每次 Tier 3 成功刷新，持续被慢策略服务的 host 锁恒活；回快通道后惰性清理）。
	slowLockTTLMS = 10 * 60 * 1000
	// slowLockProbeReserveMS 预算闸：链剩余预算不足此值不复探——保证复探失败后
	// 慢策略仍有 ≥8s 预算完成本轮正章抓取。
	slowLockProbeReserveMS = 8000
)

type slowLockEntry struct {
	markedAt  int64 // 最近一次 Tier 3 成功时刻（ms，每次成功刷新）
	lastProbe int64 // 上次复探时刻（ms；0=尚未复探过）
	hits      int64 // 上次复探以来的链尝试次数
}

var (
	slowLockMu   sync.Mutex
	slowLocks    = map[string]*slowLockEntry{}
	slowProbeOff = os.Getenv("PROBE_SLOW_LOCK_OFF") == "1"
)

// slowLockMark Tier 3 策略在某主机成功时调用：新建或续期慢锁并刷新计量窗口。
func slowLockMark(host string) {
	if host == "" {
		return
	}
	now := nowMs()
	slowLockMu.Lock()
	defer slowLockMu.Unlock()
	e, ok := slowLocks[host]
	if !ok {
		slowLocks[host] = &slowLockEntry{markedAt: now}
		return
	}
	e.markedAt = now
	e.hits++ // 慢策略继续成功 = 又一次慢通道尝试，计入复探窗口
}

// slowLockClear Tier 1/2 策略成功时调用：快通道已接管，慢锁立即作废。
func slowLockClear(host string) {
	if host == "" {
		return
	}
	slowLockMu.Lock()
	defer slowLockMu.Unlock()
	delete(slowLocks, host)
}

// slowLockProbeDue 慢锁是否到期需要复探（纯检查不落账——调用方预算闸通过后必须
// 再调 slowLockNoteProbe 落账，未通过则下轮链尝试继续按本判定重查）。
// 顺手做惰性过期：锁龄超 TTL 无续期 → 删除并返回 false。
func slowLockProbeDue(host string) bool {
	if slowProbeOff || host == "" {
		return false
	}
	now := nowMs()
	slowLockMu.Lock()
	defer slowLockMu.Unlock()
	e, ok := slowLocks[host]
	if !ok {
		return false
	}
	if now-e.markedAt > slowLockTTLMS {
		delete(slowLocks, host)
		return false
	}
	if e.hits >= slowLockProbeEvery {
		return true
	}
	base := e.lastProbe
	if base == 0 {
		base = e.markedAt
	}
	return now-base >= slowLockProbeMaxAgeMS
}

// slowLockNoteProbe 记账一次已执行的复探（重置次数窗口与时间戳）。
func slowLockNoteProbe(host string) {
	slowLockMu.Lock()
	defer slowLockMu.Unlock()
	e, ok := slowLocks[host]
	if !ok {
		return // 并发窗口内锁已被快策略成功清除：无需记账
	}
	e.lastProbe = nowMs()
	e.hits = 0
}

// slowLockStats 观测透出（/api/strategies.slowLock）：慢锁主机数与明细。
func slowLockStats() (tracked int, detail map[string]map[string]any) {
	slowLockMu.Lock()
	defer slowLockMu.Unlock()
	tracked = len(slowLocks)
	if tracked == 0 {
		return 0, nil
	}
	detail = make(map[string]map[string]any, tracked)
	for h, e := range slowLocks {
		detail[h] = map[string]any{
			"markedAtMs":  e.markedAt,
			"lastProbeMs": e.lastProbe,
			"hits":        e.hits,
		}
	}
	return tracked, detail
}

// strategyTierByName 策略名 → 层级（未知名返回 0）。
func strategyTierByName(name string) int {
	if name == "" {
		return 0
	}
	for i := range allStrategies {
		if allStrategies[i].name == name {
			return allStrategies[i].tier
		}
	}
	return 0
}

// firstAvailableTier1 返回首个探测可用的 Tier 1 HTTP 策略（allStrategies 中 Tier 1
// 为连续前缀，非 Tier 1 即停）。全部不可用返回 nil（复探放弃，本轮照旧全链）。
// probe() 已按链层同款 recover 兜底，绝不 panic。
func firstAvailableTier1() *strategyDef {
	for i := range allStrategies {
		s := &allStrategies[i]
		if s.tier != tierStrategyHTTP {
			break
		}
		avail := false
		func() {
			defer func() { _ = recover() }()
			avail = s.probe()
		}()
		if avail {
			return s
		}
	}
	return nil
}
