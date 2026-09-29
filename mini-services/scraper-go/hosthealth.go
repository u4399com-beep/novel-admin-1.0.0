/**
 * 按主机健康度记忆（移植自 strategies/host-health.ts，语义一致）。
 *
 * - 429/503 限流记忆：某主机最近一次被限流后，下一次抓取链开始前先「主动退避」
 *   （站点给出 Retry-After 时优先采用，缺省按指数增长 2s→4s→…，上界 15s；任何一次成功即清零）；
 * - 连败熔断：同一主机连续 3 次整条策略链失败时进入熔断，fetchPage 快速结构化失败不空烧预算；
 *   冷却 60s 起按连败次数指数增长（上界 10min），冷却结束自动「半开」恢复尝试，一次成功即完全复位；
 *   Task 58-a（E17）起熔断按 (主机×出口代理) 独立记账（egressBreaker）：连接层被封/限流本质上是
 *   「站点对特定出口 IP」的拒绝——直连出口被 SYN 黑洞时，更换规则代理出口属于新出口、不受历史
 *   熔断影响；全部候选出口均熔断才快速失败，链内取槽也优先跳过熔断中的出口（临时降权不删除）。
 *   主线实测驱动：aijjxs/huangjinwu/xinjianpan 站点 IP 被沙箱直连出口封锁，旧实现把全部出口的
 *   失败合流到裸 host 键上，规则改配代理后仍被旧直连连败的熔断持续拦截（~370s 逐次延长）。
 * - 显式指定策略时尊重用户调试意图：跳过熔断（限流退避仍生效）；
 * - 合规边界：只做「对目标站更客气」的退避与自保护（少发请求），熔断/退避只会降低请求频率。
 */
package main

import (
	"strconv"
	"sync"
	"time"
)

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

// egressBreaker Task 58-a（E17）：出口维度的熔断状态（自 hostHealth 拆出）。
// strikes/netStreak/openUntil 的语义与拆分前完全一致，只是记账粒度从裸 host 变为
// (host, egress)：egress 为 "" 时是直连出口，否则是规则配置的某个代理 URL。
type egressBreaker struct {
	host      string // 冗余存储：hostCircuitOpenMs 观测面按 host 扫描（避免字符串前缀碰撞歧义）
	egress    string
	strikes   int
	netStreak int // 连续「纯网络级错误」整链失败计数（连接层被拒/EOF）
	openUntil int64
}

type hostHealth struct {
	failStreak   int // Task 35-b: 连续整链失败计数（含网络级/HTTP 级；成功即随健康度整体清零），驱动非网络级连败的指数退避（主机级，E17 不拆分）
	penaltyMs    int64
	penaltyUntil int64
	// Task 32-d: 最近一次显式限流（429/503）记忆——fetch 整链失败时把该上下文注入错误消息，
	// backend 熔断分类（isRateLimitErr）与日志从此能区分「真限流」与「其它失败」
	lastRateLimitAt     int64 // 0 = 无记忆
	lastRateLimitStatus int   // 429 / 503
}

var (
	healthMu    sync.Mutex
	healthOrder []string
	healthMap   = map[string]*hostHealth{}
)

// egressMaxEntries 出口熔断条目上界（与 hostHealthMaxEntries 同量级）：key=host+egress，
// 规则代理池个位数量级 × 主机数；LRU 触顶淘汰最旧条目，淘汰=该出口冷却记忆丢失
// （下次真实失败重新计数，fail-open 方向，无防护弱化风险）。
const egressMaxEntries = 256

var (
	egressOrder []string
	egressMap   = map[string]*egressBreaker{}
)

// egressKey (host, egress) 复合键。\x1f 为单元分隔符：主机名与代理 URL 中实际不可出现
// （net/url 对 Host 控制字符不产生合法解析产物），即使病态输入碰撞也只是两个出口合流记账
// （=E17 前的旧行为），无安全面。
func egressKey(host, egress string) string { return host + "\x1f" + egress }

// touchEgressLocked 取/建出口熔断条目并刷新 LRU 序（调用方必须已持有 healthMu）。
func touchEgressLocked(host, egress string) *egressBreaker {
	key := egressKey(host, egress)
	b, ok := egressMap[key]
	if ok {
		for i, n := range egressOrder {
			if n == key {
				egressOrder = append(egressOrder[:i], egressOrder[i+1:]...)
				break
			}
		}
	} else {
		b = &egressBreaker{host: host, egress: egress}
	}
	egressOrder = append(egressOrder, key)
	egressMap[key] = b
	for len(egressOrder) > egressMaxEntries {
		oldest := egressOrder[0]
		egressOrder = egressOrder[1:]
		delete(egressMap, oldest)
	}
	return b
}

// removeEgressLocked 删除单出口熔断条目（成功复位用；调用方必须已持有 healthMu）。
func removeEgressLocked(host, egress string) {
	key := egressKey(host, egress)
	if _, ok := egressMap[key]; !ok {
		return
	}
	delete(egressMap, key)
	for i, n := range egressOrder {
		if n == key {
			egressOrder = append(egressOrder[:i], egressOrder[i+1:]...)
			break
		}
	}
}

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

// egressCircuitOpenMs 单出口熔断剩余毫秒（0 = 未熔断/已到半开时刻）。字段读取必须在锁内。
func egressCircuitOpenMs(host, egress string) int64 {
	healthMu.Lock()
	defer healthMu.Unlock()
	b, ok := egressMap[egressKey(host, egress)]
	if !ok || b.openUntil <= nowMs() {
		return 0
	}
	return b.openUntil - nowMs()
}

// egressCircuitsAllOpen 候选出口是否全部处于熔断态。E17 入口快速失败口径：仅当本次抓取
// 的全部候选出口（规则代理池或直连）都熔断时才结构化早退——任一出口可用即放行真实尝试
// （链内 pickProxy 会优先跳过熔断出口）。返回全部熔断时的最大剩余冷却毫秒（供 detail 展示）。
// 单出口（直连或单代理池）时与 E17 前的裸 host 熔断判定完全等价。
func egressCircuitsAllOpen(host string, egresses []string) (int64, bool) {
	healthMu.Lock()
	defer healthMu.Unlock()
	if len(egresses) == 0 {
		egresses = []string{""}
	}
	worst := int64(0)
	now := nowMs()
	for _, e := range egresses {
		b, ok := egressMap[egressKey(host, e)]
		if !ok || b.openUntil <= now {
			return 0, false // 任一出口未熔断：放行
		}
		if ms := b.openUntil - now; ms > worst {
			worst = ms
		}
	}
	return worst, true
}

// hostCircuitOpenMs 该主机全部出口中处于熔断态的最大剩余毫秒（0 = 无任何出口熔断/已到半开时刻）。
// E17 后熔断按 (host, egress) 记账，/api/host-health 观测面取最严重出口（观测语义；
// backend 不编程消费该字段，仅运维排障展示）。字段读取必须在锁内。
func hostCircuitOpenMs(host string) int64 {
	healthMu.Lock()
	defer healthMu.Unlock()
	worst := int64(0)
	now := nowMs()
	for _, b := range egressMap {
		if b.host != host || b.openUntil <= now {
			continue
		}
		if ms := b.openUntil - now; ms > worst {
			worst = ms
		}
	}
	return worst
}

// hostFailStreak Task 35-b: 当前连续整链失败计数（0 = 无记忆/已成功复位）。
// /api/host-health?host= 观测面消费，供运维/后续 backend 车道感知判断软拦截深度。
func hostFailStreak(host string) int {
	healthMu.Lock()
	defer healthMu.Unlock()
	if h, ok := healthMap[host]; ok {
		return h.failStreak
	}
	return 0
}

// noteRateLimited 记录一次限流（429/503）：Retry-After 优先，缺省指数增长。
// Task 32-d: 同步记录限流时刻与状态码（供 hostRateLimitMemo 注入 fetch 失败错误）
func noteRateLimited(host string, status int, retryAfterMs *int64) {
	if host == "" {
		return
	}
	healthMu.Lock()
	defer healthMu.Unlock()
	h := touchHealth(host)
	h.lastRateLimitAt = nowMs()
	if status == 429 || status == 503 {
		h.lastRateLimitStatus = status
	}
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
// egresses=本次链上有真实网络尝试的出口集合（E17 归因：直连为 [""]，规则代理池为实际
// 用到的代理子集；空切片按 [""] 兜底）。主机级退避（penalty/failStreak）每次链失败记一拍；
// 熔断计数（strikes/netStreak）按出口独立记账。
// Task 26-d 增强：
//  1. 连败温和退避：失败后给主机记一拍 penalty（网络级 1.5s 起步指数增长上界 8s；
//     其他失败 1s 起步），fetchPage 进链前会先等待——对已受刺激的站点少突击；
//  2. 纯网络级连败 2 次即熔断（netBreakerStrikes）：连接层被拒＝源站拒绝本机，
//     3 次阈值会让全链多空烧一整轮；
//  3. 冷却指数增长口径不变（60s→120s→…上界 10min），成功一次整体清零。
//
// Task 35-b 增强（方向 B-1 自适应退避）：非网络级连败从「固定 1s」改为按 failStreak
// 指数增长（1s→2s→4s→8s→15s 上界 maxPenaltyMS）：持续软拦截（200 空壳/挑战循环）时
// 每次失败把下一拍退避翻倍，烧预算速率随连败深度自动衰减；一次性抖动仍只退 1s。
// 网络级路径维持 netStreak 翻倍（既有口径）；两路径共用「取较大者」合入逻辑，
// 429/503 的 Retry-After 指数路径不被打断。
//
// Task 58-a（E17）：熔断记账粒度从裸 host 拆到 (host, egress)。主机级 penalty 的网络级
// 指数增长取「本次归因出口中最大的 netStreak」（拆分前合并计数器≈各出口之和上界，取 max
// 是最接近的保守重建）；混合失败链（部分出口网络错误、部分出口 HTTP 级失败）按链级
// allNetErr=false 归类，各出口 netStreak 归零——对单出口归因的常见形态（全网错误封锁/
// 全挑战）语义与拆分前一致，对混合链仅轻度低估网络级深度（熔断更慢、无过激方向）。
func noteChainFailure(host string, allNetErr bool, egresses []string) {
	if host == "" {
		return
	}
	if len(egresses) == 0 {
		egresses = []string{""}
	}
	healthMu.Lock()
	defer healthMu.Unlock()
	h := touchHealth(host)
	h.failStreak++
	// 出口维度熔断记账（E17）：每出口独立 strikes/netStreak/熔断冷却
	maxNetStreak := 0
	for _, e := range egresses {
		b := touchEgressLocked(host, e)
		b.strikes++
		if allNetErr {
			b.netStreak++
		} else {
			b.netStreak = 0
		}
		if b.netStreak > maxNetStreak {
			maxNetStreak = b.netStreak
		}
		// 熔断：普通连败 3 次；连续纯网络级错误 2 次即熔断
		if b.strikes >= breakerStrikes || (allNetErr && b.netStreak >= netBreakerStrikes) {
			exp := b.strikes - breakerStrikes
			if exp < 0 {
				exp = 0
			}
			cooldown := int64(baseCooldownMS) << uint(exp)
			if cooldown > maxCooldownMS || cooldown <= 0 {
				cooldown = maxCooldownMS
			}
			b.openUntil = nowMs() + cooldown
		}
	}
	// 失败温和退避（主机级）：取「既有 penalty」与「本次建议」较大者（不打断 429/503 的指数路径）
	suggest := int64(1_000)
	if allNetErr {
		suggest = netFailPenaltyBaseMS
		for i := 1; i < maxNetStreak && suggest < netFailPenaltyMaxMS; i++ {
			suggest *= 2
		}
		if suggest > netFailPenaltyMaxMS {
			suggest = netFailPenaltyMaxMS
		}
	} else {
		// Task 35-b: 非网络级连败指数退避：1s 左移 (failStreak-1) 位，钳 4 位（×16 → 15s 由 maxPenaltyMS 兑底）
		shift := h.failStreak - 1
		if shift > 4 {
			shift = 4
		}
		if shift < 0 {
			shift = 0
		}
		suggest = int64(1_000) << uint(shift)
	}
	if suggest > h.penaltyMs {
		h.penaltyMs = suggest
	}
	if h.penaltyMs > maxPenaltyMS {
		h.penaltyMs = maxPenaltyMS
	}
	h.penaltyUntil = nowMs() + h.penaltyMs
}

// noteChainSuccess 记录一次成功：主机级健康度（退避/限流记忆/failStreak）完全复位；
// 熔断仅复位本次成功出口（E17：其余出口可能仍被封锁，冷却到期自然半开恢复——
// 经代理成功不应清掉直连出口的真实封锁记忆）。
func noteChainSuccess(host, egress string) {
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
	removeEgressLocked(host, egress)
}

// hostRateLimitMemoMaxAge 限流记忆注入错误消息的有效窗口（记忆过旧则不再注入，
// 避免「上周被限流一次」的陈旧上下文误导 backend 分类）
const hostRateLimitMemoMaxAge = 10 * 60_000

// hostRateLimitMemo Task 32-d（Task 31 遗留①落地）：fetch 整链失败时供 chain.go 注入错误消息的
// hosthealth 限流上下文。此前 ixdzs8 实证：hosthealth 有 429/503 记忆但 fetch 失败 Error 不携带，
// backend isRateLimitErr 判定不到 → 车道降档/熔断分类（BreakerRateLimit）全部失灵。
// 近期（hostRateLimitMemoMaxAge 内）被 429/503 过的主机返回「(host 近期限流记忆: …，建议退避)」；
// 无记忆/记忆过旧返回空串（不注入）。
func hostRateLimitMemo(host string) string {
	healthMu.Lock()
	defer healthMu.Unlock()
	h, ok := healthMap[host]
	if !ok || h.lastRateLimitAt == 0 || nowMs()-h.lastRateLimitAt > hostRateLimitMemoMaxAge {
		return ""
	}
	status := "429/503"
	if h.lastRateLimitStatus != 0 {
		status = strconv.Itoa(h.lastRateLimitStatus)
	}
	t := time.UnixMilli(h.lastRateLimitAt).UTC().Format("2006-01-02T15:04:05Z")
	return "(host 近期限流记忆: " + status + " @" + t + "，建议退避)"
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
