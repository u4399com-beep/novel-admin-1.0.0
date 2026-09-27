/**
 * audit51_test.go —— Task 51 封面下载多出口回退回归锁定：
 * 实证根因（Task 51）：huangjinwu 图床被沙箱网络封锁而规则 proxy=''（直连）→ 该站
 * 全部书籍封面 dial timeout 静默丢失。修复为「网络类失败自动回退规则代理池」，本文件锁定：
 * ① ruleProxiesForHost 候选序：同站（近似注册域）优先、其余规则兜底、socks 过滤、去重保序；
 * ② 回退触发面：网络类失败才回退，确定性失败（HTTP 404/非图像等）零回退；
 * ③ 回退可达性：伪代理 httptest 全链（fetchAndStoreCover 经 ProxyURL 通道拿到合法 JPEG
 *    落盘成功——零外部网络依赖，remoteURL 用 203.0.113.99（TEST-NET-3，isPrivateIPv4Text
 *    判公网、LookupHost 对 IP 字面量短路不触 DNS——Task 51-b 对齐 audit51b_test.go 的
 *    无网沙箱可复跑性））；
 * ④ primary 同值去重 + hardDeadline 预算截断（65s WriteTimeout 防线，backfill 通道）。
 * 复用 recover_test.go 的 TestMain 临时库；落盘 id 用 953xx 段并在 Cleanup 删除产物。
 */
package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"
	"time"
)

// mustInitRuleFixtures 规则测试夹具：id 段 95200+ 避让其他测试文件；t.Cleanup 自清。
func mustInitRuleFixtures(t *testing.T) {
	t.Helper()
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	t.Cleanup(func() {
		_, _ = db.Exec(`DELETE FROM "ScrapeRule" WHERE "id" >= 95200`)
	})
}

func insertRule(t *testing.T, id int64, siteURL, proxy string) {
	t.Helper()
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO "ScrapeRule" ("id","name","siteUrl","proxy","createdAt","updatedAt")
                        VALUES (?,?,?,?,0,0)`, id, "回退测试规则"+itoa(int(id)), siteURL, proxy); err != nil {
		t.Fatalf("insert rule #%d: %v", id, err)
	}
}

// TestRuleProxiesForHostOrdering 候选序：同站规则 proxy 优先（跨 id 顺序聚合）、
// socks5 形态跳过（封面通道不支持）、逗号池展开、全局去重保序、其余规则兜底殿后。
func TestRuleProxiesForHostOrdering(t *testing.T) {
	mustInitRuleFixtures(t)
	insertRule(t, 95201, "https://unrelated.example/", "http://p-other1:9")
	insertRule(t, 95202, "https://img.huangjinwu.org/", "http://p2:1, socks5://skip-me:1080, http://p3:1")
	insertRule(t, 95203, "https://huangjinwu.org/", "http://p2:1") // 与 95202 首代理重复：去重
	insertRule(t, 95204, "http://203.0.113.99/", "http://p-ip:8")  // IP 站点规则兜底组
	// 95205 不插入：proxy='' 的规则（huangjinwu 现状）不产候选

	got := ruleProxiesForHost("http://www.huangjinwu.org/book/x.jpg")
	if len(got) == 0 {
		t.Fatal("应产出回退候选，got 空")
	}
	// 同站组：95202（p2,p3；socks 跳过）→ 95203（p2 重复去重，无新增）；其余组：95201 → 95204
	want := []string{"http://p2:1", "http://p3:1", "http://p-other1:9", "http://p-ip:8"}
	if len(got) != len(want) {
		t.Fatalf("候选 = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("候选[%d] = %q, want %q（全量 %v）", i, got[i], want[i], got)
		}
	}

	if g := ruleProxiesForHost("http://"); g != nil {
		t.Fatalf("非法 srcURL 应返回 nil，got %v", g)
	}
}

// TestIsNetworkLikeCoverReason 回退触发面表驱动：传输层两类前缀才回退，
// 确定性失败（SSRF/HTTP 状态/非图像/空体/解码/落盘）换出口结果相同、零回退。
func TestIsNetworkLikeCoverReason(t *testing.T) {
	yes := []string{
		`请求失败: Get "https://x.org/a.jpg": dial tcp 1.2.3.4:443: i/o timeout`,
		"请求失败: httpproxy: got HTTP status code 503",
		"响应体读取失败: unexpected EOF",
		"HTTP 503", // 实测形态：Go Transport 对 http 目标的代理非 2xx 是响应透传
		"HTTP 502 Bad Gateway",
	}
	no := []string{
		"SSRF 校验未过（非 http(s)/解析失败/私网地址）",
		"HTTP 404",
		"非图像响应: text/html",
		"响应体为空",
		"图像头校验未过（非图/越界像素）",
		"图像解码失败: invalid JPEG",
		"落盘失败: permission denied",
	}
	for _, r := range yes {
		if !isNetworkLikeCoverReason(r) {
			t.Fatalf("网络类应回退: %q", r)
		}
	}
	for _, r := range no {
		if isNetworkLikeCoverReason(r) {
			t.Fatalf("确定性失败不应回退: %q", r)
		}
	}
}

// fakeProxyServer 伪 HTTP 代理：不转发，按脚本直接应答（Go Transport 的 ProxyURL 通道
// 对 http 目标发绝对 URI 请求 → handler 正常消费；客户端无感）。返回命中计数器。
func fakeProxyServer(t *testing.T, status int, ctype string, body []byte) (*httptest.Server, *atomic.Int64) {
	t.Helper()
	var hits atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", ctype)
		w.WriteHeader(status)
		_, _ = w.Write(body)
	}))
	return srv, &hits
}

// withCoverFallbackProxies 注入候选来源并在测试结束后还原生产实现。
func withCoverFallbackProxies(t *testing.T, calls *atomic.Int64, candidates []string) {
	t.Helper()
	old := coverFallbackProxies
	coverFallbackProxies = func(string) []string {
		calls.Add(1)
		return candidates
	}
	t.Cleanup(func() { coverFallbackProxies = old })
}

// TestFetchCoverWithFallbackReachesFallbackProxy 端到端：primary 代理 503（网络类）→
// 回退候选伪代理直接返回合法 JPEG → 落盘成功、cover 字段语义（/covers/{id}.jpg）保持。
func TestFetchCoverWithFallbackReachesFallbackProxy(t *testing.T) {
	jpg := tinyJPEGBytes(t)
	bad, _ := fakeProxyServer(t, http.StatusServiceUnavailable, "text/plain", []byte("no"))
	defer bad.Close()
	ok, okHits := fakeProxyServer(t, http.StatusOK, "image/jpeg", jpg)
	defer ok.Close()

	var calls atomic.Int64
	withCoverFallbackProxies(t, &calls, []string{bad.URL, ok.URL})

	// primary=伪代理 503（直连 primary 无法在单测中「快速且确定」地网络失败——真直连
	// 会触外网；回退判定作用在 reason 前缀上与 primary 形态无关，代理形态已足覆盖）
	stored, reason := fetchCoverWithFallback(95301, "http://203.0.113.99/cover.jpg", bad.URL, time.Time{})
	if stored != "/covers/95301.jpg" {
		t.Fatalf("应经回退成功落盘，got %q（reason=%q）", stored, reason)
	}
	t.Cleanup(func() { removeCoverArtifact(t, 95301) })
	if okHits.Load() != 1 {
		t.Fatalf("回退出口应恰好命中 1 次，got %d", okHits.Load())
	}
}

// TestFetchCoverWithFallbackSkipsPrimaryProxy primary 与候选同值去重：primary 已试过
// 的出口不再重复尝试；候选内首个有效出口成功即止。
func TestFetchCoverWithFallbackSkipsPrimaryProxy(t *testing.T) {
	jpg := tinyJPEGBytes(t)
	bad, badHits := fakeProxyServer(t, http.StatusServiceUnavailable, "text/plain", []byte("no"))
	defer bad.Close()
	ok, okHits := fakeProxyServer(t, http.StatusOK, "image/jpeg", jpg)
	defer ok.Close()

	var calls atomic.Int64
	withCoverFallbackProxies(t, &calls, []string{bad.URL, ok.URL})

	stored, reason := fetchCoverWithFallback(95302, "http://203.0.113.99/cover.jpg", bad.URL, time.Time{})
	if stored != "/covers/95302.jpg" {
		t.Fatalf("应经候选成功，got %q（reason=%q）", stored, reason)
	}
	t.Cleanup(func() { removeCoverArtifact(t, 95302) })
	if badHits.Load() != 1 {
		t.Fatalf("primary 出口应恰好被试 1 次，got %d", badHits.Load())
	}
	if okHits.Load() != 1 {
		t.Fatalf("回退出口应恰好被试 1 次，got %d", okHits.Load())
	}
}

// TestFetchCoverWithFallbackNoRetryOnDeterministic 确定性失败（404）零回退：
// 候选来源甚至不应被查询（fetchAndStoreCover 一次尝试后直接返回首因）。
func TestFetchCoverWithFallbackNoRetryOnDeterministic(t *testing.T) {
	jpg := tinyJPEGBytes(t)
	notFound, _ := fakeProxyServer(t, http.StatusNotFound, "image/jpeg", jpg)
	defer notFound.Close()

	var calls atomic.Int64
	withCoverFallbackProxies(t, &calls, []string{"http://203.0.113.1:1"})

	stored, reason := fetchCoverWithFallback(95303, "http://203.0.113.99/cover.jpg", notFound.URL, time.Time{})
	if stored != "" || reason != "HTTP 404" {
		t.Fatalf("确定性失败应原样透出首因，got %q/%q", stored, reason)
	}
	if calls.Load() != 0 {
		t.Fatalf("确定性失败不应查询候选来源，got %d 次", calls.Load())
	}
}

// TestFetchCoverWithFallbackBudgetExhausted 回退预算截断：hardDeadline 已过 → 候选零尝试、
// 首因原样返回（不带「代理回退×N」后缀；attempted 语义=本书已按预算处理完）。
func TestFetchCoverWithFallbackBudgetExhausted(t *testing.T) {
	bad, badHits := fakeProxyServer(t, http.StatusServiceUnavailable, "text/plain", []byte("no"))
	defer bad.Close()
	second, secondHits := fakeProxyServer(t, http.StatusOK, "image/jpeg", tinyJPEGBytes(t))
	defer second.Close()

	var calls atomic.Int64
	withCoverFallbackProxies(t, &calls, []string{second.URL})

	stored, reason := fetchCoverWithFallback(95304, "http://203.0.113.99/cover.jpg", bad.URL,
		time.Now().Add(-time.Second))
	if stored != "" || reason == "" || !isNetworkLikeCoverReason(reason) {
		t.Fatalf("预算耗尽应以首因返回，got %q/%q", stored, reason)
	}
	if calls.Load() != 1 {
		t.Fatalf("候选来源应查询 1 次（轻量读库无害），got %d", calls.Load())
	}
	if badHits.Load() != 1 || secondHits.Load() != 0 {
		t.Fatalf("应仅 primary 尝试 1 次、候选零尝试，got primary=%d second=%d",
			badHits.Load(), secondHits.Load())
	}
}

// TestFetchCoverWithFallbackNoCandidates 候选为空：行为退化为单出口（首因原样返回，
// 不劣于修复前）。
func TestFetchCoverWithFallbackNoCandidates(t *testing.T) {
	bad, badHits := fakeProxyServer(t, http.StatusServiceUnavailable, "text/plain", []byte("no"))
	defer bad.Close()

	var calls atomic.Int64
	withCoverFallbackProxies(t, &calls, nil)

	stored, reason := fetchCoverWithFallback(95305, "http://203.0.113.99/cover.jpg", bad.URL, time.Time{})
	if stored != "" || reason == "" {
		t.Fatalf("无候选应首因返回，got %q/%q", stored, reason)
	}
	if calls.Load() != 1 {
		t.Fatalf("候选来源应恰好查询 1 次，got %d", calls.Load())
	}
	if badHits.Load() != 1 {
		t.Fatalf("primary 出口应恰好被试 1 次，got %d", badHits.Load())
	}
}

// removeCoverArtifact 测试落盘产物清理（coversDir 为生产共享目录，逐件删除防污染）。
func removeCoverArtifact(t *testing.T, novelID int) {
	t.Helper()
	_ = os.Remove(coversDir() + "/" + itoa(novelID) + ".jpg")
}
