/**
 * audit53b_test.go —— Task 53「ScrapeRule.cookies 规则级静态 cookie 底座」深审回归锁定：
 *
 * 1) TestScrapeRulesCookiesSaveListRoundTrip：保存→列表全链 round trip——保存端
 *    TrimSpace+4096 rune 钳制、列表 SELECT/Scan 12 列序对齐（错位即 Scan 报错/值串位）、
 *    缺失/null → ""（与 proxy/insecureTLS 全量保存语义一致）、非字符串 400（类型断言
 *    panic 面收口）、更新缺失清空语义锁定。
 * 2) TestEngineRuleBodyCookiesConditional：engineRuleBody 下发条件——Cookies 非空才发
 *    body["cookies"]，空值/未配置绝不发空键（与引擎 strField 4096 rune 钳制口径对齐，
 *    重复钳制无害）；charset/proxy/insecureTLS/referer 既有条件展开不受影响。
 * 3) TestLoadRuleCookiesTrimmed：loadRule SELECT 8 列序 + cookies 装载 TrimSpace；
 *    未配置/不存在的 ruleID → 全空规则（采集走引擎内置启发式）。
 * 4) TestSeedJSONCookiesChainInvariants：seed/seed.json 嵌入文件语法合法性（三规则组
 *    JSON 均可解析）+ 新增 id=25 kelexs/id=26 cunshu 未实测草稿不变式（enabled=false、
 *    proxy=""、cookies="" 空占位）。
 * 5) TestAdminRuleFormIdsContract：admin.js 静态 $('#id') 引用与 admin.html id 全量
 *    契约扫描——Task 53 实证缺陷类（JS 引用 adm-rule-cookies 而模板漏配输入框 →
 *    querySelector 返回 null → 新建/编辑规则表单整卡崩溃）的类级回归锁。
 *
 * 复用 recover_test.go 的 TestMain 临时库（getDB once 已由 ensureBaseSchema 建全量表，
 * 含 Task 53 cookies 列）；夹具 id≥95300 自清，绝不触碰生产 db/custom.db。
 */
package main

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"
)

// ---------- ① 保存→列表 round trip ----------

func mustCleanupRule(t *testing.T, id int64) {
	t.Helper()
	db, err := getDB()
	if err != nil {
		t.Fatalf("getDB: %v", err)
	}
	t.Cleanup(func() {
		_, _ = db.Exec(`DELETE FROM "ScrapeRule" WHERE "id" = ?`, id)
	})
}

func TestScrapeRulesCookiesSaveListRoundTrip(t *testing.T) {
	// 创建：cookies 带首尾空白 → 保存端 TrimSpace
	createBody := map[string]any{
		"name":    "cookie-roundtrip-95301",
		"siteUrl": "https://cookie-rt.example/",
		"cookies": "  a=1; b=2  ",
		"enabled": false,
	}
	rec := httptest.NewRecorder()
	handleScrapeRulesSaveBody(rec, createBody)
	if rec.Code != 201 {
		t.Fatalf("创建应 201，got %d body=%s", rec.Code, rec.Body.String())
	}
	var created struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil || created.ID <= 0 {
		t.Fatalf("创建响应应含正 id，got %s（err=%v）", rec.Body.String(), err)
	}
	mustCleanupRule(t, created.ID)

	listRows := func() map[string]any {
		t.Helper()
		lr := httptest.NewRecorder()
		handleScrapeRulesList(lr, httptest.NewRequest("GET", "/api/scrape-rules", nil), nil)
		if lr.Code != 200 {
			t.Fatalf("列表应 200，got %d body=%s", lr.Code, lr.Body.String())
		}
		var rows []map[string]any
		if err := json.Unmarshal(lr.Body.Bytes(), &rows); err != nil {
			t.Fatalf("列表解析失败: %v", err)
		}
		for _, row := range rows {
			if int64(row["id"].(float64)) == created.ID {
				return row
			}
		}
		t.Fatalf("列表缺行 id=%d", created.ID)
		return nil
	}

	if got := listRows()["cookies"]; got != "a=1; b=2" {
		t.Fatalf("cookies 应 TrimSpace 落库回读，got %q", got)
	}

	// 更新缺失 cookies → "" 全量保存（与 proxy/insecureTLS 语义一致，显式锁定）
	rec2 := httptest.NewRecorder()
	handleScrapeRulesSaveBody(rec2, map[string]any{
		"id": float64(created.ID), "name": "cookie-roundtrip-95301",
		"siteUrl": "https://cookie-rt.example/",
	})
	if rec2.Code != 200 {
		t.Fatalf("更新应 200，got %d body=%s", rec2.Code, rec2.Body.String())
	}
	if got := listRows()["cookies"]; got != "" {
		t.Fatalf("更新缺失 cookies 应清空为空串（全量保存语义），got %q", got)
	}

	// cookies:null 与缺失同语义（校验放行 → 提取零值 ""）
	rec3 := httptest.NewRecorder()
	handleScrapeRulesSaveBody(rec3, map[string]any{
		"id": float64(created.ID), "name": "cookie-roundtrip-95301",
		"siteUrl": "https://cookie-rt.example/", "cookies": nil,
	})
	if rec3.Code != 200 {
		t.Fatalf("cookies null 更新应 200，got %d body=%s", rec3.Code, rec3.Body.String())
	}
	if got := listRows()["cookies"]; got != "" {
		t.Fatalf("cookies null 应落空串，got %q", got)
	}

	// 超长钳制：5000 rune → 4096（与引擎 strField 4096 同口径）
	long := strings.Repeat("k=v;", 1250) // 5000 rune
	rec4 := httptest.NewRecorder()
	handleScrapeRulesSaveBody(rec4, map[string]any{
		"id": float64(created.ID), "name": "cookie-roundtrip-95301",
		"siteUrl": "https://cookie-rt.example/", "cookies": long,
	})
	if rec4.Code != 200 {
		t.Fatalf("超长 cookies 更新应 200，got %d body=%s", rec4.Code, rec4.Body.String())
	}
	if got, _ := listRows()["cookies"].(string); len([]rune(got)) != 4096 {
		t.Fatalf("超长 cookies 应钳制 4096 rune，got len=%d", len([]rune(got)))
	}

	// 类型断言 panic 面：非字符串非 null → 400，绝不落库
	rec5 := httptest.NewRecorder()
	handleScrapeRulesSaveBody(rec5, map[string]any{
		"id": float64(created.ID), "name": "cookie-roundtrip-95301",
		"siteUrl": "https://cookie-rt.example/", "cookies": map[string]any{"evil": "x"},
	})
	if rec5.Code != 400 {
		t.Fatalf("cookies 非字符串应 400，got %d body=%s", rec5.Code, rec5.Body.String())
	}
	for _, bad := range []any{float64(1), []any{"a=1"}, true} {
		recN := httptest.NewRecorder()
		handleScrapeRulesSaveBody(recN, map[string]any{
			"name": "cookie-badtype-95302", "siteUrl": "https://cookie-rt.example/", "cookies": bad,
		})
		if recN.Code != 400 {
			t.Fatalf("cookies %T 应 400，got %d", bad, recN.Code)
		}
	}
}

// ---------- ② engineRuleBody 下发条件 ----------

func TestEngineRuleBodyCookiesConditional(t *testing.T) {
	base := LoadedRule{ListRule: RuleMap{}, BookRule: RuleMap{}, ChapterRule: RuleMap{}}

	// 全空规则：只发 url+rule，五个可选键全部缺席
	b0 := engineRuleBody("https://x.example/", map[string]any{"bookRule": base.BookRule}, base, "")
	for _, k := range []string{"charset", "proxy", "insecureTLS", "cookies", "referer"} {
		if _, ok := b0[k]; ok {
			t.Fatalf("空规则不应携带可选键 %q", k)
		}
	}

	// Cookies 非空才发；与 charset/proxy 共存
	b1 := engineRuleBody("https://x.example/", map[string]any{}, LoadedRule{
		Charset: "gbk", Proxy: "http://p.example:1", Cookies: "a=1; b=2",
		ListRule: RuleMap{}, BookRule: RuleMap{}, ChapterRule: RuleMap{},
	}, "https://ref.example/")
	if b1["cookies"] != "a=1; b=2" || b1["charset"] != "gbk" || b1["proxy"] != "http://p.example:1" || b1["referer"] != "https://ref.example/" {
		t.Fatalf("可选键下发不符: %v", b1)
	}

	// Cookies 为空但其他键配置：绝不发空 cookies 键（引擎按缺省=无注入处理）
	b2 := engineRuleBody("https://x.example/", map[string]any{}, LoadedRule{
		Charset: "utf-8", Cookies: "   ",
		ListRule: RuleMap{}, BookRule: RuleMap{}, ChapterRule: RuleMap{},
	}, "")
	if _, ok := b2["cookies"]; ok {
		t.Fatalf("空 cookies 不应下发该键: %v", b2)
	}
	if b2["charset"] != "utf-8" {
		t.Fatalf("charset 条件展开回归: %v", b2)
	}

	// insecureTLS 布尔条件与 cookies 共存
	b3 := engineRuleBody("https://x.example/", map[string]any{}, LoadedRule{
		InsecureTLS: true, Cookies: "k=v",
		ListRule: RuleMap{}, BookRule: RuleMap{}, ChapterRule: RuleMap{},
	}, "")
	if b3["insecureTLS"] != true || b3["cookies"] != "k=v" {
		t.Fatalf("insecureTLS+cookies 下发不符: %v", b3)
	}
}

// ---------- ③ loadRule cookies 装载 ----------

func TestLoadRuleCookiesTrimmed(t *testing.T) {
	db, err := getDB()
	if err != nil {
		t.Fatalf("getDB: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO "ScrapeRule" ("id","name","siteUrl","enabled","charset","proxy","insecureTLS","cookies","createdAt","updatedAt")
                VALUES (95310,'loadrule-95310','https://lr.example/',1,'GBK',' http://p.example:2 ',0,' k1=v1; k2=v2 ',1,1)`); err != nil {
		t.Fatalf("insert fixture: %v", err)
	}
	t.Cleanup(func() { _, _ = db.Exec(`DELETE FROM "ScrapeRule" WHERE "id" = 95310`) })

	id := 95310
	r := loadRule(&id)
	if r.Cookies != "k1=v1; k2=v2" {
		t.Fatalf("cookies 应 TrimSpace 装载，got %q", r.Cookies)
	}
	if r.Charset != "gbk" || r.Proxy != "http://p.example:2" {
		t.Fatalf("charset/proxy 既有装载语义回归: %q/%q", r.Charset, r.Proxy)
	}

	// 不存在 ruleID → 全空规则（零 cookies）
	missing := 95311
	if r2 := loadRule(&missing); r2.Cookies != "" || r2.Charset != "" {
		t.Fatalf("不存在 ruleID 应全空，got %+v", r2)
	}
	// nil → 全空
	if r3 := loadRule(nil); r3.Cookies != "" {
		t.Fatalf("nil ruleID 应全空，got %+v", r3)
	}
}

// ---------- ④ seed.json 语法与草稿不变式 ----------

func TestSeedJSONCookiesChainInvariants(t *testing.T) {
	var doc seedDoc
	if err := json.Unmarshal(seedBlob, &doc); err != nil {
		t.Fatalf("seed/seed.json 语法非法（嵌入文件解析失败）: %v", err)
	}
	if len(doc.Rules) == 0 {
		t.Fatal("种子规则为空")
	}
	byID := map[int64]seedRule{}
	for _, r := range doc.Rules {
		byID[r.ID] = r
		// 三规则组 JSON 列语法合法性（种子资产面全量）
		for name, col := range map[string]string{"listRule": r.ListRule, "bookRule": r.BookRule, "chapterRule": r.ChapterRule} {
			var m map[string]any
			if col == "" {
				continue // 空串=引擎内置启发式（历史种子允许）
			}
			if err := json.Unmarshal([]byte(col), &m); err != nil {
				t.Fatalf("规则 %d %s 非法 JSON: %v", r.ID, name, err)
			}
		}
	}
	for _, want := range []struct {
		id   int64
		name string
	}{{25, "kelexs"}, {26, "cunshu"}} {
		r, ok := byID[want.id]
		if !ok {
			t.Fatalf("种子缺新增草稿规则 id=%d", want.id)
		}
		if r.Name != want.name {
			t.Fatalf("规则 %d name=%q want %q", want.id, r.Name, want.name)
		}
		if r.Enabled {
			t.Fatalf("草稿规则 %d(%s) 必须 enabled=false（WAF 人机验证站防任务空烧）", want.id, want.name)
		}
		if r.Proxy != "" {
			t.Fatalf("草稿规则 %d proxy 应为空直连，got %q", want.id, r.Proxy)
		}
		if r.Cookies != "" {
			t.Fatalf("草稿规则 %d cookies 应为空占位（真实凭证由用户人工过验后经后台填入），got %q", want.id, r.Cookies)
		}
	}
}

// ---------- ⑤ admin 表单 id 契约扫描 ----------

func TestAdminRuleFormIdsContract(t *testing.T) {
	html, err := os.ReadFile("web/templates/admin/admin.html")
	if err != nil {
		t.Fatalf("读 admin.html: %v", err)
	}
	js, err := os.ReadFile("web/static/js/admin.js")
	if err != nil {
		t.Fatalf("读 admin.js: %v", err)
	}
	// Task 53 P1 实证缺陷类回归锁：admin.js 每个静态 $('#id') 引用必须在 admin.html
	// 存在同名 id（querySelector 返回 null 时属性赋值/读取直接 TypeError，整个表单
	// 或表格功能区崩溃）。动态拼接选择器（'#' + 变量）不在此扫描面。
	htmlStr := string(html)
	idRe := regexp.MustCompile(`id="([a-z0-9-]+)"`)
	known := map[string]bool{}
	for _, m := range idRe.FindAllStringSubmatch(htmlStr, -1) {
		known[m[1]] = true
	}
	refRe := regexp.MustCompile(`\$\('#([a-z0-9-]+)'\)`)
	missing := map[string]bool{}
	for _, m := range refRe.FindAllStringSubmatch(string(js), -1) {
		if !known[m[1]] {
			missing[m[1]] = true
		}
	}
	if len(missing) > 0 {
		var ids []string
		for id := range missing {
			ids = append(ids, id)
		}
		t.Fatalf("admin.js 引用了 admin.html 不存在的 id（querySelector null → 运行时 TypeError）: %v", ids)
	}
	// Task 53 专项：Cookie 列与表单输入框双侧在位（列表 {{if .cookies}} + 表单 #adm-rule-cookies）
	if !strings.Contains(htmlStr, `id="adm-rule-cookies"`) {
		t.Fatal("admin.html 规则表单缺 #adm-rule-cookies 输入框（Task 53 P1 回归）")
	}
	if !strings.Contains(htmlStr, "{{if .cookies}}") {
		t.Fatal("admin.html 规则列表缺 cookies 列渲染分支")
	}
}
