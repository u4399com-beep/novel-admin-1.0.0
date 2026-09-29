/**
 * scraper-go —— E20 引擎可观测性统计（61-R5 新增能力）。
 *
 * 动机：「稳定长期获取」需要运营面数据支撑——哪些站点长期健康、哪些策略命中率高、
 * 哪些站点挑战/断网频发，此前只能翻日志。本模块以零锁开销（atomic + sync.Map 桶）
 * 记录整链成功/失败/挑战/断网四类事件，按 主机 与 策略 两个维度分桶，经
 * GET /api/stats 透出（自启动起累计，重启归零——长期曲线由外部巡检/抓取落库承担）。
 *
 * 并发安全：桶经 LoadOrStore 获取（同桶内字段全 atomic）；map 访问仅 LoadOrStore
 * 与快照两处，快照读加 RWMutex 防遍历时并发写入。统计路径永不 panic（nil 桶防抖）。
 *
 * 边界：仅统计 fetchPage 整链结果（每请求一行），策略子尝试不重复计数；纯引擎自状态
 * 失败（budget-exhausted/unavailable/shed）不计入站点失败（与 hosthealth 连败口径一致，
 * 但仍计入 totalFail 供吞吐观察——isEngineSelfState 判定与 hosthealth 同源）。
 */
package main

import (
	"sort"
	"sync"
	"sync/atomic"
)

// chainStatBucket 单桶四类计数 + 最近一次观测值
type chainStatBucket struct {
	ok         atomic.Int64
	fail       atomic.Int64
	challenge  atomic.Int64 // 整链失败且 sawChallenge（挑战页形态）
	netErr     atomic.Int64 // 整链失败且全部真实尝试 status=0（连接层被拒/超时）
	lastStatus atomic.Int64
	lastMs     atomic.Int64
}

var (
	statsMu        sync.RWMutex
	statsHosts     = map[string]*chainStatBucket{}
	statsStrats    = map[string]*chainStatBucket{}
	statsBootMs    = nowMs()
	statsTotalOK   atomic.Int64
	statsTotalFail atomic.Int64
)

// statsHostBucket 取主机桶（缺失则建）
func statsHostBucket(host string) *chainStatBucket {
	statsMu.Lock()
	defer statsMu.Unlock()
	b, exist := statsHosts[host]
	if !exist {
		b = &chainStatBucket{}
		statsHosts[host] = b
	}
	return b
}

// statsStratBucket 取策略桶（缺失则建）
func statsStratBucket(strategy string) *chainStatBucket {
	statsMu.Lock()
	defer statsMu.Unlock()
	b, exist := statsStrats[strategy]
	if !exist {
		b = &chainStatBucket{}
		statsStrats[strategy] = b
	}
	return b
}

// statsRecordChainOK 整链成功（strategy=命中策略名，ms=整链耗时）
func statsRecordChainOK(host, strategy string, ms int64) {
	statsTotalOK.Add(1)
	hb := statsHostBucket(host)
	hb.ok.Add(1)
	hb.lastMs.Store(ms)
	sb := statsStratBucket(strategy)
	sb.ok.Add(1)
	sb.lastMs.Store(ms)
}

// statsRecordChainFail 整链失败。challenge/netErr 与 hosthealth 口径对齐：
// challenge=检测到挑战页；netErr=全部尝试均为连接层失败；realAttempt 由调用方以
// hasRealNetworkAttempt(attempts) 传入（与 hosthealth 连败闸同源同函数）。61-R9 修复：
// 旧版闸 hasRealNetworkTraffic(challenge, allNet, status) 在「真实 status=0 网络失败尝试
// + 后续 budget-exhausted/unavailable 引擎自状态尝试」的混合链下漏判——该链 hosthealth
// 记连败而主机桶不记 fail（口径漂移）。realAttempt=true ⟹ 旧闸恒 true，修复只增不删。
// 纯引擎自状态（零真实网络请求或纯 budget/unavailable）不进主机/策略桶的 fail
// （防引擎自拥堵污染站点画像），仅计入 totalFail。
func statsRecordChainFail(host string, ms int64, challenge, allNet bool, status int64, realAttempt bool) {
	statsTotalFail.Add(1)
	if !realAttempt {
		return
	}
	hb := statsHostBucket(host)
	hb.fail.Add(1)
	hb.lastStatus.Store(status)
	hb.lastMs.Store(ms)
	if challenge {
		hb.challenge.Add(1)
	}
	if allNet {
		hb.netErr.Add(1)
	}
}

// statBucketOut 快照行
type statBucketOut struct {
	OK         int64 `json:"ok"`
	Fail       int64 `json:"fail"`
	Challenge  int64 `json:"challenge"`
	NetErr     int64 `json:"netErr"`
	LastStatus int64 `json:"lastStatus"`
	LastMs     int64 `json:"lastMs"`
}

func (b *chainStatBucket) snapshot() statBucketOut {
	return statBucketOut{
		OK: b.ok.Load(), Fail: b.fail.Load(), Challenge: b.challenge.Load(),
		NetErr: b.netErr.Load(), LastStatus: b.lastStatus.Load(), LastMs: b.lastMs.Load(),
	}
}

// statsSnapshot 全量快照（GET /api/stats）。host 维度按 fail 降序截断 Top 32（排障优先
// 看坏站点），strategy 维度全量（策略数固定个位数）。
func statsSnapshot() map[string]any {
	statsMu.RLock()
	// 61-R9 修复：hostCount 必须在 RLock 内取——map 长度读与 statsHostBucket 的写
	// （Lock 内插入新桶）并发是数据竞态，旧版在 RUnlock 后读 len(statsHosts)
	hostCount := len(statsHosts)
	hostOut := make(map[string]statBucketOut, len(statsHosts))
	type kv struct {
		k string
		b *chainStatBucket
	}
	hostList := make([]kv, 0, len(statsHosts))
	for k, b := range statsHosts {
		hostList = append(hostList, kv{k, b})
	}
	stratOut := make(map[string]statBucketOut, len(statsStrats))
	for k, b := range statsStrats {
		stratOut[k] = b.snapshot()
	}
	statsMu.RUnlock()
	// fail 降序（同分按 ok 升序=更坏的排前），截断 Top 32
	sort.Slice(hostList, func(i, j int) bool {
		fi, fj := hostList[i].b.fail.Load(), hostList[j].b.fail.Load()
		if fi != fj {
			return fi > fj
		}
		return hostList[i].b.ok.Load() < hostList[j].b.ok.Load()
	})
	const topHosts = 32
	if len(hostList) > topHosts {
		hostList = hostList[:topHosts]
	}
	for _, e := range hostList {
		hostOut[e.k] = e.b.snapshot()
	}
	return map[string]any{
		"bootAt":     statsBootMs,
		"uptimeMs":   nowMs() - statsBootMs,
		"totalOK":    statsTotalOK.Load(),
		"totalFail":  statsTotalFail.Load(),
		"hosts":      hostOut,
		"hostCount":  hostCount,
		"strategies": stratOut,
	}
}
