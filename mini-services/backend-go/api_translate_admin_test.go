/**
 * api_translate_admin_test.go —— 翻译缓存管理端点测试（R139）。
 *
 * 覆盖：stats 形状（总量/语种分布/按书归属含未归属桶）、clear 三态（按书/按语种/
 * 双空 400 防全清）、enqueue 态（缺 novelId 400 / 书不存在 404 / libre 语种放行
 * 后走书校验 404【R183 成本闸放开】/ 正常入队幂等）。DB 隔离沿用 TestMain（recover_test.go）+ mustInit 表守护。
 */
package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func translateAdminPost(handler func(w http.ResponseWriter, r *http.Request, ps map[string]string), body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/api/admin/translate-cache/x", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler(rec, req, nil)
	return rec
}

func mustInitTranslationQueueTable(t *testing.T) {
	t.Helper()
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS "TranslationQueue" (
                "id" INTEGER PRIMARY KEY AUTOINCREMENT,
                "novelId" INTEGER NOT NULL DEFAULT 0,
                "chapterId" INTEGER NOT NULL DEFAULT 0,
                "target" TEXT NOT NULL,
                "state" TEXT NOT NULL DEFAULT 'pending',
                "attempts" INTEGER NOT NULL DEFAULT 0,
                "updatedAt" INTEGER NOT NULL DEFAULT 0,
                UNIQUE("chapterId", "target")
        )`); err != nil {
		t.Fatalf("init TranslationQueue: %v", err)
	}
	_, _ = db.Exec(`DELETE FROM "TranslationQueue"`)
	_, _ = db.Exec(`DELETE FROM "TranslationCache"`)
}

func TestTranslateCacheClearValidation(t *testing.T) {
	mustInitTranslationCacheTable(t)

	// 双空 = 防意外全清（管理页不留全清入口的契约）
	if rec := translateAdminPost(handleTranslateCacheClear, `{}`); rec.Code != 400 {
		t.Fatalf("empty body must 400, got %d: %s", rec.Code, rec.Body.String())
	}
	// 非法语种
	if rec := translateAdminPost(handleTranslateCacheClear, `{"target":"xx"}`); rec.Code != 400 {
		t.Fatalf("bad target must 400, got %d", rec.Code)
	}
	// 按语种清理（空表 deleted=0 也应 200）
	rec := translateAdminPost(handleTranslateCacheClear, `{"target":"zh-Hant"}`)
	if rec.Code != 200 {
		t.Fatalf("clear by target must 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		OK      bool  `json:"ok"`
		Deleted int64 `json:"deleted"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || !out.OK {
		t.Fatalf("bad clear response: %v %s", err, rec.Body.String())
	}
}

func TestTranslateCacheClearByNovel(t *testing.T) {
	mustInitTranslationCacheTable(t)
	db, _ := getDB()
	_, _ = db.Exec(`INSERT INTO "TranslationCache" ("key","target","content","novelId","createdAt") VALUES
                ('k1|zh-Hant','zh-Hant','甲',7,1),('k2|zh-Hant','zh-Hant','乙',7,2),('k3|en','en','丙',8,3)`)

	rec := translateAdminPost(handleTranslateCacheClear, `{"novelId":7}`)
	if rec.Code != 200 {
		t.Fatalf("clear by novel must 200, got %d", rec.Code)
	}
	var out struct {
		Deleted int64 `json:"deleted"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out.Deleted != 2 {
		t.Fatalf("want deleted=2, got %d", out.Deleted)
	}
	db2, _ := getDB()
	var left int64
	_ = db2.QueryRow(`SELECT COUNT(*) FROM "TranslationCache"`).Scan(&left)
	if left != 1 {
		t.Fatalf("want 1 row left, got %d", left)
	}
}

func TestTranslateCacheStatsShape(t *testing.T) {
	mustInitTranslationCacheTable(t)
	db, _ := getDB()
	_, _ = db.Exec(`INSERT INTO "TranslationCache" ("key","target","content","novelId","createdAt") VALUES
                ('s1|zh-Hant','zh-Hant','段落一',9,100),('s2|ja','ja','段落二',9,200),('s3|en','en','段落三',0,300)`)

	req := httptest.NewRequest(http.MethodGet, "/api/admin/translate-cache/stats", nil)
	rec := httptest.NewRecorder()
	handleTranslateCacheStats(rec, req, nil)
	if rec.Code != 200 {
		t.Fatalf("stats must 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		OK          bool             `json:"ok"`
		Total       int64            `json:"total"`
		ApproxBytes int64            `json:"approxBytes"`
		ByTarget    []map[string]any `json:"byTarget"`
		ByNovel     []map[string]any `json:"byNovel"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("bad stats json: %v", err)
	}
	if !out.OK || out.Total != 3 || len(out.ByTarget) != 3 {
		t.Fatalf("unexpected stats: ok=%v total=%d targets=%d", out.OK, out.Total, len(out.ByTarget))
	}
	// 未归属桶必须在 byNovel 中显式可见（novelId=0）
	foundOrphan := false
	for _, r := range out.ByNovel {
		if r["novelId"].(float64) == 0 {
			foundOrphan = true
		}
	}
	if !foundOrphan {
		t.Fatalf("orphan bucket (novelId=0) missing from byNovel: %v", out.ByNovel)
	}
}

func mustInitNovelTable(t *testing.T) {
	t.Helper()
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS "Novel" (
                "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                "title" TEXT NOT NULL,
                "author" TEXT NOT NULL DEFAULT '',
                "description" TEXT NOT NULL DEFAULT '',
                "cover" TEXT NOT NULL DEFAULT 'g1',
                "coverSrc" TEXT NOT NULL DEFAULT '',
                "categoryId" INTEGER NOT NULL DEFAULT 0,
                "status" TEXT NOT NULL DEFAULT 'serial',
                "isFeatured" BOOLEAN NOT NULL DEFAULT false,
                "isHot" BOOLEAN NOT NULL DEFAULT false,
                "wordCount" INTEGER NOT NULL DEFAULT 0,
                "clicks" INTEGER NOT NULL DEFAULT 0,
                "createdAt" INTEGER NOT NULL DEFAULT 0,
                "updatedAt" INTEGER NOT NULL DEFAULT 0
        )`); err != nil {
		t.Fatalf("init Novel: %v", err)
	}
	_, _ = db.Exec(`DELETE FROM "Novel" WHERE "id"=901`)
}

func TestTranslateCacheEnqueueValidation(t *testing.T) {
	mustInitTranslationQueueTable(t)
	mustInitNovelTable(t)

	// 缺 novelId
	if rec := translateAdminPost(handleTranslateCacheEnqueue, `{}`); rec.Code != 400 {
		t.Fatalf("no novelId must 400, got %d", rec.Code)
	}
	// 书不存在
	if rec := translateAdminPost(handleTranslateCacheEnqueue, `{"novelId":12345}`); rec.Code != 404 {
		t.Fatalf("unknown novel must 404, got %d: %s", rec.Code, rec.Body.String())
	}
	// libre 语种（en）成本闸已放开（R183：R173 LibreTranslate 零边际成本）——
	// 不再语种级 400，走书存在性校验：书 901 本测试未插入 → 404 语义链验证
	if rec := translateAdminPost(handleTranslateCacheEnqueue, `{"novelId":901,"targets":["en"]}`); rec.Code != 404 {
		t.Fatalf("libre target on unknown novel must 404 (target gate lifted), got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestTranslateCacheEnqueueOk(t *testing.T) {
	mustInitTranslationQueueTable(t)
	mustInitNovelTable(t)
	db, _ := getDB()
	// 最小书+两章（Chapter 表在 TestMain 最小 schema 内——若无 Chapter 表则建）
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS "Chapter" ("id" INTEGER PRIMARY KEY, "novelId" INTEGER, "idx" INTEGER, "title" TEXT, "volume" TEXT, "content" TEXT, "wordCount" INTEGER, "createdAt" INTEGER)`); err != nil {
		t.Fatalf("init Chapter: %v", err)
	}
	// 分类确定性获取（全量套件共享 tmp DB：其他测试可能已建/清空 Category——
	// 取现有行，无则建；不依赖固定 id=1）
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS "Category" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT NOT NULL, "sort" INTEGER NOT NULL DEFAULT 0)`); err != nil {
		t.Fatalf("init Category: %v", err)
	}
	var catID int64
	if err := db.QueryRow(`SELECT "id" FROM "Category" ORDER BY "id" LIMIT 1`).Scan(&catID); err != nil {
		if _, ierr := db.Exec(`INSERT INTO "Category" ("name") VALUES ('翻译预热测试分类')`); ierr != nil {
			t.Fatalf("insert category: %v", ierr)
		}
		if err := db.QueryRow(`SELECT "id" FROM "Category" ORDER BY "id" LIMIT 1`).Scan(&catID); err != nil {
			t.Fatalf("category still missing: %v", err)
		}
	}
	if _, err := db.Exec(`INSERT INTO "Novel" ("id","title","author","categoryId") VALUES (901,'预热测试书','佚名',?)`, catID); err != nil {
		t.Fatalf("insert novel: %v", err)
	}
	_, _ = db.Exec(`DELETE FROM "Chapter" WHERE "novelId"=901`)
	if _, err := db.Exec(`INSERT INTO "Chapter" ("id","novelId","idx","title") VALUES (1,901,1,'一'),(2,901,2,'二')`); err != nil {
		t.Fatalf("insert chapters: %v", err)
	}

	rec := translateAdminPost(handleTranslateCacheEnqueue, `{"novelId":901}`)
	if rec.Code != 200 {
		t.Fatalf("enqueue ok path must 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Enqueued int64 `json:"enqueued"`
		Chapters int64 `json:"chapters"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out.Chapters != 2 || out.Enqueued != 4 { // 2 章 × 默认双语种（zh-Hant/zh-HK）
		t.Fatalf("want chapters=2 enqueued=4, got %d/%d", out.Chapters, out.Enqueued)
	}
	db2, _ := getDB()
	var qn int64
	_ = db2.QueryRow(`SELECT COUNT(*) FROM "TranslationQueue" WHERE "novelId"=901 AND "state"='pending'`).Scan(&qn)
	if qn != 4 {
		t.Fatalf("queue rows want 4 pending, got %d", qn)
	}
}
