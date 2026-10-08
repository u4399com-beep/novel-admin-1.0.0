/**
 * Task 102-a（三层架构）回归：链序分层断言 + 挑战感知跳层（recommendTierForChallenge /
 * promoteTierAfter 纯函数表驱动）+ /api/strategies tier 字段契约。
 */
package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestAllStrategiesTierOrdering 链序必须按三层成本递增排列：
// Tier 1 HTTP 全部在前（内部相对序保持既有兼容），Tier 2 恰一个 fetch-iv8，Tier 3 收尾。
func TestAllStrategiesTierOrdering(t *testing.T) {
	phase := 0 // 0=未见非 T1，1=T2 段，2=T3 段
	seenT2 := 0
	for i, s := range allStrategies {
		if s.tier < tierStrategyHTTP || s.tier > tierStrategyBrowser {
			t.Fatalf("策略 %s tier=%d 越界", s.name, s.tier)
		}
		switch {
		case s.tier == tierStrategyHTTP:
			if phase > 0 {
				t.Fatalf("Tier 1 策略 %s 出现在更高层之后（位置 %d），链序未按成本递增", s.name, i)
			}
		case s.tier == tierStrategyIv8:
			if phase == 2 {
				t.Fatalf("Tier 2 策略 %s 出现在 Tier 3 之后（位置 %d）", s.name, i)
			}
			phase = 1
			seenT2++
		case s.tier == tierStrategyBrowser:
			phase = 2
		}
	}
	if seenT2 != 1 {
		t.Fatalf("Tier 2 应恰含 fetch-iv8 一个策略，got %d", seenT2)
	}
	// 名单防漂移：iv8 之外的任何策略不得标 Tier 2
	for _, s := range allStrategies {
		if s.tier == tierStrategyIv8 && s.name != "fetch-iv8" {
			t.Fatalf("策略 %s 错标 Tier 2", s.name)
		}
	}
	// fetch-cloak 与 browser 必须是 Tier 3
	for _, s := range allStrategies {
		switch s.name {
		case "fetch-cloak", "browser":
			if s.tier != tierStrategyBrowser {
				t.Fatalf("策略 %s 应属 Tier 3，got %d", s.name, s.tier)
			}
		}
	}
}

func TestRecommendTierForChallenge(t *testing.T) {
	normal := []byte("<html><head><title>正常章节页</title></head><body><div id='content'>" +
		strings.Repeat("这是一段正常的小说正文内容，足够长不会被误判为挑战壳。", 30) + "</div></body></html>")
	cases := []struct {
		name string
		body []byte
		want int
	}{
		{"空体", nil, 0},
		{"正常内容页", normal, 0},
		{"平台强特征-CF", []byte("<html><body><script>cf_chl_opt={};</script>Just a moment...</body></html>"), tierStrategyBrowser},
		{"平台强特征-acw_sc__v2", []byte("<script>var arg1='ABC';var acw_sc__v2='x9y8';</script>"), tierStrategyBrowser},
		{"平台强特征-GoEdge验证码", []byte("<html><body><input name='GOEDGE_WAF_CAPTCHA'/></body></html>"), tierStrategyBrowser},
		{"JS算cookie壳", []byte("<html><head><script>document.cookie='y='+t;location.reload();</script></head><body></body></html>"), tierStrategyIv8},
		{"JS跳转壳-近空正文", []byte("<html><head><script>window.location.href='/index.php';</script></head><body></body></html>"), tierStrategyIv8},
		{"风控验证壳-微信环境异常型", []byte("<html><head><style>" + strings.Repeat(".c{margin:0};", 200) + "</style></head><body><div>当前环境异常，完成验证后即可继续访问。<a>去验证</a></div></body></html>"), tierStrategyBrowser},
		{"风控词但正文非近空-不误杀", append([]byte("<html><body>"),
			append([]byte(strings.Repeat("正文内容足够长。", 30)), []byte("因访问异常被记录。</body></html>")...)...), 0},
		{"JS跳转但正文非近空", append([]byte("<html><head><script>window.location.href='/x';</script></head><body>"),
			append([]byte(strings.Repeat("正文内容足够长。", 30)), []byte("</body></html>")...)...), 0},
	}
	for _, tc := range cases {
		if got := recommendTierForChallenge(tc.body); got != tc.want {
			t.Errorf("%s: recommendTierForChallenge=%d want %d", tc.name, got, tc.want)
		}
	}
}

func mkOrder(t *testing.T, names ...string) []strategyDef {
	order := make([]strategyDef, 0, len(names))
	for _, n := range names {
		def, ok := strategyByName(n)
		if !ok {
			t.Fatalf("策略不存在: " + n)
		}
		order = append(order, def)
	}
	return order
}

// strategyByName 测试辅助：按名取策略定义副本
func strategyByName(name string) (strategyDef, bool) {
	for _, s := range allStrategies {
		if s.name == name {
			return s, true
		}
	}
	return strategyDef{}, false
}

func TestPromoteTierAfter(t *testing.T) {
	base := mkOrder(t, "fetch-browser", "fetch-ua-rotate", "got-scraping", "fetch-iv8", "fetch-cloak", "browser")

	// JS 壳 → 提 iv8：跳过剩余 Tier 1
	got, promoted := promoteTierAfter(base, 1, tierStrategyIv8)
	if promoted != "fetch-iv8" {
		t.Fatalf("应把 fetch-iv8 提前，got %q", promoted)
	}
	if got[2].name != "fetch-iv8" {
		t.Fatalf("fetch-iv8 应落在 si+1=2，got %s", got[2].name)
	}
	// 保序：其余相对顺序不变
	want := "fetch-browser,fetch-ua-rotate,fetch-iv8,got-scraping,fetch-cloak,browser"
	if got2 := joinNames(got); got2 != want {
		t.Fatalf("提层后保序失败: %s", got2)
	}

	// 已在下一位 → 不动且不拷贝（同一切片）
	same, promoted2 := promoteTierAfter(base, 2, tierStrategyIv8)
	if promoted2 != "" || len(same) != len(base) || &same[0] != &base[0] {
		t.Fatalf("目标已在下一跳应原样返回，got %q", promoted2)
	}

	// 后续无该层 → 原样
	none, promoted3 := promoteTierAfter(base, 4, tierStrategyIv8)
	if promoted3 != "" {
		t.Fatalf("无该层策略应返回空提升，got %q", promoted3)
	}
	if len(none) != len(base) {
		t.Fatalf("无提升时不应改序")
	}

	// 平台 WAF → 提 fetch-cloak（Tier 3），iv8 被跳过
	got3, promoted4 := promoteTierAfter(base, 0, tierStrategyBrowser)
	if promoted4 != "fetch-cloak" {
		t.Fatalf("应把 fetch-cloak 提前，got %q", promoted4)
	}
	if got3[1].name != "fetch-cloak" {
		t.Fatalf("fetch-cloak 应落在 si+1=1，got %s", got3[1].name)
	}

	// copy-on-write：base 底层数组不得被改
	if joinNames(base) != "fetch-browser,fetch-ua-rotate,got-scraping,fetch-iv8,fetch-cloak,browser" {
		t.Fatalf("原切片被污染（copy-on-write 失效）")
	}
}

// TestPromoteTierDoesNotPolluteAllStrategies pickOrder 默认路径返回 allStrategies 共享底层数组，
// 跳层提位必须 copy-on-write，不得污染进程级全局链序（并发 fetchPage 的正确性底线）。
func TestPromoteTierDoesNotPolluteAllStrategies(t *testing.T) {
	before := strategyNamesList()
	order := allStrategies // 模拟 pickOrder 默认路径的直接引用
	got, promoted := promoteTierAfter(order, 0, tierStrategyBrowser)
	if promoted == "" {
		t.Fatalf("应触发 fetch-cloak 提前")
	}
	if got[1].name != "fetch-cloak" {
		t.Fatalf("fetch-cloak 应提前，got %s", got[1].name)
	}
	after := strategyNamesList()
	for i := range before {
		if before[i] != after[i] {
			t.Fatalf("allStrategies 被污染: idx %d %s→%s", i, before[i], after[i])
		}
	}
}

// TestStrategiesAPITierField /api/strategies 契约：每策略带 tier 且分层合法（102-a 观测透出）
func TestStrategiesAPITierField(t *testing.T) {
	rec := postRoute(t, "GET", "/api/strategies", "")
	if rec.Code != 200 {
		t.Fatalf("GET /api/strategies 应 200，got %d", rec.Code)
	}
	var out struct {
		Strategies []StrategyInfo `json:"strategies"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("解码失败: %v", err)
	}
	seen := map[string]int{}
	for _, s := range out.Strategies {
		seen[s.Name] = s.Tier
		if s.Tier < 1 || s.Tier > 3 {
			t.Fatalf("策略 %s tier=%d 越界", s.Name, s.Tier)
		}
	}
	for name, want := range map[string]int{"fetch-browser": 1, "fetch-cloak": 3, "fetch-iv8": 2} {
		if got, ok := seen[name]; !ok || got != want {
			t.Fatalf("策略 %s tier=%d（存在=%v）want %d", name, got, ok, want)
		}
	}
}

// ---- 辅助 ----

func joinNames(order []strategyDef) string {
	names := make([]string, 0, len(order))
	for _, s := range order {
		names = append(names, s.name)
	}
	return strings.Join(names, ",")
}

func strategyNamesList() []string {
	names := make([]string, 0, len(allStrategies))
	for _, s := range allStrategies {
		names = append(names, s.name)
	}
	return names
}
