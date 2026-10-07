package main

/**
 * audit82a_test.go —— R82 目录分页修复回归（scraper-go 引擎侧）。
 *
 * 背景（用户指令「检查所有采集规则，重点是章节目录页是否有分页设置」实测驱动）：
 * xinjianpan（biquge2023 系模板）书页 .all 块服务端只渲染前 100 章，全量目录
 * 由 a.morechapter → list-1.html…list-N.html 分页承载（100 章/页）；且分页页
 * 章节锚为 JS 混淆形态 <a href="javascript:;" onclick="location.href='/txt/xx/ab7.html'>。
 * 旧实现两处缺陷：①onclick 混淆锚整页提 0 章；②目录分页无任何跟随机制，
 * 539/565 本在库书截断 ≤100 章。
 *
 * 本文件锁定：
 *   1. effectiveAnchorHref：href 正常时原样返回（不覆盖）；空/#/javascript: 时
 *      回退 onclick 内 location.href='...' 赋值目标（单引号/双引号/window. 前缀）；
 *      onclick 无赋值目标时返回原 href；
 *   2. extractBook chapterListPaginationSelector：命中锚 → BookData.TocPages
 *      绝对 URL 去重保序、自页剔除、锚点变体剔除；
 *   3. 规则未配置该键时 TocPages 为空数组（不误报）；
 *   4. onclick 混淆目录页经 extractChapterRefs 正常提取章节（list-2.html 形态）。
 */

import (
        "strings"
        "testing"

        "github.com/PuerkitoBio/goquery"
)

func doc82(t *testing.T, html string) *goquery.Document {
        t.Helper()
        doc, err := goquery.NewDocumentFromReader(strings.NewReader(html))
        if err != nil {
                t.Fatalf("goquery 解析失败: %v", err)
        }
        return doc
}

func TestEffectiveAnchorHrefOnclickFallback(t *testing.T) {
        sel := func(html string) *goquery.Selection {
                return doc82(t, html).Find("a")
        }
        cases := []struct {
                name string
                html string
                want string
        }{
                {"正常href原样返回", `<a href="/txt/a/1.html">第1章</a>`, "/txt/a/1.html"},
                {"javascript混淆回退onclick单引号", `<a href="javascript:;" onclick="location.href='/txt/a/2.html'" title="第2章">第2章</a>`, "/txt/a/2.html"},
                {"javascript混淆回退onclick双引号", `<a href="javascript:;" onclick='location.href="/txt/a/3.html"'>第3章</a>`, "/txt/a/3.html"},
                {"window.location.href前缀", `<a href="javascript:void(0)" onclick="window.location.href='/txt/a/4.html'">第4章</a>`, "/txt/a/4.html"},
                {"href为空回退onclick", `<a onclick="location.href='/txt/a/5.html'">第5章</a>`, "/txt/a/5.html"},
                {"井号href回退onclick", `<a href="#" onclick="location.href='/txt/a/6.html'">第6章</a>`, "/txt/a/6.html"},
                {"onclick无赋值保持原href", `<a href="javascript:;" onclick="return false">第7章</a>`, "javascript:;"},
                {"普通onclick不污染正常href", `<a href="/txt/a/8.html" onclick="track()">第8章</a>`, "/txt/a/8.html"},
        }
        for _, tc := range cases {
                t.Run(tc.name, func(t *testing.T) {
                        if got := effectiveAnchorHref(sel(tc.html)); got != tc.want {
                                t.Fatalf("effectiveAnchorHref = %q, want %q", got, tc.want)
                        }
                })
        }
}

func TestExtractBookTocPages(t *testing.T) {
        const page = `<html><body>
                <h1>测试书</h1>
                <div class="chapterlist">
                        <ul><li><a href="/txt/ab/vl7.html">第一章</a></li><li><a href="/txt/ab/el7.html">第二章</a></li></ul>
                        <a class="morechapter" href="/txt/ab/list-1.html">更多章节列表 >></a>
                        <a class="morechapter" href="/txt/ab/list-2.html">更多章节列表 >></a>
                        <a class="morechapter" href="/txt/ab/list-1.html#frag">更多章节列表(锚点变体)</a>
                </div>
        </body></html>`
        rule := map[string]string{
                "chapterLinkSelector":           ".chapterlist ul li a",
                "chapterListPaginationSelector": "a.morechapter",
        }
        var warnings []string
        book := extractBook(doc82(t, page), rule, "https://www.x.com/txt/ab/", &warnings)
        if len(book.TocPages) != 2 {
                t.Fatalf("TocPages = %v (len %d), want 2 个去重分页", book.TocPages, len(book.TocPages))
        }
        if book.TocPages[0] != "https://www.x.com/txt/ab/list-1.html" || book.TocPages[1] != "https://www.x.com/txt/ab/list-2.html" {
                t.Fatalf("TocPages 顺序/绝对化错误: %v", book.TocPages)
        }
        if len(book.Chapters) != 2 {
                t.Fatalf("Chapters = %d, want 2", len(book.Chapters))
        }
}

func TestExtractBookTocPagesOnclickAndSelfExclusion(t *testing.T) {
        const page = `<html><body>
                <h1>混淆分页页</h1>
                <ul class="list">
                        <li><a href="javascript:;" onclick="location.href='/txt/ab/x1.html'" title="第一百零一章">第一百零一章</a></li>
                        <li><a href="javascript:;" onclick="location.href='/txt/ab/x2.html'" title="第一百零二章">第一百零二章</a></li>
                </ul>
                <a class="morechapter" href="/txt/ab/list-3.html">下一页</a>
                <a class="morechapter" href="/txt/ab/list-2.html">当前页(剔除)</a>
                <a class="morechapter" href="/txt/ab/list-2.html#frag">当前页锚点变体(剔除)</a>
        </body></html>`
        rule := map[string]string{
                "chapterLinkSelector":           ".list li a",
                "chapterListPaginationSelector": "a.morechapter",
        }
        var warnings []string
        book := extractBook(doc82(t, page), rule, "https://www.x.com/txt/ab/list-2.html", &warnings)
        if len(book.TocPages) != 1 || book.TocPages[0] != "https://www.x.com/txt/ab/list-3.html" {
                t.Fatalf("TocPages = %v, want 仅 list-3（当前页+锚点变体剔除+混淆锚正常提取）", book.TocPages)
        }
        if len(book.Chapters) != 2 {
                t.Fatalf("混淆锚章节提取 = %d, want 2", len(book.Chapters))
        }
        if book.Chapters[0].Url == nil || *book.Chapters[0].Url != "https://www.x.com/txt/ab/x1.html" {
                t.Fatalf("混淆锚 URL = %v, want onclick 提取的绝对 URL", book.Chapters[0].Url)
        }
}

func TestExtractBookTocPagesUnconfigured(t *testing.T) {
        // R96 语义翻转：规则未配置该键时不再保持 TocPages 空数组——启用内置机会性
        // 选择器组（defaultTocPaginationSelectors）兜底发现分页锚（分页能力防回退，
        // 根治 seed/存量库规则缺失键导致目录 100 章封顶）。原「不误报」语义由
        // 「显式配置键且其候选不命中锚时不出候选」保证（见 audit96a_test.go 显式键用例）。
        const page = `<html><body><h1>无分页配置</h1>
                <a class="morechapter" href="/txt/ab/list-2.html">更多章节</a></body></html>`
        var warnings []string
        book := extractBook(doc82(t, page), map[string]string{"titleSelector": "h1"}, "https://www.x.com/txt/ab/", &warnings)
        if book.TocPages == nil || len(book.TocPages) != 1 {
                t.Fatalf("未配置时 TocPages = %v, want R96 回退发现 1 页", book.TocPages)
        }
        if book.TocPages[0] != "https://www.x.com/txt/ab/list-2.html" {
                t.Fatalf("回退发现页 = %v, want list-2 绝对 URL", book.TocPages)
        }
        found := false
        for _, w := range warnings {
                if strings.Contains(w, "chapterListPaginationSelector") && strings.Contains(w, "发现目录分页") {
                        found = true
                }
        }
        if !found {
                t.Fatalf("warnings 缺护栏子串警告: %v", warnings)
        }
}
