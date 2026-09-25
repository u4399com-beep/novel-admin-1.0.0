/**
 * seed_time_test.go —— Task 33-b 回归锁定：
 * 1) seed.go 播种 INSERT 禁用 SQL CURRENT_TIMESTAMP（Task 31 落档口径：任何 DB 写
 *    updatedAt 必须 Go nowMillis() 毫秒整数；SQLite CURRENT_TIMESTAMP 写 TEXT 存储类，
 *    TEXT > INTEGER 比较错位 + int64 Scan 500，本库 ScrapeRule.updatedAt 文本行实证源头）；
 * 2) normalizeLegacyRuleTimestamps 对存量 TEXT/乱值时间戳行的幂等归一。
 * 复用 recover_test.go 的 TestMain 临时库（绝不触碰生产 db/custom.db）。
 */
package main

import (
	"testing"
	"time"
)

func mustInitSeedTables(t *testing.T) {
	t.Helper()
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS "ScrapeRule" (
		"id" INTEGER PRIMARY KEY AUTOINCREMENT,
		"name" TEXT NOT NULL,
		"siteUrl" TEXT NOT NULL DEFAULT '',
		"enabled" INTEGER NOT NULL DEFAULT 1,
		"charset" TEXT NOT NULL DEFAULT '',
		"proxy" TEXT NOT NULL DEFAULT '',
		"insecureTLS" INTEGER NOT NULL DEFAULT 0,
		"listRule" TEXT NOT NULL DEFAULT '{}',
		"bookRule" TEXT NOT NULL DEFAULT '{}',
		"chapterRule" TEXT NOT NULL DEFAULT '{}',
		"notes" TEXT NOT NULL DEFAULT '',
		"createdAt" INTEGER,
		"updatedAt" INTEGER
	)`); err != nil {
		t.Fatalf("create ScrapeRule: %v", err)
	}
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS "Category" (
		"id" INTEGER PRIMARY KEY,
		"name" TEXT NOT NULL,
		"sort" INTEGER NOT NULL DEFAULT 0
	)`); err != nil {
		t.Fatalf("create Category: %v", err)
	}
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS "SiteSetting" (
		"id" INTEGER PRIMARY KEY,
		"siteName" TEXT NOT NULL DEFAULT '',
		"activeTheme" TEXT NOT NULL DEFAULT '',
		"notice" TEXT NOT NULL DEFAULT '',
		"seoConfig" TEXT NOT NULL DEFAULT '{}',
		"footerConfig" TEXT NOT NULL DEFAULT '{}',
		"homeConfig" TEXT NOT NULL DEFAULT '{}'
	)`); err != nil {
		t.Fatalf("create SiteSetting: %v", err)
	}
	t.Cleanup(func() {
		_, _ = db.Exec(`DELETE FROM "ScrapeRule"`)
		_, _ = db.Exec(`DELETE FROM "Category"`)
	})
}

// TestSeedIfEmptyWritesIntegerTimestamps 播种路径全量回归：空表播种后所有规则行的
// createdAt/updatedAt 必须是 integer 存储类毫秒值（旧版 CURRENT_TIMESTAMP 写 TEXT）。
func TestSeedIfEmptyWritesIntegerTimestamps(t *testing.T) {
	mustInitSeedTables(t)
	if err := seedIfEmpty(); err != nil {
		t.Fatalf("seedIfEmpty: %v", err)
	}
	var textRows, total int
	if err := queryOne(`SELECT COUNT(*) FROM "ScrapeRule" WHERE typeof("createdAt") != 'integer' OR typeof("updatedAt") != 'integer'`,
		[]any{&textRows}); err != nil {
		t.Fatalf("count text rows: %v", err)
	}
	if err := queryOne(`SELECT COUNT(*) FROM "ScrapeRule"`, []any{&total}); err != nil {
		t.Fatalf("count rules: %v", err)
	}
	if total == 0 {
		t.Fatal("播种后 ScrapeRule 不应为空（种子未生效）")
	}
	if textRows != 0 {
		t.Fatalf("播种写入的规则存在非 integer 时间戳行 %d/%d（CURRENT_TIMESTAMP 回归）", textRows, total)
	}
	// 幂等：重复 seedIfEmpty 不重复播种
	if err := seedIfEmpty(); err != nil {
		t.Fatalf("seedIfEmpty second: %v", err)
	}
	var total2 int
	_ = queryOne(`SELECT COUNT(*) FROM "ScrapeRule"`, []any{&total2})
	if total2 != total {
		t.Fatalf("重复播种改变行数 %d → %d（幂等被破坏）", total, total2)
	}
}

// TestNormalizeLegacyRuleTimestamps 存量 TEXT 时间戳归一（表驱动）：
// integer 行不动；可解析 TEXT 行归一为原毫秒值；乱值行按 nowMillis 兜底；归一后全表 integer。
func TestNormalizeLegacyRuleTimestamps(t *testing.T) {
	mustInitSeedTables(t)
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	before := nowMillis() - 3600_000
	textMs, _ := parseMillisText("2026-09-23 12:04:11")
	if _, err := db.Exec(`INSERT INTO "ScrapeRule" ("id","name","createdAt","updatedAt") VALUES (1,'int行',?,?)`, before, before); err != nil {
		t.Fatalf("insert int row: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO "ScrapeRule" ("id","name","createdAt","updatedAt") VALUES (2,'text行',?,?)`, "2026-09-23 12:04:11", "2026-09-23 12:04:11"); err != nil {
		t.Fatalf("insert text row: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO "ScrapeRule" ("id","name","createdAt","updatedAt") VALUES (3,'乱值行','not-a-date','garbage')`); err != nil {
		t.Fatalf("insert garbage row: %v", err)
	}
	t.Cleanup(func() { _, _ = db.Exec(`DELETE FROM "ScrapeRule" WHERE "id" IN (1,2,3)`) })

	normalizeLegacyRuleTimestamps()

	type tsRow struct {
		createdAt, updatedAt int64
	}
	get := func(id int64) tsRow {
		t.Helper()
		var r tsRow
		if err := queryOne(`SELECT "createdAt","updatedAt" FROM "ScrapeRule" WHERE "id" = ?`, []any{&r.createdAt, &r.updatedAt}, id); err != nil {
			t.Fatalf("read row %d: %v", id, err)
		}
		return r
	}
	if r := get(1); r.createdAt != before || r.updatedAt != before {
		t.Fatalf("integer 行不应被改动，got (%d,%d) want (%d,%d)", r.createdAt, r.updatedAt, before, before)
	}
	if r := get(2); r.createdAt != textMs || r.updatedAt != textMs {
		t.Fatalf("TEXT 行应归一为解析毫秒 %d，got (%d,%d)", textMs, r.createdAt, r.updatedAt)
	}
	if textMs == 0 {
		t.Fatal("parseMillisText 应能解析 CURRENT_TIMESTAMP 文本形态")
	}
	r3 := get(3)
	nowFloor := time.Now().UnixMilli() - 60_000
	if r3.createdAt < nowFloor || r3.updatedAt < nowFloor {
		t.Fatalf("乱值行应按 nowMillis 兜底（≥%d），got (%d,%d)", nowFloor, r3.createdAt, r3.updatedAt)
	}
	var textRows int
	if err := queryOne(`SELECT COUNT(*) FROM "ScrapeRule" WHERE typeof("createdAt") != 'integer' OR typeof("updatedAt") != 'integer'`,
		[]any{&textRows}); err != nil {
		t.Fatalf("count text rows: %v", err)
	}
	if textRows != 0 {
		t.Fatalf("归一后仍存在 %d 行非 integer 时间戳", textRows)
	}
}
