/**
 * audit85b_test.go —— R86 目录截断修复回归锁定（backend-go 侧）：
 *
 * 根因 ②：配置 chapterListApi 的站点（ixdzs8），书页内嵌仅「最新 8 章」，完整目录靠同源
 * JSON 接口。引擎域限速排队超预算 shed 该接口时（响应 warnings 可见），旧 fetchBookPage
 * 照单全收截断目录 → 86 本书全部只入库 8 章。
 *
 * 修复：fetchBookPageWithTocRetry 小目录护栏——内嵌章节数 < tocShedSmallToc 且出现
 * shed 警告时退避重抓（最多 tocShedRetries 次）；bookPageResult 透出 warnings。
 *
 * 本文件锁定：tocShedTruncated 判定全分支、bookChapterCount nil 安全、
 * fetchBookPageWithTocRetry 端到端重试行为（stub 引擎）。
 */
package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

// ---------- ① tocShedTruncated 判定 ----------

func TestTocShedTruncatedBranches(t *testing.T) {
	mk := func(count int) bookPageResult {
		n := count
		return bookPageResult{
			OK:       true,
			Book:     BookData{Title: "书", ChapterCount: &n},
			Warnings: []string{"chapterListApi：域限速排队超预算，已跳过 JSON 目录提取（引擎准入拒绝，不影响书页内嵌目录）"},
		}
	}
	cases := []struct {
		name string
		page bookPageResult
		want bool
	}{
		{"小目录+shed 警告 → 截断", mk(8), true},
		{"0 章+shed 警告 → 截断", mk(0), true},
		{"大目录+shed 警告 → 非截断（内嵌已足够好，不重试）", mk(1500), false},
		{
			"小目录+非 shed 警告 → 非截断",
			bookPageResult{OK: true, Book: func() BookData { n := 8; return BookData{Title: "书", ChapterCount: &n} }(),
				Warnings: []string{"chapterListApi：bookIdSelector 未命中，跳过"}},
			false,
		},
		{"小目录+无警告 → 非截断", bookPageResult{OK: true, Book: func() BookData { n := 8; return BookData{Title: "书", ChapterCount: &n} }()}, false},
	}
	for _, c := range cases {
		if got := tocShedTruncated(c.page); got != c.want {
			t.Fatalf("%s: tocShedTruncated = %v, want %v", c.name, got, c.want)
		}
	}
}

// ---------- ② bookChapterCount nil 安全 ----------

func TestBookChapterCountNilSafety(t *testing.T) {
	if got := bookChapterCount(BookData{}); got != 0 {
		t.Fatalf("nil ChapterCount 应得 0，got %d", got)
	}
	n := 7
	if got := bookChapterCount(BookData{ChapterCount: &n}); got != 7 {
		t.Fatalf("got %d, want 7", got)
	}
}

// ---------- ③ fetchBookPageWithTocRetry 端到端（stub 引擎） ----------

// stubBookResp 构造引擎 /api/test 书页响应
func stubBookResp(title string, count int, urlPrefix string, warnings []string) string {
	n := count
	chs := make([]map[string]any, 0, count)
	for i := 1; i <= count; i++ {
		chs = append(chs, map[string]any{
			"title": fmt.Sprintf("第%d章 测试", i),
			"url":   fmt.Sprintf("%s/ch/%d.html", urlPrefix, i),
		})
	}
	bj, _ := json.Marshal(map[string]any{"title": title, "chapterCount": n, "chapters": chs})
	obj := map[string]any{"ok": true, "data": map[string]any{"book": json.RawMessage(bj)}, "warnings": warnings}
	oj, _ := json.Marshal(obj)
	return string(oj)
}

func TestFetchBookPageWithTocRetryRecoversFullToc(t *testing.T) {
	var calls atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		if n == 1 {
			// 首抓：JSON 目录被 shed，仅内嵌 8 章
			_, _ = w.Write([]byte(stubBookResp("护栏恢复书", 8, "https://site.example/b1",
				[]string{"chapterListApi：域限速排队超预算，已跳过 JSON 目录提取（引擎准入拒绝，不影响书页内嵌目录）"})))
			return
		}
		// 重抓：JSON 目录成功，全量 120 章
		_, _ = w.Write([]byte(stubBookResp("护栏恢复书", 120, "https://site.example/b1", nil)))
	}))
	defer srv.Close()
	t.Setenv("BACKEND_ENGINE_URL", srv.URL)

	// stopState 查 ScrapeTask 行（缺失=canceled）：种 running 行让重试路径正常执行
	seedRunningTaskForTest(t, 990_850, "https://site.example/b1/")

	rule := LoadedRule{BookRule: RuleMap{"chapterListApi": `{"url":"/api/toc","bookIdSelector":"#bid","titleField":"name","urlTemplate":"/read/{bookId}"}`}}
	run := NewRun(990_850)
	page := fetchBookPageWithTocRetry(run, "https://site.example/b1/", rule, "")
	if !page.OK {
		t.Fatalf("书页应成功: %s", page.Err)
	}
	if got := bookChapterCount(page.Book); got != 120 {
		t.Fatalf("护栏应重抓并取回全量目录: got %d 章, want 120（calls=%d）", got, calls.Load())
	}
	if calls.Load() != 2 {
		t.Fatalf("应恰好重抓 1 次: calls=%d", calls.Load())
	}
}

func TestFetchBookPageWithTocRetryBoundedAndFallback(t *testing.T) {
	var calls atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		// 始终 shed：护栏重试耗尽后必须回退首次成功结果（旧语义），不得报错
		_, _ = w.Write([]byte(stubBookResp("持续截断书", 8, "https://site.example/b2",
			[]string{"chapterListApi：域限速排队超预算，已跳过 JSON 目录提取（引擎准入拒绝，不影响书页内嵌目录）"})))
	}))
	defer srv.Close()
	t.Setenv("BACKEND_ENGINE_URL", srv.URL)

	seedRunningTaskForTest(t, 990_851, "https://site.example/b2/")

	rule := LoadedRule{BookRule: RuleMap{"chapterListApi": `{"url":"/api/toc","bookIdSelector":"#bid","titleField":"name","urlTemplate":"/read/{bookId}"}`}}
	run := NewRun(990_851)
	page := fetchBookPageWithTocRetry(run, "https://site.example/b2/", rule, "")
	if !page.OK {
		t.Fatalf("重试耗尽后应保留首次成功结果: %s", page.Err)
	}
	if got := bookChapterCount(page.Book); got != 8 {
		t.Fatalf("回退结果应为首次书页: got %d 章, want 8", got)
	}
	if calls.Load() != 1+tocShedRetries {
		t.Fatalf("重试应有界（1+2=3 次抓取）: calls=%d", calls.Load())
	}
}

// seedRunningTaskForTest 向临时测试库种一条 running 任务行（stopState 语义：
// 记录缺失 = canceled，重试路径会在首次退避后停手——测试必须先登记任务）
func seedRunningTaskForTest(t *testing.T, id int, target string) {
	t.Helper()
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	if _, ierr := db.Exec(
		`INSERT INTO "ScrapeTask" ("id","mode","targetUrl","pages","storageMode","status","createdAt","updatedAt")
                 VALUES (?,'single',?,1,'db','running',?,?)`, id, target, nowMillis(), nowMillis()); ierr != nil {
		t.Fatalf("seed running task %d: %v", id, ierr)
	}
	t.Cleanup(func() { _, _ = db.Exec(`DELETE FROM "ScrapeTask" WHERE "id" = ?`, id) })
}

func TestFetchBookPageNoApiNoRetry(t *testing.T) {
	var calls atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(stubBookResp("无API书", 8, "https://site.example/b3",
			[]string{"chapterListApi：域限速排队超预算，已跳过 JSON 目录提取（引擎准入拒绝，不影响书页内嵌目录）"})))
	}))
	defer srv.Close()
	t.Setenv("BACKEND_ENGINE_URL", srv.URL)

	// 规则未配置 chapterListApi：护栏必须零开销直通（shed 警告也不触发重试）
	rule := LoadedRule{BookRule: RuleMap{"chapterLinkSelector": "#list a"}}
	run := NewRun(990_852)
	page := fetchBookPageWithTocRetry(run, "https://site.example/b3/", rule, "")
	if !page.OK || bookChapterCount(page.Book) != 8 {
		t.Fatalf("直通语义被破坏: ok=%v count=%d", page.OK, bookChapterCount(page.Book))
	}
	if calls.Load() != 1 {
		t.Fatalf("未配置 chapterListApi 不得重试: calls=%d", calls.Load())
	}
}

// 重试受任务停止信号协作：stopState 非空时不应再发请求（防取消/暂停后的无谓消耗）。
func TestFetchBookPageWithTocRetryStopsOnStopState(t *testing.T) {
	var calls atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(stubBookResp("停止协作书", 8, "https://site.example/b4",
			[]string{"chapterListApi：域限速排队超预算，已跳过 JSON 目录提取（引擎准入拒绝，不影响书页内嵌目录）"})))
	}))
	defer srv.Close()
	t.Setenv("BACKEND_ENGINE_URL", srv.URL)

	// stopState 查询 ScrapeTask 行：种一条 canceled 任务行（recover_test.go 临时库）
	taskID := 990_854
	db, derr := getDB()
	if derr != nil {
		t.Fatalf("open temp db: %v", derr)
	}
	if _, ierr := db.Exec(
		`INSERT INTO "ScrapeTask" ("id","mode","targetUrl","pages","storageMode","status","createdAt","updatedAt")
                 VALUES (?,'single','https://site.example/b4/',1,'db','canceled',?,?)`, taskID, nowMillis(), nowMillis()); ierr != nil {
		t.Fatalf("seed task row: %v", ierr)
	}
	t.Cleanup(func() { _, _ = db.Exec(`DELETE FROM "ScrapeTask" WHERE "id" = ?`, taskID) })

	rule := LoadedRule{BookRule: RuleMap{"chapterListApi": `{"url":"/api/toc","bookIdSelector":"#bid","titleField":"name","urlTemplate":"/read/{bookId}"}`}}
	run := NewRun(taskID)
	page := fetchBookPageWithTocRetry(run, "https://site.example/b4/", rule, "")
	if !page.OK {
		t.Fatalf("停止信号下应保留首次结果: %s", page.Err)
	}
	if calls.Load() != 1 {
		t.Fatalf("停止信号下不得重抓: calls=%d", calls.Load())
	}
}
