/**
 * audit86b_test.go —— R86 配套能力回归：reorderChapterRefsForce / resort-chapters force 分支。
 *
 * 背景：追加式目录补全（骨架按标题增量 upsert，idx=MAX+1）修复截断书后，旧「最新章节块」
 * 残留在目录中间（如 idx 101-112 挂着 第1977..1988章），位置错乱占比仅 1-2%，低于
 * DISORDER_RATIO=20% 审计阈值 → 常规 resort-chapters 永不命中。force 分支按章节序号
 * 强制重排（编号章节下限等保护保留）。
 */
package main

import (
        "database/sql"
        "net/http/httptest"
        "strings"
        "testing"
)

// ---------- ① reorderChapterRefsForce 语义 ----------

func TestReorderChapterRefsForceSmallDisorder(t *testing.T) {
        // 模拟修复后形态：1..100 有序块 + 尾部残留「最新 3 章」块 + 追加的 101..106
        refs := []ChapterRef{}
        for i := 1; i <= 100; i++ {
                refs = append(refs, ChapterRef{Title: numTitle(i), URL: itoa(i)})
        }
        refs = append(refs, ChapterRef{Title: numTitle(105), URL: "105"})
        refs = append(refs, ChapterRef{Title: numTitle(106), URL: "106"})
        for i := 101; i <= 104; i++ {
                refs = append(refs, ChapterRef{Title: numTitle(i), URL: itoa(i)})
        }

        // 常规判定：错乱占比 4/106 ≈ 3.8% < 20% → 不重排
        if rr := reorderChapterRefs(refs); rr.reordered {
                t.Fatal("常规阈值不应重排（复现审计盲区）")
        }
        // 强制判定：应重排且结果为全升序
        rr := reorderChapterRefsForce(refs)
        if !rr.reordered {
                t.Fatal("force 应重排（尾部残留最新块低于审计阈值）")
        }
        want := make([]string, 0, len(refs))
        for i := 1; i <= 106; i++ {
                want = append(want, itoa(i))
        }
        got := make([]string, 0, len(rr.refs))
        for _, r := range rr.refs {
                got = append(got, r.URL)
        }
        if strings.Join(got, ",") != strings.Join(want, ",") {
                t.Fatalf("force 重排结果应为全升序: got %s... want %s...", strings.Join(got[:8], ","), strings.Join(want[:8], ","))
        }
}

func TestReorderChapterRefsForceZeroDisorderNoop(t *testing.T) {
        refs := []ChapterRef{}
        for i := 1; i <= 12; i++ {
                refs = append(refs, ChapterRef{Title: numTitle(i), URL: itoa(i)})
        }
        if rr := reorderChapterRefsForce(refs); rr.reordered {
                t.Fatal("已有序目录 force 不得重排（disorder=0 不动）")
        }
}

func numTitle(i int) string { return "第" + itoa(i) + "章 测试" }

// ---------- ② resort-chapters force 端点（端到端） ----------

func TestResortChaptersForceEndpoint(t *testing.T) {
        db, err := getDB()
        if err != nil {
                t.Fatalf("getDB: %v", err)
        }
        cleanup := func() {
                _, _ = db.Exec(`DELETE FROM "Chapter"`)
                _, _ = db.Exec(`DELETE FROM "Novel"`)
                _, _ = db.Exec(`DELETE FROM "Category"`)
                _, _ = db.Exec(`DELETE FROM "ScrapeTask"`)
        }
        cleanup()
        t.Cleanup(cleanup)

        if _, err := db.Exec(`INSERT INTO "Category" ("name") VALUES ('A86分类')`); err != nil {
                t.Fatalf("seed category: %v", err)
        }
        var novelID int64
        if err := db.QueryRow(
                `INSERT INTO "Novel" ("title","author","categoryId","createdAt","updatedAt") VALUES ('A86重排书','作者',(SELECT "id" FROM "Category" WHERE "name"='A86分类'),?,?) RETURNING "id"`,
                nowMillis(), nowMillis()).Scan(&novelID); err != nil {
                t.Fatalf("seed novel: %v", err)
        }

        // 种乱序目录：idx 1..10 = 第1..10章，idx 11..12 = 第105/106章，idx 13..17 = 第11..15章
        type seedRow struct {
                idx int
                no  int
        }
        rows := []seedRow{}
        for i := 1; i <= 10; i++ {
                rows = append(rows, seedRow{i, i})
        }
        rows = append(rows, seedRow{11, 105}, seedRow{12, 106})
        for i := 11; i <= 15; i++ {
                rows = append(rows, seedRow{i + 2, i})
        }
        for _, r := range rows {
                if _, err := db.Exec(
                        `INSERT INTO "Chapter" ("novelId","idx","title","createdAt") VALUES (?,?,?,?)`,
                        novelID, r.idx, numTitle(r.no), nowMillis()); err != nil {
                        t.Fatalf("seed chapter: %v", err)
                }
        }

        // force 端点（无活动任务 → 409 防护放行）
        rec := httptest.NewRecorder()
        req := httptest.NewRequest("POST", "/api/novels/resort-chapters", strings.NewReader(`{"novelId":`+itoa(int(novelID))+`,"force":true}`))
        req.Header.Set("Content-Type", "application/json")
        handleNovelsResortChaptersPost(rec, req, map[string]string{})
        if rec.Code != 200 {
                t.Fatalf("force 端点应 200: %d %s", rec.Code, rec.Body.String())
        }

        // 断言：idx 应变为 1..17 严格按章节序号（第105/106章排在 第15章 之后）
        type row struct {
                idx   int64
                title string
        }
        got := []row{}
        if err := queryList(`SELECT "idx","title" FROM "Chapter" WHERE "novelId" = ? ORDER BY "idx" ASC`, func(rows *sql.Rows) error {
                var r row
                if err := rows.Scan(&r.idx, &r.title); err != nil {
                        return err
                }
                got = append(got, r)
                return nil
        }, novelID); err != nil {
                t.Fatalf("query chapters: %v", err)
        }
        wantTitles := []string{}
        for i := 1; i <= 15; i++ {
                wantTitles = append(wantTitles, numTitle(i))
        }
        wantTitles = append(wantTitles, numTitle(105), numTitle(106))
        for i, r := range got {
                if r.title != wantTitles[i] {
                        t.Fatalf("重排后位置 %d 应为 %s，got idx=%d %s", i+1, wantTitles[i], r.idx, r.title)
                }
        }
}
