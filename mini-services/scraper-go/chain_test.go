/**
 * chain_test.go —— Task 29-b 逐行第二轮回归锁定：
 * allAttemptsNetErr/isEngineStateNote 纯函数表驱动（整链失败的「纯网络级连败」判定，
 * 供 hosthealth netBreakerStrikes=2 快速熔断的输入）。
 * 修复背景：旧实现只排除 budget-exhausted/unavailable——策略内部预算子尝试（timeout-budget）、
 * 硬时间闸（hard-timeout）、二进制缺失（missing-*）、策略 panic（internal-error）均按
 * status=0 落入网络级失败，站点整体挂起（连接成功但响应停滞）时被误判为「源站连接层拒绝
 * 本机」，2 轮即触发快速熔断+网络级退避。
 */
package main

import "testing"

// TestAllAttemptsNetErr 整链失败的网络级判定（表驱动）
func TestAllAttemptsNetErr(t *testing.T) {
	cases := []struct {
		name     string
		attempts []AttemptSummary
		want     bool
	}{
		{"空尝试（全链未发起请求）", nil, false},
		{"单条网络错误", []AttemptSummary{{Strategy: "fetch-browser", Status: 0, Note: "network-error"}}, true},
		{"单条客户端超时（连接层证据）", []AttemptSummary{{Strategy: "fetch-browser", Status: 0, Note: "timeout"}}, true},
		{"多条全网络错误", []AttemptSummary{
			{Strategy: "fetch-browser", Status: 0, Note: "timeout"},
			{Strategy: "got-scraping", Status: 0, Note: "network-error"},
		}, true},
		// —— Task 29-b 修复面：引擎自身状态不再计入网络级连败 ——
		{"硬时间闸放行（站点挂起非拒绝）", []AttemptSummary{{Strategy: "got-scraping", Status: 0, Note: "hard-timeout"}}, false},
		{"策略内部预算耗尽子尝试", []AttemptSummary{{Strategy: "fetch-browser", Profile: "chrome-desktop", Status: 0, Note: "timeout-budget"}}, false},
		{"curl 二进制缺失", []AttemptSummary{{Strategy: "curl-impersonate", Status: 0, Note: "missing-binary"}}, false},
		{"策略内部 panic", []AttemptSummary{{Strategy: "fetch-mobile", Status: 0, Note: "internal-error"}}, false},
		{"整链预算耗尽（Task 26-d 原排除项回归）", []AttemptSummary{{Strategy: "fetch-browser", Status: 0, Note: "budget-exhausted（整体时间预算耗尽）"}}, false},
		{"策略探测失败（Task 26-d 原排除项回归）", []AttemptSummary{{Strategy: "browser", Status: 0, Note: "unavailable（探测失败，跳过）"}}, false},
		// —— 混合形态 ——
		{"网络错误混合硬时间闸（非纯网络级）", []AttemptSummary{
			{Strategy: "fetch-browser", Status: 0, Note: "network-error"},
			{Strategy: "got-scraping", Status: 0, Note: "hard-timeout"},
		}, false},
		{"HTTP 状态失败（非连接层）", []AttemptSummary{{Strategy: "fetch-browser", Status: 403, Note: "http-403"}}, false},
		{"挑战页（blocked）", []AttemptSummary{{Strategy: "fetch-browser", Status: 200, Blocked: true, Note: "challenge-page"}}, false},
		{"exec 失败（curl 真实尝试，维持网络级口径）", []AttemptSummary{{Strategy: "fetch-curl", Status: 0, Note: "exec-error"}}, true},
	}
	for _, c := range cases {
		if got := allAttemptsNetErr(c.attempts); got != c.want {
			t.Fatalf("%s: allAttemptsNetErr = %v, want %v", c.name, got, c.want)
		}
	}
}
