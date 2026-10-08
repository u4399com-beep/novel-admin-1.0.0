package main

import (
        "strings"
        "testing"

        "github.com/PuerkitoBio/goquery"
)

// R103：chapterListHtmlApiTemplate（HTML 片段全量目录接口模板）锁定测试。
// 背景：101kks 目录页 #allchapter 首屏仅渲染 36 条，完整目录由同源 AJAX 端点
// /ajax_novels/chapterlist/{id}.html 提供（HTML 片段形态，jsontoc 的 JSON 通道不适用），
// 且端点 URL 不出现在任何页面锚里——规则无法用 chapterListPaginationSelector 表达。

func TestBookIdFromURL(t *testing.T) {
        cases := []struct{ url, want string }{
                {"https://101kks.com/book/184.html", "184"},
                {"https://101kks.com/book/184/index.html", "184"},
                {"https://x.com/novel/12345/", "12345"},
                {"https://x.com/book_9.html", "9"},
                {"https://x.com/nobook/", ""},
                {"https://x.com/?page=2", ""},
                {"not a url", ""},
        }
        for _, c := range cases {
                if got := bookIdFromURL(c.url); got != c.want {
                        t.Errorf("bookIdFromURL(%q) = %q, want %q", c.url, got, c.want)
                }
        }
}

func TestExpandTocHtmlApi(t *testing.T) {
        // 正常展开：相对模板 + {bookId} 替换 + 绝对化
        u, ok := expandTocHtmlApi("/ajax_novels/chapterlist/{bookId}.html", "https://101kks.com/book/184.html")
        if !ok || u != "https://101kks.com/ajax_novels/chapterlist/184.html" {
                t.Fatalf("expand = %q ok=%v, want expanded api url", u, ok)
        }
        // 绝对 URL 模板
        u, ok = expandTocHtmlApi("https://101kks.com/ajax_novels/chapterlist/{bookId}.html", "https://101kks.com/book/184.html")
        if !ok || !strings.HasSuffix(u, "/chapterlist/184.html") {
                t.Fatalf("absolute template expand = %q ok=%v", u, ok)
        }
        // 去锚
        u, ok = expandTocHtmlApi("/api/toc/{bookId}.html#frag", "https://101kks.com/book/184.html")
        if !ok || strings.Contains(u, "#") {
                t.Fatalf("hash strip failed: %q", u)
        }
        // 书页 URL 无数字 → 拒绝
        if _, ok := expandTocHtmlApi("/api/{bookId}.html", "https://x.com/book/noid.html"); ok {
                t.Fatal("book URL without numeric id should be rejected")
        }
        // 跨源模板 → 拒绝（SSRF 防护）
        if _, ok := expandTocHtmlApi("https://evil.example/api/{bookId}.html", "https://101kks.com/book/184.html"); ok {
                t.Fatal("cross-origin template should be rejected")
        }
}

func TestExtractBookHtmlApiTemplateInTocPages(t *testing.T) {
        // 书页 HTML + bookRule 带模板 → BookData.TocPages 含展开 URL + 结构化警告
        html := `<html><body>
                <h1>测试书</h1>
                <a class="btn more-btn" href="https://101kks.com/book/184/index.html">完整目錄</a>
                <div id="allchapter"><ul><li data-num="1"><a href="https://101kks.com/txt/184/1.html">第1章 起</a></li></ul></div>
        </body></html>`
        rule := map[string]string{
                "catalogLinkSelector":        "a.more-btn",
                "chapterLinkSelector":        "#allchapter li a, li[data-num] a",
                "chapterListHtmlApiTemplate": "/ajax_novels/chapterlist/{bookId}.html",
        }
        warnings := []string{}
        doc, _ := goquery.NewDocumentFromReader(strings.NewReader(html))
        book := extractBook(doc, rule, "https://101kks.com/book/184.html", &warnings)
        found := false
        for _, p := range book.TocPages {
                if p == "https://101kks.com/ajax_novels/chapterlist/184.html" {
                        found = true
                }
        }
        if !found {
                t.Fatalf("TocPages should contain expanded api url, got %v", book.TocPages)
        }
        warned := false
        for _, w := range warnings {
                if strings.Contains(w, "chapterListHtmlApiTemplate") && strings.Contains(w, "已展开并入目录跟随") {
                        warned = true
                }
        }
        if !warned {
                t.Fatalf("expected structured warning, got %v", warnings)
        }
}

func TestExtractBookHtmlApiTemplateCrossOriginSkipped(t *testing.T) {
        html := `<html><body><h1>书</h1></body></html>`
        rule := map[string]string{"chapterListHtmlApiTemplate": "https://evil.example/{bookId}.html"}
        warnings := []string{}
        doc, _ := goquery.NewDocumentFromReader(strings.NewReader(html))
        book := extractBook(doc, rule, "https://101kks.com/book/184.html", &warnings)
        if len(book.TocPages) != 0 {
                t.Fatalf("cross-origin template must not enter TocPages, got %v", book.TocPages)
        }
        warned := false
        for _, w := range warnings {
                if strings.Contains(w, "chapterListHtmlApiTemplate") && strings.Contains(w, "已跳过") {
                        warned = true
                }
        }
        if !warned {
                t.Fatalf("expected skip warning, got %v", warnings)
        }
}

func TestSanitizeRuleKeepsHtmlApiTemplate(t *testing.T) {
        // /api/test 的 bookRule 白名单必须放行新键（否则引擎收不到模板——本轮实测踩坑点）
        raw := map[string]any{
                "chapterListHtmlApiTemplate": "/ajax_novels/chapterlist/{bookId}.html",
                "unknownKey":                 "dropped",
        }
        m := sanitizeRule(bookKeys, raw)
        if m["chapterListHtmlApiTemplate"] != "/ajax_novels/chapterlist/{bookId}.html" {
                t.Fatalf("sanitizeRule dropped chapterListHtmlApiTemplate: %v", m)
        }
        if _, ok := m["unknownKey"]; ok {
                t.Fatal("unknown key should be filtered")
        }
}

// R103：抓取时乱序排序（sortChapterRefsByNo）锁定测试。
// 背景：5165.org 目录页章节随机序展示（第381章在首、第225章在尾），事后 resort
// 修复率低，根治在抓取源头排序。
func mkRefs(titles []string) []BookChapterRef {
        refs := make([]BookChapterRef, len(titles))
        for i, t := range titles {
                refs[i] = BookChapterRef{Title: t, Url: strPtr("https://x.com/1.html")}
        }
        return refs
}

func refTitles(refs []BookChapterRef) []string {
        out := make([]string, len(refs))
        for i, r := range refs {
                out[i] = r.Title
        }
        return out
}

func TestSortChapterRefsByNo(t *testing.T) {
        // 乱序阿拉伯编号 → 排序生效
        refs := sortChapterRefsByNo(mkRefs([]string{
                "第381章 甲", "第12章 乙", "第3章 丙", "第225章 丁",
                "第9章 戊", "第100章 己", "第44章 庚", "第1章 辛",
        }))
        got := refTitles(refs)
        want := []string{"第1章 辛", "第3章 丙", "第9章 戊", "第12章 乙", "第44章 庚", "第100章 己", "第225章 丁", "第381章 甲"}
        for i := range want {
                if got[i] != want[i] {
                        t.Fatalf("sort mismatch at %d: got %v", i, got)
                }
        }
        // 未编号行锚定前一编号行后（页面序中公告位于 第9章 之后 → key=9.5，排在第9章后）
        refs = sortChapterRefsByNo(mkRefs([]string{
                "第9章 甲", "公告：求票", "第3章 乙", "第12章 丙", "第1章 丁",
                "第44章 戊", "第100章 己", "第225章 庚", "第381章 辛",
        }))
        got = refTitles(refs)
        if got[0] != "第1章 丁" || got[1] != "第3章 乙" || got[2] != "第9章 甲" || got[3] != "公告：求票" || got[4] != "第12章 丙" {
                t.Fatalf("unnumbered anchor mismatch: %v", got)
        }
        // 升序站零实害（含前缀装饰）
        asc := []string{"【第1章】一", "第2章 二", "第3章 三", "第4章 四", "第5章 五", "第6章 六", "第7章 七", "第8章 八"}
        if g := refTitles(sortChapterRefsByNo(mkRefs(asc))); !equalStrs(g, asc) {
                t.Fatalf("ascending site must be unchanged, got %v", g)
        }
        // 重复编号 → 不动（交后端分卷重排）
        dup := []string{"第1章 一", "第2章 二", "第2章 二b", "第4章 四", "第5章 五", "第6章 六", "第7章 七", "第8章 八"}
        if g := refTitles(sortChapterRefsByNo(mkRefs(dup))); !equalStrs(g, dup) {
                t.Fatal("duplicate numbering must not be reordered")
        }
        // 解析率 <80%（中文数字形态）→ 不动
        cn := []string{"第一章 一", "第二章 二", "第三章 三", "第四章 四", "第五章 五", "第六章 六", "第七章 七", "第八章 八"}
        if g := refTitles(sortChapterRefsByNo(mkRefs(cn))); !equalStrs(g, cn) {
                t.Fatal("chinese numeral form must not be reordered at engine layer")
        }
        // 倒序目录（完整但反向）→ 翻转为正序（阅读顺序修复）
        desc := []string{"第8章 八", "第7章 七", "第6章 六", "第5章 五", "第4章 四", "第3章 三", "第2章 二", "第1章 一"}
        wantAsc := []string{"第1章 一", "第2章 二", "第3章 三", "第4章 四", "第5章 五", "第6章 六", "第7章 七", "第8章 八"}
        if g := refTitles(sortChapterRefsByNo(mkRefs(desc))); !equalStrs(g, wantAsc) {
                t.Fatalf("descending toc should be flipped, got %v", g)
        }
}

func equalStrs(a, b []string) bool {
        if len(a) != len(b) {
                return false
        }
        for i := range a {
                if a[i] != b[i] {
                        return false
                }
        }
        return true
}

func TestParseArabicChapterNo(t *testing.T) {
        cases := []struct {
                title string
                want  int64
                ok    bool
        }{
                {"第12章 永夜", 12, true},
                {"【第12章】永夜", 12, true},
                {"第１２章 全角", 12, true},
                {"第12节 节", 12, true},
                {"第12话 话", 12, true},
                {"第十二章 中文", 0, false},
                {"序章", 0, false},
                {"番外1", 0, false},
        }
        for _, c := range cases {
                v, ok := parseArabicChapterNo(c.title)
                if ok != c.ok || (ok && v != c.want) {
                        t.Errorf("parseArabicChapterNo(%q) = (%d,%v), want (%d,%v)", c.title, v, ok, c.want, c.ok)
                }
        }
}
