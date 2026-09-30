/**
 * audit56b_test.go —— Task 56-b（第 18 轮 API 层深审）回归锁定：
 *
 * 1) TestIntFieldStrictNegativeOverflowGuard / TestCategorySortNegativeOverflowGuard：
 *    intFieldStrict 补对称负向 -2^53 下界——旧版 sort=-1e300 时 int(f) 实现定义溢出为
 *    MinInt64 直写 Category.sort（Task 49-b 只封了正向 1e300，负向同族漏网）。
 * 2) TestParsePositiveIntUpperBound / TestScrapeTaskIDUpperBound / TestScrapeRulesDeleteIDUpperBound：
 *    parsePositiveInt 补 2^53 上界——scrape-tasks 路由 id 与 scrape-rules ?id= 的 1e300
 *    越界值旧版 int64 溢出为 MinInt64（GET/PUT/PATCH 404 空转、DELETE 200 空转），
 *    与全包 id 参数 float 域判定口径不一致。
 * 3) TestChapterNovelIdParamUpperBound：/api/chapters/audit（GET+POST）/volumes 的
 *    novelId 补 2^53 上界（同族口径，1e300 → 400 而非溢出后 404）。
 * 4) TestSettingsPatchUpdateErrorSurfaced：PATCH /api/settings UPDATE 失败（trigger
 *    RAISE(ABORT) 强制注入）不再静默 200 ok:true（旧版保存丢失无提示），上返 500。
 *
 * 复用 recover_test.go 的 TestMain 临时库（绝不触碰生产 db/custom.db）。
 */
package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// ---------- ① intFieldStrict 负向 2^53 下界 ----------

func TestIntFieldStrictNegativeOverflowGuard(t *testing.T) {
	cases := []struct {
		name   string
		v      any
		want   int
		wantOK bool
	}{
		{"负整数合法（sort 允许负值）", float64(-3), -3, true},
		{"恰为 -2^53 下界（对称口径）", float64(-9_007_199_254_740_992), -9_007_199_254_740_992, true},
		{"-2^53 内大值", float64(-4_503_599_627_370_496), -4_503_599_627_370_496, true},
		{"越下界（-(2^53+2)）", float64(-9_007_199_254_740_994), 0, false},
		{"越界浮点 -1e300（旧版溢出为 MinInt64 直写 sort）", -1e300, 0, false},
		{"正常值", float64(5), 5, true},
		{"零", float64(0), 0, true},
	}
	for _, c := range cases {
		got, ok := intFieldStrict(c.v)
		if ok != c.wantOK || (ok && got != c.want) {
			t.Errorf("%s: intFieldStrict(%v) = (%d,%v), want (%d,%v)", c.name, c.v, got, ok, c.want, c.wantOK)
		}
	}
}

// TestCategorySortNegativeOverflowGuard 端到端：PUT /api/categories/{id} 携带
// sort=-1e300 不得把溢出负值（amd64 MinInt64）写进 Category.sort（数据腐蚀）；
// 合法负值照常生效（sort 负域是合法排序语义，不得误伤）。
func TestCategorySortNegativeOverflowGuard(t *testing.T) {
	db, derr := getDB()
	if derr != nil {
		t.Fatalf("open temp db: %v", derr)
	}
	res, err := db.Exec(`INSERT INTO "Category" ("name","sort") VALUES ('56b负向排序守卫', 7)`)
	if err != nil {
		t.Fatalf("insert category: %v", err)
	}
	cid, _ := res.LastInsertId()
	t.Cleanup(func() {
		_, _ = db.Exec(`DELETE FROM "Category" WHERE "id" = ?`, cid)
	})

	// 越下界浮点：不得腐蚀 sort（旧版溢出 MinInt64 直写）
	req := httptest.NewRequest(http.MethodPut, "/api/categories/"+itoa(int(cid)),
		strings.NewReader(`{"sort":-1e300}`))
	rec := httptest.NewRecorder()
	handleCategoryByID(rec, req, map[string]string{"id": itoa(int(cid))})
	if rec.Code != 200 {
		t.Fatalf("越下界 sort 应宽松忽略返回 200（PATCH 语义），got %d（body=%s）", rec.Code, rec.Body.String())
	}
	var sortVal int64
	if err := db.QueryRow(`SELECT "sort" FROM "Category" WHERE "id" = ?`, cid).Scan(&sortVal); err != nil {
		t.Fatalf("query sort: %v", err)
	}
	if sortVal != 7 {
		t.Fatalf("越下界 sort 不得写库（旧版溢出 MinInt64 腐蚀），got %d", sortVal)
	}

	// 合法负值照常生效（不误伤）
	req2 := httptest.NewRequest(http.MethodPut, "/api/categories/"+itoa(int(cid)),
		strings.NewReader(`{"sort":-7}`))
	rec2 := httptest.NewRecorder()
	handleCategoryByID(rec2, req2, map[string]string{"id": itoa(int(cid))})
	if rec2.Code != 200 {
		t.Fatalf("合法负 sort 应生效，got %d（body=%s）", rec2.Code, rec2.Body.String())
	}
	if err := db.QueryRow(`SELECT "sort" FROM "Category" WHERE "id" = ?`, cid).Scan(&sortVal); err != nil {
		t.Fatalf("query sort: %v", err)
	}
	if sortVal != -7 {
		t.Fatalf("合法 sort=-7 应写库，got %d", sortVal)
	}
}

// ---------- ② parsePositiveInt 2^53 上界 ----------

func TestParsePositiveIntUpperBound(t *testing.T) {
	cases := []struct {
		name   string
		v      any
		want   int64
		wantOK bool
	}{
		{"正常值", float64(3), 3, true},
		{"字符串数字", "12", 12, true},
		{"恰为 2^53 上界（> 上界才拒，同族口径）", float64(9_007_199_254_740_992), 9_007_199_254_740_992, true},
		{"超界 1e300（旧版溢出 MinInt64）", 1e300, 0, false},
		{"超界整串", "100000000000000000000", 0, false},
		{"负数", float64(-5), 0, false},
		{"非数字字符串", "abc", 0, false},
	}
	for _, c := range cases {
		got, ok := parsePositiveInt(c.v)
		if ok != c.wantOK || (ok && got != c.want) {
			t.Errorf("%s: parsePositiveInt(%v) = (%d,%v), want (%d,%v)", c.name, c.v, got, ok, c.want, c.wantOK)
		}
	}
}

// TestScrapeTaskIDUpperBound scrape-tasks 四个路由 id 越界 → 400（旧版溢出负值后
// GET/PUT/PATCH 404 空转、DELETE 空转，响应语义随实现定义值漂移）
func TestScrapeTaskIDUpperBound(t *testing.T) {
	for _, tc := range []struct {
		method string
		path   string
		fn     func(w http.ResponseWriter, r *http.Request, ps map[string]string)
	}{
		{http.MethodGet, "1e300", handleScrapeTaskDetail},
		{http.MethodPut, "1e300", handleScrapeTaskUpdate},
		{http.MethodPatch, "1e300", handleScrapeTaskCancel},
		{http.MethodDelete, "1e300", handleScrapeTaskDelete},
	} {
		req := httptest.NewRequest(tc.method, "/api/scrape-tasks/"+tc.path, strings.NewReader(`{}`))
		rec := httptest.NewRecorder()
		tc.fn(rec, req, map[string]string{"id": tc.path})
		if rec.Code != 400 {
			t.Fatalf("%s /api/scrape-tasks/%s 应 400（2^53 上界族口径），got %d（body=%s）",
				tc.method, tc.path, rec.Code, rec.Body.String())
		}
	}
	// 合法值不误伤：不存在 id 仍走 404 语义
	req := httptest.NewRequest(http.MethodGet, "/api/scrape-tasks/999999", nil)
	rec := httptest.NewRecorder()
	handleScrapeTaskDetail(rec, req, map[string]string{"id": "999999"})
	if rec.Code != 404 {
		t.Fatalf("合法形态不存在 id 应保持 404，got %d（body=%s）", rec.Code, rec.Body.String())
	}
}

// TestScrapeRulesDeleteIDUpperBound DELETE /api/scrape-rules?id=1e300 → 400
// （旧版溢出负值 DELETE 空转后仍 200 ok）
func TestScrapeRulesDeleteIDUpperBound(t *testing.T) {
	req := httptest.NewRequest(http.MethodDelete, "/api/scrape-rules?id=1e300", nil)
	rec := httptest.NewRecorder()
	handleScrapeRulesDelete(rec, req, nil)
	if rec.Code != 400 {
		t.Fatalf("id=1e300 应 400（2^53 上界族口径），got %d（body=%s）", rec.Code, rec.Body.String())
	}
}

// ---------- ③ /api/chapters novelId 参数 2^53 上界 ----------

func TestChapterNovelIdParamUpperBound(t *testing.T) {
	// GET /api/chapters/audit?novelId=1e300
	req := httptest.NewRequest(http.MethodGet, "/api/chapters/audit?novelId=1e300", nil)
	rec := httptest.NewRecorder()
	handleChapterAuditGet(rec, req, nil)
	if rec.Code != 400 {
		t.Fatalf("audit GET novelId=1e300 应 400，got %d（body=%s）", rec.Code, rec.Body.String())
	}

	// GET /api/chapters/volumes?novelId=1e300
	req2 := httptest.NewRequest(http.MethodGet, "/api/chapters/volumes?novelId=1e300", nil)
	rec2 := httptest.NewRecorder()
	handleChapterVolumesGet(rec2, req2, nil)
	if rec2.Code != 400 {
		t.Fatalf("volumes novelId=1e300 应 400，got %d（body=%s）", rec2.Code, rec2.Body.String())
	}

	// POST /api/chapters/audit {"action":"dedupe","novelId":1e300}
	req3 := httptest.NewRequest(http.MethodPost, "/api/chapters/audit",
		strings.NewReader(`{"action":"dedupe","novelId":1e300}`))
	rec3 := httptest.NewRecorder()
	handleChapterAuditPost(rec3, req3, nil)
	if rec3.Code != 400 {
		t.Fatalf("audit POST novelId=1e300 应 400，got %d（body=%s）", rec3.Code, rec3.Body.String())
	}

	// 合法值不误伤：负值/非整数维持 400，正常不存在 id 维持 404
	req4 := httptest.NewRequest(http.MethodGet, "/api/chapters/audit?novelId=99999999", nil)
	rec4 := httptest.NewRecorder()
	handleChapterAuditGet(rec4, req4, nil)
	if rec4.Code != 404 {
		t.Fatalf("合法形态不存在 novelId 应保持 404，got %d（body=%s）", rec4.Code, rec4.Body.String())
	}
}

// ---------- ④ settings PATCH UPDATE 失败不再静默 200 ----------

func TestSettingsPatchUpdateErrorSurfaced(t *testing.T) {
	mustInitSiteSettingTable(t)
	db, derr := getDB()
	if derr != nil {
		t.Fatalf("open temp db: %v", derr)
	}

	var origName string
	if err := db.QueryRow(`SELECT "siteName" FROM "SiteSetting" WHERE "id" = 1`).Scan(&origName); err != nil {
		t.Fatalf("read siteName: %v", err)
	}

	// 注入写失败：BEFORE UPDATE 触发器 RAISE(ABORT)（SELECT 路径不受影响）
	if _, err := db.Exec(`CREATE TRIGGER IF NOT EXISTS t56b_block_settings BEFORE UPDATE ON "SiteSetting"
		BEGIN
			SELECT RAISE(ABORT, 't56b forced failure');
		END`); err != nil {
		t.Fatalf("create trigger: %v", err)
	}
	t.Cleanup(func() {
		_, _ = db.Exec(`DROP TRIGGER IF EXISTS t56b_block_settings`)
	})

	code, resp := patchSettings(t, `{"siteName":"56b不应写入"}`)
	if code != 500 {
		t.Fatalf("UPDATE 失败应上返 500（旧版静默 200 ok:true 保存丢失），got %d（body=%v）", code, resp)
	}
	if err := db.QueryRow(`SELECT "siteName" FROM "SiteSetting" WHERE "id" = 1`).Scan(&origName); err != nil {
		t.Fatalf("read siteName: %v", err)
	}
	if origName == "56b不应写入" {
		t.Fatal("写失败后 siteName 不得变化")
	}

	// 撤除注入后恢复正常 200 + 落库（回归面：错误路径收窄不得误伤成功路径）
	if _, err := db.Exec(`DROP TRIGGER IF EXISTS t56b_block_settings`); err != nil {
		t.Fatalf("drop trigger: %v", err)
	}
	code, resp = patchSettings(t, `{"siteName":"56b正常保存"}`)
	if code != 200 {
		t.Fatalf("正常 PATCH 应 200，got %d（body=%v）", code, resp)
	}
	var got string
	if err := db.QueryRow(`SELECT "siteName" FROM "SiteSetting" WHERE "id" = 1`).Scan(&got); err != nil {
		t.Fatalf("read siteName: %v", err)
	}
	if got != "56b正常保存" {
		t.Fatalf("正常 PATCH 应落库，got %q", got)
	}
	t.Cleanup(func() {
		_, _ = db.Exec(`UPDATE "SiteSetting" SET "siteName" = ? WHERE "id" = 1`, origName)
	})
}
