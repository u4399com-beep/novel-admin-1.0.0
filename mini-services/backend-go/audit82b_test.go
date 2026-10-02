/**
 * audit82b_test.go —— R82 目录分页修复回归（backend-go 侧）。
 *
 * 背景：xinjianpan（biquge2023 系模板）书页 .all 块服务端只渲染前 100 章，
 * 全量目录由 a.morechapter → list-N.html 分页承载（100 章/页）且分页页章节锚
 * href=javascript:; onclick 混淆——实测 539/565 本在库书截断 ≤100 章。
 *
 * 本文件锁定 worker 侧目录 walker 的纯函数语义：
 *  ① mergeTocRefs 按 URL 去重合并：首现者胜、保持首现顺序、空 URL 跳过；
 *  ② 锚点变体（#frag）与正页同址不产生重复；
 *  ③ stripURLHash 基础语义；
 *  ④ MAX_TOC_PAGES_PER_BOOK 上界合理（120 页 × 100 章/页 ≥ 顶格 9993 章书）。
 */

package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

func TestMergeTocRefs(t *testing.T) {
	base := []ChapterRef{
		{Title: "第一章", URL: "https://x.com/txt/a/vl7.html"},
		{Title: "第二章", URL: "https://x.com/txt/a/el7.html"},
	}
	add := []ChapterRef{
		// 同 URL 重复：首现者胜（标题保留 第一章）
		{Title: "第一章(重复)", URL: "https://x.com/txt/a/vl7.html"},
		// 锚点变体：与正页同址，不产生重复
		{Title: "第二章(锚点)", URL: "https://x.com/txt/a/el7.html#frag"},
		// 新章节：追加保持顺序
		{Title: "第三章", URL: "https://x.com/txt/a/hl7.html"},
		// 空 URL：跳过
		{Title: "无效", URL: ""},
	}
	got := mergeTocRefs(base, add)
	if len(got) != 3 {
		t.Fatalf("mergeTocRefs len = %d, want 3: %+v", len(got), got)
	}
	if got[0].Title != "第一章" {
		t.Fatalf("首现者胜失败: %+v", got[0])
	}
	if got[2].Title != "第三章" || got[2].URL != "https://x.com/txt/a/hl7.html" {
		t.Fatalf("新章顺序/内容错误: %+v", got[2])
	}
}

func TestMergeTocRefsEmptyDst(t *testing.T) {
	add := []ChapterRef{
		{Title: "第一章", URL: "https://x.com/txt/a/vl7.html"},
		{Title: "同址去重", URL: "https://x.com/txt/a/vl7.html"},
	}
	got := mergeTocRefs(nil, add)
	if len(got) != 1 {
		t.Fatalf("len = %d, want 1", len(got))
	}
}

func TestStripURLHash(t *testing.T) {
	cases := []struct{ in, want string }{
		{"https://x.com/a.html", "https://x.com/a.html"},
		{"https://x.com/a.html#frag", "https://x.com/a.html"},
		{"", ""},
		{"#top", ""},
	}
	for _, c := range cases {
		if got := stripURLHash(c.in); got != c.want {
			t.Fatalf("stripURLHash(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestMaxTocPagesCoversCap(t *testing.T) {
	// MAX_CHAPTERS_PER_BOOK=10000，分页目录站 100 章/页 → 100 页顶格；
	// 上限 120 必须足以覆盖，否则顶格书仍被截断
	if MAX_TOC_PAGES_PER_BOOK*100 < MAX_CHAPTERS_PER_BOOK {
		t.Fatalf("MAX_TOC_PAGES_PER_BOOK=%d 不足以覆盖 %d 章顶格书（100 章/页）", MAX_TOC_PAGES_PER_BOOK, MAX_CHAPTERS_PER_BOOK)
	}
}

// ---- R82 二轮：fetchFullToc 伪引擎端到端回归 ----
//
// 锁定种子跳过 bug（二轮修复）：walker 必须逐个抓取全部种子页与发现页——
// 旧写法把种子预标记 visited 后循环里「已 visited 且非首个」即跳过，第二个
// 种子页（唯一含新章的 list-2）被静默跳过。伪引擎按 URL 分发固定目录：
//   书页(0xt/)          → 100 章 + tocPages [list-1, list-2]
//   list-1              → 100 章（与书页全重复）+ tocPages [list-1(回链), list-2]
//   list-2              → 99 章新章 + tocPages [list-1, list-2(回链)]
// 期望：walker 抓 2 页、合并 199 条；书页/重复页入 visited 防回环（引擎收到
// 的请求 URL 集合恰为 {list-1, list-2}）。

func TestFetchFullTocWalksAllSeeds(t *testing.T) {
	var mu sync.Mutex
	fetched := []string{}
	mk := func(n int, first int) []ChapterRef {
		refs := make([]ChapterRef, 0, n)
		for i := 0; i < n; i++ {
			refs = append(refs, ChapterRef{Title: "章", URL: "https://x.com/txt/0xt/c" + itoa(first+i) + ".html"})
		}
		return refs
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		u, _ := body["url"].(string)
		mu.Lock()
		fetched = append(fetched, u)
		mu.Unlock()
		var chs []ChapterRef
		var pages []string
		switch u {
		case "https://x.com/txt/0xt/":
			chs = mk(100, 1)
			pages = []string{"https://x.com/txt/0xt/list-1.html", "https://x.com/txt/0xt/list-2.html"}
		case "https://x.com/txt/0xt/list-1.html":
			chs = mk(100, 1) // 与书页全重复
			pages = []string{"https://x.com/txt/0xt/list-1.html", "https://x.com/txt/0xt/list-2.html"}
		case "https://x.com/txt/0xt/list-2.html":
			chs = mk(99, 101) // 唯一的新章来源
			pages = []string{"https://x.com/txt/0xt/list-1.html", "https://x.com/txt/0xt/list-2.html"}
		default:
			chs = nil
		}
		resp := map[string]any{
			"ok":       true,
			"warnings": []string{},
			"data": map[string]any{
				"book": map[string]any{"title": "书", "chapters": chs, "tocPages": pages},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()
	t.Setenv("BACKEND_ENGINE_URL", srv.URL)

	run := NewRun(990_101)
	seeds := []string{
		"https://x.com/txt/0xt/list-1.html",
		"https://x.com/txt/0xt/list-2.html#frag", // 锚点变体应与正页同址
	}
	refs, pagesWalked := fetchFullToc(run, seeds, LoadedRule{}, "https://x.com/txt/0xt/", true)
	if pagesWalked != 2 {
		t.Fatalf("pagesWalked = %d, want 2（两个种子页都必须被抓取——种子跳过 bug 回归锁）", pagesWalked)
	}
	if len(refs) != 199 {
		t.Fatalf("合并 refs = %d, want 199（书页 100 重复 + list-2 99 新章）", len(refs))
	}
	if len(fetched) != 2 {
		t.Fatalf("引擎实际请求 = %v, want 恰 [list-1, list-2]（无重复、无书页回链）", fetched)
	}
}
