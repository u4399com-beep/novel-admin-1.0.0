/**
 * worker_fillorder_test.go —— R112 填充顺序 UX 优化回归锁定：
 *
 * 旧序：fillMap 按 novelId 升序逐本填充——aijjxs 实证 51 本中最新扫描的 21 本全部
 * 排在队尾，数小时零新书正文产出，用户体感「正文采集全部失败」。
 * 新序：①零填充书优先（新扫描书立即出进度）②同类内待填充少者优先（小书先完结，
 * 更多本尽快可读）③同级 novelId 升序确定性。
 *
 * TestPhase2FillZeroFilledBooksFirst：三书同域（串行单组）——
 *   book 301：已有正文 1 章 + 待填 1 章（有填充 → 最后）
 *   book 302：零填充 + 待填 1 章（零填充且最小 → 最先）
 *   book 303：零填充 + 待填 2 章（零填充次之）
 * 断言引擎请求的首现顺序 = [302, 303, 301]，总调用 4 次。
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

func TestPhase2FillZeroFilledBooksFirst(t *testing.T) {
	var mu sync.Mutex
	var order []string // 引擎收到的章节 URL 序（按真实处理顺序）

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var payload map[string]any
		_ = json.Unmarshal(body, &payload)
		u, _ := payload["url"].(string)
		mu.Lock()
		order = append(order, u)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"data":{"title":"第1章 桩","content":"这是桩正文内容，长度足够通过空壳判定。"},"warnings":[],"elapsedMs":3}`))
	}))
	t.Cleanup(srv.Close)
	t.Setenv("BACKEND_ENGINE_URL", srv.URL)
	seedRunningTaskForTest(t, 990_930, "https://order.example/book")

	// 种三本书：301 有填充，302/303 零填充
	for _, nid := range []int{301, 302, 303} {
		seedNovelForFill(t, nid)
	}
	// book 301：1 章已有正文（wordCount>0）+ 1 章待填
	seedChapterSkeleton(t, 990_931, 301, 1, "第1章 旧章")
	if db, err := getDB(); err != nil {
		t.Fatalf("open db: %v", err)
	} else if _, err := db.Exec(`UPDATE "Chapter" SET "wordCount" = 5 WHERE "id" = 990931`); err != nil {
		t.Fatalf("mark filled: %v", err)
	}
	seedChapterSkeleton(t, 990_932, 301, 2, "第1章 301待填")

	// book 302：1 章待填（零填充最小）
	seedChapterSkeleton(t, 990_933, 302, 1, "第1章 302待填")
	// book 303：2 章待填（零填充次之）
	seedChapterSkeleton(t, 990_934, 303, 1, "第1章 303待填A")
	seedChapterSkeleton(t, 990_935, 303, 2, "第1章 303待填B")

	fillMap := map[int]fillPlan{
		301: {Referer: "https://order.example/book/301", Rows: []refPair{{Title: "第1章 301待填", URL: "https://order.example/bk301/ch2.html"}}},
		302: {Referer: "https://order.example/book/302", Rows: []refPair{{Title: "第1章 302待填", URL: "https://order.example/bk302/ch1.html"}}},
		303: {Referer: "https://order.example/book/303", Rows: []refPair{
			{Title: "第1章 303待填A", URL: "https://order.example/bk303/ch1.html"},
			{Title: "第1章 303待填B", URL: "https://order.example/bk303/ch2.html"},
		}},
	}

	run := NewRun(990_930)
	out := phase2Fill(run, LoadedRule{}, fillMap, "db", func(int) bool { return true })

	if out.Filled != 4 {
		t.Fatalf("应填充 4 章，got %d（日志：%s）", out.Filled, run.LogText())
	}
	mu.Lock()
	defer mu.Unlock()
	if len(order) != 4 {
		t.Fatalf("引擎应收到 4 次请求，got %d: %v", len(order), order)
	}
	// 首现书序：302（零填充 1 章）→ 303（零填充 2 章）→ 301（有填充垫底）
	firstOf := map[string]int{}
	for i, u := range order {
		for bk := range []string{"bk301", "bk302", "bk303"} {
			if strings.Contains(u, "/bk"+[]string{"301", "302", "303"}[bk]+"/") {
				name := []string{"301", "302", "303"}[bk]
				if _, ok := firstOf[name]; !ok {
					firstOf[name] = i
				}
			}
		}
	}
	got := []string{"302", "303", "301"}
	last := -1
	for _, name := range got {
		idx, ok := firstOf[name]
		if !ok {
			t.Fatalf("书 %s 的章节从未被请求，order=%v", name, order)
		}
		if idx <= last {
			t.Fatalf("填充顺序错位：期望 302→303→301，实际 order=%v", order)
		}
		last = idx
	}
}
