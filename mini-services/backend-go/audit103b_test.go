/**
 * audit103b_test.go —— R103 章节写入事务合并回归锁定（backend 侧）：
 *
 * 背景：章节写入原为两条 autocommit 语句——storeChapter（Chapter INSERT + ChapterContent
 * INSERT，失败时手动 DELETE 补偿）与 persistChapterFill（ChapterContent INSERT + Chapter
 * UPDATE）。中断窗口内可留下「无正文骨架行/孤儿正文/正文已写字数未记」中间态，且每章
 * 写 2 次 WAL 提交。R103 统一合并 txRetry 单事务（busy 退避重试同 execRetry 口径）。
 *
 * 测试库：TestMain（recover_test.go）已把 DB_PATH 指向临时库，getDB once 自动建全表；
 * 本文件直用生产原语（txRetry/queryOne/Run{TaskID}），表名不加引号变体与生产路径一致。
 */
package main

import (
	"database/sql"
	"errors"
	"strings"
	"testing"
)

// mkNovel103 Chapter.novelId FK 依赖的 Novel 行（categoryId 同样 FK → 先确保分类存在；
// Category.name 有 UNIQUE 约束，其他测试可能已播种——INSERT OR IGNORE 幂等兼容）
func mkNovel103(t *testing.T, id int) {
	t.Helper()
	if _, err := exec(`INSERT OR IGNORE INTO "Category" ("id","name") VALUES (1,'R103测试分类')`); err != nil {
		t.Fatalf("建分类失败: %v", err)
	}
	var n int
	_ = queryOne(`SELECT COUNT(*) FROM "Novel" WHERE "id"=?`, []any{&n}, id)
	if n > 0 {
		return
	}
	var catID int
	if err := queryOne(`SELECT "id" FROM "Category" ORDER BY "id" LIMIT 1`, []any{&catID}); err != nil {
		t.Fatalf("无可用分类: %v", err)
	}
	if _, err := exec(`INSERT INTO "Novel" ("id","title","author","categoryId","createdAt","updatedAt") VALUES (?,'测试书'||?,'佚名',?,1,1)`, id, id, catID); err != nil {
		t.Fatalf("建测试书失败: %v", err)
	}
}

func TestTxRetryAtomicRollback(t *testing.T) {
	mkNovel103(t, 999001)
	// fn 半程失败（第一条 INSERT 已执行、fn 返回错误）→ 全量回滚，不留半态
	forced := errors.New("forced rollback")
	err := txRetry(func(tx *sql.Tx) error {
		if _, err := tx.Exec(`INSERT INTO "Chapter" ("novelId","idx","title","volume","content","wordCount","createdAt") VALUES (999001,1,'甲','','',0,1)`); err != nil {
			return err
		}
		return forced
	})
	if !errors.Is(err, forced) {
		t.Fatalf("fn 错误应原样上抛，got %v", err)
	}
	var cnt int
	if err := queryOne(`SELECT COUNT(*) FROM "Chapter" WHERE "novelId" = 999001`, []any{&cnt}); err != nil {
		t.Fatalf("query: %v", err)
	}
	if cnt != 0 {
		t.Fatalf("fn 失败应全量回滚（第一条 INSERT 不留行），got %d 行", cnt)
	}
}

func TestTxRetryCommitBoth(t *testing.T) {
	mkNovel103(t, 999002)
	err := txRetry(func(tx *sql.Tx) error {
		if _, err := tx.Exec(`INSERT INTO "Chapter" ("novelId","idx","title","volume","content","wordCount","createdAt") VALUES (999002,1,'甲','','',0,1)`); err != nil {
			return err
		}
		if _, err := tx.Exec(`INSERT INTO "ChapterContent" ("chapterId","content") SELECT id,'正文' FROM "Chapter" WHERE "novelId"=999002`); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		t.Fatalf("tx 应提交: %v", err)
	}
	var cnt, ccnt int
	_ = queryOne(`SELECT COUNT(*) FROM "Chapter" WHERE "novelId" = 999002`, []any{&cnt})
	_ = queryOne(`SELECT COUNT(*) FROM "ChapterContent" cc JOIN "Chapter" c ON cc."chapterId"=c."id" WHERE c."novelId"=999002`, []any{&ccnt})
	if cnt != 1 || ccnt != 1 {
		t.Fatalf("双语句应同事务落库，got chapter=%d content=%d", cnt, ccnt)
	}
}

func TestPersistChapterFillTxSemantics(t *testing.T) {
	mkNovel103(t, 999301)
	run := NewRun(999301)
	// ①storeChapter：骨架 + 单章正文同事务落库
	used, ok, msg := storeChapter(run, 999301, 1, ChapterRow{Title: "第1章 起点", Content: "初始正文", WordCount: 4})
	if !ok {
		t.Fatalf("storeChapter 应成功: %s", msg)
	}
	var chID int
	if err := queryOne(`SELECT id FROM "Chapter" WHERE "novelId"=999301 AND "idx"=?`, []any{&chID}, used); err != nil {
		t.Fatalf("骨架未落库: %v", err)
	}
	var content string
	if err := queryOne(`SELECT "content" FROM "ChapterContent" WHERE "chapterId"=?`, []any{&content}, chID); err != nil || content != "初始正文" {
		t.Fatalf("单章正文应同事务落库: err=%v content=%q", err, content)
	}
	// ②persistChapterFill 正常路径：分表正文 + wordCount 更新
	if !persistChapterFill(run, 999301, chID, 1, "第1章 起点·新", "全新的正文内容", "db") {
		t.Fatalf("persistChapterFill 应成功")
	}
	var wc int64
	var title string
	_ = queryOne(`SELECT "wordCount","title" FROM "Chapter" WHERE id=?`, []any{&wc, &title}, chID)
	if wc == 0 || !strings.Contains(title, "新") {
		t.Fatalf("填充后 wordCount/title 不符: wc=%d title=%q", wc, title)
	}
	var filled string
	_ = queryOne(`SELECT "content" FROM "ChapterContent" WHERE "chapterId"=?`, []any{&filled}, chID)
	if filled != "全新的正文内容" {
		t.Fatalf("分表正文应被 INSERT OR REPLACE 覆盖，got %q", filled)
	}
	// ③无效 chapterId：RowsAffected=0 → false（原语义保留，不误标已填充）
	if persistChapterFill(run, 999301, 999999999, 9, "幽灵", "正文", "db") {
		t.Fatalf("无效 chapterId 应返回 false")
	}
	// ④txt 模式：分表不写正文，wordCount 照记（resume 判据不受影响）
	if !persistChapterFill(run, 999301, chID, 1, "第1章 txt", "txt正文内容", "txt") {
		t.Fatalf("txt 模式应成功（文件写入）")
	}
}

func TestStoreChapterUniqueBumpStillWorks(t *testing.T) {
	mkNovel103(t, 999401)
	run := NewRun(999401)
	_, ok, _ := storeChapter(run, 999401, 5, ChapterRow{Title: "第5章 冲突"})
	if !ok {
		t.Fatalf("首插应成功")
	}
	// 同 idx 再插 → 唯一冲突顺延（事务化后语义不变）
	used, ok, msg := storeChapter(run, 999401, 5, ChapterRow{Title: "第5章 顺延"})
	if !ok {
		t.Fatalf("冲突顺延应成功: %s", msg)
	}
	if used != 6 {
		t.Fatalf("应顺延到 idx=6，got %d", used)
	}
}
