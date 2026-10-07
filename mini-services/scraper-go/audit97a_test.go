package main

/**
 * audit97a_test.go —— R97 代理池 407 直连兜底回归（scraper-go 侧）。
 *
 * 用户实证（trxsw）：规则只挂一个要求认证的免费代理 → 全策略 HTTP 407 → 全池熔断 →
 * 直连不参与（E17「有池=仅池内代理」）→ 规则永久卡死，且 proxywatch 旧口径把 407 当
 * 「可达」死口永不清洗。R97 三层修复：
 *   1. hosthealth：egressBreaker 增 authStreak（407 整链失败记账，成功清除）
 *   2. chain：全池熔断且全部出口 authStreak≥1 → 追加直连出口兜底（本次请求生效）
 *   3. backend proxywatch：probeProxyViaProxy 407 → 死口（backend 侧 audit97b 锁定）
 *
 * 本文件锁定 1/2 的纯函数语义与表驱动用例；链层端到端（真实 407 代理）由后端
 * audit97b_test.go 以 httptest 代理服务器覆盖，引擎侧不重复起网络。
 */

import "testing"

func TestAllAttemptsProxyAuthR97(t *testing.T) {
	cases := []struct {
		name string
		in   []AttemptSummary
		want bool
	}{
		{"全 407（trxsw 形态）", []AttemptSummary{
			{Strategy: "fetch-browser", Status: 407},
			{Strategy: "fetch-ua-rotate", Status: 407},
		}, true},
		{"407 混 403", []AttemptSummary{
			{Strategy: "fetch-browser", Status: 407},
			{Strategy: "fetch-ua-rotate", Status: 403},
		}, false},
		{"407 混网络错误（status=0）", []AttemptSummary{
			{Strategy: "fetch-browser", Status: 407},
			{Strategy: "fetch-ua-rotate", Status: 0, Note: "network-error"},
		}, true},
		{"407 混挑战页（Blocked 不参与判定）", []AttemptSummary{
			{Strategy: "fetch-browser", Status: 407},
			{Strategy: "fetch-ua-rotate", Status: 403, Blocked: true},
		}, true},
		{"407 混引擎自状态（shed 不参与判定）", []AttemptSummary{
			{Strategy: "fetch-browser", Status: 407},
			{Strategy: "fetch-ua-rotate", Status: 0, Note: "budget-exhausted（限速排队饱和，未预约槽位快速失败，backend 请降并发）"},
		}, true},
		{"仅引擎自状态（无 HTTP 状态）", []AttemptSummary{
			{Strategy: "fetch-browser", Status: 0, Note: "budget-exhausted（整体时间预算耗尽）"},
		}, false},
		{"空尝试", nil, false},
		{"单 407", []AttemptSummary{{Strategy: "fetch-browser", Status: 407}}, true},
	}
	for _, c := range cases {
		if got := allAttemptsProxyAuth(c.in); got != c.want {
			t.Fatalf("%s: allAttemptsProxyAuth = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestNoteChainFailureProxyAuthTrackingR97(t *testing.T) {
	clearBreakerForTest("trxsw-r97.example")
	clearBreakerForTest("blocked-site-r97.example")
	const host = "trxsw-r97.example"
	const proxy = "http://auth-proxy.example:11111"

	// 首次 407 整链失败（allProxyAuth=true）→ 该出口带上 authStreak≥1 记忆
	noteChainFailure(host, false, []string{proxy}, true)
	if !egressAllAuthBroken(host, []string{proxy}) {
		t.Fatal("407 整链失败一次后，egressAllAuthBroken 应为 true")
	}
	// 其他出口无记忆 → 不满足「全部 auth 破坏」
	if egressAllAuthBroken(host, []string{proxy, ""}) {
		t.Fatal("存在无记忆出口（直连）时不应判定全部 auth 破坏")
	}
	if egressAllAuthBroken(host, nil) {
		t.Fatal("空出口列表应返回 false")
	}
	if egressAllAuthBroken(host+"-x", []string{proxy}) {
		t.Fatal("无记忆主机不应判定全部 auth 破坏")
	}

	// 非 407 失败（allProxyAuth=false）→ 记忆归零（出口改报其它错误=代理恢复语义判断失效）
	noteChainFailure(host, false, []string{proxy}, false)
	if egressAllAuthBroken(host, []string{proxy}) {
		t.Fatal("非 407 整链失败应清零 authStreak")
	}

	// 再次 407 → 记忆重建；成功一次 → 出口条目删除，记忆清零
	noteChainFailure(host, false, []string{proxy}, true)
	noteChainSuccess(host, proxy)
	if egressAllAuthBroken(host, []string{proxy}) {
		t.Fatal("出口成功一次后 authStreak 应随出口条目清除")
	}
}

func TestEgressCircuitAllOpenStillFailsFastWithoutAuthR97(t *testing.T) {
	// 非 407 场景（站点封锁类）全池熔断必须保持快速失败语义——兜底仅限代理认证破坏形态
	clearBreakerForTest("trxsw-r97.example")
	clearBreakerForTest("blocked-site-r97.example")
	const host = "blocked-site-r97.example"
	const proxy = "http://plain-proxy.example:8080"
	for i := 0; i < breakerStrikes; i++ {
		noteChainFailure(host, false, []string{proxy}, false)
	}
	if ms, allOpen := egressCircuitsAllOpen(host, []string{proxy}); !allOpen {
		t.Fatalf("3 次整链失败后应全池熔断（ms=%d）", ms)
	}
	if egressAllAuthBroken(host, []string{proxy}) {
		t.Fatal("非 407 失败路径不得产生 authStreak 记忆")
	}
}
