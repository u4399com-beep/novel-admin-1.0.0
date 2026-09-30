/**
 * audit60_test.go —— Task 60-R20 本地封面文件缺失自愈契约锁。
 *
 * 场景：运行时产物 public/covers/ 被环境重置清空（repo.tar 不含该目录），DB 中
 * cover 仍指向 /covers/{id}.jpg → 站点大面积裂图。backfillBrokenCoverLocal 必须：
 *  1) 文件缺失的本地形态 cover → 重置 gradientTokenFor(title,author)（确定性 token，
 *     与渲染层 TS 同算法）；
 *  2) 文件存在的本地形态 cover → 零写放大（保持原值）；
 *  3) 重置后的 token 形态 + coverSrc 非空 → 落入 coverBackfillCandidates 既有候选面
 *     （补抓通道衔接前提）。
 * 复用 recover_test.go 的 TestMain 临时库；Novel 表用最小 DDL 自建；落盘文件用
 * 953xx 段 id 并在 Cleanup 删除。
 */
package main

import (
	"os"
	"path/filepath"
	"testing"
)

// minimalNovelDDL 自愈测试所需最小 Novel 表（Task 60-R20）
const minimalNovelDDL = `CREATE TABLE IF NOT EXISTS "Novel" (
        "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        "title" TEXT NOT NULL DEFAULT '',
        "author" TEXT NOT NULL DEFAULT '',
        "cover" TEXT NOT NULL DEFAULT '',
        "coverSrc" TEXT NOT NULL DEFAULT '',
        "createdAt" INTEGER NOT NULL DEFAULT 0,
        "updatedAt" INTEGER NOT NULL DEFAULT 0
)`

// sqlCategoryIDForTest 取任一合法分类 id（临时库 Category 表由其他测试保证非空；
// 空表兜底插入「其他」9999——与 seed 语义一致）
func sqlCategoryIDForTest(t *testing.T) int64 {
	t.Helper()
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	var id int64
	err = db.QueryRow(`SELECT COALESCE(MIN("id"),0) FROM "Category"`).Scan(&id)
	if err == nil && id == 0 {
		if _, err := db.Exec(`INSERT INTO "Category" ("id","name","sort") VALUES (9999,'其他',9999)`); err != nil {
			t.Fatalf("seed fallback category: %v", err)
		}
		id = 9999
	} else if err != nil {
		t.Fatalf("query category: %v", err)
	}
	return id
}

func TestBackfillBrokenCoverLocal(t *testing.T) {
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	if _, err := db.Exec(minimalNovelDDL); err != nil {
		t.Fatalf("create Novel: %v", err)
	}
	t.Cleanup(func() {
		_, _ = db.Exec(`DELETE FROM "Novel" WHERE "id" >= 95301`)
		_ = os.Remove(filepath.Join(coversDir(), "95301.jpg"))
	})

	dir := coversDir()
	_ = os.MkdirAll(dir, 0o755)

	// 三本书：#95301 本地封面且文件存在（应零写放大）；#95302 本地封面但文件缺失
	// （应重置 token）；#95303 同缺失且 coverSrc 非空（重置后应被补抓候选扫到）
	rows := []struct {
		id       int64
		title    string
		author   string
		cover    string
		coverSrc string
	}{
		{95301, "存在于书", "作者甲", "/covers/95301.jpg", "http://203.0.113.99/1.jpg"},
		{95302, "缺失文件书", "作者乙", "/covers/95302.jpg", ""},
		{95303, "重下候选书", "作者丙", "/covers/95303.jpg", "http://203.0.113.99/3.jpg"},
	}
	for _, r := range rows {
		if _, err := db.Exec(`INSERT INTO "Novel" ("id","title","author","categoryId","cover","coverSrc","createdAt","updatedAt")
                        VALUES (?,?,?,?,?,?,?,?)`, r.id, r.title, r.author,
			sqlCategoryIDForTest(t), r.cover, r.coverSrc, 1, 1); err != nil {
			t.Fatalf("insert #%d: %v", r.id, err)
		}
	}
	// #95301 的文件真实存在
	if err := os.WriteFile(filepath.Join(dir, "95301.jpg"), []byte("fake-jpeg"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := backfillBrokenCoverLocal(db); err != nil {
		t.Fatalf("backfillBrokenCoverLocal: %v", err)
	}

	// #95301 文件存在：原值保留
	var cover1 string
	if err := db.QueryRow(`SELECT "cover" FROM "Novel" WHERE "id"=95301`).Scan(&cover1); err != nil {
		t.Fatal(err)
	}
	if cover1 != "/covers/95301.jpg" {
		t.Fatalf("文件存在的行被误改: %q", cover1)
	}

	// #95302/#95303 文件缺失：重置为确定性 token
	want2 := gradientTokenFor("缺失文件书", "作者乙")
	want3 := gradientTokenFor("重下候选书", "作者丙")
	var cover2, cover3 string
	if err := db.QueryRow(`SELECT "cover" FROM "Novel" WHERE "id"=95302`).Scan(&cover2); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT "cover" FROM "Novel" WHERE "id"=95303`).Scan(&cover3); err != nil {
		t.Fatal(err)
	}
	if cover2 != want2 || cover3 != want3 {
		t.Fatalf("token 重置不符: got %q/%q want %q/%q", cover2, cover3, want2, want3)
	}

	// #95303 重置后落入补抓候选面（token 形态 + coverSrc 非空）；#95301 本地形态不进候选
	cands, err := coverBackfillCandidates()
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, c := range cands {
		if c.id == 95303 {
			found = true
		}
		if c.id == 95301 {
			t.Fatalf("本地形态书不应进入补抓候选: %d", c.id)
		}
	}
	if !found {
		t.Fatalf("重置后的书应进入补抓候选面: %v", cands)
	}

	// 幂等：重复执行结果稳定
	if err := backfillBrokenCoverLocal(db); err != nil {
		t.Fatal(err)
	}
	var cover2b string
	_ = db.QueryRow(`SELECT "cover" FROM "Novel" WHERE "id"=95302`).Scan(&cover2b)
	if cover2b != want2 {
		t.Fatalf("幂等性破坏: %q != %q", cover2b, want2)
	}
}
