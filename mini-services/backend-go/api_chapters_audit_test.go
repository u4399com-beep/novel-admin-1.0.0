/**
 * api_chapters_audit_test.go —— Task 33-b 回归锁定（/api/chapters/audit 修复链）：
 * 1) reindex 单事务原子执行：乱序章节压实 idx 1..n，不留 -1000000 僵尸序号（旧版两段式
 *    UPDATE 忽略错误，段落位失败即永久滞留负数暂存区）；
 * 2) 重排变号后 TXT 分章文件同步改名（旧版文件名仍挂旧 idx，txt 回落串章/丢失）；
 * 3) dedupe 删除重复行 + 其 TXT 文件一并清理（旧版残留已删行文件，压实后新 idx 命中
 *    已删行旧文件读到已删章节内容）。
 * 复用 recover_test.go 的 TestMain 临时库 + TXT_ROOT 临时目录（绝不触碰生产库/文件）。
 */
package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func mustInitAuditTables(t *testing.T) {
	t.Helper()
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS "Novel" (
                "id" INTEGER PRIMARY KEY AUTOINCREMENT,
                "title" TEXT NOT NULL,
                "wordCount" INTEGER NOT NULL DEFAULT 0,
                "updatedAt" INTEGER NOT NULL DEFAULT 0
        )`); err != nil {
		t.Fatalf("create Novel: %v", err)
	}
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS "Chapter" (
                "id" INTEGER PRIMARY KEY AUTOINCREMENT,
                "novelId" INTEGER NOT NULL REFERENCES "Novel"("id") ON DELETE CASCADE,
                "idx" INTEGER NOT NULL,
                "title" TEXT NOT NULL DEFAULT '',
                "content" TEXT NOT NULL DEFAULT '',
                "wordCount" INTEGER NOT NULL DEFAULT 0,
                "createdAt" INTEGER NOT NULL DEFAULT 0,
                UNIQUE("novelId","idx")
        )`); err != nil {
		t.Fatalf("create Chapter: %v", err)
	}
	t.Cleanup(func() {
		_, _ = db.Exec(`DELETE FROM "Chapter"`)
		_, _ = db.Exec(`DELETE FROM "Novel"`)
	})
}

func insertAuditChapter(t *testing.T, novelID int64, idx int64, title string, wc int) int64 {
	t.Helper()
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	res, err := db.Exec(`INSERT INTO "Chapter" ("novelId","idx","title","wordCount","createdAt") VALUES (?,?,?,?,?)`,
		novelID, idx, title, wc, nowMillis())
	if err != nil {
		t.Fatalf("insert chapter (novel=%d idx=%d): %v", novelID, idx, err)
	}
	id, _ := res.LastInsertId()
	return id
}

func postAuditAction(t *testing.T, body string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/chapters/audit", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handleChapterAuditPost(rec, req, nil)
	var m map[string]any
	if b := rec.Body.Bytes(); len(b) > 0 {
		_ = json.Unmarshal(b, &m)
	}
	return rec.Code, m
}

func chapterIdxByTitle(t *testing.T, novelID int64) map[string]int64 {
	t.Helper()
	out := map[string]int64{}
	err := queryList(`SELECT "title","idx" FROM "Chapter" WHERE "novelId" = ?`, func(rs *sql.Rows) error {
		var title string
		var idx int64
		if err := rs.Scan(&title, &idx); err != nil {
			return err
		}
		out[title] = idx
		return nil
	}, novelID)
	if err != nil {
		t.Fatalf("query chapters: %v", err)
	}
	return out
}

// TestAuditReindexReordersAndSyncsTxt reindex：乱序压实 + txt 文件随 idx 改名
func TestAuditReindexReordersAndSyncsTxt(t *testing.T) {
	mustInitAuditTables(t)
	t.Setenv("TXT_ROOT", t.TempDir())
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	// 基础 schema 下 Novel.categoryId NOT NULL+FK：先建分类行
	if _, err := db.Exec(`INSERT OR IGNORE INTO "Category" ("id","name") VALUES (9001,'测试分类')`); err != nil {
		t.Fatalf("insert category: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO "Novel" ("id","title","author","categoryId","updatedAt") VALUES (1,'重排测试书','测试作者',9001,?)`, nowMillis()); err != nil {
		t.Fatalf("insert novel: %v", err)
	}
	// idx 顺序与标题序号完全错开（1..4 全部变号）
	insertAuditChapter(t, 1, 1, "第3章", 10)
	insertAuditChapter(t, 1, 2, "第1章", 10)
	insertAuditChapter(t, 1, 3, "第4章", 10)
	insertAuditChapter(t, 1, 4, "第2章", 10)
	// txt 文件按「旧 idx + 旧标题」落盘（与写入方 writeChapterTxt 同口径）
	for _, c := range []struct {
		idx int
		title,
		body string
	}{{1, "第3章", "body3"}, {2, "第1章", "body1"}, {3, "第4章", "body4"}, {4, "第2章", "body2"}} {
		if err := writeChapterTxt(1, c.idx, c.title, c.body); err != nil {
			t.Fatalf("write txt: %v", err)
		}
	}

	code, resp := postAuditAction(t, `{"action":"reindex","novelId":1}`)
	if code != 200 {
		t.Fatalf("reindex 应 200，got %d（%v）", code, resp)
	}
	if moved, _ := resp["moved"].(float64); int(moved) != 4 {
		t.Fatalf("moved = %v, want 4（1..4 全部变号）", resp["moved"])
	}
	// DB idx 压实后与标题序号一致，无 -1000000 僵尸序号
	got := chapterIdxByTitle(t, 1)
	for title, want := range map[string]int64{"第1章": 1, "第2章": 2, "第3章": 3, "第4章": 4} {
		if got[title] != want {
			t.Fatalf("章节 %s idx = %d, want %d（全表：%v）", title, got[title], want, got)
		}
	}
	// txt 文件内容跟随新 idx（旧版串章：位置 1 读到 body3）
	for idx, want := range map[int]string{1: "body1", 2: "body2", 3: "body3", 4: "body4"} {
		body, err := readChapterFromTxt(1, idx)
		if err != nil || body != want {
			t.Fatalf("txt 位置 %d = (%q,%v), want %q", idx, body, err, want)
		}
	}
	// 无暂存残留
	entries, _ := os.ReadDir(novelTxtDir(1))
	for _, e := range entries {
		if strings.Contains(e.Name(), "reidx_") {
			t.Fatalf("存在暂存残留文件 %s", e.Name())
		}
	}
	_ = filepath.Join // 保持 import 精简
}

// TestAuditReindexRepairsLegacyStuckNegativeRows Task 42-b 回归：旧二进制两段式重排的
// 段落位失败曾把章永久滞留在 idx=-1_000_000-i（本文件头注 33-b 所述病灶，属本系统自身
// 历史损伤类）。固定 -1_000_000-i 暂存值与滞留行相撞：待暂存行落到滞留行已占的
// (novelId,idx) → UNIQUE 冲突 → 整个事务回滚 500，该损伤类永久不可 reindex
// （P2-9「再次 reindex 即修复」的恢复路径失效）。暂存区压到全书最小 idx 之下后必须可修复。
func TestAuditReindexRepairsLegacyStuckNegativeRows(t *testing.T) {
	mustInitAuditTables(t)
	t.Setenv("TXT_ROOT", t.TempDir())
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	if _, err := db.Exec(`INSERT OR IGNORE INTO "Category" ("id","name") VALUES (9004,'测试分类4')`); err != nil {
		t.Fatalf("insert category: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO "Novel" ("id","title","author","categoryId","updatedAt") VALUES (4,'滞留行修复书','测试作者',9004,?)`, nowMillis()); err != nil {
		t.Fatalf("insert novel: %v", err)
	}
	// 滞留行（旧版段落位失败的遗留形态）+ 正数行乱序：
	// 按标题序 ordered = [第1章(idx2), 第2章(idx=-1000000), 第3章(idx1)]，
	// 旧版暂存 i=0 即把「第1章」落到 -1_000_000 —— 与滞留行相撞。
	insertAuditChapter(t, 4, 2, "第1章", 10)
	insertAuditChapter(t, 4, -1_000_000, "第2章", 10)
	insertAuditChapter(t, 4, 1, "第3章", 10)
	// txt 仅正数旧 idx 行有文件（reindexChapterTxtFiles 对无文件行自动跳过）
	if err := writeChapterTxt(4, 2, "第1章", "body1"); err != nil {
		t.Fatalf("write txt: %v", err)
	}
	if err := writeChapterTxt(4, 1, "第3章", "body3"); err != nil {
		t.Fatalf("write txt: %v", err)
	}

	code, resp := postAuditAction(t, `{"action":"reindex","novelId":4}`)
	if code != 200 {
		t.Fatalf("对滞留行损伤书 reindex 应 200（恢复路径必须存在），got %d（%v）", code, resp)
	}
	if moved, _ := resp["moved"].(float64); int(moved) != 3 {
		t.Fatalf("moved = %v, want 3（三行全部变号）", resp["moved"])
	}
	got := chapterIdxByTitle(t, 4)
	for title, want := range map[string]int64{"第1章": 1, "第2章": 2, "第3章": 3} {
		if got[title] != want {
			t.Fatalf("章节 %s idx = %d, want %d（全表：%v）", title, got[title], want, got)
		}
	}
	// 无负数 idx 残留（滞留行被一并压实进 1..n）
	var neg int64
	if err := queryOne(`SELECT COUNT(*) FROM "Chapter" WHERE "novelId" = 4 AND "idx" < 1`, []any{&neg}); err != nil || neg != 0 {
		t.Fatalf("负数 idx 残留 %d（err=%v）", neg, err)
	}
	// txt 内容跟随新 idx；滞留行（无文件）位置 2 读不到属预期
	if body, err := readChapterFromTxt(4, 1); err != nil || body != "body1" {
		t.Fatalf("txt 位置 1 = (%q,%v), want body1", body, err)
	}
	if _, err := readChapterFromTxt(4, 2); !errors.Is(err, errTxtNotFound) {
		t.Fatalf("位置 2（滞留行无文件）应 errTxtNotFound，got %v", err)
	}
	if body, err := readChapterFromTxt(4, 3); err != nil || body != "body3" {
		t.Fatalf("txt 位置 3 = (%q,%v), want body3", body, err)
	}
}

// TestAuditReindexEdges 边界回归（表驱动）：断档压实（含大 idx 间隙）/ 单章原位 / 全部未编号。
// 断档用例同时锁定 Task 42-b 暂存区下压语义：暂存值必须低于落位目标 1..n，
// 大间隙书（min idx 远大于章数）暂存不得落进正数区与落位相撞。
func TestAuditReindexEdges(t *testing.T) {
	mustInitAuditTables(t)
	t.Setenv("TXT_ROOT", t.TempDir())
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	if _, err := db.Exec(`INSERT OR IGNORE INTO "Category" ("id","name") VALUES (9005,'测试分类5')`); err != nil {
		t.Fatalf("insert category: %v", err)
	}
	cases := []struct {
		name    string
		novelID int64
		rows    []struct {
			idx   int64
			title string
		}
		wantIdx map[string]int64
	}{
		{
			name:    "大间隙断档压实",
			novelID: 11,
			rows: []struct {
				idx   int64
				title string
			}{{1, "第1章"}, {2, "第2章"}, {5000, "未编号番外"}},
			wantIdx: map[string]int64{"第1章": 1, "第2章": 2, "未编号番外": 3},
		},
		{
			name:    "单章原位不动",
			novelID: 12,
			rows: []struct {
				idx   int64
				title string
			}{{1, "唯一一章"}},
			wantIdx: map[string]int64{"唯一一章": 1},
		},
		{
			name:    "全未编号按原序压实",
			novelID: 13,
			rows: []struct {
				idx   int64
				title string
			}{{7, "甲"}, {9, "乙"}, {20, "丙"}},
			wantIdx: map[string]int64{"甲": 1, "乙": 2, "丙": 3},
		},
	}
	for _, c := range cases {
		// Novel(title,author) 唯一约束 → 每本书独立书名
		if _, err := db.Exec(`INSERT INTO "Novel" ("id","title","author","categoryId","updatedAt") VALUES (?,?,'测试作者',9005,?)`, c.novelID, c.name, nowMillis()); err != nil {
			t.Fatalf("%s: insert novel: %v", c.name, err)
		}
		for _, r := range c.rows {
			insertAuditChapter(t, c.novelID, r.idx, r.title, 10)
		}
		code, resp := postAuditAction(t, `{"action":"reindex","novelId":`+itoa(int(c.novelID))+`}`)
		if code != 200 {
			t.Fatalf("%s: reindex 应 200，got %d（%v）", c.name, code, resp)
		}
		got := chapterIdxByTitle(t, c.novelID)
		for title, want := range c.wantIdx {
			if got[title] != want {
				t.Fatalf("%s: 章节 %s idx = %d, want %d（全表：%v）", c.name, title, got[title], want, got)
			}
		}
		var neg int64
		if err := queryOne(`SELECT COUNT(*) FROM "Chapter" WHERE "novelId" = ? AND "idx" < 1`, []any{&neg}, c.novelID); err != nil || neg != 0 {
			t.Fatalf("%s: 负数 idx 残留 %d（err=%v）", c.name, neg, err)
		}
	}
}

// TestAuditDedupeRemovesTxtFiles dedupe：删重复行 + 该行 txt 文件一并清理 + 压实不串章
func TestAuditDedupeRemovesTxtFiles(t *testing.T) {
	mustInitAuditTables(t)
	t.Setenv("TXT_ROOT", t.TempDir())
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	if _, err := db.Exec(`INSERT OR IGNORE INTO "Category" ("id","name") VALUES (9002,'测试分类2')`); err != nil {
		t.Fatalf("insert category: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO "Novel" ("id","title","author","categoryId","updatedAt") VALUES (2,'去重测试书','测试作者',9002,?)`, nowMillis()); err != nil {
		t.Fatalf("insert novel: %v", err)
	}
	insertAuditChapter(t, 2, 1, "第1章", 50) // 保留（wordCount 最大）
	insertAuditChapter(t, 2, 2, "第1章", 0)  // 重复 → 删
	insertAuditChapter(t, 2, 3, "第2章", 10)
	for _, c := range []struct {
		idx   int
		title string
		body  string
	}{{1, "第1章", "dupKeep"}, {2, "第1章", "dupDrop"}, {3, "第2章", "two"}} {
		if err := writeChapterTxt(2, c.idx, c.title, c.body); err != nil {
			t.Fatalf("write txt: %v", err)
		}
	}

	code, resp := postAuditAction(t, `{"action":"dedupe","novelId":2}`)
	if code != 200 {
		t.Fatalf("dedupe 应 200，got %d（%v）", code, resp)
	}
	if removed, _ := resp["removed"].(float64); int(removed) != 1 {
		t.Fatalf("removed = %v, want 1", resp["removed"])
	}
	// 压实：第1章→1、第2章→2
	got := chapterIdxByTitle(t, 2)
	if got["第1章"] != 1 || got["第2章"] != 2 {
		t.Fatalf("压实结果错误：%v", got)
	}
	// 已删行（旧 idx2）的 txt 文件必须被清理——否则位置 2 命中 dupDrop 串章
	if body, err := readChapterFromTxt(2, 1); err != nil || body != "dupKeep" {
		t.Fatalf("位置 1 = (%q,%v), want dupKeep", body, err)
	}
	if body, err := readChapterFromTxt(2, 2); err != nil || body != "two" {
		t.Fatalf("位置 2 = (%q,%v), want two（旧版此处读到已删行 dupDrop）", body, err)
	}
	if _, err := os.Stat(filepath.Join(novelTxtDir(2), "00002_第1章.txt")); !os.IsNotExist(err) {
		t.Fatalf("已删行的 txt 文件应被清理: %v", err)
	}
}
