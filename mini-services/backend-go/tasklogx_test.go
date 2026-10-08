/**
 * R102-b 数据库优化回归：
 * ①索引优化（复合/部分索引存在性 + 旧冗余索引已删）；
 * ②ScrapeTaskLog 垂直拆表（迁移幂等、UPSERT 覆盖、级联删除）；
 * ③任务历史清理 TTL 语义（partial/running 保护）。
 * 测试库：独立临时文件库 + baseSchemaDDL 全量建表（与生产同构，各测试互不污染）。
 */
package main

import (
	"database/sql"
	"fmt"
	"testing"
)

var r102Seq int

// setupR102DB 独立 shared-memory 库 + 全量 schema（每测试独立命名空间互不污染；
// 单连接防内存库多连接各自为政）
func setupR102DB(t *testing.T) *sql.DB {
	t.Helper()
	r102Seq++
	dsn := fmt.Sprintf("file:r102mem%d?mode=memory&cache=shared&_pragma=foreign_keys(1)", r102Seq)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatalf("打开测试库失败: %v", err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })
	if _, err := db.Exec(baseSchemaDDL); err != nil {
		t.Fatalf("建表失败: %v", err)
	}
	return db
}

func insertR102Task(t *testing.T, db *sql.DB, status string, updatedAt int64) int64 {
	t.Helper()
	res, err := db.Exec(
		`INSERT INTO "ScrapeTask" ("mode","targetUrl","status","message","log","createdAt","updatedAt")
                 VALUES ('single','http://x/c',?,'','行',?,?)`, status, updatedAt, updatedAt)
	if err != nil {
		t.Fatalf("插入 %s 任务失败: %v", status, err)
	}
	id, _ := res.LastInsertId()
	return id
}

func TestR102Indexes(t *testing.T) {
	db := setupR102DB(t)
	want := map[string]bool{
		"Novel_updatedAt_id_idx":            false,
		"Novel_categoryId_updatedAt_id_idx": false,
		"Novel_clicks_id_idx":               false,
		"Chapter_novelId_idx_key":           false,
	}
	rows, err := db.Query(`SELECT name FROM sqlite_master WHERE type='index'`)
	if err != nil {
		t.Fatalf("查索引失败: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		_ = rows.Scan(&name)
		if _, ok := want[name]; ok {
			want[name] = true
		}
	}
	for name, found := range want {
		if !found {
			t.Errorf("索引 %s 应存在", name)
		}
	}
	// 旧冗余索引必须已删（DROP INDEX IF EXISTS 幂等执行后不存在）
	for _, name := range []string{"Novel_updatedAt_idx", "Novel_categoryId_idx", "Novel_clicks_idx", "Chapter_novelId_idx"} {
		var cnt int
		if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name = ?`, name).Scan(&cnt); err != nil {
			t.Fatalf("检查 %s 失败: %v", name, err)
		}
		if cnt != 0 {
			t.Errorf("冗余索引 %s 应已删除", name)
		}
	}
}

func TestR102TaskLogSplit(t *testing.T) {
	db := setupR102DB(t)
	now := nowMillis()
	t1 := insertR102Task(t, db, "running", now)
	t2 := insertR102Task(t, db, "success", now)
	// 给两任务写主表旧日志（模拟存量库）
	if _, err := db.Exec(`UPDATE "ScrapeTask" SET "log" = '存量-' || "id"`); err != nil {
		t.Fatalf("写存量日志失败: %v", err)
	}

	// 迁移：主表 log → 拆表；主表清零
	migrateTaskLogSplitDB(db)
	var mainLog string
	if err := db.QueryRow(`SELECT "log" FROM "ScrapeTask" WHERE "id" = ?`, t1).Scan(&mainLog); err != nil {
		t.Fatalf("查主表日志失败: %v", err)
	}
	if mainLog != "" {
		t.Fatalf("迁移后主表 log 应清零，got %q", mainLog)
	}
	// 二次迁移幂等（无重复行、无错误）
	migrateTaskLogSplitDB(db)
	var splitRows int
	if err := db.QueryRow(`SELECT COUNT(*) FROM "ScrapeTaskLog"`).Scan(&splitRows); err != nil {
		t.Fatalf("查拆表行数失败: %v", err)
	}
	if splitRows != 2 {
		t.Fatalf("拆表应有 2 行（幂等不重复），got %d", splitRows)
	}

	// UPSERT 覆盖语义（writeTaskLog 同构 SQL）
	if _, err := db.Exec(`INSERT INTO "ScrapeTaskLog" ("taskId","log") VALUES (?,?) ON CONFLICT("taskId") DO UPDATE SET "log" = excluded."log"`, t2, "覆盖后的新日志"); err != nil {
		t.Fatalf("UPSERT 失败: %v", err)
	}
	var v string
	if err := db.QueryRow(`SELECT "log" FROM "ScrapeTaskLog" WHERE "taskId" = ?`, t2).Scan(&v); err != nil || v != "覆盖后的新日志" {
		t.Fatalf("UPSERT 应覆盖，got %q err=%v", v, err)
	}
	// 级联：删任务 → 日志行自动消失
	if _, err := db.Exec(`DELETE FROM "ScrapeTask" WHERE "id" = ?`, t2); err != nil {
		t.Fatalf("删任务失败: %v", err)
	}
	var cnt int
	if err := db.QueryRow(`SELECT COUNT(*) FROM "ScrapeTaskLog" WHERE "taskId" = ?`, t2).Scan(&cnt); err != nil {
		t.Fatalf("查级联失败: %v", err)
	}
	if cnt != 0 {
		t.Fatalf("FK 级联应清理拆表日志行，got %d", cnt)
	}
}

func TestR102HistoryCleanup(t *testing.T) {
	db := setupR102DB(t)
	now := nowMillis()
	insertR102Task(t, db, "success", now-40*24*3600*1000)  // 终态超 TTL → 删
	insertR102Task(t, db, "failed", now-40*24*3600*1000)   // 终态超 TTL → 删
	insertR102Task(t, db, "canceled", now-40*24*3600*1000) // 终态超 TTL → 删
	insertR102Task(t, db, "success", now-10*24*3600*1000)  // 终态 TTL 内 → 保留
	insertR102Task(t, db, "partial", now-40*24*3600*1000)  // partial → 保留（可恢复）
	insertR102Task(t, db, "running", now)                  // running → 保留

	// 与 cleanupFinishedTasks 同构的 TTL 语义（全局态函数依赖 gDB，这里直连测试库验证 SQL）
	cutoff := now - taskHistoryTTLMs
	res, err := db.Exec(`DELETE FROM "ScrapeTask" WHERE "status" IN ('success','failed','canceled') AND "updatedAt" > 0 AND "updatedAt" < ?`, cutoff)
	if err != nil {
		t.Fatalf("TTL 清理失败: %v", err)
	}
	n, _ := res.RowsAffected()
	if n != 3 {
		t.Fatalf("TTL 应删 3 条 40 天前终态任务，got %d", n)
	}
	var remain []string
	rows, err := db.Query(`SELECT "status" FROM "ScrapeTask" ORDER BY "id" ASC`)
	if err != nil {
		t.Fatalf("复查失败: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var s string
		_ = rows.Scan(&s)
		remain = append(remain, s)
	}
	if len(remain) != 3 || remain[0] != "success" || remain[1] != "partial" || remain[2] != "running" {
		t.Fatalf("应保留 10 天前 success + 40 天前 partial + running，got %v", remain)
	}
}
