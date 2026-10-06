/**
 * audit84_test.go —— R84「种子重富集自愈巡检」（pseo_reenrich.go）回归锁定：
 * 1) 扫描判定：血缘词<8 的 generated book 种子入选；血缘充足/pending/非 book 来源排除；
 * 2) 单发闸门：首轮重置后种子被标记（pseoReenrichDone:<kwNorm>），即使再次回到
 *    generated 且血缘仍不足，后续巡检不再重置——真无下拉词的冷门书不空转；
 * 3) 批量上限：单轮至多 reset batch 个，剩余留待下轮（节奏克制）；
 * 4) 闸门键归一：kwNormalize 归一形态同词同键（全角/空白/大小写不重复记账）。
 */
package main

import (
	"testing"
)

func seedReenrichFixture(t *testing.T) {
	db, err := getDB()
	if err != nil {
		t.Fatalf("getDB: %v", err)
	}
	cleanup := func() {
		_, _ = db.Exec(`DELETE FROM "PseoKeyword"`)
		_, _ = db.Exec(`DELETE FROM "AppMeta" WHERE "key" LIKE 'pseoReenrichDone:%'`)
	}
	cleanup()
	t.Cleanup(cleanup)
}

func insertSeedRow(t *testing.T, keyword, source, status string, lineage int) {
	t.Helper()
	db, err := getDB()
	if err != nil {
		t.Fatalf("getDB: %v", err)
	}
	now := nowMillis()
	if _, err := db.Exec(
		`INSERT OR IGNORE INTO "PseoKeyword" ("keyword","source","status","createdAt","updatedAt","kwNorm") VALUES (?,?,?,?,?,?)`,
		keyword, source, status, now, now, kwNormalize(keyword)); err != nil {
		t.Fatalf("insert seed %q: %v", keyword, err)
	}
	for i := 0; i < lineage; i++ {
		w := keyword + "-词" + itoa(i)
		if _, err := db.Exec(
			`INSERT OR IGNORE INTO "PseoKeyword" ("keyword","source","status","createdAt","updatedAt","kwNorm","seed") VALUES (?,?,'generated',?,?,?,?)`,
			w, "baidu", now, now, kwNormalize(w), keyword); err != nil {
			t.Fatalf("insert lineage word %q: %v", w, err)
		}
	}
}

func TestPseoReenrichScanFilters(t *testing.T) {
	seedReenrichFixture(t)
	insertSeedRow(t, "零血缘书", "book", "generated", 0)   // 入选
	insertSeedRow(t, "足血缘书", "book", "generated", 8)   // 血缘充足排除
	insertSeedRow(t, "待富集书", "book", "pending", 0)     // 非 generated 排除
	insertSeedRow(t, "简介提取词", "intro", "generated", 0) // 非 book 排除
	insertSeedRow(t, "手工词", "manual", "generated", 0)  // 非 book 排除

	kws, err := pseoReenrichScan(pseoReenrichMinLine, 100)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(kws) != 1 || kws[0] != "零血缘书" {
		t.Fatalf("扫描应仅含零血缘 book 种子，got %v", kws)
	}
}

func TestPseoReenrichSweepOneShot(t *testing.T) {
	seedReenrichFixture(t)
	insertSeedRow(t, "一次性书", "book", "generated", 0)

	n, err := runPseoReenrichSweep(pseoReenrichMinLine, 50)
	if err != nil {
		t.Fatalf("sweep1: %v", err)
	}
	if n != 1 {
		t.Fatalf("首轮应重置 1 个，got %d", n)
	}
	db, _ := getDB()
	var st string
	if err := db.QueryRow(`SELECT "status" FROM "PseoKeyword" WHERE "keyword" = '一次性书'`).Scan(&st); err != nil || st != "pending" {
		t.Fatalf("种子应已回 pending，got %s (err=%v)", st, err)
	}

	// 模拟引擎再次全败后富集链照常收敛置 generated（血缘仍为 0）
	if _, err := db.Exec(`UPDATE "PseoKeyword" SET "status" = 'generated' WHERE "keyword" = '一次性书'`); err != nil {
		t.Fatalf("reset generated: %v", err)
	}
	n, err = runPseoReenrichSweep(pseoReenrichMinLine, 50)
	if err != nil {
		t.Fatalf("sweep2: %v", err)
	}
	if n != 0 {
		t.Fatalf("单发闸门失效：第二轮不应重置，got %d", n)
	}
}

func TestPseoReenrichSweepBatchLimit(t *testing.T) {
	seedReenrichFixture(t)
	for _, kw := range []string{"批量甲", "批量乙", "批量丙", "批量丁", "批量戊"} {
		insertSeedRow(t, kw, "book", "generated", 0)
	}
	n, err := runPseoReenrichSweep(pseoReenrichMinLine, 3)
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if n != 3 {
		t.Fatalf("批量上限应生效（3/5），got %d", n)
	}
	db, _ := getDB()
	var pend, gen int
	_ = db.QueryRow(`SELECT COUNT(*) FROM "PseoKeyword" WHERE "keyword" IN ('批量甲','批量乙','批量丙','批量丁','批量戊') AND "status" = 'pending'`).Scan(&pend)
	_ = db.QueryRow(`SELECT COUNT(*) FROM "PseoKeyword" WHERE "keyword" IN ('批量甲','批量乙','批量丙','批量丁','批量戊') AND "status" = 'generated'`).Scan(&gen)
	if pend != 3 || gen != 2 {
		t.Fatalf("批内 3 重置/批外 2 保留，got pending=%d generated=%d", pend, gen)
	}
	// 下轮继续消化剩余（无闸门行仍可入队）
	n, err = runPseoReenrichSweep(pseoReenrichMinLine, 50)
	if err != nil || n != 2 {
		t.Fatalf("下轮应消化剩余 2 个，got n=%d err=%v", n, err)
	}
}

func TestPseoReenrichMarkerNormalize(t *testing.T) {
	if pseoReenrichMarker("圣墟") != pseoReenrichMarker("圣墟 ") {
		t.Fatal("归一形失败：尾随空白应折叠为同键")
	}
	if pseoReenrichMarker("ABC") != pseoReenrichMarker("abc") {
		t.Fatal("归一形失败：大小写应折叠为同键")
	}
	if pseoReenrichMarker("圣墟") == pseoReenrichMarker("神墓") {
		t.Fatal("不同词不应同键")
	}
}

// TestSanitizeGarbageCoverSrc R84：boot 清洗——None/null/undefined 字面量 coverSrc
// 清空回退渐变 token；正常 URL 与已空行零触碰（幂等）。
func TestSanitizeGarbageCoverSrc(t *testing.T) {
	mustInitBackfillFixtures(t)
	insertBackfillNovel(t, 95201, "垃圾None书", "g3", "https://img22.ixdzs.com/None")
	insertBackfillNovel(t, 95202, "垃圾null书", "g4", "https://img.example.com/null")
	insertBackfillNovel(t, 95203, "带查询串垃圾书", "g5", "https://img.example.com/undefined?v=2")
	insertBackfillNovel(t, 95204, "正常封面书", "g6", "https://img.example.com/covers/6.jpg")
	insertBackfillNovel(t, 95205, "路径含None子串书", "g7", "https://img.example.com/Noneless/7.jpg")

	db, err := getDB()
	if err != nil {
		t.Fatalf("getDB: %v", err)
	}
	sanitizeGarbageCoverSrc(db)

	var src string
	if err := db.QueryRow(`SELECT "coverSrc" FROM "Novel" WHERE "id" = 95201`).Scan(&src); err != nil || src != "" {
		t.Fatalf("None 字面量应被清空，got %q err=%v", src, err)
	}
	_ = db.QueryRow(`SELECT "coverSrc" FROM "Novel" WHERE "id" = 95202`).Scan(&src)
	if src != "" {
		t.Fatalf("null 字面量应被清空，got %q", src)
	}
	_ = db.QueryRow(`SELECT "coverSrc" FROM "Novel" WHERE "id" = 95203`).Scan(&src)
	if src != "" {
		t.Fatalf("带查询串的 undefined 应被清空，got %q", src)
	}
	_ = db.QueryRow(`SELECT "coverSrc" FROM "Novel" WHERE "id" = 95204`).Scan(&src)
	if src != "https://img.example.com/covers/6.jpg" {
		t.Fatalf("正常 URL 不得误伤，got %q", src)
	}
	_ = db.QueryRow(`SELECT "coverSrc" FROM "Novel" WHERE "id" = 95205`).Scan(&src)
	if src != "https://img.example.com/Noneless/7.jpg" {
		t.Fatalf("路径中间含 None 子串不得误杀（末段精确匹配），got %q", src)
	}

	// 幂等：二次执行零变化零报错
	sanitizeGarbageCoverSrc(db)
	_ = db.QueryRow(`SELECT "coverSrc" FROM "Novel" WHERE "id" = 95204`).Scan(&src)
	if src != "https://img.example.com/covers/6.jpg" {
		t.Fatalf("幂等破坏，got %q", src)
	}
}
