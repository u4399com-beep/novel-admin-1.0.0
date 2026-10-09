/**
 * worker_bookparallel_test.go —— P1-2（R107 提速·host 感知书间并行池）回归锁定：
 *
 * 1) TestPhase2FillBookParallelMultiHost：多域 fillMap（2 host × 2 书）经 phase2Fill
 *    书间并行池全部填充成功；任务日志含 [book-parallel] 域检测行（两个域都被识别）；
 *    章节行 wordCount 落库（并行路径与串行路径持久化语义一致）。
 * 2) TestPhase2FillBookParallelSerialSingleHost：单域 fillMap 退化串行（无并行日志，
 *    行为与历史版本等价）；SCRAPE_BOOK_PARALLEL=1 强制串行同款。
 * 3) TestPhase2FillBookParallelBreakerDrains：连败熔断触发后生产端停止投递、workers
 *    持续 drain 至 close 不死锁（30s 看门狗护栏；旧实现若有生产/消费阻塞此测试超时）。
 * 复用 recover_test.go 的 TestMain 临时库（绝不触碰生产 db/custom.db）。
 */
package main

import (
        "fmt"
        "net/http"
        "net/http/httptest"
        "strings"
        "sync/atomic"
        "testing"
        "time"
)

// stubChapterServer 构造引擎 /api/chapter 桩：failAll=false 返回固定正文，否则整链失败
func stubChapterServer(t *testing.T, calls *atomic.Int64, failAll bool) *httptest.Server {
        t.Helper()
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                calls.Add(1)
                w.Header().Set("Content-Type", "application/json")
                if failAll {
                        _, _ = w.Write([]byte(`{"ok":false,"error":"stub 全链失败（模拟源站封禁）","warnings":[]}`))
                        return
                }
                _, _ = w.Write([]byte(`{"ok":true,"data":{"title":"第1章 桩","content":"这是桩正文内容，长度足够通过空壳判定。"},"warnings":[],"elapsedMs":5}`))
        }))
        t.Cleanup(srv.Close)
        return srv
}

// seedNovelForFill 种 Novel 行（Chapter.novelId 外键前置；Category 外键一并种）
func seedNovelForFill(t *testing.T, novelID int) {
	t.Helper()
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	if _, err := db.Exec(`INSERT OR IGNORE INTO "Category" ("id","name","sort") VALUES (990000,'并行池测试分类',0)`); err != nil {
		t.Fatalf("seed category: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO "Novel" ("id","title","author","categoryId","createdAt","updatedAt") VALUES (?,?,'测试作者',990000,?,?)`,
		novelID, fmt.Sprintf("并行池测试书-%d", novelID), nowMillis(), nowMillis()); err != nil {
		t.Fatalf("seed novel %d: %v", novelID, err)
	}
	t.Cleanup(func() {
		_, _ = db.Exec(`DELETE FROM "Novel" WHERE "id" = ?`, novelID)
	})
}

// seedChapterSkeleton 向临时库种一章 wordCount=0 骨架（fillMap 行的 DB 对应物）
func seedChapterSkeleton(t *testing.T, dbID, novelID int, idx int, title string) {
        t.Helper()
        db, err := getDB()
        if err != nil {
                t.Fatalf("open temp db: %v", err)
        }
        if _, err := db.Exec(`INSERT INTO "Chapter" ("id","novelId","idx","title","wordCount","createdAt") VALUES (?,?,?,?,0,?)`,
                dbID, novelID, idx, title, nowMillis()); err != nil {
                t.Fatalf("seed chapter %d: %v", dbID, err)
        }
        t.Cleanup(func() {
                _, _ = db.Exec(`DELETE FROM "Chapter" WHERE "id" = ?`, dbID)
                _, _ = db.Exec(`DELETE FROM "ChapterContent" WHERE "chapterId" = ?`, dbID)
        })
}

func bookparallelFillMap(t *testing.T) (map[int]fillPlan, []int) {
        // 2 域 × 2 书 × 1 章；novelID 101/102 = a.example，201/202 = b.example。
        // 种章标题必须与 fillMap 行标题逐字一致（persistChapterFill 前置批查按 title IN 匹配）
        fillMap := map[int]fillPlan{
                101: {Referer: "https://a.example/book/1", Rows: []refPair{{Title: "第1章 A1", URL: "https://a.example/ch1.html"}}},
                102: {Referer: "https://a.example/book/2", Rows: []refPair{{Title: "第1章 A2", URL: "https://a.example/ch2.html"}}},
                201: {Referer: "https://b.example/book/1", Rows: []refPair{{Title: "第1章 B1", URL: "https://b.example/ch1.html"}}},
                202: {Referer: "https://b.example/book/2", Rows: []refPair{{Title: "第1章 B2", URL: "https://b.example/ch2.html"}}},
        }
        ids := []int{101, 102, 201, 202}
        for _, id := range ids {
                seedNovelForFill(t, id)
                seedChapterSkeleton(t, 990_900+id, id, 1, fillMap[id].Rows[0].Title)
        }
        return fillMap, ids
}

func chapterWordCount(t *testing.T, dbID int) int64 {
        t.Helper()
        var wc int64
        db, err := getDB()
        if err != nil {
                t.Fatalf("open temp db: %v", err)
        }
        if err := db.QueryRow(`SELECT "wordCount" FROM "Chapter" WHERE "id" = ?`, dbID).Scan(&wc); err != nil {
                t.Fatalf("query wordCount #%d: %v", dbID, err)
        }
        return wc
}

func TestPhase2FillBookParallelMultiHost(t *testing.T) {
        var calls atomic.Int64
        srv := stubChapterServer(t, &calls, false)
        t.Setenv("BACKEND_ENGINE_URL", srv.URL)
        seedRunningTaskForTest(t, 990_940, "https://a.example/book/1")

        fillMap, ids := bookparallelFillMap(t)
        run := NewRun(990_940)
        out := phase2Fill(run, LoadedRule{}, fillMap, "db", func(int) bool { return true })

        if out.Filled != 4 || out.Failed != 0 {
                t.Fatalf("4 书 × 1 章应全部填充成功，got filled=%d failed=%d", out.Filled, out.Failed)
        }
        if calls.Load() != 4 {
                t.Fatalf("stub 引擎应被调 4 次（每章 1 次），got %d", calls.Load())
        }
        logText := run.LogText()
        if !strings.Contains(logText, "[book-parallel]") {
                t.Fatalf("多域任务应打印书间并行域检测日志，got: %s", logText)
        }
        if !strings.Contains(logText, "a.example") || !strings.Contains(logText, "b.example") {
                t.Fatalf("域检测日志应含两个源站域，got: %s", logText)
        }
        for _, dbID := range []int{990_900 + 101, 990_900 + 102, 990_900 + 201, 990_900 + 202} {
                if got := chapterWordCount(t, dbID); got <= 0 {
                        t.Fatalf("章节 #%d 应已落库 wordCount>0（并行路径持久化语义），got %d", dbID, got)
                }
        }
        _ = ids
}

func TestPhase2FillBookParallelSerialSingleHost(t *testing.T) {
        var calls atomic.Int64
        srv := stubChapterServer(t, &calls, false)
        t.Setenv("BACKEND_ENGINE_URL", srv.URL)
        t.Setenv("SCRAPE_BOOK_PARALLEL", "1") // 显式关闭并行（env 开关回归）
        seedRunningTaskForTest(t, 990_941, "https://a.example/book/1")

        // 单域 2 书：bookPar=1 与单域双重退化 → 串行路径
        fillMap := map[int]fillPlan{
                101: {Referer: "https://a.example/book/1", Rows: []refPair{{Title: "第1章 S1", URL: "https://a.example/ch1.html"}}},
                102: {Referer: "https://a.example/book/2", Rows: []refPair{{Title: "第1章 S2", URL: "https://a.example/ch2.html"}}},
        }
        seedNovelForFill(t, 101)
        seedNovelForFill(t, 102)
        seedChapterSkeleton(t, 990_950, 101, 1, "第1章 S1")
        seedChapterSkeleton(t, 990_951, 102, 1, "第1章 S2")

        run := NewRun(990_941)
        out := phase2Fill(run, LoadedRule{}, fillMap, "db", func(int) bool { return true })
        if out.Filled != 2 || out.Failed != 0 {
                t.Fatalf("单域串行路径应全部填充成功，got filled=%d failed=%d", out.Filled, out.Failed)
        }
        if strings.Contains(run.LogText(), "[book-parallel]") {
                t.Fatalf("单域任务不应打印并行日志（退化为串行），got: %s", run.LogText())
        }
}

func TestPhase2FillBookParallelBreakerDrains(t *testing.T) {
        var calls atomic.Int64
        srv := stubChapterServer(t, &calls, true) // 全部失败 → 连败熔断
        t.Setenv("BACKEND_ENGINE_URL", srv.URL)
        seedRunningTaskForTest(t, 990_942, "https://a.example/book/1")

        // 收紧熔断阈值（包内变量直改，defer 复原；Go 测试同包串行无并发读险）
        origBreaker := PHASE2_FAIL_BREAKER
        PHASE2_FAIL_BREAKER = 2
        defer func() { PHASE2_FAIL_BREAKER = origBreaker }()

        // 2 域 × 3 书 × 1 章：熔断后剩余组的书必须被 workers drain（不死锁）
        fillMap := map[int]fillPlan{
                101: {Referer: "https://a.example/book/1", Rows: []refPair{{Title: "第1章 X1", URL: "https://a.example/x1.html"}}},
                102: {Referer: "https://a.example/book/2", Rows: []refPair{{Title: "第1章 X2", URL: "https://a.example/x2.html"}}},
                103: {Referer: "https://a.example/book/3", Rows: []refPair{{Title: "第1章 X3", URL: "https://a.example/x3.html"}}},
                201: {Referer: "https://b.example/book/1", Rows: []refPair{{Title: "第1章 Y1", URL: "https://b.example/y1.html"}}},
                202: {Referer: "https://b.example/book/2", Rows: []refPair{{Title: "第1章 Y2", URL: "https://b.example/y2.html"}}},
                203: {Referer: "https://b.example/book/3", Rows: []refPair{{Title: "第1章 Y3", URL: "https://b.example/y3.html"}}},
        }
        for id, plan := range fillMap {
                seedNovelForFill(t, id)
                seedChapterSkeleton(t, 990_960+id, id, 1, plan.Rows[0].Title)
        }
        run := NewRun(990_942)

        done := make(chan Phase2Outcome, 1)
        go func() {
                done <- phase2Fill(run, LoadedRule{}, fillMap, "db", func(int) bool { return true })
        }()
        select {
        case out := <-done:
                if !out.FailBreaker {
                        t.Fatalf("全失败场景应触发连败熔断（FailBreaker=true）")
                }
                if out.Filled != 0 {
                        t.Fatalf("全失败场景不应有填充成功，got %d", out.Filled)
                }
        case <-time.After(30 * time.Second):
                t.Fatal("phase2Fill 在熔断后 30s 未返回——书间并行池存在生产/消费阻塞死锁")
        }
}
