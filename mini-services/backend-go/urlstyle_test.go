/**
 * urlstyle_test.go —— R162 伪静态方案单测。
 *
 * 覆盖面：18 方案定义完整性（id 连续/四模板占位符合法）、越界兜底、生成器 golden
 * （各形态书/章节[嵌套含无书上下文回退]/分类/目录）、入站段尾剥离、admin 下拉数据源
 * 同型、请求体清洗，以及 **Clone+Funcs 覆盖语义**（renderPage 伪静态注入的机制前提——
 * html/template Clone 后同名 Funcs 覆盖必须在 Execute 生效，用最小模板实锤防 Go 版本
 * 行为漂移）。
 */
package main

import (
	"bytes"
	"strings"
	"testing"
	"text/template"
)

// TestURLStylesDefinition 18 方案完整性：数量/id 连续/四模板非空/占位符白名单。
func TestURLStylesDefinition(t *testing.T) {
	if len(urlStyles) != 18 {
		t.Fatalf("方案数量应为 18（用户指令），实际 %d", len(urlStyles))
	}
	for i, d := range urlStyles {
		if d.id != i+1 {
			t.Fatalf("方案 id 应连续 1-18，第 %d 项 id=%d", i, d.id)
		}
		if d.name == "" {
			t.Fatalf("方案 %d 名称缺失", d.id)
		}
		for kind, tpl := range map[string]string{"book": d.book, "chapter": d.chapter, "toc": d.toc, "category": d.category} {
			if tpl == "" {
				t.Fatalf("方案 %d 的 %s 模板为空", d.id, kind)
			}
			if !strings.HasPrefix(tpl, "/") {
				t.Fatalf("方案 %d 的 %s 模板未以 / 开头: %s", d.id, kind, tpl)
			}
			// 占位符白名单校验（防手滑写出未知占位符导致生成泄漏 {xxx} 原文）
			clean := tpl
			for _, ph := range []string{"{id}", "{cid}", "{cat}", "{book}"} {
				clean = strings.ReplaceAll(clean, ph, "")
			}
			if strings.Contains(clean, "{") || strings.Contains(clean, "}") {
				t.Fatalf("方案 %d 的 %s 模板含非法占位符: %s", d.id, kind, tpl)
			}
		}
		// 嵌套式章节模板必须含 {book}+{cid}；独立式禁止 {book}（生成器分支依据）
		if strings.Contains(d.chapter, "{book}") && !strings.Contains(d.chapter, "{cid}") {
			t.Fatalf("方案 %d 嵌套章节模板缺 {cid}: %s", d.id, d.chapter)
		}
	}
}

// TestURLStyleByIDFallback 越界/零值回落方案 1（零回归兜底语义）。
func TestURLStyleByIDFallback(t *testing.T) {
	for _, bad := range []int64{0, -1, 19, 999} {
		if got := urlStyleByID(bad); got.id != defaultURLStyle {
			t.Fatalf("越界方案 %d 应回落方案 %d，实际 %d", bad, defaultURLStyle, got.id)
		}
	}
	if got := urlStyleByID(4); got.book != "/book/{id}.html" {
		t.Fatalf("方案 4 书模板不符: %s", got.book)
	}
}

// TestNormalizeURLStyle admin 回显归一。
func TestNormalizeURLStyle(t *testing.T) {
	if normalizeURLStyle(0) != 1 || normalizeURLStyle(-5) != 1 || normalizeURLStyle(99) != 1 {
		t.Fatalf("越界应归一 1")
	}
	if normalizeURLStyle(7) != 7 {
		t.Fatalf("合法值应透传")
	}
}

// TestURLStyleFuncsGolden 生成器 golden：各形态出站 URL。
func TestURLStyleFuncsGolden(t *testing.T) {
	cases := []struct {
		style   int64
		book    string
		chapter string // 独立式断言（无书上下文场景）
		cat     string
		toc     string
	}{
		{1, "/book/12", "/chapter/345", "/category/7", "/book/12/toc"},
		{2, "/book/12.html", "/chapter/345.html", "/category/7.html", "/book/12/toc.html"},
		{3, "/book/12/", "/chapter/345/", "/category/7/", "/book/12/toc/"},
		{10, "/b/12", "/c/345", "/fenlei/7", "/b/12/toc"},
		{15, "/book/12.htm", "/chapter/345.htm", "/category/7.htm", "/book/12/toc.htm"},
		{18, "/m/12.html", "/chapter/345", "/category/7.html", "/m/12/"}, // 嵌套式无书上下文 → 章节回退 /chapter/{cid}
	}
	for _, c := range cases {
		f := urlStyleFuncs(c.style, 0)
		bookURL := f["bookURL"].(func(any) string)
		chapterURL := f["chapterURL"].(func(any) string)
		catURL := f["catURL"].(func(any) string)
		tocURL := f["tocURL"].(func(any) string)
		if got := bookURL(int64(12)); got != c.book {
			t.Fatalf("方案 %d bookURL: 期望 %s 实际 %s", c.style, c.book, got)
		}
		if got := chapterURL(int64(345)); got != c.chapter {
			t.Fatalf("方案 %d chapterURL(无书): 期望 %s 实际 %s", c.style, c.chapter, got)
		}
		if got := catURL(int64(7)); got != c.cat {
			t.Fatalf("方案 %d catURL: 期望 %s 实际 %s", c.style, c.cat, got)
		}
		if got := tocURL(int64(12)); got != c.toc {
			t.Fatalf("方案 %d tocURL: 期望 %s 实际 %s", c.style, c.toc, got)
		}
	}
}

// TestURLStyleFuncsNestedChapter 嵌套式章节：有书上下文出嵌套形态，无上下文回退原形态。
func TestURLStyleFuncsNestedChapter(t *testing.T) {
	f := urlStyleFuncs(4, 12) // 方案 4 书内章节 + 当前书 12
	chapterURL := f["chapterURL"].(func(any) string)
	if got := chapterURL(int64(345)); got != "/book/12/345.html" {
		t.Fatalf("方案 4 嵌套章节（书 12）: 期望 /book/12/345.html 实际 %s", got)
	}
	f0 := urlStyleFuncs(4, 0) // pseo 等跨书页面：无书上下文
	chapterURL0 := f0["chapterURL"].(func(any) string)
	if got := chapterURL0(int64(345)); got != "/chapter/345" {
		t.Fatalf("方案 4 无书上下文: 期望 /chapter/345 实际 %s", got)
	}
	// 方案 17 双层目录形态
	f17 := urlStyleFuncs(17, 99)
	chURL17 := f17["chapterURL"].(func(any) string)
	if got := chURL17(int64(345)); got != "/book/99/read/345.html" {
		t.Fatalf("方案 17 嵌套章节（书 99）: 期望 /book/99/read/345.html 实际 %s", got)
	}
}

// TestURLStyleFuncsTemplateExec 生成函数族在模板管道中可用（int64/字符串占位混合场景）。
func TestURLStyleFuncsTemplateExec(t *testing.T) {
	tpl := template.Must(template.New("t").Funcs(urlStyleFuncs(2, 0)).Parse(
		`{{bookURL .id}}|{{chapterURL .cid}}|{{catURL .cat}}`))
	var buf bytes.Buffer
	if err := tpl.Execute(&buf, map[string]any{"id": int64(5), "cid": int64(6), "cat": int64(7)}); err != nil {
		t.Fatalf("模板执行失败: %v", err)
	}
	if got := buf.String(); got != "/book/5.html|/chapter/6.html|/category/7.html" {
		t.Fatalf("模板管道输出不符: %s", got)
	}
}

// TestStripStaticExt 入站段尾剥离。
func TestStripStaticExt(t *testing.T) {
	cases := []struct{ in, want string }{
		{"123.html", "123"},
		{"123.htm", "123"},
		{"123.HTML", "123"},
		{"search.html", "search"},
		{"foo.bar.html", "foo.bar"},
		{"toc.html", "toc"},
		{"book", "book"},
		{"123", "123"},
		{"123.htmlx", "123.htmlx"}, // 非后缀尾不剥
		{"", ""},
	}
	for _, c := range cases {
		if got := stripStaticExt(c.in); got != c.want {
			t.Fatalf("stripStaticExt(%q): 期望 %q 实际 %q", c.in, c.want, got)
		}
	}
}

// TestCloneFuncsOverride 机制前提实锤：html/template Clone 后同名 Funcs 覆盖必须在
// Execute 生效（renderPage 伪静态注入依赖此语义；Go 版本行为漂移时本测试最先报警）。
func TestCloneFuncsOverride(t *testing.T) {
	base := template.Must(template.New("t").Funcs(template.FuncMap{
		"bookURL": func(v any) string { return "/book/" + v.(string) },
	}).Parse(`[{{bookURL .}}]`))
	// 缓存原版执行 = 默认形态
	var buf bytes.Buffer
	if err := base.Execute(&buf, "12"); err != nil || buf.String() != "[/book/12]" {
		t.Fatalf("缓存原版执行不符: %s err=%v", buf.String(), err)
	}
	// Clone + 覆盖 = 新形态
	t2, err := base.Clone()
	if err != nil {
		t.Fatalf("Clone 失败: %v", err)
	}
	t2.Funcs(template.FuncMap{"bookURL": func(v any) string { return "/xiaoshuo/" + v.(string) + ".html" }})
	buf.Reset()
	if err := t2.Execute(&buf, "12"); err != nil || buf.String() != "[/xiaoshuo/12.html]" {
		t.Fatalf("Clone 覆盖未生效: %s err=%v", buf.String(), err)
	}
	// 原版不受影响（tplCache 本体不动语义）
	buf.Reset()
	if err := base.Execute(&buf, "34"); err != nil || buf.String() != "[/book/34]" {
		t.Fatalf("Clone 后原版被污染: %s", buf.String())
	}
}

// TestURLStyleOptionList admin 下拉数据源：18 项 + id 与回显同型（int64）。
func TestURLStyleOptionList(t *testing.T) {
	list := urlStyleOptionList()
	if len(list) != 18 {
		t.Fatalf("下拉数据源应 18 项，实际 %d", len(list))
	}
	for i, m := range list {
		id, ok := m["id"].(int64)
		if !ok || id != int64(i+1) {
			t.Fatalf("下拉第 %d 项 id 类型/值不符: %v", i, m["id"])
		}
		if m["name"].(string) == "" || m["desc"].(string) == "" {
			t.Fatalf("下拉第 %d 项 name/desc 缺失", i)
		}
	}
}

// TestURLStyleFromBody 请求体清洗：JSON 数字/字符串/非法值三路。
func TestURLStyleFromBody(t *testing.T) {
	if n, ok := urlStyleFromBody(map[string]any{"urlStyle": float64(7)}); !ok || n != 7 {
		t.Fatalf("float64 7 应通过: %d %v", n, ok)
	}
	if n, ok := urlStyleFromBody(map[string]any{"urlStyle": "4"}); !ok || n != 4 {
		t.Fatalf("字符串 4 应通过: %d %v", n, ok)
	}
	for _, bad := range []any{float64(0), float64(19), float64(-1), "abc", true, nil} {
		if _, ok := urlStyleFromBody(map[string]any{"urlStyle": bad}); ok {
			t.Fatalf("非法值 %v 不应通过", bad)
		}
	}
	if _, ok := urlStyleFromBody(map[string]any{}); ok {
		t.Fatalf("键缺失不应通过")
	}
}

// TestURLStyleAliasesRegistered 别名路由注册完整性（书前缀 ×[独立+嵌套] + 独立章节 + 分类）。
func TestURLStyleAliasesRegistered(t *testing.T) {
	want := map[string]bool{}
	for _, p := range urlStyleBookPrefixes {
		if p != "book" {
			want["GET "+p+"/{id}"] = true
		}
		want["GET "+p+"/{id}/{cid}"] = true
	}
	want["GET c/{cid}"] = true
	for _, p := range urlStyleCatAliases {
		want["GET "+p+"/{cat}"] = true
	}
	got := map[string]bool{}
	for _, r := range routes {
		got[r.method+" "+strings.Join(r.segs, "/")] = true
	}
	for k := range want {
		if !got[k] {
			t.Fatalf("别名路由缺失: %s", k)
		}
	}
}
