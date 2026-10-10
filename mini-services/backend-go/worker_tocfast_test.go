/**
 * worker_tocfast_test.go —— P3-4（R108 提速·关关式连载监听快进）回归锁定：
 *
 * 1) TestTocFastSkipTargetBranches：三重条件逐分支（新鲜窗口/窗口过期/空骨架存在/
 *    作者不匹配/条目无作者/env 关闭）。
 * 2) TestPhase1TocFastSkipsBookFetch：快进命中的条目不发起书页抓取（stub 引擎 0 调用），
 *    无作者条目照常走抓取路径（对照组）；outcome.SkippedFresh 记账正确。
 * 复用 recover_test.go 的 TestMain 临时库与 audit85b_test.go 的 stubBookResp 书页桩。
 */
package main

import (
        "net/http"
        "net/http/httptest"
        "strings"
        "sync/atomic"
        "testing"
)

func seedNovelFull(t *testing.T, id int, title, author string, tocScannedAt int64) {
        t.Helper()
        db, err := getDB()
        if err != nil {
                t.Fatalf("open temp db: %v", err)
        }
        if _, err := db.Exec(`INSERT OR IGNORE INTO "Category" ("id","name","sort") VALUES (990000,'快进测试分类',0)`); err != nil {
                t.Fatalf("seed category: %v", err)
        }
        if _, err := db.Exec(`INSERT OR REPLACE INTO "Novel" ("id","title","author","categoryId","tocScannedAt","createdAt","updatedAt") VALUES (?,?,?,990000,?,?,?)`,
                id, title, author, tocScannedAt, nowMillis(), nowMillis()); err != nil {
                t.Fatalf("seed novel %d: %v", id, err)
        }
        t.Cleanup(func() {
                _, _ = db.Exec(`DELETE FROM "Novel" WHERE "id" = ?`, id)
        })
}

func TestTocFastSkipTargetBranches(t *testing.T) {
        fresh := nowMillis() - 5*3600_000     // 5h 前（6h 窗口内）
        stale := nowMillis() - 24*3600_000    // 24h 前（窗口外）
        item := ListItem{Title: "快进之书", URL: "https://tf.example/book/1", Author: "快进作者"}

        // ① 命中：库内已有（title+author 精确匹配）+ 窗口内 + 零空骨架
        seedNovelFull(t, 990_980, "快进之书", "快进作者", fresh)
        if id, ok := tocFastSkipTarget(LoadedRule{}, item); !ok || id != 990_980 {
                t.Fatalf("新鲜窗口+零空骨架应命中快进，got id=%d ok=%v", id, ok)
        }

        // ② 窗口外：照常重扫
        seedNovelFull(t, 990_981, "过期之书", "快进作者", stale)
        if _, ok := tocFastSkipTarget(LoadedRule{}, ListItem{Title: "过期之书", Author: "快进作者"}); ok {
                t.Fatalf("窗口外的书不应快进")
        }

        // ③ 有空骨架（wordCount=0）：续传 URL 依赖目录 diff，必须重抓
        seedNovelFull(t, 990_982, "空骨架之书", "快进作者", fresh)
        db, _ := getDB()
        if _, err := db.Exec(`INSERT INTO "Chapter" ("id","novelId","idx","title","wordCount","createdAt") VALUES (9909821,990982,1,'第1章 空骨架',0,?)`, nowMillis()); err != nil {
                t.Fatalf("seed empty chapter: %v", err)
        }
        t.Cleanup(func() {
                _, _ = db.Exec(`DELETE FROM "Chapter" WHERE "id" = 9909821`)
        })
        if _, ok := tocFastSkipTarget(LoadedRule{}, ListItem{Title: "空骨架之书", Author: "快进作者"}); ok {
                t.Fatalf("有空骨架的书不应快进（续传 URL 依赖目录 diff）")
        }

        // ④ 作者不匹配（同名异书）：不快进
        if _, ok := tocFastSkipTarget(LoadedRule{}, ListItem{Title: "快进之书", Author: "另一位作者"}); ok {
                t.Fatalf("作者不匹配不应快进（防同名异书误跳）")
        }

        // ⑤ 条目无作者：双键不齐，不快进
        if _, ok := tocFastSkipTarget(LoadedRule{}, ListItem{Title: "快进之书"}); ok {
                t.Fatalf("条目无作者不应快进（保守规则）")
        }

        // ⑥ env 关闭：永不快进
        t.Setenv("SCRAPE_TOC_REFRESH_HOURS", "0")
        if _, ok := tocFastSkipTarget(LoadedRule{}, item); ok {
                t.Fatalf("SCRAPE_TOC_REFRESH_HOURS=0 应整体停用快进")
        }
}

func TestPhase1TocFastSkipsBookFetch(t *testing.T) {
        var calls atomic.Int64
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                calls.Add(1)
                w.Header().Set("Content-Type", "application/json")
                _, _ = w.Write([]byte(stubBookResp("对照组书", 3, "https://tf.example/b2", nil)))
        }))
        t.Cleanup(srv.Close)
        t.Setenv("BACKEND_ENGINE_URL", srv.URL)
        seedRunningTaskForTest(t, 990_983, "https://tf.example/list")

        // 命中快进的条目：库内已有（title+author 匹配）+ 窗口内 + 零空骨架
        seedNovelFull(t, 990_984, "快进之书", "快进作者", nowMillis()-3600_000)
        items := []ListItem{
                {Title: "快进之书", URL: "https://tf.example/book/1", Author: "快进作者"},
                {Title: "对照组书", URL: "https://tf.example/book/2"}, // 无作者 → 照常抓取（对照组）
        }

        run := NewRun(990_983)
        out := phase1Skeletons(run, LoadedRule{}, items, "https://tf.example/list")

        if out.SkippedFresh != 1 {
                t.Fatalf("应恰好快进跳过 1 条，got SkippedFresh=%d", out.SkippedFresh)
        }
        if calls.Load() != 1 {
                t.Fatalf("书页 stub 应只被对照组条目调用 1 次（快进条目零请求），got %d", calls.Load())
        }
        if out.OKBooks != 1 {
                t.Fatalf("对照组条目应正常入库 1 本，got OKBooks=%d", out.OKBooks)
        }
        if !strings.Contains(run.LogText(), "[toc-fast]") {
                t.Fatalf("任务日志应含 [toc-fast] 行，got: %s", run.LogText())
        }

        // 快进跳过的书 tocScannedAt 应被续期（跳过视作一次扫描）
        db, _ := getDB()
        var scanned int64
        if err := db.QueryRow(`SELECT "tocScannedAt" FROM "Novel" WHERE "id" = 990984`).Scan(&scanned); err != nil {
                t.Fatalf("query tocScannedAt: %v", err)
        }
        if nowMillis()-scanned >= int64(tocRefreshHours())*3600_000 {
                t.Fatalf("快进命中后续期失败：scanned=%d now=%d", scanned, nowMillis())
        }
}
