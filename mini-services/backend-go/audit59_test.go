package main

// audit59_test.go —— Task 59 v4-③ pSEO 种子书主打根修测试。
//
// 用户指令：pseo 页的书籍信息+简介信息应该是种子书的信息，而不是当前页一本书的信息。
//
// 锁定四层契约：
//  1. pseoSeedBookTitle   血缘解析三态（seed 非空 / source=book / 无血缘）
//  2. pseoPromoteSeedNovel 置顶重排（中段提升 / 截断头插 / 无种子书原样）
//  3. pseoSeedBookNovel   定位（精确 SQL 命中在列/不在列、归一形兜底、未中回退）
//  4. matchNovels 保真补位（真实匹配不丢）与 novelsByIDs 绑定序保持（clicks 不重排）
//
// 复用 recover_test.go 的 TestMain 临时库（getDB → ensureBaseSchema 幂等建全量表）。

import (
	"testing"
)

func TestPseoSeedBookTitle(t *testing.T) {
	cases := []struct {
		kw, src, seed, want, note string
	}{
		{"下拉词A", "engine", "凡人修仙传", "凡人修仙传", "seed 血缘优先（Task 40 下拉词/简介词入库 seed=书名）"},
		{"书名种子X", "book", "", "书名种子X", "book 行 seed 空（enqueuePseoBookSeed 未写 seed）→ keyword 本身"},
		{"手工词", "manual", "", "", "manual 无血缘"},
		{"引擎词", "engine", "", "", "engine 直添词无血缘"},
	}
	for _, c := range cases {
		if got := pseoSeedBookTitle(c.kw, c.src, c.seed); got != c.want {
			t.Fatalf("pseoSeedBookTitle(%q,%q,%q) = %q, want %q —— %s", c.kw, c.src, c.seed, got, c.want, c.note)
		}
	}
}

func TestPseoPromoteSeedNovel(t *testing.T) {
	a := map[string]any{"id": int64(1), "title": "热门甲"}
	b := map[string]any{"id": int64(2), "title": "种子书"}
	c := map[string]any{"id": int64(3), "title": "热门乙"}
	orderOf := func(list []map[string]any) []int64 {
		out := make([]int64, 0, len(list))
		for _, n := range list {
			id, _ := n["id"].(int64)
			out = append(out, id)
		}
		return out
	}

	assertOrder := func(tag string, list []map[string]any, want []int64) {
		t.Helper()
		gotOrder := orderOf(list)
		if len(gotOrder) != len(want) {
			t.Fatalf("%s 长度错: %v", tag, gotOrder)
		}
		for i, w := range want {
			if gotOrder[i] != w {
				t.Fatalf("%s 错序 idx=%d: %v", tag, i, gotOrder)
			}
		}
	}

	// 中段提升：种子书移到首位，其余保序不丢
	assertOrder("中段提升", pseoPromoteSeedNovel([]map[string]any{a, b, c}, b, 2), []int64{2, 1, 3})
	// 截断头插：种子书不在列表 → 头插且原列表保序
	assertOrder("截断头插", pseoPromoteSeedNovel([]map[string]any{a, c}, b, 2), []int64{2, 1, 3})
	// 无种子书：原样返回（nil 语义）
	got := pseoPromoteSeedNovel([]map[string]any{a}, nil, 0)
	if len(got) != 1 {
		t.Fatalf("无种子书应原样返回: %v", orderOf(got))
	}
	if id, _ := got[0]["id"].(int64); id != 1 {
		t.Fatalf("无种子书原样被破坏: %v", orderOf(got))
	}
}

func TestPseoSeedBookNovel(t *testing.T) {
	db, err := getDB()
	if err != nil {
		t.Fatalf("getDB: %v", err)
	}
	cleanup := func() {
		_, _ = db.Exec(`DELETE FROM "Novel"`)
		_, _ = db.Exec(`DELETE FROM "Category"`)
	}
	cleanup()
	t.Cleanup(cleanup)

	if _, err := db.Exec(`INSERT INTO "Category" ("name") VALUES ('A59分类')`); err != nil {
		t.Fatalf("seed category: %v", err)
	}
	mustSeed := func(title string, clicks int64) int64 {
		res, err := db.Exec(`INSERT INTO "Novel" ("title","author","categoryId","clicks","createdAt","updatedAt") VALUES (?,'作者',(SELECT "id" FROM "Category" WHERE "name"='A59分类'),?,?,?)`,
			title, clicks, nowMillis(), nowMillis())
		if err != nil {
			t.Fatalf("seed novel %q: %v", title, err)
		}
		id, _ := res.LastInsertId()
		return id
	}
	seedID := mustSeed("种子书实测", 10)
	hotID := mustSeed("热门甲", 999)
	fullID := mustSeed("ＫＷ形态书", 50) // 全角形态：SQL 精确未中、kwNormalize 归一命中

	// 1) 精确 SQL 命中且在列表 → 返回列表内同一元素（保持 map 引用一致）
	novels := []map[string]any{
		{"id": hotID, "title": "热门甲"},
		{"id": seedID, "title": "种子书实测"},
	}
	sn, id := pseoSeedBookNovel("种子书实测", novels)
	if id != seedID || sn == nil || sn["id"].(int64) != seedID {
		t.Fatalf("精确命中在列: got id=%d want %d", id, seedID)
	}
	// 2) 精确命中但不在列表（被 12 本截断）→ webNovelFull 直取
	sn, id = pseoSeedBookNovel("种子书实测", novels[:1])
	if id != seedID || sn == nil {
		t.Fatalf("精确命中不在列应 webNovelFull 直取: id=%d sn=%v", id, sn)
	}
	if ti, _ := sn["title"].(string); ti != "种子书实测" {
		t.Fatalf("webNovelFull 直取书名错: %q", ti)
	}
	// 3) SQL 未中、归一形兜底（全半角折叠）
	alt := []map[string]any{
		{"id": hotID, "title": "热门甲"},
		{"id": fullID, "title": "ＫＷ形态书"},
	}
	sn, id = pseoSeedBookNovel("KW形态书", alt) // 半角 seed
	if id != fullID || sn == nil {
		t.Fatalf("归一形兜底应命中全角书: id=%d sn=%v", id, sn)
	}
	// 4) 完全未中 → (nil, 0)，调用方回退 novels[0]
	sn, id = pseoSeedBookNovel("不存在的书", novels)
	if sn != nil || id != 0 {
		t.Fatalf("未中应返回零值: id=%d sn=%v", id, sn)
	}
}

func TestMatchNovelsKeepsRealMatches(t *testing.T) {
	db, err := getDB()
	if err != nil {
		t.Fatalf("getDB: %v", err)
	}
	cleanup := func() {
		_, _ = db.Exec(`DELETE FROM "Novel"`)
		_, _ = db.Exec(`DELETE FROM "Category"`)
	}
	cleanup()
	t.Cleanup(cleanup)

	if _, err := db.Exec(`INSERT INTO "Category" ("name") VALUES ('A59M分类')`); err != nil {
		t.Fatalf("seed category: %v", err)
	}
	res, err := db.Exec(`INSERT INTO "Novel" ("title","author","categoryId","clicks","createdAt","updatedAt") VALUES ('孤本秘籍真身','作者',(SELECT "id" FROM "Category" WHERE "name"='A59M分类'),1,?,?)`, nowMillis(), nowMillis())
	if err != nil {
		t.Fatalf("seed real match: %v", err)
	}
	realID, _ := res.LastInsertId()
	for i := 0; i < 5; i++ {
		if _, err := db.Exec(`INSERT INTO "Novel" ("title","author","categoryId","clicks","createdAt","updatedAt") VALUES (?,'作者',(SELECT "id" FROM "Category" WHERE "name"='A59M分类'),?, ?,?)`,
			"无关热门书"+string(rune('甲'+i)), 1000+i, nowMillis(), nowMillis()); err != nil {
			t.Fatalf("seed hot %d: %v", i, err)
		}
	}
	got, err := matchNovels("孤本秘籍真身")
	if err != nil {
		t.Fatalf("matchNovels: %v", err)
	}
	// Task 59 保真契约：唯一真实匹配必须在结果内（旧实现 <3 本整体替换为热门榜 → 丢失）
	found := false
	for _, n := range got {
		if id, ok := n["id"].(int64); ok && id == realID {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("真实匹配被丢弃（旧病灶回归）: %d 本", len(got))
	}
	// 真实匹配置顶 + 补位到 ≥3 本
	if id, _ := got[0]["id"].(int64); id != realID {
		t.Fatalf("真实匹配应置顶: got[0].id=%d want %d", id, realID)
	}
	if len(got) < 3 {
		t.Fatalf("补位后应 ≥3 本: %d", len(got))
	}
}

func TestNovelsByIDsPreservesBindOrder(t *testing.T) {
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

	if _, err := db.Exec(`INSERT INTO "Category" ("name") VALUES ('A59B分类')`); err != nil {
		t.Fatalf("seed category: %v", err)
	}
	mustSeed := func(title string, clicks int64) int64 {
		res, err := db.Exec(`INSERT INTO "Novel" ("title","author","categoryId","clicks","createdAt","updatedAt") VALUES (?,'作者',(SELECT "id" FROM "Category" WHERE "name"='A59B分类'),?,?,?)`,
			title, clicks, nowMillis(), nowMillis())
		if err != nil {
			t.Fatalf("seed %q: %v", title, err)
		}
		id, _ := res.LastInsertId()
		return id
	}
	idA := mustSeed("绑定甲", 999)
	idB := mustSeed("绑定乙", 500)
	idC := mustSeed("绑定丙", 100)

	// 传 [丙,甲,乙]（绑定书丙置顶语义）：输出必须按 ids 原序，而非 clicks 重排
	ids := []float64{float64(idC), float64(idA), float64(idB)}
	got, err := novelsByIDs(ids)
	if err != nil {
		t.Fatalf("novelsByIDs: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("应返回 3 本: %d", len(got))
	}
	wantOrder := []int64{idC, idA, idB}
	for i, w := range wantOrder {
		if id, _ := got[i]["id"].(int64); id != w {
			t.Fatalf("绑定序被破坏 idx=%d: got %d want %d（旧实现 ORDER BY clicks 重排）", i, id, w)
		}
	}
}
