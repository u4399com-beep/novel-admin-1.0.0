/**
 * schema_test.go —— Task 39 纯 Go 全量建表引导回归锁定：
 * 1) 全新空库 ensureBaseSchema → 7 张业务表 + 关键索引/唯一约束全部在位，且幂等（跑两遍）；
 * 2) 外键约束真实生效（Chapter.novelId → Novel CASCADE）；
 * 3) 生产路径：getDB() 的 once 回调内 ensureBaseSchema 先于一切——TestMain 临时库
 *    （全新文件）经 getDB 打开后业务表必然已存在（本次事故的直击回归面）。
 */
package main

import (
	"database/sql"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

func openFreshTempDB(t *testing.T) *sql.DB {
	t.Helper()
	tmp := filepath.Join(t.TempDir(), "schema-test.db")
	db, err := sql.Open("sqlite", "file:"+tmp+"?_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func TestEnsureBaseSchemaFreshDB(t *testing.T) {
	db := openFreshTempDB(t)

	if err := ensureBaseSchema(db); err != nil {
		t.Fatalf("ensureBaseSchema: %v", err)
	}
	// 幂等：第二遍必须零错误零影响
	if err := ensureBaseSchema(db); err != nil {
		t.Fatalf("ensureBaseSchema idempotent: %v", err)
	}

	// 7 张业务表全部在位（ChapterContent/SiteSite 属 db.go 辖区不在此断言）
	wantTables := []string{"Category", "Novel", "Chapter", "SiteSetting", "PseoKeyword", "ScrapeRule", "ScrapeTask"}
	for _, tb := range wantTables {
		var n int
		if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?`, tb).Scan(&n); err != nil || n != 1 {
			t.Fatalf("表 %s 未建（count=%d err=%v）", tb, n, err)
		}
	}
	// 关键索引/唯一约束在位
	wantIdx := []string{
		"Category_name_key", "Novel_title_author_key", "Novel_categoryId_idx",
		"Novel_updatedAt_idx", "Novel_clicks_idx", "Chapter_novelId_idx_key",
		"Chapter_novelId_idx", "PseoKeyword_keyword_key", "ScrapeRule_name_key",
		"ScrapeTask_status_idx",
	}
	for _, ix := range wantIdx {
		var n int
		if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?`, ix).Scan(&n); err != nil || n != 1 {
			t.Fatalf("索引 %s 未建（count=%d err=%v）", ix, n, err)
		}
	}

	// 外键生效：无 Category 时插 Novel 必须被拒
	if _, err := db.Exec(`INSERT INTO "Novel" ("title","author","categoryId") VALUES ('t','a',12345)`); err == nil {
		t.Fatal("FK 未生效：无分类仍插入 Novel 成功")
	}
	// 正常链路：Category → Novel → Chapter，删书级联删章
	res, err := db.Exec(`INSERT INTO "Category" ("name") VALUES ('测试分类')`)
	if err != nil {
		t.Fatalf("insert category: %v", err)
	}
	cid, _ := res.LastInsertId()
	res, err = db.Exec(`INSERT INTO "Novel" ("title","author","categoryId","createdAt","updatedAt") VALUES ('测试书','作者',?,?,?)`, 1, 1, 1)
	if err != nil {
		t.Fatalf("insert novel: %v", err)
	}
	nid, _ := res.LastInsertId()
	if _, err := db.Exec(`INSERT INTO "Chapter" ("novelId","idx","title") VALUES (?,1,'第1章')`, nid); err != nil {
		t.Fatalf("insert chapter: %v", err)
	}
	if _, err := db.Exec(`DELETE FROM "Novel" WHERE "id"=?`, nid); err != nil {
		t.Fatalf("delete novel: %v", err)
	}
	var chapters int
	if err := db.QueryRow(`SELECT COUNT(*) FROM "Chapter" WHERE "novelId"=?`, nid).Scan(&chapters); err != nil || chapters != 0 {
		t.Fatalf("级联删除未生效（残留 %d 章 err=%v）", chapters, err)
	}
	_ = cid
}

// TestGetDBBootstrapsBaseSchema 生产路径直击：TestMain 的全新临时库经 getDB 打开后
// （once 回调内 ensureBaseSchema），业务表必然已存在——seed 播种时序契约的回归面。
func TestGetDBBootstrapsBaseSchema(t *testing.T) {
	db, err := getDB()
	if err != nil {
		t.Fatalf("getDB: %v", err)
	}
	for _, tb := range []string{"Category", "Novel", "Chapter", "SiteSetting", "PseoKeyword", "ScrapeRule", "ScrapeTask", "ChapterContent", "SiteSite"} {
		var n int
		if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?`, tb).Scan(&n); err != nil || n != 1 {
			t.Fatalf("getDB 后表 %s 不存在（count=%d err=%v）", tb, n, err)
		}
	}
}
