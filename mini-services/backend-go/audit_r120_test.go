/**
 * audit_r120_test.go —— R120（waitSelector 关键选择器等待全链透传）回归锁定：
 *
 * 1) TestCssSafeWaitSelectorBackend：与 scraper-go 同语义双实现——DSL 专有语法拒绝、
 *    纯 CSS 放行、长度钳 256（两服务独立构建无共享包，双侧锁定防漂移）。
 * 2) TestEngineRuleBodyWait：engineRuleBodyWait 组装契约——选择器透传/DSL 剔除/
 *    minTier 等既有字段不受影响。
 * 3) TestFetchCallSitesWaitSelector：四个调用点各自取「该页主提取选择器」——
 *    fetchListPage→itemSelector、fetchBookPage→titleSelector、fetchTocPage→
 *    chapterLinkSelector、fetchChapter→contentSelector；DSL 选择器（washai 的
 *    a:contains(下一页) 形态）整体不透传（零行为变化红线）。
 * 引擎经 BACKEND_ENGINE_URL httptest stub 注入（audit49b 同款，零真实网络）。
 */
package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestCssSafeWaitSelectorBackend(t *testing.T) {
	cases := []struct {
		name, in, want string
	}{
		{"纯 CSS 放行", "ol.custom-rank-list li.rank-item", "ol.custom-rank-list li.rank-item"},
		{"空白裁剪", " div.read-content ", "div.read-content"},
		{":contains 拒绝", "a:contains(下一页)", ""},
		{"aref DSL 拒绝", "aref*='/menu/']", ""},
		{"ownText 拒绝", "ownText", ""},
		{"超长拒绝", strings.Repeat("a", 257), ""},
		{"空串", "", ""},
	}
	for _, c := range cases {
		if got := cssSafeWaitSelector(c.in); got != c.want {
			t.Errorf("[%s] = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestEngineRuleBodyWait(t *testing.T) {
	rule := LoadedRule{
		Name:    "r120桩",
		MinTier: 3,
		ListRule: RuleMap{
			"itemSelector": "ol.custom-rank-list li.rank-item",
			"linkSelector": "p.rank-t a",
		},
	}
	body := engineRuleBodyWait("https://x.example/list", map[string]any{"listRule": rule.ListRule}, rule, "", rule.ListRule["itemSelector"])
	if body["waitSelector"] != "ol.custom-rank-list li.rank-item" {
		t.Fatalf("waitSelector 应透传，got %v", body["waitSelector"])
	}
	if body["minTier"] != 3 {
		t.Fatalf("minTier 既有透传不得受影响，got %v", body["minTier"])
	}
	// DSL 选择器：整体剔除（该页不等待，零行为变化）
	dsl := LoadedRule{Name: "dsl", ListRule: RuleMap{"itemSelector": "a:contains(下一页)"}}
	body2 := engineRuleBodyWait("https://x.example/l", map[string]any{"listRule": dsl.ListRule}, dsl, "", dsl.ListRule["itemSelector"])
	if _, exists := body2["waitSelector"]; exists {
		t.Fatalf("DSL 选择器不得透传（wait_for_selector 非法），got %v", body2["waitSelector"])
	}
	// 空选择器：不下发键
	body3 := engineRuleBodyWait("https://x.example/l", map[string]any{}, LoadedRule{}, "", "")
	if _, exists := body3["waitSelector"]; exists {
		t.Fatalf("空选择器不得下发 waitSelector 键")
	}
}

// capturedBody 捕获引擎请求体（并发安全）
type capturedBody struct {
	mu   sync.Mutex
	body map[string]any
}

func (c *capturedBody) snapshot() map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.body
}

func stubEngineCapture(t *testing.T, resp string) *capturedBody {
	t.Helper()
	cap := &capturedBody{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		b := map[string]any{}
		_ = json.Unmarshal(raw, &b)
		cap.mu.Lock()
		cap.body = b
		cap.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(resp))
	}))
	t.Cleanup(srv.Close)
	t.Setenv("BACKEND_ENGINE_URL", srv.URL)
	return cap
}

func TestFetchCallSitesWaitSelector(t *testing.T) {
	rule := LoadedRule{
		Name: "r120调用点",
		ListRule: RuleMap{
			"itemSelector":  "ol.custom-rank-list li.rank-item",
			"titleSelector": "p.rank-t a",
		},
		BookRule: RuleMap{
			"titleSelector":       "h2.works-intro-title strong",
			"chapterLinkSelector": ".chapter-page-new a",
		},
		ChapterRule: RuleMap{"contentSelector": "div.read-content", "titleSelector": "h3.j_chapterName"},
	}

	// fetchListPage → itemSelector
	cap := stubEngineCapture(t, `{"ok":true,"data":{"list":{"items":[{"title":"书","url":"https://x.example/b1"}]}},"warnings":[]}`)
	run := NewRun(1200_001)
	if _, err := fetchListPage(run, "https://x.example/list", rule, ""); err != "" {
		t.Fatalf("fetchListPage 不应失败: %s", err)
	}
	if got := cap.snapshot()["waitSelector"]; got != "ol.custom-rank-list li.rank-item" {
		t.Fatalf("fetchListPage 应透传 itemSelector，got %v", got)
	}

	// fetchBookPage → titleSelector
	cap2 := stubEngineCapture(t, `{"ok":true,"data":{"book":{"title":"测试书"}},"warnings":[]}`)
	if bp := fetchBookPage(run, "https://x.example/book/1", rule, "", true); !bp.OK {
		t.Fatalf("fetchBookPage 不应失败: %s", bp.Err)
	}
	if got := cap2.snapshot()["waitSelector"]; got != "h2.works-intro-title strong" {
		t.Fatalf("fetchBookPage 应透传 titleSelector，got %v", got)
	}

	// fetchTocPage → chapterLinkSelector
	cap3 := stubEngineCapture(t, `{"ok":true,"data":{"book":{"chapters":[{"title":"第1章","url":"https://x.example/c1"}]}},"warnings":[]}`)
	if _, _, ok := fetchTocPage(run, "https://x.example/menu/1", rule, "", true); !ok {
		t.Fatalf("fetchTocPage 不应失败")
	}
	if got := cap3.snapshot()["waitSelector"]; got != ".chapter-page-new a" {
		t.Fatalf("fetchTocPage 应透传 chapterLinkSelector，got %v", got)
	}

	// fetchChapter → contentSelector
	cap4 := stubEngineCapture(t, `{"ok":true,"data":{"title":"第1章","content":"正文内容足够长以通过空壳判定"},"warnings":[]}`)
	if res := fetchChapter("https://x.example/c1", rule, ""); !res.OK {
		t.Fatalf("fetchChapter 不应失败: %s", res.Error)
	}
	if got := cap4.snapshot()["waitSelector"]; got != "div.read-content" {
		t.Fatalf("fetchChapter 应透传 contentSelector，got %v", got)
	}

	// DSL 正文选择器（washai 形态体系）：fetchChapter 整体不透传
	dslRule := LoadedRule{Name: "dsl", ChapterRule: RuleMap{"contentSelector": "a:contains(下一页)"}}
	cap5 := stubEngineCapture(t, `{"ok":true,"data":{"title":"第1章","content":"正文内容足够长以通过空壳判定"},"warnings":[]}`)
	if res := fetchChapter("https://x.example/c2", dslRule, ""); !res.OK {
		t.Fatalf("fetchChapter(dsl) 不应失败: %s", res.Error)
	}
	if _, exists := cap5.snapshot()["waitSelector"]; exists {
		t.Fatalf("DSL contentSelector 不得透传")
	}
}
