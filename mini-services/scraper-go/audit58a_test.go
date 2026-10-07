package main

/**
 * audit58a_test.go —— Task 58-a 审计：E17 出口感知熔断（hosthealth/chain）。
 *
 * 背景（主线实测驱动）：aijjxs/huangjinwu/xinjianpan 站点 IP 被沙箱直连出口 SYN 黑洞，
 * 旧实现熔断记账键是裸 host——直连连败 2 次即熔断且冷却指数延长（~370s+），把规则
 * proxy 字段改配可用代理后，新出口仍被旧直连连败的熔断持续快速失败拦截。
 * E17 修复：熔断按 (host×egress) 独立记账（egressBreaker），入口仅在「全部候选出口均
 * 熔断」时快速失败，链内 pickProxy 优先跳过熔断出口（临时降权不删除）。
 *
 * 本文件锁定：
 *   1. 出口维度记账独立性（直连封锁不波及代理出口、经代理成功不清直连封锁记忆）；
 *   2. 多出口归因计数与混合失败链的 netStreak 口径；
 *   3. fetchPage 端到端：直连熔断快速失败 + 换代理立即放行 + 成功后双面记忆状态
 *      （本地 httptest 代理，零外网依赖；robots 缓存预热免真实 robots 请求）；
 *   4. 熔断出口在链内被降权（多代理池时全部尝试走健康出口）；
 *   5. egressMap 容量上界（LRU 淘汰 fail-open 方向）。
 */

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// clearBreakerForTest 清理某主机的全部熔断/健康度状态（测试隔离用）
func clearBreakerForTest(host string) {
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
	for k, b := range egressMap {
		if b.host == host {
			delete(egressMap, k)
		}
	}
	for i := len(egressOrder) - 1; i >= 0; i-- {
		if b, ok := egressMap[egressOrder[i]]; !ok || b.host == host {
			egressOrder = append(egressOrder[:i], egressOrder[i+1:]...)
		}
	}
}

// TestEgressBreakerPerEgressIndependence E17 核心：各出口熔断独立记账，经代理成功不清直连记忆
func TestEgressBreakerPerEgressIndependence(t *testing.T) {
	host := "e17-unit.test"
	clearBreakerForTest(host)
	defer clearBreakerForTest(host)

	// 直连出口：连续 2 次纯网络级失败 → 快速熔断（netBreakerStrikes=2）
	noteChainFailure(host, true, nil, false)
	if ms := egressCircuitOpenMs(host, ""); ms > 0 {
		t.Fatalf("直连首败不应熔断，剩 %dms", ms)
	}
	noteChainFailure(host, true, nil, false)
	if ms := egressCircuitOpenMs(host, ""); ms <= 0 {
		t.Fatal("直连 2 次网络级连败应熔断")
	}
	// 代理出口未受直连连败波及（旧实现裸 host 键此处已熔断——E17 修复点）
	if ms := egressCircuitOpenMs(host, "http://proxy-e17.example:9"); ms != 0 {
		t.Fatalf("代理出口不应继承直连连败的熔断，剩 %dms", ms)
	}

	// 代理出口：3 次混合失败 → 熔断；此时两出口均熔断 → 全部熔断成立
	p := "http://proxy-e17.example:9"
	for i := 0; i < 3; i++ {
		noteChainFailure(host, false, []string{p}, false)
	}
	if ms := egressCircuitOpenMs(host, p); ms <= 0 {
		t.Fatal("代理出口 3 次混合连败应熔断")
	}
	if remaining, allOpen := egressCircuitsAllOpen(host, []string{"", p}); !allOpen || remaining <= 0 {
		t.Fatalf("两出口均熔断时应判全部熔断，got remaining=%d allOpen=%v", remaining, allOpen)
	}

	// 经代理成功：代理出口熔断复位，直连封锁记忆保留（E17 语义：不互相清零）
	noteChainSuccess(host, p)
	if ms := egressCircuitOpenMs(host, p); ms != 0 {
		t.Fatalf("成功出口应复位，剩 %dms", ms)
	}
	if ms := egressCircuitOpenMs(host, ""); ms <= 0 {
		t.Fatal("经代理成功不应清掉直连出口的真实封锁记忆")
	}
	if _, allOpen := egressCircuitsAllOpen(host, []string{"", p}); allOpen {
		t.Fatal("任一出口复位后不应判全部熔断（新出口链应放行）")
	}
	// 观测面：最严重出口剩余 > 0
	if ms := hostCircuitOpenMs(host); ms <= 0 {
		t.Fatal("hostCircuitOpenMs 应反映直连出口的熔断剩余")
	}

	// 直连成功：全部复位
	noteChainSuccess(host, "")
	if ms := hostCircuitOpenMs(host); ms != 0 {
		t.Fatalf("全部出口复位后观测面应归零，got %dms", ms)
	}
	if hostFailStreak(host) != 0 {
		t.Fatalf("成功应复位主机级 failStreak，got %d", hostFailStreak(host))
	}
	if ms := hostPenaltyMs(host); ms != 0 {
		t.Fatalf("成功应复位主机级退避，got %dms", ms)
	}
}

// TestNoteChainFailureEgressAttribution 多出口归因计数：netStreak 按出口独立累计，
// 混合失败链把归因出口的 netStreak 归零；主机级 penalty 的网络级指数取归因集合 max(netStreak)
func TestNoteChainFailureEgressAttribution(t *testing.T) {
	host := "e17-attr.test"
	clearBreakerForTest(host)
	defer clearBreakerForTest(host)

	// 链 1：p1+p2 均网络级失败（allNetErr）→ 双出口 netStreak=1
	noteChainFailure(host, true, []string{"p1", "p2"}, false)
	// 链 2：仅 p1 网络级失败 → p1 netStreak=2 熔断；p2 停在 1 不熔断
	noteChainFailure(host, true, []string{"p1"}, false)
	if ms := egressCircuitOpenMs(host, "p1"); ms <= 0 {
		t.Fatal("p1 连续 2 次网络级链失败应熔断")
	}
	if ms := egressCircuitOpenMs(host, "p2"); ms != 0 {
		t.Fatalf("p2 仅 1 次网络级失败不应熔断，剩 %dms", ms)
	}
	// 主机级网络级退避指数按 max(netStreak)=2 → 1.5s×2=3s
	if ms := hostPenaltyMs(host); ms < 2000 {
		t.Fatalf("网络级退避应按归因集合最大 netStreak 指数（≈3s），got %dms", ms)
	}

	// 链 3：p2 混合失败 → p2 netStreak 归零；此时 strikes=2（<3）且 netStreak=0（<2）不熔断，
	// 验证混合失败对「网络级连败」的归零语义（若不归零，下一次网络级失败即触发网络级熔断）
	noteChainFailure(host, false, []string{"p2"}, false)
	if ms := egressCircuitOpenMs(host, "p2"); ms != 0 {
		t.Fatalf("p2 链 3 后 strikes=2/netStreak 归零，不应熔断，剩 %dms", ms)
	}
	// 链 4：p2 再 1 次网络级失败 → netStreak=1 不触发网络级熔断，但 strikes=3 达通用阈值 →
	// 通用连败熔断（by-design：与 E17 前「3 次整链失败熔断」口径一致，netStreak 归零只影响网络级支路）
	noteChainFailure(host, true, []string{"p2"}, false)
	if ms := egressCircuitOpenMs(host, "p2"); ms <= 0 {
		t.Fatal("p2 第 3 次链失败应触发通用连败熔断（strikes>=3，与 E17 前口径一致）")
	}
	// p1 熔断不受 p2 链影响
	if ms := egressCircuitOpenMs(host, "p1"); ms <= 0 {
		t.Fatal("p1 熔断不应被 p2 的链失败复位")
	}
}

// TestEgressMapCapLocked egressMap 容量上界（LRU 淘汰；淘汰=该出口冷却记忆丢失，fail-open）
func TestEgressMapCapLocked(t *testing.T) {
	host := "e17-cap.test"
	clearBreakerForTest(host)
	defer clearBreakerForTest(host)
	for i := 0; i < egressMaxEntries+50; i++ {
		noteChainFailure(host, false, []string{"http://p" + itoa(i) + ".example:9"}, false)
	}
	healthMu.Lock()
	n := len(egressMap)
	healthMu.Unlock()
	if n > egressMaxEntries {
		t.Fatalf("egressMap 应钳在 %d，实际 %d", egressMaxEntries, n)
	}
}

// e17ProxyFixture 本地伪代理上游：作为 HTTP 代理接受绝对形式 GET 并返回 200 HTML
func e17ProxyFixture(marker string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte("<html><head><title>e17-ok</title></head><body><h1>" + marker +
			"</h1><p>他推开柴门，院子里的老槐树落下几片叶子，灶间的火光映在土墙上，屋外传来更夫走远的梆子声。</p></body></html>"))
	}))
}

// e17SeedRobotsCache 预热 robots 缓存（免真实 robots.txt 请求，测试零外网依赖且免 5s 拨号）
func e17SeedRobotsCache(origin string) (cleanup func()) {
	robotsCacheMu.Lock()
	saved, had := robotsCache[origin]
	robotsCache[origin] = robotsCacheEntry{at: time.Now(), info: robotsInfo{checked: true}}
	robotsCacheMu.Unlock()
	return func() {
		robotsCacheMu.Lock()
		defer robotsCacheMu.Unlock()
		if had {
			robotsCache[origin] = saved
		} else {
			delete(robotsCache, origin)
		}
	}
}

// TestFetchPageBreakerScopedToEgress E17 端到端：直连熔断快速失败 → 改配代理立即放行并成功，
// 成功后直连封锁记忆保留（主线「改了规则代理仍被熔断拦截」痛点的回归锁）
func TestFetchPageBreakerScopedToEgress(t *testing.T) {
	host := "203.0.113.88" // TEST-NET-3：SSRF 文本层判公网、IP 字面量免 DNS、直连必败
	clearBreakerForTest(host)
	defer clearBreakerForTest(host)
	defer jarRemoveHostForTest(host)

	// 预热：直连出口 2 次纯网络级整链失败（模拟 SYN 黑洞）→ 直连熔断
	noteChainFailure(host, true, nil, false)
	noteChainFailure(host, true, nil, false)
	if ms := egressCircuitOpenMs(host, ""); ms <= 0 {
		t.Fatal("预热直连熔断失败")
	}

	// 直连抓取：应结构化快速失败（不进真实策略链），detail 指明直连出口
	res := fetchPage("http://"+host+"/", fetchPageOptions{})
	if res.ok || !strings.Contains(res.err, "目标主机熔断中") {
		t.Fatalf("直连熔断应快速失败，ok=%v err=%q", res.ok, res.err)
	}
	if !strings.Contains(res.detail, "直连出口熔断") {
		t.Fatalf("detail 应指明直连出口熔断，实际 %q", res.detail)
	}

	// 换代理：本地 httptest 伪代理出口 → 入口不应熔断，真实策略链经代理成功
	upstream := e17ProxyFixture("e17-egress-scoped-ok")
	defer upstream.Close()
	cleanupRobots := e17SeedRobotsCache("http://" + host)
	defer cleanupRobots()

	res2 := fetchPage("http://"+host+"/", fetchPageOptions{proxy: upstream.URL})
	if !res2.ok {
		t.Fatalf("改配可用代理后应立即放行并成功（E17 核心语义），err=%q detail=%q warnings=%v",
			res2.err, res2.detail, res2.warnings)
	}
	if !strings.Contains(res2.html, "e17-egress-scoped-ok") {
		t.Fatalf("应拿到伪代理上游返回的页面，实际 len=%d", len(res2.html))
	}
	// 成功后双面记忆状态：成功出口复位；直连封锁记忆保留
	if ms := egressCircuitOpenMs(host, upstream.URL); ms != 0 {
		t.Fatalf("成功出口应复位，剩 %dms", ms)
	}
	if ms := egressCircuitOpenMs(host, ""); ms <= 0 {
		t.Fatal("直连出口封锁记忆应保留（不被其他出口成功清零）")
	}
}

// TestFetchPagePrefersHealthyEgress E17 出口降权：多代理池中熔断出口被链内跳过，
// 全部真实尝试走健康出口（旧实现全池轮转会随机撞熔断出口）
func TestFetchPagePrefersHealthyEgress(t *testing.T) {
	host := "203.0.113.89" // TEST-NET-3
	clearBreakerForTest(host)
	defer clearBreakerForTest(host)
	defer jarRemoveHostForTest(host)

	upstream := e17ProxyFixture("e17-healthy-preferred")
	defer upstream.Close()
	cleanupRobots := e17SeedRobotsCache("http://" + host)
	defer cleanupRobots()

	// 预热：坏出口（127.0.0.1:1 连接拒绝）3 次混合失败 → 熔断（好出口保持健康）
	bad := "http://127.0.0.1:1"
	for i := 0; i < 3; i++ {
		noteChainFailure(host, false, []string{bad}, false)
	}
	if ms := egressCircuitOpenMs(host, bad); ms <= 0 {
		t.Fatal("预热坏出口熔断失败")
	}

	pool := bad + "," + upstream.URL
	for round := 0; round < 6; round++ {
		res := fetchPage("http://"+host+"/", fetchPageOptions{proxy: pool})
		if !res.ok {
			t.Fatalf("round %d: 池内存在健康出口时应成功，err=%q detail=%q", round, res.err, res.detail)
		}
		for _, a := range res.attempts {
			if a.Status == 0 && !a.OK {
				t.Fatalf("round %d: 熔断出口应被降权跳过（健康出口唯一，不应有任何网络级失败尝试），attempts=%+v", round, res.attempts)
			}
		}
	}
}
