/**
 * api_noveltools_resort_test.go —— Task 38-b 回归锁定（/api/novels/resort-chapters TXT 同步）：
 * 重排落库后分章 txt 文件必须随 idx 改名（旧版遗漏：文件名内嵌旧 idx，DB 重排后
 * readChapterFromTxt 按「新 idx」前缀命中别的章内容（串章）或读不到（txt 书正文"丢失"）；
 * 与 Task 33-b audit 重排修复同形态的姊妹路径）。
 * 复用 recover_test.go 的 TestMain 临时库 + api_chapters_audit_test.go 的建表助手
 * （绝不触碰生产库/文件）。
 */
package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestResortChaptersReorderSyncsTxtFiles(t *testing.T) {
	mustInitAuditTables(t)
	mustInitScrapeTaskTable(t) // 重排守卫查询 ScrapeTask pending/running（须为空）
	t.Setenv("TXT_ROOT", t.TempDir())
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO "Novel" ("id","title","updatedAt") VALUES (3,'重排TXT书',?)`, nowMillis()); err != nil {
		t.Fatalf("insert novel: %v", err)
	}
	// 9 章完全倒序（≥NUMBERED_MIN(8)，无重复序号，disorder=100%>20% 必触发重排）：
	// idx 1 存「第9章」… idx 9 存「第1章」；txt 文件按「旧 idx + 标题」落盘
	for i := 1; i <= 9; i++ {
		title := fmt.Sprintf("第%d章", 10-i)
		res, err := db.Exec(`INSERT INTO "Chapter" ("novelId","idx","title","content","wordCount","createdAt") VALUES (3,?,?,'',10,?)`,
			i, title, nowMillis())
		if err != nil {
			t.Fatalf("insert chapter idx=%d: %v", i, err)
		}
		_, _ = res.LastInsertId()
		if err := writeChapterTxt(3, i, title, "body"+itoa(10-i)); err != nil {
			t.Fatalf("write txt idx=%d: %v", i, err)
		}
	}

	req := httptest.NewRequest(http.MethodPost, "/api/novels/resort-chapters", strings.NewReader(`{"novelId":3}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handleNovelsResortChaptersPost(rec, req, nil)
	if rec.Code != 200 {
		t.Fatalf("resort 应 200，got %d（%s）", rec.Code, rec.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode resp: %v", err)
	}
	if reordered, _ := resp["reordered"].(float64); int(reordered) != 1 {
		t.Fatalf("reordered = %v, want 1", resp["reordered"])
	}
	results, _ := resp["results"].([]any)
	if len(results) != 1 {
		t.Fatalf("results = %v, want 1 本", resp["results"])
	}
	r0, _ := results[0].(map[string]any)
	if moved, _ := r0["moved"].(float64); int(moved) != 9 {
		t.Fatalf("moved = %v, want 9（1..9 全部变号）", r0["moved"])
	}

	// DB idx 压实后与标题序号一致
	got := chapterIdxByTitle(t, 3)
	for n := 1; n <= 9; n++ {
		title := fmt.Sprintf("第%d章", n)
		if got[title] != int64(n) {
			t.Fatalf("章节 %s idx = %d, want %d（全表：%v）", title, got[title], n, got)
		}
	}
	// 核心断言：txt 文件内容跟随新 idx（旧版串章：位置 N 读到别的 body）
	for n := 1; n <= 9; n++ {
		want := "body" + itoa(n)
		body, err := readChapterFromTxt(3, n)
		if err != nil || body != want {
			t.Fatalf("txt 位置 %d = (%q,%v), want %q", n, body, err, want)
		}
	}
	// 无暂存残留
	entries, _ := os.ReadDir(novelTxtDir(3))
	for _, e := range entries {
		if strings.Contains(e.Name(), "reidx_") {
			t.Fatalf("存在暂存残留文件 %s", e.Name())
		}
	}
}

// TestResortTxtMoves 只重排未变号的行不产生迁移记录（幂等保护）
func TestResortTxtMoves(t *testing.T) {
	chapters := []resortChapterRow{
		{id: 11, idx: 1, title: "第1章"},
		{id: 12, idx: 2, title: "第2章"},
		{id: 13, idx: 3, title: "第3章"},
	}
	// 已有序：order 顺序与 idx 一致 → 无迁移
	if moves := resortTxtMoves(chapters, []int64{11, 12, 13}); len(moves) != 0 {
		t.Fatalf("已序目录不应产生迁移，got %v", moves)
	}
	// 交换 1/3：两行变号，中行不动
	moves := resortTxtMoves(chapters, []int64{13, 12, 11})
	if len(moves) != 2 {
		t.Fatalf("want 2 moves, got %v", moves)
	}
	byID := map[int64]chapterTxtMove{}
	for _, m := range moves {
		byID[m.ChapterID] = m
	}
	if m := byID[13]; m.OldIdx != 3 || m.NewIdx != 1 || m.Title != "第3章" {
		t.Fatalf("id13 move = %+v", m)
	}
	if m := byID[11]; m.OldIdx != 1 || m.NewIdx != 3 || m.Title != "第1章" {
		t.Fatalf("id11 move = %+v", m)
	}
	if _, ok := byID[12]; ok {
		t.Fatalf("未变号行不应产生迁移")
	}
}
