/**
 * concurrency_test.go —— Task 26-d 并发安全回归（go test -race 下运行）：
 * 覆盖 cookies.jar（并发读写/容量淘汰不逐出自身桶）、hosthealth、affinity、
 * ratelimit（共享 hostSlots 跨请求并发取槽）、chain.proxyCursor 以及
 * challenge 关键词守卫 / parseRetryAfterMs / formatRatio / resolveJsRedirect 纯函数语义。
 * 运行：cd mini-services/scraper-go && go test -race ./...
 */
package main

import (
	"fmt"
	"sync"
	"testing"
)

// TestCookieJarConcurrent 并发捕获/回放 cookie（-race 下验证无数据竞争）
func TestCookieJarConcurrent(t *testing.T) {
	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 200; i++ {
				host := fmt.Sprintf("g%d.t%d.test", g%2, i%16)
				recordSetCookieLines(host, []string{"sid=abc" + itoa(i) + "; Path=/"}, true)
				_ = cookieHeaderFor(host, true)
			}
		}(g)
	}
	wg.Wait()
}

// TestCookieJarNoSelfEvict 容量触顶时绝不淘汰本次触达的 host（Task 26-d 修复回归）
func TestCookieJarNoSelfEvict(t *testing.T) {
	jar.mu.Lock()
	savedHosts := jar.hosts
	savedOrder := jar.order
	jar.hosts = map[string]*cookieBucket{}
	jar.order = nil
	jar.mu.Unlock()
	defer func() {
		jar.mu.Lock()
		jar.hosts = savedHosts
		jar.order = savedOrder
		jar.mu.Unlock()
	}()
	for i := 0; i < cookieMaxHosts+5; i++ {
		host := "cap" + itoa(i) + ".test"
		recordSetCookieLines(host, []string{"k=v"}, false)
		if cookieHeaderFor(host, false) == "" {
			t.Fatalf("host %s 刚写入即不可见：touchHost 把自身桶淘汰了", host)
		}
	}
}

// TestCookieJarLRU 真实 LRU 淘汰序回归（Task 29-b 修复锁定）：
// ①容量触顶淘汰的必须是「最久未触达」的 host，而非 map 随机迭代撞到的倒霉蛋；
// ②读路径（cookieHeaderFor）刷新 LRU 位——刚被读取的 host 不会被后续写入淘汰。
// 旧实现（无 order 序、随机淘汰+读不刷新）在本用例下确定性失败。
func TestCookieJarLRU(t *testing.T) {
	jar.mu.Lock()
	savedHosts := jar.hosts
	savedOrder := jar.order
	jar.hosts = map[string]*cookieBucket{}
	jar.order = nil
	jar.mu.Unlock()
	defer func() {
		jar.mu.Lock()
		jar.hosts = savedHosts
		jar.order = savedOrder
		jar.mu.Unlock()
	}()
	// 灌满容量
	for i := 0; i < cookieMaxHosts; i++ {
		recordSetCookieLines("lru"+itoa(i)+".test", []string{"k=v"}, false)
	}
	// 触达最老的 lru0（读刷新 → 移到 LRU 尾部）
	if cookieHeaderFor("lru0.test", false) == "" {
		t.Fatalf("lru0 刚写入应有可回放 cookie")
	}
	// 再写 1 个新 host 触发一次淘汰：应淘汰 lru1（当前最久未触达）
	recordSetCookieLines("lru-new.test", []string{"k=v"}, false)
	jar.mu.Lock()
	_, ok0 := jar.hosts["lru0.test"]
	_, ok1 := jar.hosts["lru1.test"]
	_, okNew := jar.hosts["lru-new.test"]
	jar.mu.Unlock()
	if !okNew {
		t.Fatalf("新 host 未入 jar")
	}
	if !ok0 {
		t.Fatalf("刚被读取刷新的 lru0 被淘汰：读路径未刷新 LRU 位")
	}
	if ok1 {
		t.Fatalf("容量触顶应淘汰最久未触达的 lru1（真实 LRU），lru1 却仍存活")
	}
}

// TestHostHealthConcurrent 健康度记忆并发读写（-race 验证锁内访问口径）
func TestHostHealthConcurrent(t *testing.T) {
	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			host := fmt.Sprintf("hh%d.test", g%3)
			for i := 0; i < 300; i++ {
				noteRateLimited(host, 429, nil)
				_ = hostPenaltyMs(host)
				noteChainFailure(host, i%2 == 0)
				_ = hostCircuitOpenMs(host)
				noteChainSuccess(host)
			}
		}(g)
	}
	wg.Wait()
}

// TestHostHealthNetStreakFastTrip 连续纯网络级错误 2 次即熔断（Task 26-d：任务 41 IP 封禁
// 后连接层 EOF 每秒数百次整链失败，3 次阈值多空烧一整轮）；混合失败仍 3 次。
func TestHostHealthNetStreakFastTrip(t *testing.T) {
	host := "nettrip.test"
	noteChainSuccess(host) // 清零
	noteChainFailure(host, true)
	if ms := hostCircuitOpenMs(host); ms > 0 {
		t.Fatalf("首次网络级失败不应熔断（剩 %dms）", ms)
	}
	noteChainFailure(host, true)
	if ms := hostCircuitOpenMs(host); ms <= 0 {
		t.Fatalf("连续 2 次纯网络级失败应立即熔断")
	}
	noteChainSuccess(host) // 成功即复位
	if ms := hostCircuitOpenMs(host); ms > 0 {
		t.Fatalf("成功后应完全复位")
	}
	// 混合失败（有 HTTP 状态/挑战页）仍走 3 次阈值
	noteChainFailure(host, false)
	noteChainFailure(host, false)
	if ms := hostCircuitOpenMs(host); ms > 0 {
		t.Fatalf("混合失败 2 次不应熔断")
	}
	noteChainFailure(host, false)
	if ms := hostCircuitOpenMs(host); ms <= 0 {
		t.Fatalf("混合失败 3 次应熔断")
	}
}

// TestHostHealthNetFailPenalty 网络级连败的温和退避记忆（1.5s 起步指数增长，成功清零）
func TestHostHealthNetFailPenalty(t *testing.T) {
	host := "netpenalty.test"
	noteChainSuccess(host)
	noteChainFailure(host, true)
	if ms := hostPenaltyMs(host); ms < 1000 {
		t.Fatalf("失败后应有温和退避记忆，got %dms", ms)
	}
	noteChainSuccess(host)
	if ms := hostPenaltyMs(host); ms != 0 {
		t.Fatalf("成功后退避应清零，got %dms", ms)
	}
}

// TestPolitenessExtraMS 突发抑制曲线（Task 26-d）
func TestPolitenessExtraMS(t *testing.T) {
	cases := []struct{ in, want int64 }{
		{0, 0}, {1, 0}, {199, 0}, {200, 100}, {400, 200}, {1000, 500}, {2200, 1000}, {100000, 1000}, {-5, 0},
	}
	for _, c := range cases {
		if got := politenessExtraMS(c.in); got != c.want {
			t.Fatalf("politenessExtraMS(%d) = %d, want %d", c.in, got, c.want)
		}
	}
}

// TestAffinityConcurrent 策略亲和缓存并发读写
func TestAffinityConcurrent(t *testing.T) {
	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			host := fmt.Sprintf("af%d.test", g%3)
			for i := 0; i < 300; i++ {
				recordStrategySuccess(host, "fetch-browser")
				_ = getPreferredStrategy(host)
			}
		}(g)
	}
	wg.Wait()
}

// TestRateLimitSlotsShared 单站限速共享性：同 host 的槽位是全局唯一实例
// （多任务并发抓同一站点时串行排队，而非各自独立限速——Task 26-d 审计项核实）
func TestRateLimitSlotsShared(t *testing.T) {
	a := getHostSlot("shared.test")
	b := getHostSlot("shared.test")
	if a != b {
		t.Fatalf("同 host 槽位必须是同一实例（共享限速），实际不同")
	}
	c := getHostSlot("other.test")
	if a == c {
		t.Fatalf("不同 host 不应共享槽位")
	}
}

// TestProxyCursorConcurrent 代理池游标原子轮换（-race）
func TestProxyCursorConcurrent(t *testing.T) {
	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 500; i++ {
				proxyCursor.Add(1)
			}
		}()
	}
	wg.Wait()
}

// TestChallengeKeywordGuard 极小页关键词层的「可见正文近空」守卫：
// 叙事含「安全验证」的正常小章节不误判；真挑战壳仍命中
func TestChallengeKeywordGuard(t *testing.T) {
	// 正常章节（正文 >200 可见字符，含关键词）→ 不判挑战
	novel := "<html><body><nav><a href='/'>首页</a> <a href='/sort'>排行</a> <a href='/cat'>分类</a> 联系我们 版权声明</nav>" +
		"<div id='content'>" +
		"他走进大厅，门口的告示写着：凡入内者须通过安全验证。他掏出令牌，守卫点头放行。" +
		"大殿深处传来低沉的钟声，一层层涟漪扩散开来，照亮了石壁上斑驳的刻痕。" +
		"他屏住呼吸，一步一步走向祭坛，手中火把的光晕在黑暗里摇曳不定，映出壁上古老的图腾。" +
		"钟声停止后，一个苍老的声音自帷幕后响起：年轻的旅人，你终于来了。我们已经等候多年，" +
		"只为你手中那半块残玉。他心头一震，握紧了怀里的信物，缓缓走上前去。" +
		"</div><footer>上一章 下一章 目录 书签</footer></body></html>"
	if looksLikeChallenge([]byte(novel)) {
		t.Fatalf("含关键词的正常章节页被误判为挑战页")
	}
	// 真挑战壳（近空正文 + 关键词）→ 判挑战
	shell := "<html><body>安全验证</body></html>"
	if !looksLikeChallenge([]byte(shell)) {
		t.Fatalf("近空正文的关键词挑战壳未命中")
	}
	// 平台强特征（任意体积）→ 判挑战（守卫不影响强特征层）
	cf := "<html><head><title>Just a moment...</title></head><body>" + novel + "</body></html>"
	if !looksLikeChallenge([]byte(cf)) {
		t.Fatalf("平台强特征未命中")
	}
}

// TestParseRetryAfterMs Retry-After 解析边界
func TestParseRetryAfterMs(t *testing.T) {
	if v := parseRetryAfterMs("2"); v == nil || *v != 2000 {
		t.Fatalf("2 秒应解析为 2000ms，got %v", v)
	}
	if v := parseRetryAfterMs("999999"); v == nil || *v != 30_000 {
		t.Fatalf("超大值应钳制 30s，got %v", v)
	}
	if parseRetryAfterMs("-3") != nil || parseRetryAfterMs("") != nil || parseRetryAfterMs("abc") != nil {
		t.Fatalf("非法形态应返回 nil")
	}
}

// TestFormatRatio 百分比格式化（Task 26-d 修复回归：0.023 → "2.3" 而非 "2.300"）
func TestFormatRatio(t *testing.T) {
	cases := []struct {
		in   float64
		want string
	}{
		{0.023, "2.3"},
		{0.1, "10.0"},
		{0.001, "0.1"},
		{0.0, "0.0"},
	}
	for _, c := range cases {
		if got := formatRatio(c.in); got != c.want {
			t.Fatalf("formatRatio(%v) = %s, want %s", c.in, got, c.want)
		}
	}
}

// TestResolveJsRedirect JS token 跳转挑战解析（字面量/变量/拼接）
func TestResolveJsRedirect(t *testing.T) {
	cur := "https://x.example.com/check?a=1"
	cases := []struct {
		html string
		want string
	}{
		{`<script>window.location.href="https://y.example.com/ok";</script>`, "https://y.example.com/ok"},
		{`<script>var locurl="/pass";location.href=locurl;</script>`, "https://x.example.com/pass"},
		{`<script>location.replace(location.origin + "/next" + location.search);</script>`, "https://x.example.com/next?a=1"},
	}
	for i, c := range cases {
		if got := resolveJsRedirect(c.html, cur); got != c.want {
			t.Fatalf("case %d: got %q, want %q", i, got, c.want)
		}
	}
	if got := resolveJsRedirect("<p>正文</p>", cur); got != "" {
		t.Fatalf("无跳转脚本应返回空，got %q", got)
	}
}
