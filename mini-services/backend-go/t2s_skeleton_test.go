/**
 * t2s_skeleton_test.go —— Task 47 繁转简入库链路回归锁定：
 * 1) Phase 1 骨架章题繁转简（t2sMode 接线）：繁体 TOC 标题落库即简体；与既有已填充
 *    简体标题精确去重（繁体源重采防重复章节——转换前词面不一致必然 miss 的病灶面）；
 * 2) 存量回填 backfillT2SMeta / backfillT2SContent（t2sField(auto) 与入库同口径、
 *    幂等重扫零变化）+ AppMeta 守卫标记读写。
 */
package main

import (
	"testing"
)

func TestSkeletonT2SDedupe(t *testing.T) {
	db, err := getDB()
	if err != nil {
		t.Fatalf("getDB: %v", err)
	}
	cleanup := func() {
		_, _ = db.Exec(`DELETE FROM "Chapter"`)
		_, _ = db.Exec(`DELETE FROM "Novel"`)
		_, _ = db.Exec(`DELETE FROM "Category"`)
	}
	cleanup()
	t.Cleanup(cleanup)

	if _, err := db.Exec(`INSERT INTO "Category" ("name") VALUES ('测试分类')`); err != nil {
		t.Fatalf("seed category: %v", err)
	}
	var catID int64
	if err := db.QueryRow(`SELECT "id" FROM "Category" WHERE "name" = '测试分类'`).Scan(&catID); err != nil {
		t.Fatalf("read category: %v", err)
	}
	res, err := db.Exec(`INSERT INTO "Novel" ("title","author","categoryId","createdAt","updatedAt") VALUES ('测试繁体骨架书','作者',?,?,?)`, catID, 1, 1)
	if err != nil {
		t.Fatalf("seed novel: %v", err)
	}
	nid, _ := res.LastInsertId()
	// 既有已填充章节：简体词面（Phase 2 填充后形态）
	if _, err := db.Exec(`INSERT INTO "Chapter" ("novelId","idx","title","volume","wordCount","createdAt") VALUES (?,?,?,?,?,?)`,
		nid, 1, "第1章 开局签到", "", 120, 1); err != nil {
		t.Fatalf("seed filled chapter: %v", err)
	}

	run := NewRun(0)
	refs := []refPair{
		{Title: "第1章 開局簽到", URL: "https://t.example/1"}, // 繁体重采词面，转换后必须命中既有已填充行
		{Title: "第2章 雙修之路", URL: "https://t.example/2"},
	}
	sk, err := storeChapterSkeletons(run, int(nid), refs, 100, "auto")
	if err != nil {
		t.Fatalf("storeChapterSkeletons: %v", err)
	}
	if sk.SkippedFilled != 1 {
		t.Fatalf("SkippedFilled = %d, want 1（繁体词面转换后应与简体已填充行精确去重，否则重复章节）", sk.SkippedFilled)
	}
	if sk.Stored != 1 {
		t.Fatalf("Stored = %d, want 1", sk.Stored)
	}
	var gotTitle string
	if err := db.QueryRow(`SELECT "title" FROM "Chapter" WHERE "novelId" = ? AND "idx" = 2`, nid).Scan(&gotTitle); err != nil {
		t.Fatalf("read skeleton: %v", err)
	}
	if gotTitle != "第2章 双修之路" {
		t.Fatalf("骨架标题未繁转简: %q", gotTitle)
	}

	// 重发同批 refs：全量命中（1 已填充 + 1 空骨架 resume），零重复建行
	sk2, err := storeChapterSkeletons(run, int(nid), refs, 100, "auto")
	if err != nil {
		t.Fatalf("resume: %v", err)
	}
	if sk2.Stored != 0 {
		t.Fatalf("重发 Stored = %d, want 0（转换词面必须与库内行稳定一致）", sk2.Stored)
	}
	var cnt int
	if err := db.QueryRow(`SELECT COUNT(*) FROM "Chapter" WHERE "novelId" = ?`, nid).Scan(&cnt); err != nil {
		t.Fatalf("count: %v", err)
	}
	if cnt != 2 {
		t.Fatalf("重发后行数 = %d, want 2（重复建骨架行）", cnt)
	}
}

func TestBackfillT2SMetaAndContent(t *testing.T) {
	db, err := getDB()
	if err != nil {
		t.Fatalf("getDB: %v", err)
	}
	cleanup := func() {
		_, _ = db.Exec(`DELETE FROM "AppMeta" WHERE "key" = 't2sBackfillV1'`)
		_, _ = db.Exec(`DELETE FROM "ChapterContent"`)
		_, _ = db.Exec(`DELETE FROM "Chapter"`)
		_, _ = db.Exec(`DELETE FROM "PseoKeyword"`)
		_, _ = db.Exec(`DELETE FROM "Novel"`)
		_, _ = db.Exec(`DELETE FROM "Category"`)
	}
	cleanup()
	t.Cleanup(cleanup)

	if _, err := db.Exec(`INSERT INTO "Category" ("name") VALUES ('測試歷史軍事')`); err != nil {
		t.Fatalf("seed category: %v", err)
	}
	var catID int64
	if err := db.QueryRow(`SELECT "id" FROM "Category" WHERE "name" = '測試歷史軍事'`).Scan(&catID); err != nil {
		t.Fatalf("read category: %v", err)
	}
	res, err := db.Exec(`INSERT INTO "Novel" ("title","author","description","categoryId","createdAt","updatedAt") VALUES ('測試繁體書','辰東','這是繁體簡介。',?,?,?)`, catID, 1, 1)
	if err != nil {
		t.Fatalf("seed novel: %v", err)
	}
	nid, _ := res.LastInsertId()
	res, err = db.Exec(`INSERT INTO "Chapter" ("novelId","idx","title","volume","createdAt") VALUES (?,?,?,?,?)`, nid, 1, "第1章 開端", "", 1)
	if err != nil {
		t.Fatalf("seed chapter: %v", err)
	}
	cid, _ := res.LastInsertId()
	if _, err := db.Exec(`INSERT INTO "ChapterContent" ("chapterId","content") VALUES (?, '這是正文內容。')`, cid); err != nil {
		t.Fatalf("seed content: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO "PseoKeyword" ("keyword","source","status","createdAt","updatedAt","kwNorm","seed") VALUES ('測試繁體書筆趣閣','baidu','generated',1,1,'','測試繁體書')`); err != nil {
		t.Fatalf("seed keyword: %v", err)
	}

	if err := backfillT2SMeta(db); err != nil {
		t.Fatalf("backfillT2SMeta: %v", err)
	}
	var title, author, desc string
	if err := db.QueryRow(`SELECT "title","author","description" FROM "Novel" WHERE "id" = ?`, nid).Scan(&title, &author, &desc); err != nil {
		t.Fatalf("read novel: %v", err)
	}
	if title != "测试繁体书" || author != "辰东" || desc != "这是繁体简介。" {
		t.Fatalf("Novel 回填结果异常: %q/%q/%q", title, author, desc)
	}
	var ctitle string
	if err := db.QueryRow(`SELECT "title" FROM "Chapter" WHERE "id" = ?`, cid).Scan(&ctitle); err != nil {
		t.Fatalf("read chapter: %v", err)
	}
	if ctitle != "第1章 开端" {
		t.Fatalf("Chapter 标题未回填: %q", ctitle)
	}
	var kw, seed string
	if err := db.QueryRow(`SELECT "keyword","seed" FROM "PseoKeyword" WHERE "keyword" = '测试繁体书笔趣阁'`).Scan(&kw, &seed); err != nil {
		t.Fatalf("read keyword（转换后词面不存在）: %v", err)
	}
	if seed != "测试繁体书" {
		t.Fatalf("PseoKeyword.seed 未回填: %q", seed)
	}
	if err := backfillT2SContent(db); err != nil {
		t.Fatalf("backfillT2SContent: %v", err)
	}
	var content string
	if err := db.QueryRow(`SELECT "content" FROM "ChapterContent" WHERE "chapterId" = ?`, cid).Scan(&content); err != nil {
		t.Fatalf("read content: %v", err)
	}
	if content != "这是正文内容。" {
		t.Fatalf("正文未回填: %q", content)
	}

	// 幂等：重复执行零变化
	if err := backfillT2SMeta(db); err != nil {
		t.Fatalf("meta idempotent: %v", err)
	}
	if err := backfillT2SContent(db); err != nil {
		t.Fatalf("content idempotent: %v", err)
	}
	if err := db.QueryRow(`SELECT "title" FROM "Novel" WHERE "id" = ?`, nid).Scan(&title); err != nil {
		t.Fatalf("re-read novel: %v", err)
	}
	if title != "测试繁体书" {
		t.Fatalf("幂等重扫改写了数据: %q", title)
	}

	// 守卫标记：写入后读取为 done（backfillT2SExisting 短路前提）
	markT2SBackfillDone(db)
	if !t2sBackfillDone(db) {
		t.Fatalf("守卫标记读取失败")
	}
}
