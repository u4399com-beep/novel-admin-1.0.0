/**
 * urlstyle.go —— R162 伪静态方案（用户指令：在站群设置中加入伪静态设置，并预设 18 种方案）。
 *
 * 出站生成 + 入站宽容双轨：
 *   - 出站：bookURL/chapterURL/catURL/tocURL 模板函数按当前站点档案 urlStyle 生成对应
 *     形态（renderPage 对缓存模板 Clone+Funcs 覆盖注入，见 web.go——tplCache 命中零开销，
 *     仅非默认方案才 Clone）；方案未覆盖的页面族（home/list/search/pseo）保持原形态。
 *   - 入站：dispatch 对每段剥 .html/.htm 尾（任意历史/新形态均命中既有段路由）+
 *     init() 循环注册 18 方案的前缀别名路由（book 独立段/嵌套章节两段/独立章节/分类）。
 *
 * 章节链接的双形态语义：
 *   - 独立式（{cid}）：chapterURL 单参（章节 id）直出；
 *   - 嵌套式（{id}/{cid}）：需要书 id——书页族（book/chapter/toc）模板的 data["Novel"].id
 *     即当前书（renderPage 闭包捕获，见 web.go）；pseo 等跨书页面无书上下文时回退
 *     /chapter/{cid} 原形态（入站宽容恒可达，SEO 无损）。
 *
 * 站群语义：SiteSetting.urlStyle（默认站点）+ SiteSite.urlStyle（每站点独立，列由
 * db.go ensureColumn 幂等添加）；越界/缺省一律回落方案 1（原始动态形态，零回归）。
 */
package main

import (
	"strconv"
	"strings"
	"text/template"
)

// defaultURLStyle 方案 1 = 原始动态形态（/book/{id} 等），全站默认且越界兜底值。
const defaultURLStyle = 1

// urlStyleDef 单套伪静态方案：四类页面的 URL 模板。
// 占位符：{id}=书 id，{cid}=章节 id，{cat}=分类 id，{id}=嵌套式章节模板中的书 id。
// 章节模板两种形态：独立式（仅 {cid}）与嵌套式（含 {id}）。
type urlStyleDef struct {
	id       int
	name     string
	desc     string
	book     string
	chapter  string
	toc      string
	category string
}

// urlStyles 18 种预设方案（用户指令数量）。
// 设计维度：前缀词（book/xiaoshuo/shuku/novel/read/b/shucheng/geguan/jingpin/wenxue/m）
// × 后缀（无/.html/.htm/尾斜杠/index.html）× 章节形态（独立式/书内嵌套）
// × 分类前缀（category/sort/fenlei）——均为真实小说站常见结构，互异且可组合。
var urlStyles = []urlStyleDef{
	{1, "默认动态", "/book/12、/chapter/345、/book/12/toc、/category/7", "/book/{id}", "/chapter/{cid}", "/book/{id}/toc", "/category/{cat}"},
	{2, "经典伪静态", "/book/12.html、/chapter/345.html", "/book/{id}.html", "/chapter/{cid}.html", "/book/{id}/toc.html", "/category/{cat}.html"},
	{3, "目录式斜杠", "/book/12/、/chapter/345/", "/book/{id}/", "/chapter/{cid}/", "/book/{id}/toc/", "/category/{cat}/"},
	{4, "书内章节", "/book/12.html、章节 /book/12/345.html", "/book/{id}.html", "/book/{book}/{cid}.html", "/book/{id}/index.html", "/category/{cat}.html"},
	{5, "书内目录式", "/book/12/、章节 /book/12/345.html", "/book/{id}/", "/book/{book}/{cid}.html", "/book/{id}/", "/category/{cat}"},
	{6, "小说站", "/xiaoshuo/12.html", "/xiaoshuo/{id}.html", "/xiaoshuo/{book}/{cid}.html", "/xiaoshuo/{id}/", "/category/{cat}.html"},
	{7, "书库站", "/shuku/12.html", "/shuku/{id}.html", "/shuku/{book}/{cid}.html", "/shuku/{id}/", "/shuku/sort/{cat}.html"},
	{8, "英文站", "/novel/12.html", "/novel/{id}.html", "/novel/{book}/{cid}.html", "/novel/{id}/", "/novel/sort/{cat}.html"},
	{9, "阅读风", "/read/12、章节 /chapter/345", "/read/{id}", "/chapter/{cid}", "/read/{id}/toc", "/sort/{cat}"},
	{10, "短链风", "/b/12、章节 /c/345", "/b/{id}", "/c/{cid}", "/b/{id}/toc", "/fenlei/{cat}"},
	{11, "书页索引页", "/book/12/index.html", "/book/{id}/index.html", "/chapter/{cid}.html", "/book/{id}/", "/category/{cat}.html"},
	{12, "书城站", "/shucheng/12.html", "/shucheng/{id}.html", "/shucheng/{book}/{cid}.html", "/shucheng/{id}/", "/category/{cat}.html"},
	{13, "阁馆风", "/geguan/12.html", "/geguan/{id}.html", "/geguan/{book}/{cid}.html", "/geguan/{id}/", "/geguan/sort/{cat}.html"},
	{14, "精品站", "/jingpin/12.html", "/jingpin/{id}.html", "/jingpin/{book}/{cid}.html", "/jingpin/{id}/", "/jingpin/sort/{cat}.html"},
	{15, "htm 后缀", "/book/12.htm", "/book/{id}.htm", "/chapter/{cid}.htm", "/book/{id}/toc.htm", "/category/{cat}.htm"},
	{16, "文学站", "/wenxue/12.html", "/wenxue/{id}.html", "/wenxue/{book}/{cid}.html", "/wenxue/{id}/", "/wenxue/sort/{cat}.html"},
	{17, "双层目录", "/book/12/、章节 /book/12/read/345.html", "/book/{id}/", "/book/{book}/read/{cid}.html", "/book/{id}/list.html", "/category/{cat}/"},
	{18, "手机站", "/m/12.html", "/m/{id}.html", "/m/{book}/{cid}.html", "/m/{id}/", "/category/{cat}.html"},
}

// urlStyleByID 方案号 → 定义；越界/未知名回落方案 1（原始形态，越界兜底零回归）。
func urlStyleByID(style int64) urlStyleDef {
	for _, d := range urlStyles {
		if d.id == int(style) {
			return d
		}
	}
	return urlStyles[0]
}

// urlStyleName 方案号 → 中文名（admin 回显/日志用；越界回落方案 1 名）。
func urlStyleName(style int64) string {
	return urlStyleByID(style).name
}

// urlStyleChapterNested 章节模板是否嵌套式（含 {id} 占位）。
func urlStyleChapterNested(d urlStyleDef) bool {
	return strings.Contains(d.chapter, "{book}")
}

// fillTmpl URL 模板占位符替换（不存在的占位符原样保留——防御性，调用方保证键集）。
func fillTmpl(tpl string, kv map[string]string) string {
	for k, v := range kv {
		tpl = strings.ReplaceAll(tpl, "{"+k+"}", v)
	}
	return tpl
}

// urlStyleFuncs 方案 + 当前书上下文 → URL 生成模板函数族（renderPage Clone+Funcs
// 覆盖注入；curBook 供嵌套式 chapterURL 取书 id，无上下文回退 /chapter/{cid} 原形态）。
// pseoURL/searchURL 不在本族（方案未覆盖页面族保持原形态，见文件头）。
func urlStyleFuncs(style int64, curBook int64) template.FuncMap {
	d := urlStyleByID(style)
	num := func(v any) string { return strconv.FormatInt(toInt64(v), 10) }
	return template.FuncMap{
		"bookURL": func(v any) string {
			return fillTmpl(d.book, map[string]string{"id": num(v)})
		},
		// chapterURL 章节链接：独立式单参直出；嵌套式需书上下文（data["Novel"].id，
		// renderPage 闭包捕获）——无上下文（pseo 等跨书页面）回退 /chapter/{cid} 原形态。
		"chapterURL": func(v any) string {
			cid := num(v)
			if urlStyleChapterNested(d) {
				if curBook > 0 {
					return fillTmpl(d.chapter, map[string]string{"book": strconv.FormatInt(curBook, 10), "cid": cid})
				}
				return "/chapter/" + cid
			}
			return fillTmpl(d.chapter, map[string]string{"cid": cid})
		},
		"catURL": func(v any) string {
			return fillTmpl(d.category, map[string]string{"cat": num(v)})
		},
		"tocURL": func(v any) string {
			return fillTmpl(d.toc, map[string]string{"id": num(v)})
		},
	}
}

// stripStaticExt 入站段尾伪静态后缀剥离（.html/.htm，大小写宽容）。
// "123.html"→"123"、"search.html"→"search"、"foo.bar.html"→"foo.bar"；
// 无尾缀段原样返回。仅剥一次尾（防 1.html.html 二次剥离攻击面——多剥也无害，
// id 解析非数字即 404）。
func stripStaticExt(seg string) string {
	low := strings.ToLower(seg)
	for _, ext := range []string{".html", ".htm"} {
		if strings.HasSuffix(low, ext) {
			return seg[:len(seg)-len(ext)]
		}
	}
	return seg
}

// urlStyleAliasPrefixes 18 方案涉及的全部出站前缀池（去重）。
// book 独立段别名 + 嵌套章节两段别名共用同一池；独立章节别名 /c 与分类别名 /sort /fenlei 单列。
var (
	urlStyleBookPrefixes = []string{"book", "xiaoshuo", "shuku", "novel", "read", "b", "shucheng", "geguan", "jingpin", "wenxue", "m"}
	urlStyleCatAliases   = []string{"sort", "fenlei"}
)

// init R162：伪静态别名路由注册（api_*.go init() 自注册先例——main.go 无需感知）。
func init() {
	registerURLStyleAliases()
}

// registerURLStyleAliases init 注册入站别名路由（R162 伪静态双轨的宽容面）：
//   - {prefix}/{id}   → 书页（book 原生 + 10 别名）
//   - {prefix}/{id}/{cid} → 嵌套式章节页（校验章节归属书后复用渲染）
//   - /c/{cid}        → 独立式章节别名（方案 10）
//   - /sort/{cat} /fenlei/{cat} → 分类别名（方案 7/8/9/10/13/14/16）
//
// 静态段优先语义（dispatch 既有）保证 /book/{id}/toc 静态尾段优先于嵌套 {cid} 参数段。
func registerURLStyleAliases() {
	// 书页 + 嵌套章节（book 原生书路由已在 web.go 注册，嵌套两段此处统一注册）
	for _, p := range urlStyleBookPrefixes {
		if p != "book" {
			register("GET", "/"+p+"/{id}", handleWebBook)
		}
		register("GET", "/"+p+"/{id}/{cid}", handleWebChapterNested)
	}
	register("GET", "/c/{cid}", handleWebChapter)
	for _, p := range urlStyleCatAliases {
		register("GET", "/"+p+"/{cat}", handleWebCategory)
	}
}

// urlStyleOptionList admin 下拉数据源（id/name/desc 三键；id 恒 int64 与
// adminSettings.urlStyle 回显同类型，html/template eq 比较同型成立）。
func urlStyleOptionList() []map[string]any {
	out := make([]map[string]any, 0, len(urlStyles))
	for _, d := range urlStyles {
		out = append(out, map[string]any{"id": int64(d.id), "name": d.name, "desc": d.desc})
	}
	return out
}
