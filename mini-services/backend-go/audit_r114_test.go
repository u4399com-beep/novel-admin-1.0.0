/**
 * audit_r114_test.go —— R114 车道饱和观测口径改造的回归锁：
 *   ① ServiceElapsedMs 服务耗时口径（总耗时−域槽排队，含向后兼容/毛刺钳制）
 *   ② 车道回升冻结语义端到端：R112 实证的「车道自排队锁死回升」在和新口径下消除
 *
 * 背景：R99 的 laneQueueFreezeEWMA 以「引擎总耗时（含域槽排队）」为采样口径，本意是
 * 排队积压时不加车道。但域槽按礼貌间隔放行（~1 req/1.35s），N 车道并发时末位车道
 * 排队 N×1.35s 起——这是流水线化的正常形态，吞吐与车道数无关。旧口径把它当拥堵：
 * R112 实证车道回升被永久冻结在 4（12 车道纯排队恒超 3.5s 阈值 → bumpLaneOnSuccess
 * 每次清空连捷计数 → 车道永不回升）。R114 引擎逐层埋点 queueMs（链层+策略内部），
 * backend EWMA 改采样 ServiceElapsedMs；未埋点路径（旧引擎）queue=0 回退旧口径。
 */
package main

import "testing"

// ---------- ① ServiceElapsedMs ----------

func TestServiceElapsedMs_R114(t *testing.T) {
	cases := []struct {
		name       string
		total, que int64
		want       int64
	}{
		{"健康直连（零排队）：服务=总耗时（旧口径兼容）", 1800, 0, 1800},
		{"旧引擎未埋点（queue 缺失回 0）：回退旧口径", 5000, 0, 5000},
		{"失败路径（total=0）：原样返回不参与 EWMA（ewmaNext 拒 ms<=0）", 0, 0, 0},
		{"常规排队：4 车道末位 ~4s 排队 + 0.8s 服务", 4800, 4000, 800},
		{"12 车道纯排队（R112 锁死形态）：剔除后服务仅 300ms", 16500, 16200, 300},
		{"排队略超总耗时（时钟毛刺）：钳 0 交 ewmaNext 跳过", 1200, 1500, 0},
		{"负 queue（非法）：按缺失处理回旧口径", 2000, -5, 2000},
	}
	for _, c := range cases {
		if got := ServiceElapsedMs(c.total, c.que); got != c.want {
			t.Fatalf("%s: ServiceElapsedMs(%d,%d) = %d, want %d", c.name, c.total, c.que, got, c.want)
		}
	}
}

// ---------- ② 车道回升冻结语义端到端 ----------

// TestLaneFreezeSemantic_R114 复现 R112 锁死场景并验证新口径解锁：
// 场景=健康站 + 满车道并发，每章 total=4800ms（域槽排队 4000 + 服务 800）。
//   旧口径：EWMA 采样 total → 数样本内越过 3500 阈值 → laneBumpFrozen=true → 回升冻结。
//   新口径：EWMA 采样 ServiceElapsedMs → 稳定在 800ms 附近 → 永不冻结 → 连捷 24 章正常回升。
// 同时验证向后兼容：queue=0（旧引擎）时新口径退化为旧口径行为（冻结照旧触发）。
func TestLaneFreezeSemantic_R114(t *testing.T) {
	const samples = 8

	// 新口径：剔除自排队后健康站不再误冻结
	var ewNew int64
	for i := 0; i < samples; i++ {
		ewNew = ewmaNext(ewNew, ServiceElapsedMs(4800, 4000))
	}
	if laneBumpFrozen(ewNew) {
		t.Fatalf("新口径：健康站（排队 4000+服务 800）EWMA=%d 不应冻结回升（R112 锁死复现）", ewNew)
	}

	// 旧口径对照：同样本必然冻结（锁定旧行为，防有人误改回）
	var ewOld int64
	for i := 0; i < samples; i++ {
		ewOld = ewmaNext(ewOld, 4800)
	}
	if !laneBumpFrozen(ewOld) {
		t.Fatalf("旧口径对照：总耗时 EWMA=%d 应冻结（该断言锁定新旧口径行为差异）", ewOld)
	}

	// 向后兼容：queue=0（旧引擎/未埋点）时 ServiceElapsedMs=total → 与旧口径一致
	if ServiceElapsedMs(4800, 0) != 4800 {
		t.Fatalf("queue=0 应原样返回 total（旧口径回退）")
	}

	// 站点真慢仍冻结（R99 本意保留）：服务耗时本身 4s/章
	var ewSlow int64
	for i := 0; i < samples; i++ {
		ewSlow = ewmaNext(ewSlow, ServiceElapsedMs(4000, 0))
	}
	if !laneBumpFrozen(ewSlow) {
		t.Fatalf("站点真慢（服务 4000ms）EWMA=%d 应冻结回升（R99 本意）", ewSlow)
	}
}
