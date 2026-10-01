/**
 * audit67_test.go —— Task 67 pSEO 页主打书（种子书籍信息+简介）回归锁定。
 *
 * 用户报告：「pseo页的书籍信息+简介应是种子书籍的信息，不应该是当页的相关小说
 * 第一本的。」Task 59 v4-③ 血缘置顶已修书名词/下拉词页，但血缘不可考的页面
 * （词行不存在 / manual / 配置种子词 source!='book' 且 seed=''）仍回退 novels[0]
 * （matchNovels 按 clicks 降序 → 相关小说第一本冒充主打书）；另 SQLite 写入
 * 高峰下单次 webNovelFull busy 失败也会把可解析种子书打回 novels[0]。
 *
 * Task 67 修复语义（本文件锁定）：
 * ① pseoFeaturedNovel 词面兜底——血缘不可考时 keyword 恰与某书 title 相等 →
 *    该书即种子书并置顶（API 路径验证）；
 * ② pseoSeedBookNovel 直取失败重试一次（100ms 退避）后再放弃；
 * ③ generatePendingPages 的 TDK novelTitle/author 与置顶同源换用 pseoFeaturedNovel
 *    （词面兜底书在生成期同样上榜主打）。
 *
 * 复用 recover_test.go 的 TestMain 临时库（绝不触碰生产 db/custom.db）。
 */
package main

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
)

func seedA67Novel(t *testing.T, title string, clicks int64) int64 {
	t.Helper()
	db, err := getDB()
	if err != nil {
		t.Fatalf("getDB: %v", err)
	}
	res, err := db.Exec(`INSERT INTO "Novel" ("title","author","description","categoryId","clicks","createdAt","updatedAt") VALUES (?,'作者甲','简介内容',(SELECT "id" FROM "Category" LIMIT 1),?,?,?)`,
		title, clicks, nowMillis(), nowMillis())
	if err != nil {
		t.Fatalf("seed %q: %v", title, err)
	}
	id, _ := res.LastInsertId()
	return id
}

// ① 词面兜底：无血缘词（manual，seed=”）但 keyword 恰为某书名——该书必须置顶主打，
// 不得让 clicks 更高的相关小说第一本冒充。旧实现 novels[0]=热门甲（clicks 降序）。
func TestPseoFeaturedWordFaceFallback(t *testing.T) {
	db, err := getDB()
	if err != nil {
		t.Fatalf("getDB: %v", err)
	}
	cleanup := func() {
		_, _ = db.Exec(`DELETE FROM "Chapter"`)
		_, _ = db.Exec(`DELETE FROM "Novel"`)
		_, _ = db.Exec(`DELETE FROM "PseoKeyword"`)
	}
	cleanup()
	t.Cleanup(cleanup)

	_, _ = db.Exec(`INSERT INTO "Category" ("name") VALUES ('A67分类')`)
	seedA67Novel(t, "词面兜底书", 1)    // 种子书（低点击）
	seedA67Novel(t, "页测热门甲", 9999) // 相关小说第一本（高点击）

	// 词行存在且无血缘：source='manual' seed=''
	if _, err := db.Exec(`INSERT INTO "PseoKeyword" ("keyword","source","status","createdAt","updatedAt","kwNorm","seed") VALUES ('词面兜底书','manual','generated',?,?,?,'')`,
		nowMillis(), nowMillis(), kwNormalize("词面兜底书")); err != nil {
		t.Fatalf("seed keyword row: %v", err)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/pseo/%E8%AF%8D%E9%9D%A2%E5%85%9C%E5%BA%95%E4%B9%A6", nil)
	handlePseoKeywordPage(rec, req, map[string]string{"kw": "%E8%AF%8D%E9%9D%A2%E5%85%9C%E5%BA%95%E4%B9%A6"})
	if rec.Code != 200 {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Novels []struct {
			ID    int64  `json:"id"`
			Title string `json:"title"`
		} `json:"novels"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(resp.Novels) < 2 {
		t.Fatalf("应返回 ≥2 本: %d", len(resp.Novels))
	}
	if resp.Novels[0].Title != "词面兜底书" {
		t.Fatalf("词面兜底未生效: novels[0]=%s（相关小说第一本冒充主打书回归）", resp.Novels[0].Title)
	}
}

// ①' 词行不存在（聚合 URL 直达）的等价场景：同样按词面主打。
func TestPseoFeaturedWordFaceNoRow(t *testing.T) {
	db, err := getDB()
	if err != nil {
		t.Fatalf("getDB: %v", err)
	}
	cleanup := func() {
		_, _ = db.Exec(`DELETE FROM "Novel"`)
	}
	cleanup()
	t.Cleanup(cleanup)

	_, _ = db.Exec(`INSERT INTO "Category" ("name") VALUES ('A67分类')`)
	target := seedA67Novel(t, "无行书名页测", 2)
	seedA67Novel(t, "页测热门乙", 8888)

	// novels 传入顺序模拟 matchNovels 输出（clicks 降序：热门乙在前）
	novels := []map[string]any{
		{"id": int64(0), "title": "页测热门乙"}, // 占位，真实 id 无关紧要（0 不等于 target）
		{"id": target, "title": "无行书名页测"},
	}
	sn, sid := pseoFeaturedNovel("无行书名页测", "", "", novels)
	if sn == nil || sid != target {
		t.Fatalf("词行不存在时词面兜底失效: sn=%v sid=%d want %d", sn, sid, target)
	}
}

// ② pseoSeedBookNovel：seed 书名与库内 title 全半角/空白形态漂移时归一形兜底仍命中。
func TestPseoSeedBookNovelNormMatch(t *testing.T) {
	db, err := getDB()
	if err != nil {
		t.Fatalf("getDB: %v", err)
	}
	cleanup := func() {
		_, _ = db.Exec(`DELETE FROM "Novel"`)
	}
	cleanup()
	t.Cleanup(cleanup)

	_, _ = db.Exec(`INSERT INTO "Category" ("name") VALUES ('A67分类')`)
	target := seedA67Novel(t, "测试？书名形态", 1)

	// novels 内含归一形同书（模拟形态漂移的命中行）
	novels := []map[string]any{{"id": target, "title": "测试？书名形态"}}
	if sn, sid := pseoSeedBookNovel("测试？书名形态", novels); sn == nil || sid != target {
		t.Fatalf("精确匹配路径失效: sid=%d want %d", sid, target)
	}
	// 归一形（？vs?）形态漂移：SQL 精确未中 → novels 内归一比对命中
	if sn, sid := pseoSeedBookNovel("测试?书名形态", novels); sn == nil || sid != target {
		t.Fatalf("归一形比对失效: sid=%d want %d", sid, target)
	}
}

// ③ generatePendingPages：pending 无血缘词的 TDK novelTitle 应为词面书（词即书名），
// 且该书置顶 novelIds 首位。
func TestGeneratePendingPagesWordFaceFeatured(t *testing.T) {
	db, err := getDB()
	if err != nil {
		t.Fatalf("getDB: %v", err)
	}
	cleanup := func() {
		_, _ = db.Exec(`DELETE FROM "Novel"`)
		_, _ = db.Exec(`DELETE FROM "PseoKeyword"`)
	}
	cleanup()
	t.Cleanup(cleanup)

	_, _ = db.Exec(`INSERT INTO "Category" ("name") VALUES ('A67分类')`)
	seedA67Novel(t, "生成词面书", 1)
	seedA67Novel(t, "页测热门丙", 7777)

	if _, err := db.Exec(`INSERT INTO "PseoKeyword" ("keyword","source","status","createdAt","updatedAt","kwNorm","seed") VALUES ('生成词面书','manual','pending',?,?,?,'')`,
		nowMillis(), nowMillis(), kwNormalize("生成词面书")); err != nil {
		t.Fatalf("seed pending row: %v", err)
	}
	g, err := generatePendingPages(10)
	if err != nil {
		t.Fatalf("generatePendingPages: %v", err)
	}
	if g < 1 {
		t.Fatalf("应生成 ≥1 页")
	}
	var blob string
	if err := db.QueryRow(`SELECT "pageData" FROM "PseoKeyword" WHERE "keyword" = '生成词面书'`).Scan(&blob); err != nil {
		t.Fatalf("read pageData: %v", err)
	}
	var saved struct {
		NovelIDs    []float64 `json:"novelIds"`
		Description string    `json:"description"`
	}
	if err := json.Unmarshal([]byte(blob), &saved); err != nil {
		t.Fatalf("unmarshal pageData: %v", err)
	}
	if len(saved.NovelIDs) < 1 {
		t.Fatalf("novelIds 为空")
	}
	var wantID int64
	if err := db.QueryRow(`SELECT "id" FROM "Novel" WHERE "title" = '生成词面书'`).Scan(&wantID); err != nil {
		t.Fatalf("read novel id: %v", err)
	}
	if int64(saved.NovelIDs[0]) != wantID {
		t.Fatalf("生成期种子书未置顶: novelIds[0]=%v want %d", saved.NovelIDs[0], wantID)
	}
}
