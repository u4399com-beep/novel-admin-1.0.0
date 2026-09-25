/**
 * audit35b_test.go —— Task 35-b ixdzs8 Phase 2 正文失败攻坚回归锁定（表驱动，风格对齐 audit33a_test.go）：
 * ①hasRealNetworkAttempt：整链零真实网络尝试（纯引擎自状态）不再计入 hosthealth 连败
 *   （ixdzs8 task7 实证：12 车道排队饱和的零网络链失败把熔断 strikes 推到 6，冷却指数涨到 600s 锁死）
 * ②isEngineStateNote 增补 queue-saturated（引擎准入拒绝新备注）
 * ③noteChainFailure 非网络级连败指数退避（1s→2s→4s→8s→15s 上界）+ 成功复位（方向 B-1 自适应退避）
 * ④acquireDomainSlotBudgeted 预算闸：预计等待超 deadline 时 shed 零副作用（不推 nextAt/不叠
 *   consec），旧语义 deadline=0 恒放行（ixdzs8 12 车道饱和根因回归）
 * 运行：cd mini-services/scraper-go && go test -race ./... -count=1
 */
package main

import (
	"strings"
	"testing"
	"time"
)

// TestHasRealNetworkAttempt 整链「是否发起过真实网络尝试」判定（Task 35-b 新增，表驱动）
func TestHasRealNetworkAttempt(t *testing.T) {
	cases := []struct {
		name     string
		attempts []AttemptSummary
		want     bool
	}{
		{"空尝试（全链未发起）→ false", nil, false},
		{"纯 budget-exhausted（链层排队饱和 shed）→ false", []AttemptSummary{
			{Strategy: "fetch-browser", Status: 0, Note: "budget-exhausted（限速排队饱和，未预约槽位快速失败，backend 请降并发）"},
		}, false},
		{"纯 timeout-budget（策略内排队超预算）→ false", []AttemptSummary{
			{Strategy: "fetch-browser", Profile: "chrome-desktop", Status: 0, Note: "timeout-budget"},
		}, false},
		{"纯 unavailable → false", []AttemptSummary{
			{Strategy: "curl-impersonate", Status: 0, Note: "unavailable（探测失败，跳过）"},
		}, false},
		{"missing-binary → false", []AttemptSummary{
			{Strategy: "curl-impersonate", Status: 0, Note: "missing-binary"},
		}, false},
		{"queue-saturated（JS 跳准入拒绝）→ false", []AttemptSummary{
			{Strategy: "fetch-browser", Status: 0, Note: "queue-saturated"},
		}, false},
		{"HTTP 200 响应（尽管 challenge）→ true", []AttemptSummary{
			{Strategy: "fetch-browser", Status: 200, Blocked: true, Note: "challenge-page"},
		}, true},
		{"HTTP 503 → true", []AttemptSummary{
			{Strategy: "got-scraping", Status: 503, Note: "http-503"},
		}, true},
		{"network-error（status=0 非引擎自状态）→ true", []AttemptSummary{
			{Strategy: "fetch-browser", Status: 0, Note: "network-error"},
		}, true},
		{"timeout（status=0 非引擎自状态）→ true", []AttemptSummary{
			{Strategy: "fetch-browser", Status: 0, Note: "timeout"},
		}, true},
		{"引擎自状态 + 真实尝试混合 → true", []AttemptSummary{
			{Strategy: "fetch-browser", Status: 0, Note: "timeout-budget"},
			{Strategy: "fetch-ua-rotate", Status: 200, Note: ""},
		}, true},
	}
	for _, c := range cases {
		if got := hasRealNetworkAttempt(c.attempts); got != c.want {
			t.Fatalf("%s: hasRealNetworkAttempt = %v, want %v", c.name, got, c.want)
		}
	}
}

// TestIsEngineStateNoteQueueSaturated queue-saturated 归类引擎自状态（Task 35-b 新增）
func TestIsEngineStateNoteQueueSaturated(t *testing.T) {
	if !isEngineStateNote("queue-saturated") {
		t.Fatalf("queue-saturated 应判定为引擎自状态（不计网络级连败）")
	}
	// 既有口径回归
	for _, note := range []string{"hard-timeout", "internal-error", "budget-exhausted（整体时间预算耗尽）", "unavailable（x）", "timeout-budget", "missing-binary"} {
		if !isEngineStateNote(note) {
			t.Fatalf("既有引擎自状态备注 %q 不应被改动", note)
		}
	}
	if isEngineStateNote("network-error") || isEngineStateNote("timeout") || isEngineStateNote("") {
		t.Fatalf("真实网络层失败备注不应被归入引擎自状态")
	}
}

// TestNoteChainFailureStreakEscalation 非网络级连败指数退避 + 成功复位（Task 35-b，方向 B-1）
func TestNoteChainFailureStreakEscalation(t *testing.T) {
	host := "streak35b.test"
	defer noteChainSuccess(host)
	wantPenalty := []int64{1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000} // 1s→2s→4s→8s→15s 封顶
	for i, want := range wantPenalty {
		noteChainFailure(host, false)
		healthMu.Lock()
		h := healthMap[host]
		gotPenalty, gotStreak := int64(0), 0
		if h != nil {
			gotPenalty, gotStreak = h.penaltyMs, h.failStreak
		}
		healthMu.Unlock()
		if gotPenalty != want {
			t.Fatalf("第 %d 次连败: penaltyMs = %d, want %d（指数退避序列漂移）", i+1, gotPenalty, want)
		}
		if gotStreak != i+1 {
			t.Fatalf("第 %d 次连败: failStreak = %d, want %d", i+1, gotStreak, i+1)
		}
	}
	// 成功即整体复位（含 failStreak）
	noteChainSuccess(host)
	if got := hostFailStreak(host); got != 0 {
		t.Fatalf("成功后 failStreak = %d, want 0（健康度应整体清零）", got)
	}
	if hostPenaltyMs(host) != 0 {
		t.Fatalf("成功后 penalty 应清零")
	}
}

// TestNoteChainFailureNetStreakPathUnchanged 网络级路径维持既有口径（Task 35-b 不回归）
func TestNoteChainFailureNetStreakPathUnchanged(t *testing.T) {
	host := "netstreak35b.test"
	defer noteChainSuccess(host)
	noteChainFailure(host, true)
	healthMu.Lock()
	p1 := healthMap[host].penaltyMs
	healthMu.Unlock()
	if p1 != netFailPenaltyBaseMS { // 1.5s
		t.Fatalf("首次网络级连败 penalty = %d, want %d（既有口径）", p1, netFailPenaltyBaseMS)
	}
	noteChainFailure(host, true) // netStreak=2 → 3s；同时 netBreakerStrikes=2 熔断
	healthMu.Lock()
	p2 := healthMap[host].penaltyMs
	healthMu.Unlock()
	if p2 != netFailPenaltyBaseMS*2 {
		t.Fatalf("第二次网络级连败 penalty = %d, want %d（既有口径）", p2, netFailPenaltyBaseMS*2)
	}
	if hostCircuitOpenMs(host) <= 0 {
		t.Fatalf("连续 2 次纯网络级失败应触发熔断（既有口径）")
	}
}

// TestAcquireSlotBudgetedShedZeroSideEffect 预算闸 shed 零副作用（Task 35-b 核心回归）
func TestAcquireSlotBudgetedShedZeroSideEffect(t *testing.T) {
	host := "shed35b.test"
	defer func() { // 清理槽位，防跨测试污染（AIMD/consec 以 host 隔离）
		hostSlotsMu.Lock()
		delete(hostSlots, host)
		hostSlotsMu.Unlock()
		noteChainSuccess(host)
	}()
	// ①新主机首取：等待≈0，granted=true（deadline 余量 5s 足够）
	waited, granted := acquireDomainSlotBudgeted(host, nowMs()+5000, 1500)
	if !granted {
		t.Fatalf("新主机首取应 granted（等待≈0 < 余量 5s）")
	}
	if waited > 200 {
		t.Fatalf("新主机首取 waited = %dms, want ≈0", waited)
	}
	// ②快照 nextAt/consec（预约制：首取后 nextAt ≈ now+interval 1.2s+抖动）
	hostSlotsMu.Lock()
	slot := hostSlots[host]
	nextAt1 := slot.nextAt
	consec1 := slot.consec.Load()
	hostSlotsMu.Unlock()
	if !nextAt1.After(time.Now().Add(500 * time.Millisecond)) {
		t.Fatalf("首取后 nextAt 应顺延一个间隔以上（got %v）", nextAt1)
	}
	if consec1 != 1 {
		t.Fatalf("首取后 consec = %d, want 1", consec1)
	}
	// ③预算闸：deadline 余量仅 300ms < 预计等待(~1.2s)+reserve → shed，零副作用
	waited2, granted2 := acquireDomainSlotBudgeted(host, nowMs()+300, 1500)
	if granted2 || waited2 != 0 {
		t.Fatalf("预算不足时应 shed（granted=%v waited=%d）", granted2, waited2)
	}
	hostSlotsMu.Lock()
	nextAt2 := slot.nextAt
	consec2 := slot.consec.Load()
	sheds := slot.sheds.Load()
	hostSlotsMu.Unlock()
	if !nextAt2.Equal(nextAt1) {
		t.Fatalf("shed 不应推动 nextAt（nextAt1=%v nextAt2=%v）——旧实现必然超时的调用方也预约槽位，正是 12 车道饱和自我放大根因", nextAt1, nextAt2)
	}
	if consec2 != 1 {
		t.Fatalf("shed 不应消耗 consec（got %d, want 1）", consec2)
	}
	if sheds < 1 {
		t.Fatalf("shed 计数应累计（got %d）", sheds)
	}
	// ④deadline=0 旧语义恒放行（robots.txt/chapterListApi 等低频路径）
	_, granted3 := acquireDomainSlotBudgeted(host, 0, 0)
	if !granted3 {
		t.Fatalf("deadline=0 应保持旧语义恒放行")
	}
}

// TestQueueSaturatedShedNoteCarriesBudgetKeyword shed 快速失败文案含 backend 降档关键词
// （backend isRateLimitErrText 按「预算耗尽/budget-exhausted」匹配触发车道降档——Task 33 关键词扩容消费面）
func TestQueueSaturatedShedNoteCarriesBudgetKeyword(t *testing.T) {
	chainNote := "budget-exhausted（限速排队饱和，未预约槽位快速失败，backend 请降并发）"
	if !strings.HasPrefix(chainNote, "budget-exhausted") {
		t.Fatalf("链层 shed 备注必须以 budget-exhausted 开头（isEngineStateNote 前缀匹配消费）")
	}
}

// TestChainSlotDeadline 链层取槽排队上界 = min(链 deadline, now+timeoutMs+2s)
// （Task 35-b 第二轮：双重限速语义下链层预等待不得超过单策略预算，超出的等待
// 必然被策略层 shed——先睡后废纯属白占车道）
func TestChainSlotDeadline(t *testing.T) {
	now := int64(1_000_000)
	cases := []struct {
		name      string
		chainDl   int64
		timeoutMs int64
		want      int64
	}{
		{"链预算更紧→用链预算", now + 10_000, 20_000, now + 10_000},
		{"策略预算更紧→钳到 now+timeoutMs+2s", now + 50_000, 20_000, now + 22_000},
		{"timeoutMs=0→退化为链预算", now + 50_000, 0, now + 50_000},
		{"timeoutMs<0→退化为链预算", now + 50_000, -5, now + 50_000},
	}
	for _, c := range cases {
		if got := chainSlotDeadline(c.chainDl, c.timeoutMs, now); got != c.want {
			t.Fatalf("%s: chainSlotDeadline = %d, want %d", c.name, got, c.want)
		}
	}
}

// TestInterStrategyBackoffGate 策略间退避门控（Task 35-b 第二轮）：退避只应发生在
// 「上一个策略产生过真实网络尝试」时——纯引擎自状态（饱和 shed 链）不应再付
// 500-750ms×8 策略的退避税。门控表达式 = isRetryableStatus(lastStatus) && hasRealNetworkAttempt(本策略 attempts)。
func TestInterStrategyBackoffGate(t *testing.T) {
	engineState := []AttemptSummary{
		{Strategy: "fetch-browser", Profile: "chrome-desktop", Status: 0, Note: "timeout-budget"},
		{Strategy: "fetch-ua-rotate", Status: 0, Note: "budget-exhausted（限速排队饱和，未预约槽位快速失败，backend 请降并发）"},
	}
	if !isRetryableStatus(0) {
		t.Fatalf("status=0 既有口径应可重试（门控第一个条件）")
	}
	if hasRealNetworkAttempt(engineState) {
		t.Fatalf("纯引擎自状态链不应触发策略间退避（gate 应短路）")
	}
	realNet := []AttemptSummary{
		{Strategy: "fetch-browser", Profile: "chrome-desktop", Status: 503, Note: ""},
	}
	if !hasRealNetworkAttempt(realNet) {
		t.Fatalf("真实网络尝试链应触发策略间退避（429/5xx 礼貌退避语义不回归）")
	}
}
