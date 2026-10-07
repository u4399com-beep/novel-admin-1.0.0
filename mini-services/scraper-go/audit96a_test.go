package main

/**
 * audit96a_test.go —— R96 分页能力防回退回归（scraper-go 引擎侧）。
 *
 * 背景（用户实证《诸天领主》目录 1-100 章后直跳 796 章）：
 * R82-R95 的分页规则修复只落运行时 DB（API PUT），seed.json/存量库规则全部缺失
 * chapterListPaginationSelector → BookData.TocPages 恒空 → worker walker 从不运行 →
 * 目录恒为书页内嵌「前 100 章 + 最新章节块」。
 *
 * 本文件锁定 extractBook 的 R96 修复语义：
 *   1. 规则未配置该键 → 内置机会性选择器组（defaultTocPaginationSelectors）兜底发现
 *      分页锚（类锚/容器锚/文本锚 a:contains(下一页)），自页剔除，绝对化去重保序；
 *   2. 回退警告必须同时含「chapterListPaginationSelector」「发现目录分页」子串
 *      （后端 pageWarnedTocPagination 重试护栏按子串匹配的跨服务契约）；
 *   3. 显式配置键且候选不命中 → 不回退、不出候选（显式键治理权不变）；
 *   4. 无分页锚的普通书页 → TocPages 空数组零行为变化。
 */

import (
        "strings"
        "testing"
)

func TestExtractBookTocPaginationFallbackContainerAnchors(t *testing.T) {
        // 未配置键 + .pagelink a 容器锚（R94 xinjianpan/ggd66 实测形态）→ 回退发现
        const page = `<html><body>
                <h1>测试书</h1>
                <div class="all"><ul><li><a href="/txt/ab/c1.html">第一章</a></li></ul></div>
                <div class="pagelink">
                        <a href="/txt/ab/list-1.html">1</a>
                        <a href="/txt/ab/list-2.html">2</a>
                        <a href="/txt/ab/list-3.html">3</a>
                </div>
        </body></html>`
        var warnings []string
        // 页面自身即 list-1（分页锚组中的「1」与自页 URL 全等 → 剔除）
        book := extractBook(doc82(t, page), map[string]string{"titleSelector": "h1"}, "https://www.x.com/txt/ab/list-1.html", &warnings)
        if len(book.TocPages) != 2 {
                t.Fatalf("回退 TocPages = %v, want 2 页（自页 list-1 剔除）", book.TocPages)
        }
        if book.TocPages[0] != "https://www.x.com/txt/ab/list-2.html" || book.TocPages[1] != "https://www.x.com/txt/ab/list-3.html" {
                t.Fatalf("回退页顺序错误: %v", book.TocPages)
        }
        assertFallbackWarning(t, warnings)
}

func TestExtractBookTocPaginationFallbackTextAnchor(t *testing.T) {
        // 未配置键 + 无容器仅文本锚「下一页」→ 回退发现（未知模板兜底路径）
        const page = `<html><body><h1>文本锚书页</h1>
                <ul><li><a href="/read/1.html">第1章</a></li></ul>
                <a href="/read/index_2.html">下一页</a>
                <a href="/read/index_3.html">下一頁</a>
        </body></html>`
        var warnings []string
        book := extractBook(doc82(t, page), map[string]string{"titleSelector": "h1"}, "https://www.x.com/read/index_1.html", &warnings)
        if len(book.TocPages) != 2 {
                t.Fatalf("文本锚回退 TocPages = %v, want 2 页", book.TocPages)
        }
        assertFallbackWarning(t, warnings)
}

func TestExtractBookTocPaginationExplicitKeyGoverns(t *testing.T) {
        // 显式配置窄键且候选不命中 → 不回退（治理权归规则），无分页警告
        const page = `<html><body><h1>显式键书页</h1>
                <div class="pagelink"><a href="/txt/ab/list-2.html">2</a></div>
        </body></html>`
        var warnings []string
        book := extractBook(doc82(t, page), map[string]string{
                "titleSelector":                 "h1",
                "chapterListPaginationSelector": "a.morechapter",
        }, "https://www.x.com/txt/ab/", &warnings)
        if len(book.TocPages) != 0 {
                t.Fatalf("显式键不命中时 TocPages = %v, want 空（不回退）", book.TocPages)
        }
        for _, w := range warnings {
                if strings.Contains(w, "发现目录分页") {
                        t.Fatalf("显式键不命中不应出分页警告: %v", warnings)
                }
        }
}

func TestExtractBookTocPaginationNoAnchorsNoChange(t *testing.T) {
        // 普通书页无任何分页锚 → TocPages 空数组，零行为变化，零警告
        const page = `<html><body><h1>普通书页</h1>
                <ul><li><a href="/read/1.html">第1章</a></li><li><a href="/read/2.html">第2章</a></li></ul>
        </body></html>`
        var warnings []string
        book := extractBook(doc82(t, page), map[string]string{"titleSelector": "h1"}, "https://www.x.com/read/", &warnings)
        if book.TocPages == nil || len(book.TocPages) != 0 {
                t.Fatalf("无锚书页 TocPages = %v, want 空数组", book.TocPages)
        }
        for _, w := range warnings {
                if strings.Contains(w, "发现目录分页") {
                        t.Fatalf("无锚书页不应出分页警告: %v", warnings)
                }
        }
}

func TestDefaultTocPaginationSelectorsMatchKnownFleetForms(t *testing.T) {
        // 防手滑删改：内置组必须覆盖三站实测形态 + 繁简文本锚
        want := []string{
                "a.morechapter",             // xinjianpan（biquge2023）
                ".pagelink a",               // xinjianpan/ggd66
                ".pagination-list a",        // huangjinwu
                "#pages a",                  // biquge 经典
                "a:contains(下一页)",           // 文本锚简体
                "a:contains(下一頁)",           // 文本锚繁体
        }
        joined := strings.Join(defaultTocPaginationSelectors, "\x00")
        for _, w := range want {
                if !strings.Contains(joined, w) {
                        t.Fatalf("defaultTocPaginationSelectors 缺实测形态 %q: %v", w, defaultTocPaginationSelectors)
                }
        }
}

// assertFallbackWarning 锁定跨服务护栏契约：警告同时含「chapterListPaginationSelector」
// 与「发现目录分页」子串（backend pageWarnedTocPagination 按子串匹配）
func assertFallbackWarning(t *testing.T, warnings []string) {
        t.Helper()
        for _, w := range warnings {
                if strings.Contains(w, "chapterListPaginationSelector") && strings.Contains(w, "发现目录分页") {
                        return
                }
        }
        t.Fatalf("回退警告缺护栏子串（后端重试护栏将失明）: %v", warnings)
}
