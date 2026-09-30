/**
 * audit54b_test.go —— Task 54-b 渲染层深审回归锁定（第 16 轮收敛·渲染层专项）。
 *
 * 1) TestAdminIgnoresThemePreviewParam      —— P3 修复回归：renderPage 的 ?theme= 预览
 *    覆盖此前同样作用于 admin 页，任意 /admin?theme=<白名单主题> 会把主题改写为前台主题
 *    → admin 模板与 _fallback 均无 admin.html → 双 nil → 极简错误页（后台整页 200 丢失，
 *    探针实证）。修复后 admin 跳过预览覆盖（与 obfMaybe 的 admin 跳过同口径），
 *    公共页预览语义不变（ggd66 资产标记实证）。
 * 2) TestAdminSSRFirstScreenContract        —— handleWebAdmin 首屏服务端渲染的列契约
 *    端到端锁定：Rules SELECT 10 列 ↔ Scan 10 目标（Task 53 cookies 列含内）、Tasks
 *    SELECT 14 列 ↔ Scan 14 目标。列错位/漏列在此表现为「行静默丢失/标记缺失」，
 *    以 cookies 已配置 ✓ 标记与任务行渲染为断言面（此前该面仅人工实测无自动化）。
 * 3) TestPaginationVariantsBoundaries       —— pagination.go 零测试覆盖补齐（辖区深审
 *    发现唯一无测试的 Go 文件）：jsEncodeURIComponent 的 JS encodeURIComponent 精确
 *    语义（保留集 A-Za-z0-9-_.!~*'() / 空格→%20 / 多字节 UTF-8 逐字节大写 %XX）、
 *    模板 {k}/{url} 替换、guessPageVariants 的 query 保留/去重/相对 URL 兜底分支、
 *    k=0/负数/超界页码零 panic 且输出确定。
 */
package main

import (
	"net/http/httptest"
	"strings"
	"testing"
)

// TestAdminIgnoresThemePreviewParam P3 修复回归（修复前探针实证：/admin?theme=ggd66
// 输出 175 字节极简错误页、零 admin DOM）。
func TestAdminIgnoresThemePreviewParam(t *testing.T) {
	// ① 带 ?theme= 预览参数的 /admin 必须照常渲染完整后台（跳过预览覆盖）
	req := httptest.NewRequest("GET", "/admin?theme=ggd66", nil)
	rec := httptest.NewRecorder()
	handleWebAdmin(rec, req)
	body := rec.Body.String()
	if rec.Code != 200 {
		t.Fatalf("/admin?theme=ggd66 status = %d, want 200", rec.Code)
	}
	if !strings.Contains(body, "站点管理后台") {
		t.Fatalf("/admin?theme=ggd66 未渲染后台首页（预览参数仍劫持 admin 主题）: %.200s", body)
	}
	if strings.Contains(body, "页面渲染异常") {
		t.Fatalf("/admin?theme=ggd66 落入极简错误页（admin 模板双 nil）")
	}
	// admin 页跳过 obfuscate（obfMaybe 同口径）——后台标识应原样出现
	if !strings.Contains(body, "adm-tabs") {
		t.Fatalf("/admin?theme=ggd66 输出缺后台 DOM 钩子 adm-tabs")
	}

	// ② 对照：不带参数的 /admin 行为不变
	rec2 := httptest.NewRecorder()
	handleWebAdmin(rec2, httptest.NewRequest("GET", "/admin", nil))
	if rec2.Code != 200 || !strings.Contains(rec2.Body.String(), "站点管理后台") {
		t.Fatalf("/admin 基线渲染回归: status=%d", rec2.Code)
	}

	// ③ 公共页 ?theme= 预览语义保持：ggd66 主题资产标记出现（标签属性不经 obfuscate
	// 文本变换，断言稳定），且不落极简错误页
	req3 := httptest.NewRequest("GET", "/search?q=&theme=ggd66", nil)
	rec3 := httptest.NewRecorder()
	handleWebSearch(rec3, req3)
	body3 := rec3.Body.String()
	if rec3.Code != 200 {
		t.Fatalf("/search?theme=ggd66 status = %d, want 200", rec3.Code)
	}
	if strings.Contains(body3, "页面渲染异常") {
		t.Fatalf("/search?theme=ggd66 落入极简错误页（公共页预览被误伤）")
	}
	if !strings.Contains(body3, "/static/js/ggd66.js") {
		t.Fatalf("/search?theme=ggd66 未按预览参数渲染 ggd66 主题资产")
	}
}

// TestAdminSSRFirstScreenContract handleWebAdmin 首屏列契约端到端（临时库，零生产触碰）。
func TestAdminSSRFirstScreenContract(t *testing.T) {
	db, err := getDB()
	if err != nil {
		t.Fatalf("getDB: %v", err)
	}
	cleanup := func() {
		_, _ = db.Exec(`DELETE FROM "ScrapeTask" WHERE "targetUrl" LIKE 'https://audit54b.example/%'`)
		_, _ = db.Exec(`DELETE FROM "ScrapeRule" WHERE "name" = '审计54B规则'`)
		_, _ = db.Exec(`DELETE FROM "ScrapeRule" WHERE "name" = '审计54B无Cookie'`)
	}
	cleanup()
	t.Cleanup(cleanup)

	res, err := db.Exec(`INSERT INTO "ScrapeRule" ("name","siteUrl","enabled","charset","proxy","cookies","notes") VALUES ('审计54B规则','https://audit54b.example/',1,'utf-8','10.0.0.1:11111','session=abc; k2=v2','审计备注')`)
	if err != nil {
		t.Fatalf("seed rule: %v", err)
	}
	ruleID, _ := res.LastInsertId()
	if _, err := db.Exec(`INSERT INTO "ScrapeRule" ("name","siteUrl","enabled","cookies","notes") VALUES ('审计54B无Cookie','https://audit54b.example/nocookie',0,'','')`); err != nil {
		t.Fatalf("seed rule2: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO "ScrapeTask" ("ruleId","mode","targetUrl","pages","status","total","done","chapters","message") VALUES (?,'list','https://audit54b.example/list',3,'partial',10,4,42,'审计消息')`, ruleID); err != nil {
		t.Fatalf("seed task: %v", err)
	}

	rec := httptest.NewRecorder()
	handleWebAdmin(rec, httptest.NewRequest("GET", "/admin", nil))
	body := rec.Body.String()
	if rec.Code != 200 {
		t.Fatalf("handleWebAdmin status = %d, want 200", rec.Code)
	}

	// 规则行渲染（Rules 10 列契约断裂时该行静默丢失）
	if !strings.Contains(body, "审计54B规则") {
		t.Fatalf("首屏缺少规则行（Rules 查询/Scan 契约断裂 → 行静默丢失）")
	}
	// cookies 已配置 ✓ 标记只对 cookies 非空行出现——列错位（如 notes 挪到 cookies 位）
	// 会令两行标记同真/同假
	if !strings.Contains(body, `title="已配置静态 cookie 底座"`) {
		t.Fatalf("首屏缺少 cookies 已配置标记（cookies 列契约断裂）")
	}
	if !strings.Contains(body, "10.0.0.1:11111") {
		t.Fatalf("首屏规则 proxy 列值缺失（列错位）")
	}
	if !strings.Contains(body, "审计备注") {
		t.Fatalf("首屏规则 notes 列值缺失（列错位）")
	}
	// 任务行渲染（Tasks 14 列契约：列错位/类型不兼容 → 行静默丢失）
	if !strings.Contains(body, `data-task-id="`) {
		t.Fatalf("首屏缺少任务行（Tasks 查询/Scan 契约断裂 → 行静默丢失）")
	}
	if !strings.Contains(body, "审计消息") {
		t.Fatalf("首屏任务 message 列值缺失（列错位）")
	}
	if !strings.Contains(body, "4/10") {
		t.Fatalf("首屏任务 done/total 缺失（列错位）")
	}
	// 分卷/类别/PSEO 面不因本轮查询故障全空（健康面粗检）
	if !strings.Contains(body, "PSEO") || !strings.Contains(body, "采集规则") {
		t.Fatalf("首屏结构性区块缺失（SSR 模板契约断裂）")
	}
}

// TestPaginationVariantsBoundaries pagination.go 契约锁定（此前零测试覆盖）。
func TestPaginationVariantsBoundaries(t *testing.T) {
	// ---- jsEncodeURIComponent：JS encodeURIComponent 精确语义 ----
	jsEnc := map[string]string{
		"":          "",
		"abc123":    "abc123",
		"a b":       "a%20b",              // 空格 → %20（非 +，与 url.QueryEscape 分叉点）
		"!'()*-_.~": "!'()*-_.~",          // JS 保留不转义全集
		"a+b":       "a%2Bb",              // + 必须转义
		"/?&=#":     "%2F%3F%26%3D%23",    // 结构字符全转义
		"玄幻":        "%E7%8E%84%E5%B9%BB", // CJK → UTF-8 逐字节大写 %XX
		"中a文1":      "%E4%B8%ADa%E6%96%871",
		"\u00a0":    "%C2%A0", // NBSP 两字节
		"~*!(')-_.": "~*!(')-_.",
	}
	for in, want := range jsEnc {
		if got := jsEncodeURIComponent(in); got != want {
			t.Errorf("jsEncodeURIComponent(%q) = %q, want %q", in, got, want)
		}
	}

	// ---- buildPageVariants：模板模式 ----
	tpl := RuleMap{"paginationTemplate": "https://s.example/list-{k}.html"}
	if got := buildPageVariants(tpl, "https://s.example/list", 2); len(got) != 1 || got[0] != "https://s.example/list-2.html" {
		t.Errorf("模板 {k} 替换错误: %v", got)
	}
	// {url} 与 {k} 同模板共存；{url} 走 encodeURIComponent 语义
	tpl2 := RuleMap{"paginationTemplate": "https://s.example/p?a={url}&k={k}"}
	want2 := "https://s.example/p?a=" + jsEncodeURIComponent("https://s.example/list?x=1") + "&k=3"
	if got := buildPageVariants(tpl2, "https://s.example/list?x=1", 3); len(got) != 1 || got[0] != want2 {
		t.Errorf("模板 {url}+{k} 替换错误: got %v want %s", got, want2)
	}
	// 模板无 {k} 时 {k} 替换为 no-op、返回单元素
	tpl3 := RuleMap{"paginationTemplate": "https://s.example/fixed"}
	if got := buildPageVariants(tpl3, "https://s.example/list", 9); len(got) != 1 || got[0] != "https://s.example/fixed" {
		t.Errorf("无 {k} 模板应原样返回: %v", got)
	}
	// 未配置模板 → 回退猜测（与 guessPageVariants 一致）
	if got := buildPageVariants(RuleMap{}, "https://s.example/list", 2); len(got) < 1 {
		t.Errorf("空模板应回退猜测变体, got %v", got)
	}

	// ---- guessPageVariants：变体/去重/边界 ----
	got := guessPageVariants("https://s.example/list", 2)
	if len(got) != 2 || got[0] != "https://s.example/list?page=2" || got[1] != "https://s.example/list/page/2" {
		t.Errorf("基础猜测变体错误: %v", got)
	}
	// 既有 query 保留（变体一 set 语义）；变体二 search 清空
	got = guessPageVariants("https://s.example/list?a=b", 3)
	if len(got) != 2 || got[0] != "https://s.example/list?a=b&page=3" || got[1] != "https://s.example/list/page/3" {
		t.Errorf("query 保留变体错误: %v", got)
	}
	// query 形态与 path 形态重合时去重（?page=k 已存在 → set 覆盖同值 → 变体一，
	// 变体二 path 不同仍两元素；去重逻辑以 [..new Set] 语义锁定为输出无重复）
	got = guessPageVariants("https://s.example/list?page=1", 2)
	if len(got) < 1 || got[0] != "https://s.example/list?page=2" {
		t.Errorf("既有 page 参数应被 set 覆盖: %v", got)
	}
	seen := map[string]bool{}
	for _, u := range got {
		if seen[u] {
			t.Errorf("变体含重复项: %v", got)
		}
		seen[u] = true
	}
	// 裸域（空 path）→ JS pathname 恒 "/" 起
	got = guessPageVariants("https://s.example", 2)
	if len(got) < 1 || got[0] != "https://s.example/?page=2" {
		t.Errorf("裸域变体应补根斜杠: %v", got)
	}
	// 尾斜杠路径 → /page/k 前先去尾斜杠
	got = guessPageVariants("https://s.example/list/", 2)
	if len(got) != 2 || got[1] != "https://s.example/list/page/2" {
		t.Errorf("尾斜杠路径变体错误: %v", got)
	}
	// 相对/非法 URL（JS new URL 抛异常分支）→ 字符串拼接兜底，零 panic
	got = guessPageVariants("relative/path", 2)
	if len(got) != 2 || got[0] != "relative/path?page=2" || got[1] != "relative/path/page/2" {
		t.Errorf("相对 URL 兜底分支错误: %v", got)
	}
	got = guessPageVariants("relative/path?x=1", 2)
	if len(got) != 2 || got[0] != "relative/path?x=1&page=2" {
		t.Errorf("相对 URL 带 query 兜底分支错误: %v", got)
	}
	// 空 URL：JS 侧同属异常分支 → 拼接兜底，零 panic
	got = guessPageVariants("", 2)
	if len(got) != 2 || got[0] != "?page=2" {
		t.Errorf("空 URL 兜底分支错误: %v", got)
	}
	// 0/负数/超界页码：纯字符串替换语义，零 panic、输出确定（页码合法性由调用方钳制）
	for _, k := range []int{0, -1, 1 << 30} {
		if got := guessPageVariants("https://s.example/list", k); len(got) != 2 {
			t.Errorf("k=%d 应稳定产出 2 变体, got %v", k, got)
		}
		if got := buildPageVariants(tpl, "https://s.example/list", k); len(got) != 1 {
			t.Errorf("k=%d 模板模式应稳定产出 1 变体, got %v", k, got)
		}
	}
}
