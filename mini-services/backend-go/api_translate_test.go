/**
 * api_translate_test.go —— R137 翻译代理回归锁定：
 *   1. 校验分支（target 白名单/items 规模/总量上限）——不触上游不触缓存表
 *   2. 缓存优先 + 上游补齐 + 回写闭环（httptest fake 上游，调用计数验证二次命中不再打上游）
 *   3. 失败段留空契约（上游返回空串 → 前端保留原文，不编造）
 *   4. ADMIN_TOKEN 启用态 /api/translate 豁免（读者侧功能不被管理写保护拦截）
 *   5. per-IP 滑窗限流计数
 * 复用 recover_test.go 的 TestMain 临时库（绝不触碰生产 db/custom.db）。
 */
package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func mustInitTranslationCacheTable(t *testing.T) {
	t.Helper()
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS "TranslationCache" (
                "key" TEXT NOT NULL PRIMARY KEY,
                "target" TEXT NOT NULL,
                "content" TEXT NOT NULL,
                "novelId" INTEGER NOT NULL DEFAULT 0,
                "createdAt" INTEGER NOT NULL DEFAULT 0
        )`); err != nil {
		t.Fatalf("create TranslationCache: %v", err)
	}
	t.Cleanup(func() {
		_, _ = db.Exec(`DELETE FROM "TranslationCache"`)
	})
}

func translatePost(body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/api/translate", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = "203.0.113.7:12345"
	rec := httptest.NewRecorder()
	handleTranslatePost(rec, req, nil)
	return rec
}

func TestHandleTranslatePostValidation(t *testing.T) {
	mustInitTranslationCacheTable(t)
	cases := []struct {
		name string
		body string
		want int
	}{
		{"bad json", `not-json`, 400},
		{"bad target", `{"target":"fr","items":["测试"]}`, 400},
		{"empty items", `{"target":"en","items":[]}`, 400},
		{"too many items", `{"target":"en","items":[` + strings.Repeat(`"a",`, 301) + `"b"]}`, 400},
		{"item too long", `{"target":"en","items":["` + strings.Repeat("字", 10001) + `"]}`, 400},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec := translatePost(c.body)
			if rec.Code != c.want {
				t.Fatalf("status = %d, want %d", rec.Code, c.want)
			}
		})
	}
}

func TestHandleTranslatePostCacheHitAndUpstream(t *testing.T) {
	mustInitTranslationCacheTable(t)
	var upstreamCalls int32
	// fake 上游：固定译文 + 调用计数
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&upstreamCalls, 1)
		var body struct {
			Target string   `json:"target"`
			Items  []string `json:"items"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		results := make([]string, len(body.Items))
		for i := range body.Items {
			results[i] = "T(" + body.Items[i] + ")"
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "results": results})
	}))
	defer up.Close()
	oldURL := translateServiceBaseURL
	translateServiceBaseURL = up.URL
	defer func() { translateServiceBaseURL = oldURL }()

	// 首次：走上游 + 回写缓存
	rec := translatePost(`{"target":"en","items":["段落甲","段落乙"],"novelId":7,"chapterId":3}`)
	if rec.Code != 200 {
		t.Fatalf("first call status = %d: %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		OK         bool     `json:"ok"`
		Results    []string `json:"results"`
		Cached     int      `json:"cached"`
		Translated int      `json:"translated"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode resp: %v", err)
	}
	if !resp.OK || len(resp.Results) != 2 || resp.Results[0] != "T(段落甲)" || resp.Translated != 2 {
		t.Fatalf("first call resp = %+v", resp)
	}
	if atomic.LoadInt32(&upstreamCalls) != 1 {
		t.Fatalf("upstreamCalls = %d, want 1", upstreamCalls)
	}

	// 二次同文：全缓存命中，上游零调用
	rec2 := translatePost(`{"target":"en","items":["段落甲","段落乙"],"novelId":7,"chapterId":3}`)
	if rec2.Code != 200 {
		t.Fatalf("second call status = %d", rec2.Code)
	}
	var resp2 struct {
		Cached     int `json:"cached"`
		Translated int `json:"translated"`
	}
	_ = json.Unmarshal(rec2.Body.Bytes(), &resp2)
	if resp2.Cached != 2 || resp2.Translated != 0 {
		t.Fatalf("second call cached=%d translated=%d, want 2/0", resp2.Cached, resp2.Translated)
	}
	if atomic.LoadInt32(&upstreamCalls) != 1 {
		t.Fatalf("upstreamCalls after cache hit = %d, want 1", upstreamCalls)
	}
}

func TestHandleTranslatePostFailedSegmentKeepsEmpty(t *testing.T) {
	mustInitTranslationCacheTable(t)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 上游契约：失败段返回空串（前端保留原文，不编造）
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "results": []string{"", "ok-seg"}})
	}))
	defer up.Close()
	oldURL := translateServiceBaseURL
	translateServiceBaseURL = up.URL
	defer func() { translateServiceBaseURL = oldURL }()

	rec := translatePost(`{"target":"zh-Hant","items":["段一","段二"]}`)
	if rec.Code != 200 {
		t.Fatalf("status = %d", rec.Code)
	}
	var resp struct {
		Results     []string `json:"results"`
		FailedCount int      `json:"failedCount"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if len(resp.Results) != 2 || resp.Results[0] != "" || resp.Results[1] != "ok-seg" {
		t.Fatalf("resp = %+v", resp)
	}
	if resp.FailedCount != 1 {
		t.Fatalf("failedCount = %d, want 1", resp.FailedCount)
	}
}

func TestAdminWriteExemptTranslate(t *testing.T) {
	old, _ := adminTokenAtomic.Load().(string) // 未初始化时 Load 返回 nil，兜底空串（Store(nil) 会 panic）
	adminTokenAtomic.Store("test-token-137")
	defer adminTokenAtomic.Store(old)

	req := httptest.NewRequest(http.MethodPost, "/api/translate", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()
	blocked := adminWriteBlocked(rec, req)
	if blocked {
		t.Fatalf("/api/translate POST should be exempt from admin write protection")
	}
	// 对照组：未豁免路径仍然拦截
	req2 := httptest.NewRequest(http.MethodPost, "/api/scrape-tasks", strings.NewReader(`{}`))
	rec2 := httptest.NewRecorder()
	if !adminWriteBlocked(rec2, req2) {
		t.Fatalf("non-exempt POST should be blocked")
	}
}

func TestTranslateRateAllow(t *testing.T) {
	ip := "198.51.100.99"
	translateRateState.Lock()
	delete(translateRateState.hits, ip)
	translateRateState.Unlock()
	defer func() {
		translateRateState.Lock()
		delete(translateRateState.hits, ip)
		translateRateState.Unlock()
	}()
	for i := 0; i < translateRateLimit; i++ {
		if !translateRateAllow(ip) {
			t.Fatalf("request %d unexpectedly blocked", i+1)
		}
	}
	if translateRateAllow(ip) {
		t.Fatalf("request %d should be rate limited", translateRateLimit+1)
	}
}

func TestTranslateCacheKeyStable(t *testing.T) {
	a := translateCacheKey("同一文本", "en")
	b := translateCacheKey("同一文本", "en")
	c := translateCacheKey("同一文本", "zh-Hant")
	if a != b {
		t.Fatalf("cache key not deterministic")
	}
	if a == c {
		t.Fatalf("different targets must not collide")
	}
	if !strings.HasSuffix(a, "|en") {
		t.Fatalf("key should carry target suffix: %s", a)
	}
}
