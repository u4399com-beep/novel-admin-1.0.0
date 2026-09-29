package main

// audit59b_test.go —— Task 59-R2 种子富集「引擎全败」有界重试测试。
//
// 病灶：fetchSuggestionsMulti 失败隔离后静默照常置 generated——引擎瞬时故障窗口内
// 处理的种子，该书下拉词长尾永久丢失。
// 锁定契约：
//  1. suggestEnginesAllFailed：Error 非空=引擎失败；OK=false+Error 空=健康零建议（不得误判）
//  2. enrichRetry 记账 AppMeta KV 往返
//  3. generatePendingPages exclude：排除词保持 pending，其余照常生成
//
// 复用 recover_test.go 的 TestMain 临时库。

import (
	"testing"
)

func TestSuggestEnginesAllFailed(t *testing.T) {
	cases := []struct {
		name string
		agg  suggestionsAggregate
		want bool
	}{
		{"零结果视同全败", suggestionsAggregate{Results: nil}, true},
		{"全部带错误", suggestionsAggregate{Results: []suggestResult{
			{Engine: "baidu", OK: false, Error: "timeout"},
			{Engine: "so", OK: false, Error: "503"},
		}}, true},
		{"健康零建议不算全败", suggestionsAggregate{Results: []suggestResult{
			{Engine: "baidu", OK: false, Error: "", Words: []string{}},
			{Engine: "so", OK: false, Error: "503"},
		}}, false},
		{"任一成功不算全败", suggestionsAggregate{Results: []suggestResult{
			{Engine: "baidu", OK: true, Words: []string{"词"}},
			{Engine: "so", OK: false, Error: "503"},
		}}, false},
	}
	for _, c := range cases {
		if got := suggestEnginesAllFailed(c.agg); got != c.want {
			t.Fatalf("%s: got %v want %v", c.name, got, c.want)
		}
	}
}

func TestEnrichRetryKV(t *testing.T) {
	db, err := getDB()
	if err != nil {
		t.Fatalf("getDB: %v", err)
	}
	t.Cleanup(func() { _, _ = db.Exec(`DELETE FROM "AppMeta" WHERE "key" LIKE 'pseoEnrichRetry:%'`) })

	if n, at := getEnrichRetry("不存在的词"); n != 0 || at != 0 {
		t.Fatalf("缺省应为零值: n=%d at=%d", n, at)
	}
	setEnrichRetry("测试种子词", 2, 1234567890)
	n, at := getEnrichRetry("测试种子词")
	if n != 2 || at != 1234567890 {
		t.Fatalf("往返失真: n=%d at=%d", n, at)
	}
	// 覆盖更新
	setEnrichRetry("测试种子词", 3, 9999999999)
	if n, _ = getEnrichRetry("测试种子词"); n != 3 {
		t.Fatalf("覆盖更新失真: n=%d", n)
	}
	clearEnrichRetry("测试种子词")
	if n, _ = getEnrichRetry("测试种子词"); n != 0 {
		t.Fatalf("清除后应归零: n=%d", n)
	}
}

func TestGeneratePendingPagesExclude(t *testing.T) {
	db, err := getDB()
	if err != nil {
		t.Fatalf("getDB: %v", err)
	}
	cleanup := func() {
		_, _ = db.Exec(`DELETE FROM "PseoKeyword"`)
		_, _ = db.Exec(`DELETE FROM "Novel"`)
		_, _ = db.Exec(`DELETE FROM "Category"`)
	}
	cleanup()
	t.Cleanup(cleanup)

	if _, err := db.Exec(`INSERT INTO "Category" ("name") VALUES ('A59X分类')`); err != nil {
		t.Fatalf("seed category: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO "Novel" ("title","author","categoryId","clicks","createdAt","updatedAt") VALUES ('排除测试书','作者',(SELECT "id" FROM "Category" WHERE "name"='A59X分类'),1,?,?)`, nowMillis(), nowMillis()); err != nil {
		t.Fatalf("seed novel: %v", err)
	}
	mustKw := func(kw, src string) {
		if _, err := db.Exec(`INSERT OR IGNORE INTO "PseoKeyword" ("keyword","source","status","createdAt","updatedAt","kwNorm") VALUES (?,?,'pending',?,?,?)`,
			kw, src, nowMillis(), nowMillis(), kwNormalize(kw)); err != nil {
			t.Fatalf("seed kw %q: %v", kw, err)
		}
	}
	mustKw("排除保留词", "book")   // 引擎全败重试中的种子（应被排除保留）
	mustKw("排除伴生词甲", "intro") // 其余 pending 照常消化
	mustKw("排除伴生词乙", "intro")

	g, err := generatePendingPages(20, "排除保留词")
	if err != nil {
		t.Fatalf("generatePendingPages: %v", err)
	}
	if g != 2 {
		t.Fatalf("应生成 2 页（排除词除外）: %d", g)
	}
	var status string
	if err := db.QueryRow(`SELECT "status" FROM "PseoKeyword" WHERE "keyword" = '排除保留词'`).Scan(&status); err != nil {
		t.Fatalf("read excluded kw: %v", err)
	}
	if status != "pending" {
		t.Fatalf("排除词必须保持 pending 供冷却重试: %s", status)
	}
	for _, kw := range []string{"排除伴生词甲", "排除伴生词乙"} {
		if err := db.QueryRow(`SELECT "status" FROM "PseoKeyword" WHERE "keyword" = ?`, kw).Scan(&status); err != nil {
			t.Fatalf("read %s: %v", kw, err)
		}
		if status != "generated" {
			t.Fatalf("伴生词应已生成: %s = %s", kw, status)
		}
	}
	// 二次全量消化：排除词兜底可被后续无排除调用收敛
	if _, err := generatePendingPages(20); err != nil {
		t.Fatalf("second pass: %v", err)
	}
	if err := db.QueryRow(`SELECT "status" FROM "PseoKeyword" WHERE "keyword" = '排除保留词'`).Scan(&status); err != nil {
		t.Fatalf("read excluded kw 2: %v", err)
	}
	if status != "generated" {
		t.Fatalf("无排除调用应消化全部 pending: %s", status)
	}
}
