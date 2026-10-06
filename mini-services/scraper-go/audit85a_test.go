/**
 * audit85a_test.go —— R86 目录截断修复回归锁定（引擎侧）：
 *
 * 根因：bookRule.chapterListApi 的取槽排队预算为固定 5s，多书并发采集（BOOK_CONCURRENCY=4）
 * 时域槽 FIFO 排队深度实测 8-10s+，JSON 目录几乎必被 shed → 书目录被静默截断为书页
 * 内嵌的「最新几章」（ixdzs8 实测 86 本书全部只入库 8 章）。
 *
 * 修复：extractBookBudgeted / extractJsonTocBudgeted 把消费方 60s 超时的剩余预算传入，
 * tocSlotBudget 自适应计算排队上界（unknown→旧 5s 档、充裕→≤20s、不足→防御性 shed）。
 *
 * 本文件锁定 tocSlotBudget 的全部分支语义与 extractBook 兼容包装的行为不变性。
 */
package main

import (
        "github.com/PuerkitoBio/goquery"
        "strings"
        "testing"
)

func TestTocSlotBudgetBranches(t *testing.T) {
        cases := []struct {
                name        string
                remainingMs int64
                want        int64
        }{
                {"unknown 沿用旧 5s 档", 0, tocSlotDefaultMS},
                {"负数视同 unknown", -123, tocSlotDefaultMS},
                {"充裕预算钳上界 20s", 60_000, tocSlotMaxMS},
                {"剩余恰好 8s → 5s", 8_000, 5_000},
                {"剩余 5s+3s 边界 → 5s", 8_001, 5_001},
                {"剩余不足（<5s+3s 边距）→ 防御性 shed", 7_999, 0},
                {"剩余为 1s → 防御性 shed", 1_000, 0},
        }
        for _, c := range cases {
                if got := tocSlotBudget(c.remainingMs); got != c.want {
                        t.Fatalf("%s: tocSlotBudget(%d) = %d, want %d", c.name, c.remainingMs, got, c.want)
                }
        }
}

// extractBook 兼容包装（4 参，unknown 预算）不得改变非 chapterListApi 场景的提取结果；
// extractBookBudgeted 大预算路径同语义（章节/目录分页提取与预算无关，预算仅作用于
// chapterListApi 取槽——此处以 TocPages/章节条数双断言锁定）。
func TestExtractBookBudgetedSemanticParity(t *testing.T) {
        page := `<!doctype html><html><body>
                <h1>预算语义测试书</h1>
                <ul id="chapterList">
                        <li><a href="/b/1.html">第1章 甲</a></li>
                        <li><a href="/b/2.html">第2章 乙</a></li>
                        <li><a href="/b/3.html">第3章 丙</a></li>
                </ul>
                <div class="pagination"><a href="/b/list-2.html">下一页</a></div>
                </body></html>`
        doc, err := goquery.NewDocumentFromReader(strings.NewReader(page))
        if err != nil {
                t.Fatalf("parse doc: %v", err)
        }
        rule := map[string]string{
                "titleSelector":                 "h1",
                "chapterLinkSelector":           "#chapterList li a",
                "chapterListPaginationSelector": ".pagination a",
        }
        w1 := []string{}
        b1 := extractBook(doc, rule, "https://x.example/b/", &w1)
        w2 := []string{}
        b2 := extractBookBudgeted(doc, rule, "https://x.example/b/", &w2, 55_000)
        if b1.Title != b2.Title || len(b1.Chapters) != len(b2.Chapters) {
                t.Fatalf("extractBook 与 extractBookBudgeted 结果不一致: %q/%d vs %q/%d",
                        b1.Title, len(b1.Chapters), b2.Title, len(b2.Chapters))
        }
        if len(b1.TocPages) != 1 || b1.TocPages[0] != "https://x.example/b/list-2.html" {
                t.Fatalf("TocPages 提取不应受预算路径影响: %v", b1.TocPages)
        }
}
