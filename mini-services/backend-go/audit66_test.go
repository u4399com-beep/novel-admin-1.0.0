/**
 * audit66_test.go —— Task 66 用户报告双缺陷回归锁定。
 *
 * 缺陷 ①：pseo 聚合页 API 路径（handlePseoKeywordPage）已生成 pageData 时
 *          按快照 novelIds 原序返回，种子书置顶只在实时路径生效——SSR 路径
 *          （web_data.go handleWebPseo）Task 59 v4-③ 已修而 API 路径遗漏，
 *          novels[0]（相关小说）冒充种子书，两条渲染路径语义劈叉。
 *          本测试锁定：已生成路径同样血缘解析种子书并置顶。
 *
 * 缺陷 ②：整机回收后 DB 空库重建而 public/covers/ 运行时产物残留，旧
 *          {id}.jpg 挂新库同 id 新书（张冠李戴），且 backfillBrokenCoverLocal
 *          「文件存在即健康」对错位失明。purgeStaleCoversIn 锁定文件清理
 *          语义（只删 jpg / 跳过子目录与非 jpg / 目录缺失静默）。
 *
 * 复用 recover_test.go 的 TestMain 临时库（绝不触碰生产 db/custom.db 与
 * 真实 covers 目录——文件清理测试一律注入 t.TempDir()）。
 */
package main

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPseoKeywordPageGeneratedPathSeedPromotion(t *testing.T) {
	db, err := getDB()
	if err != nil {
		t.Fatalf("getDB: %v", err)
	}
	cleanup := func() {
		_, _ = db.Exec(`DELETE FROM "Chapter"`)
		_, _ = db.Exec(`DELETE FROM "Novel"`)
		_, _ = db.Exec(`DELETE FROM "Category"`)
		_, _ = db.Exec(`DELETE FROM "PseoKeyword"`)
	}
	cleanup()
	t.Cleanup(cleanup)

	if _, err := db.Exec(`INSERT INTO "Category" ("name") VALUES ('A66分类')`); err != nil {
		t.Fatalf("seed category: %v", err)
	}
	mustSeed := func(title string, clicks int64) int64 {
		res, err := db.Exec(`INSERT INTO "Novel" ("title","author","categoryId","clicks","createdAt","updatedAt") VALUES (?,'作者',(SELECT "id" FROM "Category" WHERE "name"='A66分类'),?,?,?)`,
			title, clicks, nowMillis(), nowMillis())
		if err != nil {
			t.Fatalf("seed %q: %v", title, err)
		}
		id, _ := res.LastInsertId()
		return id
	}
	hotID := mustSeed("页测热门甲", 9999) // 相关小说第一本（生成快照的 novels[0]）
	seedID := mustSeed("页测种子书", 1)   // 种子书（血缘 target）

	// 模拟存量快照（下拉词/简介词形态：keyword=长尾词，seed=书名血缘）：生成窗口期
	// 种子书被 12 本截断 → pageData.novelIds 首元素是相关书而非种子书
	pageData := map[string]any{
		"novelIds":    []any{float64(hotID), float64(seedID)},
		"title":       "页测词甲小说推荐",
		"description": "d",
		"keywords":    "k",
	}
	blob, _ := json.Marshal(pageData)
	if _, err := db.Exec(`INSERT INTO "PseoKeyword" ("keyword","source","seed","status","pageData","createdAt","updatedAt","kwNorm") VALUES ('页测词甲','baidu','页测种子书','generated',?,?,?,?)`,
		string(blob), nowMillis(), nowMillis(), kwNormalize("页测词甲")); err != nil {
		t.Fatalf("seed pseo keyword: %v", err)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/pseo/%E9%A1%B5%E6%B5%8B%E8%AF%8D%E7%94%B2", nil)
	handlePseoKeywordPage(rec, req, map[string]string{"kw": "%E9%A1%B5%E6%B5%8B%E8%AF%8D%E7%94%B2"})
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
	// 缺陷 ① 锁定：seed 血缘（页测种子书）在已生成路径也必须置顶（旧实现按快照原序返回热门甲在首位）
	if resp.Novels[0].ID != seedID {
		t.Fatalf("API 已生成路径种子书未置顶: novels[0].id=%d(%s) want %d（pageData 快照序缺陷回归）",
			resp.Novels[0].ID, resp.Novels[0].Title, seedID)
	}
}

func TestPurgeStaleCoversIn(t *testing.T) {
	dir := t.TempDir()
	mk := func(name string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o644); err != nil {
			t.Fatalf("mk %s: %v", name, err)
		}
	}
	mk("1.jpg")
	mk("43.JPG")
	mk("54.jpg.bak")
	mk("notes.txt")
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	mk(filepath.Join("sub", "nested.jpg"))

	removed := purgeStaleCoversIn(dir)
	if removed != 2 {
		t.Fatalf("应删 2 个 jpg（含大写扩展名）: got %d", removed)
	}
	// jpg 全灭，其余保留
	for _, name := range []string{"1.jpg", "43.JPG"} {
		if _, err := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(err) {
			t.Fatalf("%s 应已删除", name)
		}
	}
	for _, name := range []string{"54.jpg.bak", "notes.txt", "sub"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Fatalf("%s 不应被删除", name)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "sub", "nested.jpg")); err != nil {
		t.Fatalf("子目录内容不应被删除")
	}
	// 幂等：再跑零删除
	if again := purgeStaleCoversIn(dir); again != 0 {
		t.Fatalf("幂等性破坏: 二次删除 %d", again)
	}
	// 目录缺失：静默零删除零 panic
	if miss := purgeStaleCoversIn(filepath.Join(dir, "no-such-dir")); miss != 0 {
		t.Fatalf("缺失目录应返回 0: %d", miss)
	}
	// 空串目录路径防呆：strings.HasSuffix 对空名不命中，静默返回
	if e := purgeStaleCoversIn(""); e != 0 || true {
		_ = e // 只要求不 panic
	}
	_ = strings.TrimSpace("") // strings 引用保活（断言逻辑在上面）
}
