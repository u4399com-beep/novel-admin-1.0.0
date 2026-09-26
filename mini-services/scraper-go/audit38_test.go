/**
 * audit38_test.go —— Task 38-a 采集+反反爬增强回归锁定（表驱动，风格对齐 audit35b_test.go）：
 * ①F1 host 键大小写归一管线：cookie 桶/限速槽 key 经 hostOf 小写后，同站点大小写变体 URL
 *   不再分裂会话与限速（fetch 系原样 Host vs got 系 hostOf 的分裂曾使 WAF 会话跨策略丢失）
 * ②F2 netErrNote：硬时间闸 context canceled 归引擎自状态 engine-cancel（不再按 network-error
 *   计入 hosthealth 网络级连败 → 2 次即熔断的误判面）；isEngineStateNote 扩词回归
 * ③F3 宝塔 WAF 挑战特征：btwaf 强特征（任意体积）+「网站防火墙」极小页关键词 + 长正文不误杀
 * ④F4 限速抖动 ± 双向：nextAt 推进量双侧散布且合规下限 1000ms 不被负向抖动击穿
 * ⑤F5 promoteRateLimitedStatus：混合失败（先 429 后 403）时限流状态提升返回
 * 运行：cd mini-services/scraper-go && go test -race ./... -count=1
 */
package main

import (
	"context"
	"errors"
	"testing"
	"time"
)

// TestHostKeyNormalizationPipeline F1: host 键大小写归一后，同站点大小写变体 URL 在
// cookie 会话与限速槽两条管线上互操作（不再分裂双桶）。
func TestHostKeyNormalizationPipeline(t *testing.T) {
	// hostOf 语义锁定：小写 + 保留端口
	got := hostOf("HTTPS://MixedCase.Example.COM:8443/book/1")
	if got != "mixedcase.example.com:8443" {
		t.Fatalf("hostOf 大小写归一失效: got %q", got)
	}
	// cookie 管线：fetch 系页面（大写 URL）种下的会话，got 系页面（小写 URL）可回放
	url1 := "https://MixedCase.Example.COM/book/1"
	url2 := "https://mixedcase.example.com/chapter/2"
	recordSetCookieLines(hostOf(url1), []string{"__jsl_clearance=pass; Path=/"}, true)
	defer func() {
		jar.mu.Lock()
		delete(jar.hosts, hostOf(url1))
		jar.mu.Unlock()
	}()
	if cookieHeaderFor(hostOf(url2), true) == "" {
		t.Fatalf("cookie 会话跨大小写变体 URL 分裂：fetch 系种的会话 got 系读不到（反复过挑战根因）")
	}
	// 限速槽管线：同一站点的两个大小写变体必须共享同一槽实例（合规限速不被稀释）
	s1 := getHostSlot(hostOf(url1))
	s2 := getHostSlot(hostOf(url2))
	if s1 != s2 {
		t.Fatalf("限速槽跨大小写变体分裂：1.2s 合规间隔被稀释成双桶")
	}
}

// TestNetErrNote F2: 网络错误 → 结构化备注分类（fetch 系/got 系共用）。
func TestNetErrNote(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want string
	}{
		{"硬时间闸 hcancel 中止在途请求 → engine-cancel", errors.New(`Get "https://x.test/": context canceled`), "engine-cancel"},
		{"裸 context canceled → engine-cancel", context.Canceled, "engine-cancel"},
		{"client.Timeout 超时 → timeout", errors.New(`Get "https://x.test/": context deadline exceeded (Client.Timeout exceeded while awaiting headers)`), "timeout"},
		{"连接拒绝 → network-error", errors.New("dial tcp 1.2.3.4:443: connect: connection refused"), "network-error"},
	}
	for _, c := range cases {
		if got := netErrNote(c.err); got != c.want {
			t.Fatalf("%s: netErrNote = %q, want %q", c.name, got, c.want)
		}
	}
}

// TestIsEngineStateNoteEngineCancel F2: engine-cancel 归引擎自状态（不计网络级连败）。
func TestIsEngineStateNoteEngineCancel(t *testing.T) {
	if !isEngineStateNote("engine-cancel") {
		t.Fatalf("engine-cancel 应判定为引擎自状态（站点挂起被硬闸兜底 ≠ 站点拒绝本机）")
	}
	// hasRealNetworkAttempt 联动：纯 engine-cancel 链不计连败
	attempts := []AttemptSummary{{Strategy: "fetch-browser", Profile: "chrome-desktop", Status: 0, Note: "engine-cancel"}}
	if hasRealNetworkAttempt(attempts) {
		t.Fatalf("纯 engine-cancel 链不应计真实网络尝试（硬闸取消竞态误判熔断回归）")
	}
	if allAttemptsNetErr(attempts) {
		t.Fatalf("纯 engine-cancel 链不应判全网络错误（netStreak 快速熔断误判回归）")
	}
}

// TestChallengeBTWAF F3: 宝塔 WAF 特征检测 + 误杀面守卫。
func TestChallengeBTWAF(t *testing.T) {
	// 强特征：拦截页含 btwaf token（class/JS/cookie 名），任意体积判挑战
	btwafPage := "<html><head><title>网站防火墙</title></head><body><div class=\"btwaf-container\"><script src=\"/btwaf/js.js\"></script>" +
		"请完成安全校验后继续访问。</div></body></html>"
	if !looksLikeChallenge([]byte(btwafPage)) {
		t.Fatalf("宝塔 btwaf 拦截页未命中挑战检测")
	}
	// 极小页关键词层：近空正文含「网站防火墙」判挑战
	shell := "<html><body>网站防火墙</body></html>"
	if !looksLikeChallenge([]byte(shell)) {
		t.Fatalf("极小页「网站防火墙」挑战壳未命中")
	}
	// 误杀面守卫：正常叙事长正文提及防火墙（可见正文 >200 字）不判挑战
	var novel string
	for i := 0; i < 6; i++ {
		novel += "城墙上的守卫轮流值守，灯火在垛口间移动，风从北面的关隘吹进来，卷起细雪。"
	}
	long := "<html><body><div id='content'>" + novel + "守卫们说，这道防火墙般的城墙自建成以来从未被攻破。</div></body></html>"
	if looksLikeChallenge([]byte(long)) {
		t.Fatalf("含「防火墙」的正常叙事章节页被误判为挑战页")
	}
}

// TestJitterBidirectional F4: 限速抖动 ± 双向 + 合规下限 1000ms 钳制。
// 每轮删除槽位重建（首取 wait≈0 不真实睡眠），观测 nextAt 相对当前时刻的推进量分布。
func TestJitterBidirectional(t *testing.T) {
	host := "jitter38.test"
	floor := int64(1000)
	base := getMinIntervalMs() // 默认 1200
	sawBelowBase := false
	for i := 0; i < 24; i++ {
		hostSlotsMu.Lock()
		delete(hostSlots, host)
		hostSlotsMu.Unlock()
		before := time.Now()
		waited, granted := acquireDomainSlotBudgeted(host, 0, 0) // deadline=0 旧语义，首取 wait≈0
		if !granted || waited > 50 {
			t.Fatalf("第 %d 轮新槽首取应 granted 且几乎不等待（waited=%d granted=%v）", i, waited, granted)
		}
		hostSlotsMu.Lock()
		slot := hostSlots[host]
		nextAt := slot.nextAt
		hostSlotsMu.Unlock()
		diffMS := nextAt.Sub(before).Milliseconds()
		if diffMS < floor {
			t.Fatalf("第 %d 轮 nextAt 推进 %dms 击穿合规下限 %dms（负向抖动未钳制）", i, diffMS, floor)
		}
		if diffMS > base+jitterMS {
			t.Fatalf("第 %d 轮 nextAt 推进 %dms 超出上界 %dms", i, diffMS, base+jitterMS)
		}
		if diffMS < base {
			sawBelowBase = true // 负向抖动存在（旧实现只加不减，恒 ≥ base）
		}
	}
	hostSlotsMu.Lock()
	delete(hostSlots, host)
	hostSlotsMu.Unlock()
	if !sawBelowBase {
		t.Fatalf("24 轮推进量从未低于基础间隔 %dms——抖动仍是单向只加（± 双向改造回归）", base)
	}
}

// TestPromoteRateLimitedStatus F5: 混合失败时限流状态提升（纯函数表驱动）。
func TestPromoteRateLimitedStatus(t *testing.T) {
	ra429 := int64(3000)
	cases := []struct {
		name          string
		finalStatus   int
		finalRA       *int64
		limitedStatus int
		limitedRA     *int64
		wantStatus    int
		wantRAIsNil   bool
	}{
		{"无限流记忆 → 原样保留", 403, nil, 0, nil, 403, true},
		{"终态已是 429 → 原样保留", 429, &ra429, 429, &ra429, 429, false},
		{"终态已是 503 → 原样保留", 503, nil, 503, nil, 503, true},
		{"先 429 后 403 → 提升为 429 并携带 Retry-After", 403, nil, 429, &ra429, 429, false},
		{"先 503 后 403 → 提升为 503", 403, nil, 503, nil, 503, true},
	}
	for _, c := range cases {
		gotStatus, gotRA := promoteRateLimitedStatus(c.finalStatus, c.finalRA, c.limitedStatus, c.limitedRA)
		if gotStatus != c.wantStatus {
			t.Fatalf("%s: status = %d, want %d", c.name, gotStatus, c.wantStatus)
		}
		if (gotRA == nil) != c.wantRAIsNil {
			t.Fatalf("%s: retryAfter nil 性不符（got %v）", c.name, gotRA)
		}
	}
}
