/**
 * api_export_test.go —— Task 38-b 回归锁定（/api/novels/{id}/export-txt N+1 修复 + 三级回落）：
 * 旧版导出对每章额外执行一次 SELECT content（35-a 留档 N+1）；修复后 legacy content 并入
 * 章节主查询、回调内流式构建。本测试锁定：
 * 1) 三级回落逐级生效：分表（ChapterContent）→ 存量列（Chapter.content）→ TXT 分章文件；
 * 2) 导出按 idx 升序、章节计数/填充计数正确；
 * 3) 头部元信息（作者/分类/状态）齐备。
 * 复用 recover_test.go 的 TestMain 临时库与 api_chapters_audit_test.go 的建表助手。
 */
package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// ensureExportColumns Novel 表补齐导出路径所需列（audit 测试的窄表形态下幂等加列）
func ensureExportColumns(t *testing.T) {
	t.Helper()
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	for _, ddl := range []string{
		`ALTER TABLE "Novel" ADD COLUMN "author" TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE "Novel" ADD COLUMN "description" TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE "Novel" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'serial'`,
		`ALTER TABLE "Novel" ADD COLUMN "categoryId" INTEGER NOT NULL DEFAULT 0`,
	} {
		if _, err := db.Exec(ddl); err != nil && !strings.Contains(err.Error(), "duplicate column") {
			t.Fatalf("ensure column: %v", err)
		}
	}
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS "Category" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT NOT NULL, "sort" INTEGER NOT NULL DEFAULT 0)`); err != nil {
		t.Fatalf("create Category: %v", err)
	}
	t.Cleanup(func() {
		_, _ = db.Exec(`DELETE FROM "Category" WHERE "id" = 3`)
	})
}

func TestExportTxtStreamsThreeLevelFallback(t *testing.T) {
	mustInitAuditTables(t)
	ensureExportColumns(t)
	t.Setenv("TXT_ROOT", t.TempDir())
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO "Category" ("id","name") VALUES (3,'科幻')`); err != nil {
		t.Fatalf("insert category: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO "Novel" ("id","title","author","description","status","categoryId","updatedAt") VALUES (10,'导出测试书','测试作者','简介X','finished',3,?)`, nowMillis()); err != nil {
		t.Fatalf("insert novel: %v", err)
	}
	// ch1：分表正文（新写路径主存储）
	res, err := db.Exec(`INSERT INTO "Chapter" ("novelId","idx","title","content","wordCount","createdAt") VALUES (10,1,'第一章','',10,?)`, nowMillis())
	if err != nil {
		t.Fatalf("insert ch1: %v", err)
	}
	ch1, _ := res.LastInsertId()
	if _, err := db.Exec(`INSERT INTO "ChapterContent" ("chapterId","content") VALUES (?,?)`, ch1, "分表正文一"); err != nil {
		t.Fatalf("insert cc1: %v", err)
	}
	// ch2：存量列正文（迁移前遗留行兜底）
	if _, err := db.Exec(`INSERT INTO "Chapter" ("novelId","idx","title","content","wordCount","createdAt") VALUES (10,2,'第二章','存量列正文二',12,?)`, nowMillis()); err != nil {
		t.Fatalf("insert ch2: %v", err)
	}
	// ch3：TXT 分章文件（storageMode=txt 书的唯一存储；wordCount>0 才尝试读文件）
	if _, err := db.Exec(`INSERT INTO "Chapter" ("novelId","idx","title","content","wordCount","createdAt") VALUES (10,3,'第三章','',11,?)`, nowMillis()); err != nil {
		t.Fatalf("insert ch3: %v", err)
	}
	if err := writeChapterTxt(10, 3, "第三章", "TXT正文三"); err != nil {
		t.Fatalf("write txt: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/novels/10/export-txt", nil)
	rec := httptest.NewRecorder()
	handleNovelExportTxt(rec, req, map[string]string{"id": "10"})
	if rec.Code != 200 {
		t.Fatalf("export 应 200，got %d（%s）", rec.Code, rec.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode resp: %v", err)
	}
	if ok, _ := resp["ok"].(bool); !ok {
		t.Fatalf("ok != true: %v", resp)
	}
	if n, _ := resp["chapters"].(float64); int(n) != 3 {
		t.Fatalf("chapters = %v, want 3", resp["chapters"])
	}
	if n, _ := resp["filled"].(float64); int(n) != 3 {
		t.Fatalf("filled = %v, want 3（三级回落各命中一章）", resp["filled"])
	}
	outPath, _ := resp["file"].(string)
	raw, err := os.ReadFile(outPath)
	if err != nil {
		t.Fatalf("read export file %q: %v", outPath, err)
	}
	body := string(raw)
	// 头部元信息
	for _, want := range []string{"导出测试书", "作者：测试作者", "分类：科幻", "状态：已完本"} {
		if !strings.Contains(body, want) {
			t.Fatalf("导出头缺 %q", want)
		}
	}
	// 三级回落正文 + idx 升序
	pos := func(s string) int { return strings.Index(body, s) }
	for _, want := range []string{"第1章 第一章", "分表正文一", "第2章 第二章", "存量列正文二", "第3章 第三章", "TXT正文三"} {
		if pos(want) < 0 {
			t.Fatalf("导出缺 %q\n%s", want, body)
		}
	}
	if !(pos("第1章 第一章") < pos("第2章 第二章") && pos("第2章 第二章") < pos("第3章 第三章")) {
		t.Fatalf("章节未按 idx 升序输出")
	}
	if !(pos("分表正文一") < pos("存量列正文二") && pos("存量列正文二") < pos("TXT正文三")) {
		t.Fatalf("正文顺序错乱")
	}
}
