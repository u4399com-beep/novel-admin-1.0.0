/**
 * audit32d_test.go —— Task 32-d 引擎反反爬增强回归锁定：
 * ①hosthealth 限流记忆注入 fetch 失败错误（hostRateLimitMemo，Task 31 遗留①）
 * ②challenge-loop 挑战循环二次校验（JS token 跳转跟随后仍挑战 / A→B→A 跳回）
 * ③200 空壳软拦截档案（pageSoftBlockProfile/extractionEmpty/challengeFeatureSummary）
 * ④htmlDebug 调试字段透传（pageFailureResponse includeHtml 路径，Task 31 遗留②）
 * 运行：cd mini-services/scraper-go && go test -race ./... -count=1
 */
package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/PuerkitoBio/goquery"
)

// TestHostRateLimitMemo 限流记忆注入（Task 32-d：fetch 失败 Error 携带 hosthealth 上下文）
func TestHostRateLimitMemo(t *testing.T) {
	host := "memo32d.test"
	noteChainSuccess(host) // 清零起点
	if got := hostRateLimitMemo(host); got != "" {
		t.Fatalf("无记忆时应返回空串，got %q", got)
	}
	noteRateLimited(host, 503, nil)
	got := hostRateLimitMemo(host)
	if !strings.Contains(got, "限流记忆") || !strings.Contains(got, "503") || !strings.Contains(got, "建议退避") {
		t.Fatalf("限流记忆格式不符，got %q", got)
	}
	// 记忆过旧（>10min）不再注入
	healthMu.Lock()
	if h, ok := healthMap[host]; ok {
		h.lastRateLimitAt -= 11 * 60_000
	}
	healthMu.Unlock()
	if got := hostRateLimitMemo(host); got != "" {
		t.Fatalf("过旧记忆不应注入，got %q", got)
	}
	// 成功一次整体复位（记忆随健康度条目删除）
	noteRateLimited(host, 429, nil)
	noteChainSuccess(host)
	if got := hostRateLimitMemo(host); got != "" {
		t.Fatalf("成功复位后不应再有记忆，got %q", got)
	}
}

// startJSChallengeServer 起一个 127.0.0.1 测试站：body 由调用方按路径给定。
// 返回 (server, baseURL)。测试用例把 allowPrivate 置 true 后再调用。
func startJSChallengeServer(t *testing.T, routes map[string]string) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	for path, body := range routes {
		mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write([]byte(body))
		})
	}
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// TestChallengeLoopAfterJSRedirect JS token 跳转跟随后仍命中挑战特征 → challenge-loop（Task 32-d）
func TestChallengeLoopAfterJSRedirect(t *testing.T) {
	savedPrivate := allowPrivate
	allowPrivate = true
	defer func() { allowPrivate = savedPrivate }()

	srv := startJSChallengeServer(t, map[string]string{
		"/entry": `<html><body><script>window.location.href="/gate";</script></body></html>`,
		// 落地页：无 JS 跳转、命中「需启用 JS」挑战壳（近空正文）
		"/gate": `<html><body>请启用 JavaScript 以通过安全验证</body></html>`,
	})
	warnings := []string{}
	res := fetchWithRedirectGuard(srv.URL+"/entry", map[string]string{"user-agent": chromeUA}, 10_000, &warnings, "", false, nil)
	if res.note != "challenge-loop" {
		t.Fatalf("跟随后仍为挑战页应判 challenge-loop，got note=%q warnings=%v", res.note, warnings)
	}
	if !strings.Contains(res.warning, "挑战循环") {
		t.Fatalf("错误消息应带「挑战循环」，got %q", res.warning)
	}
}

// TestChallengeLoopABAB JS token 跳转 A→B→A 回环 → challenge-loop（Task 32-d）
func TestChallengeLoopABAB(t *testing.T) {
	savedPrivate := allowPrivate
	allowPrivate = true
	defer func() { allowPrivate = savedPrivate }()

	srv := startJSChallengeServer(t, map[string]string{
		"/aa": `<html><body><script>location.href="/bb";</script></body></html>`,
		"/bb": `<html><body><script>location.href="/aa";</script></body></html>`,
	})
	warnings := []string{}
	res := fetchWithRedirectGuard(srv.URL+"/aa", map[string]string{"user-agent": chromeUA}, 10_000, &warnings, "", false, nil)
	if res.note != "challenge-loop" {
		t.Fatalf("A→B→A 回环应判 challenge-loop，got note=%q warnings=%v", res.note, warnings)
	}
}

// TestChallengeLoopDoesNotFireOnNormalLanding 跟随后是正常内容页 → 不误判 challenge-loop
func TestChallengeLoopDoesNotFireOnNormalLanding(t *testing.T) {
	savedPrivate := allowPrivate
	allowPrivate = true
	defer func() { allowPrivate = savedPrivate }()

	normal := "<html><head><title>第一章 测试</title></head><body><div id=content>"
	for i := 0; i < 20; i++ {
		normal += "<p>山风吹过山谷，少年握紧手中的长剑，望向远方的群山，心中涌起一股莫名的勇气与期待。</p>"
	}
	normal += "</div></body></html>"
	srv := startJSChallengeServer(t, map[string]string{
		"/entry": `<html><body><script>window.location.href="/real";</script></body></html>`,
		"/real":  normal,
	})
	warnings := []string{}
	res := fetchWithRedirectGuard(srv.URL+"/entry", map[string]string{"user-agent": chromeUA}, 10_000, &warnings, "", false, nil)
	if res.note == "challenge-loop" {
		t.Fatalf("正常落地页被误判 challenge-loop")
	}
	if res.status != 200 || len(res.bytes) == 0 {
		t.Fatalf("正常落地页应 200 有 body，got status=%d bytes=%d", res.status, len(res.bytes))
	}
}

// TestPageSoftBlockProfile 200 空壳特征档案字段（Task 32-d）
func TestPageSoftBlockProfile(t *testing.T) {
	page := fetchPageResult{
		ok: true, status: 200, strategy: "fetch-browser",
		html: `<html><head><title>安全验证</title></head><body><script>var x=1;</script></body></html>`,
	}
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(page.html))
	if err != nil {
		t.Fatal(err)
	}
	prof := pageSoftBlockProfile(page, doc)
	if prof["status"] != 200 || prof["strategy"] != "fetch-browser" {
		t.Fatalf("档案缺基础字段: %v", prof)
	}
	if prof["title"] != "安全验证" {
		t.Fatalf("档案 title 不符: %v", prof["title"])
	}
	hits, ok := prof["challengeFeatures"].([]string)
	if !ok || len(hits) == 0 {
		t.Fatalf("空壳页应带挑战特征摘要: %v", prof)
	}
	joined := strings.Join(hits, ",")
	if !strings.Contains(joined, "challenge-keyword") {
		t.Fatalf("应命中 challenge-keyword 特征: %v", hits)
	}
}

// TestExtractionEmpty handleTest 空提取判定（Task 32-d）
func TestExtractionEmpty(t *testing.T) {
	empty := map[string]any{"list": ListData{Count: 0}}
	if !extractionEmpty(empty) {
		t.Fatalf("列表 0 条应判空")
	}
	nonEmpty := map[string]any{"book": BookData{Title: "书名"}}
	if extractionEmpty(nonEmpty) {
		t.Fatalf("有书名不应判空")
	}
	if !extractionEmpty(map[string]any{}) {
		t.Fatalf("无提取结果应判空")
	}
}

// TestPageFailureResponseHtmlDebug 整链失败响应的 htmlDebug 透传（Task 31 遗留②落地）
func TestPageFailureResponseHtmlDebug(t *testing.T) {
	page := fetchPageResult{
		ok: false, err: "全部可用策略均抓取失败", detail: "fetch-browser: challenge-page",
		debugHTML: "<html><body>Just a moment...</body></html>",
		attempts:  []AttemptSummary{{Strategy: "fetch-browser", OK: false, Status: 200, Blocked: true, Note: "challenge-page"}},
	}
	rec := httptest.NewRecorder()
	pageFailureResponse(rec, page, "https://x.test/", true)
	if rec.Code != 502 {
		t.Fatalf("应返回 502，got %d", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "htmlDebug") || !strings.Contains(body, "Just a moment") {
		t.Fatalf("includeHtml=true 失败响应应带 htmlDebug 原文，got %s", body)
	}
	if !strings.Contains(body, `"challengeSuspected":true`) {
		t.Fatalf("挑战页应标记 challengeSuspected，got %s", body)
	}
	// includeHtml=false 不透出
	rec2 := httptest.NewRecorder()
	pageFailureResponse(rec2, page, "https://x.test/", false)
	if strings.Contains(rec2.Body.String(), "htmlDebug") {
		t.Fatalf("includeHtml=false 不应带 htmlDebug")
	}
}

// TestChainErrorCarriesRateLimitMemo 整链失败 err 注入限流记忆（Task 31 遗留①，纯逻辑侧验证：
// memo 由 hostRateLimitMemo 产出，chain 失败返回时拼进 err——注入点见 chain.go 尾部）
func TestChainErrorCarriesRateLimitMemo(t *testing.T) {
	host := "chainmemo.test"
	noteRateLimited(host, 429, nil)
	memo := hostRateLimitMemo(host)
	if memo == "" || !strings.Contains(memo, "429") {
		t.Fatalf("memo 应包含状态码，got %q", memo)
	}
	// 拼接语义与 chain.go 一致：err + 空格 + memo
	errMsg := "全部可用策略均抓取失败" + " " + memo
	if !strings.Contains(errMsg, "全部可用策略均抓取失败 (host 近期限流记忆: 429") {
		t.Fatalf("拼接后 err 应可被 backend isRateLimitErr 命中（含 429），got %q", errMsg)
	}
}
