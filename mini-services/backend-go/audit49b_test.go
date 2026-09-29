/**
 * audit49b_test.go —— Task 49-b 深审回归锁定：
 *
 * 1) TestSmartFillLimitParamOverflowGuard：smart-fill body.limit 的 2^53 上界守卫——
 *    旧版 int(f) 对 1e300 实现定义溢出（amd64 得 MinInt64 负值），负 limit 传入 SQLite
 *    `LIMIT ?` 语义=无上限（候选全表展开 + 逐书 LLM 调用）。
 * 2) TestNovelsListCategoryIdOverflowGuard：列表 categoryId 越界浮点 400（旧版溢出负值
 *    使 categoryId>0 判定失效、静默丢过滤条件）。
 * 3) TestSoftBlockNullRawMessageNotPresent：引擎响应 `"softBlock": null` 不得视为档案命中
 *    （旧 len(RawMessage)>0 判定把 null 误当软拦截 → 空提取被归入瞬态、自动恢复空转烧预算）。
 * 4) TestClampRatioFloatAndFloatRange：比例/数值钳制的 float 域实现（越界=上界语义，
 *    旧 int 转换溢出翻转）。
 * 5) TestPhase1FillMapMergeDuplicateNovel：同书多列表条目（同 title+author 收敛同一
 *    novelID）时 fillPlan 合并而非覆盖——旧版后到条目把先到条目的待填充行挤出本轮计划
 *    （wordCount=0 骨架只能等下次重发自愈）。
 *
 * Task 49-b 续审追加（收敛轮）：
 * 6) TestIntFieldStrictOverflowGuard / TestCategorySortOverflowGuard：intFieldStrict
 *    2^53 上界——旧版 int(f) 对 1e300 实现定义溢出为 MinInt64，PUT categories 溢出负值
 *    直写 Category.sort（数据腐蚀）。
 * 7) TestPseoDeleteIDBound：DELETE /api/pseo?id=1e300 拒绝（全包 id 参数 2^53 口径统一）。
 * 8) TestParseDigitsASCIIOverflowGuard：目录体检编号解析的 int64 防溢出——旧版超长
 *    数字串（20+ 位）回绕为负穿透 extractNum 编号比较（乱序检测误报）。
 *
 * 复用 recover_test.go 的 TestMain 临时库（getDB once 已由 ensureBaseSchema 建全量表），
 * 绝不触碰生产 db/custom.db；引擎经 BACKEND_ENGINE_URL httptest stub 注入。
 */
package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// ---------- ① smart-fill limit 守卫 ----------

func TestSmartFillLimitParamOverflowGuard(t *testing.T) {
	cases := []struct {
		name  string
		limit any
		want  int
	}{
		{"缺省（nil map）", nil, 30},
		{"无字段", map[string]any{}, 30},
		{"正常值", map[string]any{"limit": float64(10)}, 10},
		{"上限钳制", map[string]any{"limit": float64(80)}, 50},
		{"2^53 内大值钳制", map[string]any{"limit": 1e12}, 50},
		{"越界浮点回落缺省", map[string]any{"limit": 1e300}, 30},
		{"负值回落缺省", map[string]any{"limit": float64(-5)}, 30},
		{"非整数回落缺省", map[string]any{"limit": 3.5}, 30},
		{"零回落缺省", map[string]any{"limit": float64(0)}, 30},
		{"字符串回落缺省", map[string]any{"limit": "10"}, 30},
	}
	for _, c := range cases {
		m, _ := c.limit.(map[string]any)
		if got := smartFillLimitParam(m); got != c.want {
			t.Errorf("%s: smartFillLimitParam = %d, want %d", c.name, got, c.want)
		}
	}
	// 显式 nil（越界向量的 limit 值形态）
	if got := smartFillLimitParam(map[string]any{"limit": 1e300}); got != 30 {
		t.Errorf("1e300 越界应回落缺省 30（负值溢出会让 SQLite LIMIT 失去上界），got %d", got)
	}
}

// ---------- ② 列表 categoryId 越界守卫（端到端 handler） ----------

func TestNovelsListCategoryIdOverflowGuard(t *testing.T) {
	for _, c := range []struct {
		raw  string
		want int
	}{
		{"1e300", 400}, // 越界浮点（旧版溢出负值→静默丢过滤条件 200）
		{"abc", 400},
		{"1.5", 400},
		{"-3", 400},
		{"9007199254740994", 400}, // >2^53 上界（2^53+1 无独立 float64 表示，取 +2）
		{"9007199254740992", 200}, // 恰为 2^53 上界：与 taskRuleIDParam 同口径（> 上界才拒）
		{"1", 200},                // 合法值不误伤
	} {
		req := httptest.NewRequest(http.MethodGet, "/api/novels?categoryId="+c.raw, nil)
		rec := httptest.NewRecorder()
		handleNovelsList(rec, req, nil)
		if rec.Code != c.want {
			t.Fatalf("categoryId=%s 应 %d，got %d（body=%s）", c.raw, c.want, rec.Code, rec.Body.String())
		}
	}
}

// ---------- ③ softBlock null 纵深防御 ----------

func TestSoftBlockNullRawMessageNotPresent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// 显式 null 档案：旧 len(RawMessage)>0 判定会误命中（4 字节 "null"）
		_, _ = w.Write([]byte(`{"ok":true,"data":{"list":{"items":[]}},"warnings":[],"softBlock":null}`))
	}))
	defer srv.Close()
	t.Setenv("BACKEND_ENGINE_URL", srv.URL)

	run := NewRun(990_300)
	items, errText := fetchListPage(run, "https://nullsb.example/list.html", LoadedRule{}, "")
	if len(items) != 0 {
		t.Fatalf("空提取应返回 0 条，got %d", len(items))
	}
	if errText != "" {
		t.Fatalf("softBlock=null 不得视为档案命中（应保持空错误串的「规则失效」旧契约），got %q", errText)
	}
	if isTransientScrapeErr(errText) {
		t.Fatal("softBlock=null 的空提取不应命中瞬态判定（否则自动恢复对真实规则失效空转烧预算）")
	}
}

// ---------- ④ float 域钳制 ----------

func TestClampRatioFloatAndFloatRange(t *testing.T) {
	if got := clampRatioFloat(1e300); got != 100 {
		t.Errorf("clampRatioFloat(1e300) = %d, want 100（旧 int 溢出翻转到 0）", got)
	}
	if got := clampRatioFloat(-5); got != 0 {
		t.Errorf("clampRatioFloat(-5) = %d, want 0", got)
	}
	if got := clampRatioFloat(40.7); got != 40 {
		t.Errorf("clampRatioFloat(40.7) = %d, want 40", got)
	}
	if got := clampRatioFloat(0); got != 0 {
		t.Errorf("clampRatioFloat(0) = %d, want 0", got)
	}

	cfg := sanitizePseoConfig(map[string]any{"perSeedLimit": 1e300, "maxKeywords": 1e300})
	if cfg.PerSeedLimit != 20 {
		t.Errorf("perSeedLimit=1e300 应钳到上界 20（旧溢出翻转到 3），got %d", cfg.PerSeedLimit)
	}
	if cfg.MaxKeywords != 500 {
		t.Errorf("maxKeywords=1e300 应钳到上界 500（旧溢出翻转到 10），got %d", cfg.MaxKeywords)
	}
	cfg = sanitizePseoConfig(map[string]any{"perSeedLimit": float64(7.6), "maxKeywords": float64(99.2)})
	if cfg.PerSeedLimit != 8 || cfg.MaxKeywords != 99 {
		t.Errorf("正常值语义不得变化：perSeedLimit=%d（want 8）maxKeywords=%d（want 99）", cfg.PerSeedLimit, cfg.MaxKeywords)
	}
}

// ---------- ⑤ 同书多列表条目 fillPlan 合并（端到端 phase1Skeletons + stub 引擎） ----------

func TestPhase1FillMapMergeDuplicateNovel(t *testing.T) {
	// stub 引擎：按请求书页 URL 返回同名书但章节 URL 前缀不同（A 条目 3 章 a*；
	// B 条目含同名 1-3 章（b* URL）+ 独有的第 4 章（b* URL））
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			URL string `json:"url"`
		}
		_ = readAllLimitedBodyInto(r, &body)
		prefix := "a"
		total := 3
		if strings.Contains(body.URL, "/b") {
			prefix = "b"
			total = 4
		}
		chs := make([]string, 0, total)
		for i := 1; i <= total; i++ {
			chs = append(chs, `{"title":"第`+itoa(i)+`章 同书多入口","url":"https://dup.example/`+prefix+itoa(i)+`.html"}`)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"data":{"book":{"title":"同书多入口测试","author":"某作者","chapterCount":` + itoa(total) + `,"chapters":[` +
			strings.Join(chs, ",") + `]}}}`))
	}))
	defer srv.Close()
	t.Setenv("BACKEND_ENGINE_URL", srv.URL)

	// stopState 协作停止查询 ScrapeTask 行（缺失=记录删除→canceled 立即停手）：
	// 先登记一条 running 行让 phase1 正常执行，收尾清理
	db, derr := getDB()
	if derr != nil {
		t.Fatalf("open temp db: %v", derr)
	}
	res, ierr := db.Exec(
		`INSERT INTO "ScrapeTask" ("id","mode","targetUrl","pages","storageMode","status","createdAt","updatedAt")
                 VALUES (990400,'list','https://dup.example/list.html',1,'db','running',?,?)`, nowMillis(), nowMillis())
	if ierr != nil {
		t.Fatalf("insert task row: %v", ierr)
	}
	_ = res
	t.Cleanup(func() {
		_, _ = db.Exec(`DELETE FROM "ScrapeTask" WHERE "id" = 990400`)
	})
	// BOOK_CONCURRENCY=1 强制条目按索引顺序处理（A 先 B 后）——合并语义（首胜保留 A URL）
	// 与覆盖语义（B 独占计划）的断言才具备确定性
	oldConcurrency := BOOK_CONCURRENCY
	BOOK_CONCURRENCY = 1
	t.Cleanup(func() { BOOK_CONCURRENCY = oldConcurrency })

	run := NewRun(990_400)
	items := []ListItem{
		{Title: "同书多入口测试", URL: "https://dup.example/a"},
		{Title: "同书多入口测试", URL: "https://dup.example/b"},
	}
	p1 := phase1Skeletons(run, LoadedRule{}, items, "")
	if p1.Fatal != nil {
		t.Fatalf("phase1 不应 fatal：%v", p1.Fatal)
	}
	if p1.OKBooks != 2 {
		t.Fatalf("两个条目都应入库成功，OKBooks=%d（firstError=%q）", p1.OKBooks, p1.FirstError)
	}
	if len(p1.NovelIDs) != 2 || p1.NovelIDs[0] != p1.NovelIDs[1] {
		t.Fatalf("两条目应收敛到同一 novelID，got %v", p1.NovelIDs)
	}
	plan, ok := p1.FillMap[p1.NovelIDs[0]]
	if !ok {
		t.Fatal("fillMap 应存在该书的填充计划")
	}
	// 去重合并：第 1-3 章（同题）首胜保留 A 入口 URL + 第 4 章仅 B 独有 → 4 行
	if len(plan.Rows) != 4 {
		t.Fatalf("fillPlan 应按标题去重合并（3 同题 + 1 B 独有 = 4 行），got %d（旧版覆盖=先到条目 3 行被挤出本轮计划）", len(plan.Rows))
	}
	if p1.FillTotal != 4 {
		t.Fatalf("chaptersTotal 分母应只按新增唯一章累加（4），got %d（虚增会让进度永远走不满）", p1.FillTotal)
	}
	hasA, hasBExtra := false, false
	for _, r := range plan.Rows {
		switch {
		case strings.HasPrefix(r.Title, "第4章") && strings.Contains(r.URL, "/b"):
			hasBExtra = true // B 条目独有的第 4 章必须进计划（旧版先到条目独占时同样缺失）
		case strings.Contains(r.URL, "/a"):
			hasA = true
		}
	}
	if !hasA || !hasBExtra {
		t.Fatalf("合并计划应含 A 入口 URL（hasA=%v）与 B 独有第 4 章（hasBExtra=%v）", hasA, hasBExtra)
	}
	// 清理本轮测试书（避免影响其他用例的列表查询断言）
	if _, err := db.Exec(`DELETE FROM "ChapterContent" WHERE "chapterId" IN (SELECT "id" FROM "Chapter" WHERE "novelId" = ?)`, p1.NovelIDs[0]); err != nil {
		t.Fatalf("cleanup cc: %v", err)
	}
	if _, err := db.Exec(`DELETE FROM "Chapter" WHERE "novelId" = ?`, p1.NovelIDs[0]); err != nil {
		t.Fatalf("cleanup chapters: %v", err)
	}
	if _, err := db.Exec(`DELETE FROM "Novel" WHERE "id" = ?`, p1.NovelIDs[0]); err != nil {
		t.Fatalf("cleanup novel: %v", err)
	}
	if _, err := db.Exec(`DELETE FROM "PseoKeyword" WHERE "keyword" LIKE '同书多入口测试%' OR "seed" = '同书多入口测试'`); err != nil {
		t.Fatalf("cleanup pseo: %v", err)
	}
}

// readAllLimitedBodyInto 测试辅助：限量读请求体并反序列化（stub 引擎用）
func readAllLimitedBodyInto(r *http.Request, v any) error {
	b, err := readAllLimited(r.Body, 1<<20)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

// ---------- ⑥ intFieldStrict 2^53 上界（Task 49-b 续审） ----------

func TestIntFieldStrictOverflowGuard(t *testing.T) {
	cases := []struct {
		name   string
		v      any
		want   int
		wantOK bool
	}{
		{"正常值", float64(5), 5, true},
		{"负整数合法（sort 允许负值）", float64(-3), -3, true},
		{"零", float64(0), 0, true},
		{"恰为 2^53 上界（同族口径：> 上界才拒）", float64(9_007_199_254_740_992), 9_007_199_254_740_992, true},
		{"2^53 内大值", float64(4_503_599_627_370_496), 4_503_599_627_370_496, true},
		{"超界（2^53+2 无独立 float 表示取 +2）", float64(9_007_199_254_740_994), 0, false},
		{"越界浮点 1e300（旧版溢出为 MinInt64）", 1e300, 0, false},
		{"非整数", float64(1.5), 0, false},
		{"字符串", "5", 0, false},
		{"nil", nil, 0, false},
	}
	for _, c := range cases {
		got, ok := intFieldStrict(c.v)
		if ok != c.wantOK || (ok && got != c.want) {
			t.Errorf("%s: intFieldStrict(%v) = (%d,%v), want (%d,%v)", c.name, c.v, got, ok, c.want, c.wantOK)
		}
	}
}

// TestCategorySortOverflowGuard 端到端：PUT /api/categories/{id} 携带 sort=1e300
// 不得把溢出负值写进 Category.sort（旧版 intFieldStrict 溢出为 MinInt64 直写腐蚀）；
// 合法值照常生效。
func TestCategorySortOverflowGuard(t *testing.T) {
	db, derr := getDB()
	if derr != nil {
		t.Fatalf("open temp db: %v", derr)
	}
	res, err := db.Exec(`INSERT INTO "Category" ("name","sort") VALUES ('49b排序守卫', 7)`)
	if err != nil {
		t.Fatalf("insert category: %v", err)
	}
	cid, _ := res.LastInsertId()
	t.Cleanup(func() {
		_, _ = db.Exec(`DELETE FROM "Category" WHERE "id" = ?`, cid)
	})

	// 越界浮点：不得腐蚀 sort
	req := httptest.NewRequest(http.MethodPut, "/api/categories/"+itoa(int(cid)),
		strings.NewReader(`{"sort":1e300}`))
	rec := httptest.NewRecorder()
	handleCategoryByID(rec, req, map[string]string{"id": itoa(int(cid))})
	if rec.Code != 200 {
		t.Fatalf("越界 sort 应宽松忽略返回 200（PATCH 语义），got %d（body=%s）", rec.Code, rec.Body.String())
	}
	var sortVal int64
	if err := db.QueryRow(`SELECT "sort" FROM "Category" WHERE "id" = ?`, cid).Scan(&sortVal); err != nil {
		t.Fatalf("query sort: %v", err)
	}
	if sortVal != 7 {
		t.Fatalf("越界 sort 不得写库（旧版溢出 MinInt64 腐蚀），got %d", sortVal)
	}

	// 合法值照常生效（不误伤）
	req2 := httptest.NewRequest(http.MethodPut, "/api/categories/"+itoa(int(cid)),
		strings.NewReader(`{"sort":42}`))
	rec2 := httptest.NewRecorder()
	handleCategoryByID(rec2, req2, map[string]string{"id": itoa(int(cid))})
	if rec2.Code != 200 {
		t.Fatalf("合法 sort 应生效，got %d（body=%s）", rec2.Code, rec2.Body.String())
	}
	if err := db.QueryRow(`SELECT "sort" FROM "Category" WHERE "id" = ?`, cid).Scan(&sortVal); err != nil {
		t.Fatalf("query sort: %v", err)
	}
	if sortVal != 42 {
		t.Fatalf("合法 sort=42 应写库，got %d", sortVal)
	}
}

// ---------- ⑦ pseo delete id 上界 ----------

func TestPseoDeleteIDBound(t *testing.T) {
	for _, c := range []struct {
		raw  string
		want int
	}{
		{"1e300", 400},            // 越界浮点（旧版 int64 溢出负值 DELETE 空转后仍 200）
		{"abc", 400},              // 非数字
		{"-1", 400},               // 负数
		{"9007199254740994", 400}, // >2^53
		{"1", 200},                // 合法值不误伤（TS .catch(()=>{}) 契约恒 ok）
	} {
		req := httptest.NewRequest(http.MethodDelete, "/api/pseo?id="+c.raw, nil)
		rec := httptest.NewRecorder()
		handlePseoDelete(rec, req, nil)
		if rec.Code != c.want {
			t.Fatalf("id=%s 应 %d，got %d（body=%s）", c.raw, c.want, rec.Code, rec.Body.String())
		}
	}
}

// ---------- ⑧ 目录体检编号解析防溢出 ----------

func TestParseDigitsASCIIOverflowGuard(t *testing.T) {
	maxSafe := int64(1) << 53
	cases := []struct {
		in   string
		want int64
	}{
		{"0", 0},
		{"123", 123},
		{"9007199254740992", maxSafe}, // 恰为 2^53
		{"9007199254740993", maxSafe}, // 2^53+1 截断（JS Number 精度语义）
		// 26 位：旧版 n*10 累积回绕为负再判 >1<<53 恒假 → 负值穿透编号比较
		{"11111111111111111111111111", maxSafe},
		{"99999999999999999999999999", maxSafe},
	}
	for _, c := range cases {
		if got := parseDigitsASCII(c.in); got != c.want {
			t.Errorf("parseDigitsASCII(%q) = %d, want %d（负值/回绕即回归）", c.in, got, c.want)
		}
		if got := parseDigitsASCII(c.in); got < 0 {
			t.Errorf("parseDigitsASCII(%q) 不得返回负值（int64 溢出回绕）", c.in)
		}
	}
}
