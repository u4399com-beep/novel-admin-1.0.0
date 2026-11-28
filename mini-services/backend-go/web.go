/**
 * web.go —— 全 Go 化页面渲染层（取消 Next.js 前端后的唯一页面出口）。
 *
 * 架构（Task 24）：
 *   用户预览 → Caddy:81 → Next:3000（catch-all 纯代理）→ backend-go:3005
 *     ├─ /api/*            业务 API（api_*.go，不变）
 *     ├─ 页面路由（本文件）：/ /category/{id} /book/{id} /book/{id}/toc
 *     │   /chapter/{id} /search /pseo/{kw} /admin /robots.txt /sitemap.xml
 *     ├─ /static/*         web/static（tw.css 主题样式 + js）
 *     └─ /covers/*         public/covers（采集封面落盘目录）
 *
 * 模板契约：
 *   web/templates/{theme}/_shared.html   —— define "layout"（html 骨架/导航/页脚）
 *   web/templates/{theme}/{page}.html    —— define "content"（页面主体）
 *   page ∈ {home, category, book, toc, chapter, search, pseo}
 *   渲染 = parse([_shared.html, {page}.html]) → ExecuteTemplate("layout", data)
 *   主题缺失/渲染失败 → _fallback 主题兜底（保证永不白屏）。
 *
 * 模板数据契约（详见 web_data.go 各 gather 函数；novel map 字段与 novelListCols 一致）：
 *   通用: .Site{siteName,notice,activeTheme} .Nav[]{id,name,sort,novelCount} .Footer{...}
 *   home: .Featured .Hot .Latest .RankClicks .RankUpdates .RankFinished .Stats .HomeBlocks
 *   category: .Category{id,name} .Novels .FeaturedBlock .HotBlock .Stats
 *   book: .Novel .Tags .Chapters .LastChapter .Related .CategoryName
 *   toc: .Novel .Chapters
 *   chapter: .Chapter{...Paragraphs} .Novel .Prev .Next
 *   search: .Q .Novels .Total
 *   pseo: .Keyword .Description .Novels
 *   admin: .Rules .Tasks .Categories .Novels .Settings .Pseo .Themes .Stats
 *
 * 合规红线：所有数据均来自本站 DB；模板输出经 html/template 自动转义。
 */
package main

import (
	"database/sql"
	"fmt"
	"html/template"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// webRoot 页面渲染资源根（web/ 模板+静态资源）：WEB_ROOT env > 可执行文件同级 web >
// 沙箱默认（paths.go 解析链；沙箱内推出值与旧硬编码一致，测试二进制走兑底同值）。
var webRoot = resolveWebRoot()
var templatesRoot = filepath.Join(webRoot, "templates")

// fallbackTheme 模板缺失/渲染失败时的兜底主题
const fallbackTheme = "_fallback"

// themeNames admin 主题切换下拉的可选清单（与 src/themes registry 对齐）
// R98 追加 ncnd（克隆 ncnd.net「gelin」版式，纯手写 CSS 自包含）
// R140 追加 jiuxiao（复刻 jiuxiaozw.com 暖纸色+朱砂红设计体系，日/夜双主题，轮播/书单/点击榜对齐原站信息架构）
// R142 追加 jiuxiaozw（jiuxiaozw.com 像素级克隆：原站全量 CSS chunk 拼接包+原站类名体系 dn-*/mh-*/rl-*/book-*/reader-*，与 jiuxiao 并行独立互不影响）
var themeNames = []string{"aijjxs", "pilishuwu", "ddyueshu", "shipsay", "x2552", "trxsw", "23qb", "101kks", "huangjinwu", "ggd66", "ncnd", "washai", "jiuxiao", "jiuxiaozw"}

// isKnownTheme 主题白名单校验（?theme= 预览参数防路径穿越）
func isKnownTheme(t string) bool {
	for _, n := range themeNames {
		if n == t {
			return true
		}
	}
	return false
}

// ---------- 模板函数 ----------

// staticVer 静态资源缓存穿透版本号（R108）：进程启动毫秒时间戳——每次部署/重启自动
// 变化，模板里 {{staticVer}} 拼到 /static/** 引用后浏览器缓存立即失效，杜绝「发新版
// 页面仍旧 JS」问题（admin 新按钮不出现即此根因）。同进程内恒定，URL 稳定可复用缓存。
var staticVer = strconv.FormatInt(nowMillis(), 10)

func webFuncMap() template.FuncMap {
	return template.FuncMap{
		// staticVer 静态资源版本号（见上）
		"staticVer": func() string { return staticVer },
		// wcFmt 字数格式化：12345 → 1.2万字；890 → 890字
		"wcFmt": func(v any) string {
			n := toInt64(v)
			if n <= 0 {
				return "0字"
			}
			if n >= 10000 {
				w := float64(n) / 10000.0
				s := strconv.FormatFloat(w, 'f', 1, 64)
				s = strings.TrimSuffix(s, ".0")
				return s + "万字"
			}
			return strconv.FormatInt(n, 10) + "字"
		},
		// dateFmt 毫秒时间戳 → MM-DD（零值返回空串；Task 28: 同 fullFmt 兼容 ISO 字符串输入）
		"dateFmt": func(v any) string {
			if s, ok := v.(string); ok {
				s = strings.TrimSpace(s)
				if s == "" {
					return ""
				}
				if ms, err := strconv.ParseInt(s, 10, 64); err == nil {
					if ms > 0 {
						return time.UnixMilli(ms).Format("01-02")
					}
					return ""
				}
				if t, err := time.Parse(time.RFC3339, s); err == nil {
					return t.Format("01-02")
				}
				return s
			}
			ms := toInt64(v)
			if ms <= 0 {
				return ""
			}
			return time.UnixMilli(ms).Format("01-02")
		},
		// fullFmt 毫秒时间戳 → 2006-01-02（Task 28: 兼容 ISO 字符串——scanNovelListItem
		// 把 updatedAt 以 RFC3339 字符串传入模板，旧版 toInt64 对其返回 0 → 页面「更新时间：」空）
		"fullFmt": func(v any) string {
			if s, ok := v.(string); ok {
				s = strings.TrimSpace(s)
				if s == "" {
					return ""
				}
				if ms, err := strconv.ParseInt(s, 10, 64); err == nil {
					if ms > 0 {
						return time.UnixMilli(ms).Format("2006-01-02")
					}
					return ""
				}
				if t, err := time.Parse(time.RFC3339, s); err == nil {
					return t.Format("2006-01-02")
				}
				return s
			}
			ms := toInt64(v)
			if ms <= 0 {
				return ""
			}
			return time.UnixMilli(ms).Format("2006-01-02")
		},
		// gcls 封面渐变类：渐变 token（g1-g12）→ 原生 CSS 类名（样式见
		// web/static/css/cover-gradients.css）；本地封面返回空串
		"gcls": func(cover any) string {
			s, _ := cover.(string)
			if strings.HasPrefix(s, "/covers/") {
				return ""
			}
			return gradientTokenClass(s)
		},
		// isLocalCover cover 是否本地封面路径（模板决定渲染 <img> 还是渐变块）
		"isLocalCover": func(cover any) bool {
			s, _ := cover.(string)
			return strings.HasPrefix(s, "/covers/")
		},
		// coverSrc 封面 URL 确定性派生（R98 防张冠李戴）：本地封面路径一律以
		// 书籍 ID 重写为 /covers/{id}.jpg（存储层命名即 {id}.jpg，见 coversx.go
		// fetchAndStoreCover），DB cover 字段即使被写坏（旧库残留/人工误改指向
		// 他人文件）也不会在前台展示成别的书的封面；渐变 token 原样返回（渲染层
		// 走 gcls 渐变块）。新模板一律 coverSrc .id .cover，不直引 .cover。
		"coverSrc": func(id, cover any) string {
			s, _ := cover.(string)
			if strings.HasPrefix(s, "/covers/") {
				return "/covers/" + strconv.FormatInt(toInt64(id), 10) + ".jpg"
			}
			return s
		},
		// excerpt 文本截断（ rune 安全 ）
		"excerpt": func(v any, n int) string {
			s, _ := v.(string)
			return excerptN(s, n)
		},
		// title0 书名首字（渐变封面占位字）
		"title0": func(v any) string {
			s, _ := v.(string)
			r := []rune(strings.TrimSpace(s))
			if len(r) == 0 {
				return "书"
			}
			return string(r[0])
		},
		// pseoURL 关键词 → /pseo/{escaped}
		"pseoURL": func(kw string) string {
			return "/pseo/" + url.PathEscape(kw)
		},
		// catURL / bookURL / chapterURL / tocURL / searchURL 页面链接
		// （R162：此处为方案 1 默认形态基线；非默认伪静态方案由 renderPage
		// Clone+Funcs 覆盖为 urlStyleFuncs 生成，tplCache 原版不动）
		"catURL":     func(v any) string { return "/category/" + strconv.FormatInt(toInt64(v), 10) },
		"bookURL":    func(v any) string { return "/book/" + strconv.FormatInt(toInt64(v), 10) },
		"chapterURL": func(v any) string { return "/chapter/" + strconv.FormatInt(toInt64(v), 10) },
		"tocURL":     func(v any) string { return "/book/" + strconv.FormatInt(toInt64(v), 10) + "/toc" },
		"searchURL":  func(q string) string { return "/search?q=" + url.QueryEscape(q) },
		"add":        func(a, b any) int64 { return toInt64(a) + toInt64(b) },
		"sub":        func(a, b any) int64 { return toInt64(a) - toInt64(b) },
		// trimSuffixStr 模板字符串后缀裁剪（长尾词去站点后缀等）
		"trimSuffixStr": strings.TrimSuffix,
		// statSplit 数值/单位分离（R150 书籍页源站同款 value+small 排版）：
		// ≥1万 → ["1.2", big]（万进制 x.x 去尾零），否则 ["856", small]。
		// 用法 {{$p := statSplit $n.wordCount "万字" "字"}} → {{index $p 0}}/{{index $p 1}}
		"statSplit": func(v any, big, small string) []string {
			n := toInt64(v)
			if n >= 10000 {
				s := strconv.FormatFloat(float64(n)/10000.0, 'f', 1, 64)
				return []string{strings.TrimSuffix(s, ".0"), big}
			}
			return []string{strconv.FormatInt(n, 10), small}
		},
		// dict 模板内联键值对 → map（R142 jiuxiaozw 主题子模板参数打包；html/template 无 map 字面量）
		"dict": func(kv ...any) map[string]any {
			m := map[string]any{}
			for i := 0; i+1 < len(kv); i += 2 {
				if k, ok := kv[i].(string); ok {
					m[k] = kv[i+1]
				}
			}
			return m
		},
		// slice3 novel map 列表切片 [from:]（首页小编精选跳过轮播前 3；越界安全返回 nil）
		"slice3": func(v any, from int) []map[string]any {
			list, ok := v.([]map[string]any)
			if !ok || from < 0 || from >= len(list) {
				return nil
			}
			return list[from:]
		},
		// idx 列表按下标取元素（书籍页取首章 id 等；越界/类型不匹配安全返回 nil）
		// R160: T/Tf 前台 UI chrome 多语种模板函数（字典在 webi18n.go；T=纯词组，Tf={0} 占位符替换）
		"T":  tmplT,
		"Tf": tmplTf,
		// R160: 语种感知数字格式化（字数/人气值；en 千进制 k，ja/ko/zh-Hant 万进制本地单位）
		"wcFmtL": wcFmtL,
		"popL":   popL,
		"idx": func(v any, i int) any {
			switch l := v.(type) {
			case []map[string]any:
				if i >= 0 && i < len(l) {
					return l[i]
				}
			case []any:
				if i >= 0 && i < len(l) {
					return l[i]
				}
			case []string:
				if i >= 0 && i < len(l) {
					return l[i]
				}
			}
			return nil
		},
	}
}

// gradientTokenClass 渐变 token → CSS 类名（g1-g12；样式实体在
// web/static/css/cover-gradients.css，色值与 src/lib/covers.ts GRADIENT_CLASSES 一致）
func gradientTokenClass(token string) string {
	switch token {
	case "g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8", "g9", "g10", "g11", "g12":
		return token
	}
	return "g1"
}

func toInt64(v any) int64 {
	switch x := v.(type) {
	case int64:
		return x
	case int:
		return int64(x)
	case float64:
		return int64(x)
	case string:
		n, _ := strconv.ParseInt(x, 10, 64)
		return n
	}
	return 0
}

// xmlEscape XML 文本转义（Task 36-b：sitemap <loc> 内 PathEscape 不转义 &，
// 采集/手工关键词含 & 时会产出非法 XML 炸掉整个 sitemap；'<'>"'" 理论上已被
// PathEscape 处理，这里一并兜底）。
func xmlEscape(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch r {
		case '&':
			b.WriteString("&amp;")
		case '<':
			b.WriteString("&lt;")
		case '>':
			b.WriteString("&gt;")
		case '"':
			b.WriteString("&quot;")
		case '\'':
			b.WriteString("&apos;")
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// excerptN rune 安全文本截断（funcmap 与 Go 数据装配共用）
func excerptN(s string, n int) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) <= n {
		return strings.TrimSpace(s)
	}
	return string(r[:n]) + "…"
}

// ---------- 模板加载（mtime 缓存） ----------

type tplCacheEntry struct {
	tpl     *template.Template
	modTime time.Time
}

var (
	tplCache sync.Map // key: theme+"/"+page → tplCacheEntry
)

// latestMtime 返回目录内文件的最新修改时间（递归两层足够）
func latestMtime(dir string) time.Time {
	var latest time.Time
	entries, err := os.ReadDir(dir)
	if err != nil {
		return latest
	}
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.IsDir() {
			if sub := latestMtime(filepath.Join(dir, e.Name())); sub.After(latest) {
				latest = sub
			}
			continue
		}
		if info.ModTime().After(latest) {
			latest = info.ModTime()
		}
	}
	return latest
}

// loadPageTemplate parse [_shared.html, {page}.html] 为模板集；返回 nil 表示文件缺失
// loadPageTemplate 默认形态入口（style=1 走 tplCache，与历史行为一致）。
func loadPageTemplate(theme, page string) *template.Template {
	return loadPageTemplateStyled(theme, page, defaultURLStyle)
}

// styleTplCache 非默认伪静态方案的模板缓存（key=theme/page/s{style}）。
// ⚠ 语义铁律（R162 html/template 实锤）：本缓存的模板【永不直接 Execute】——
// html/template 首次 Execute 会 escape 烧定函数集，此后 Clone+同名 Funcs 覆盖
// 不再生效（时序复现测试见 urlstyle 单测）；每次渲染必须 Clone+Funcs(urlStyleFuncs)
// 后 Execute，保持「escape 发生在覆盖之后」的时序。
var styleTplCache sync.Map

// loadPageTemplateStyled 按伪静态方案加载模板：方案 1 = 历史 tplCache 直通；
// 非 1 = styleTplCache（Parse 后未 escape 原版，由 renderPage Clone+覆盖后 Execute）。
// mtime 热更新语义与 tplCache 一致。
func loadPageTemplateStyled(theme, page string, style int64) *template.Template {
	dir := filepath.Join(templatesRoot, theme)
	pageFile := filepath.Join(dir, page+".html")
	if _, err := os.Stat(pageFile); err != nil {
		return nil
	}
	shared := filepath.Join(dir, "_shared.html")
	var files []string
	if _, err := os.Stat(shared); err == nil {
		files = append(files, shared)
	}
	files = append(files, pageFile)

	key := theme + "/" + page
	cache := &tplCache
	if style != defaultURLStyle {
		cache = &styleTplCache
		key = fmt.Sprintf("%s/s%d", key, style)
	}
	mt := latestMtime(dir)
	if v, ok := cache.Load(key); ok {
		if e := v.(tplCacheEntry); !mt.After(e.modTime) {
			return e.tpl
		}
	}
	t, err := template.New(page + ".html").Funcs(webFuncMap()).ParseFiles(files...)
	if err != nil {
		log.Printf("[web] 模板解析失败 %s/%s(style=%d): %v", theme, page, style, err)
		return nil
	}
	cache.Store(key, tplCacheEntry{tpl: t, modTime: mt})
	return t
}

// renderPage 按激活主题渲染页面；支持 ?theme= 预览覆盖（白名单校验防穿越）；
// 主题模板缺失或渲染失败 → _fallback 兜底 → 极简错误页
func renderPage(w http.ResponseWriter, r *http.Request, page string, data map[string]any) {
	theme, _ := data["theme"].(string)
	if theme == "" {
		// Task 30-a: 主题解析走站群 Host 匹配（站点档案决定 theme；未命中回落默认站点）。
		// tplCache key 仍为 theme+"/"+page——主题隔离天然成立，无需改 key。
		// Task 31-d: 站点档案主题同样过白名单（与 webCommon 纵深校验同款，防历史行穿越）。
		if s := resolveSite(r); s != nil && isKnownTheme(s.ActiveTheme) {
			theme = s.ActiveTheme
		}
	}
	// ?theme= 主题预览（仅白名单内主题生效；后台切换/逐主题核查用）。
	// Task 54-b: admin 页跳过预览覆盖——handleWebAdmin 固定 data["theme"]="admin"
	//（模板仅 templates/admin/admin.html 一份），旧逻辑任意 /admin?theme=<白名单主题>
	// 会把主题改写为前台主题 → admin 模板与 _fallback 均无 admin.html → 双 nil →
	// 极简错误页（后台整页 200 丢失；探针实证 175 字节错误页）。与 obfMaybe 的
	// admin 跳过同口径。
	if page != "admin" {
		if q := r.URL.Query().Get("theme"); q != "" && isKnownTheme(q) {
			theme = q
		}
	}
	data["theme"] = theme

	// R160: 前台访客语种判定（判定链/cookie 写回见 langip.go；admin 页保持简体中文——
	// 后台仅管理员使用，不随访客地区漂移）。Lang 供模板 T/Tf 消费，LangAttr 供 <html lang>。
	if page == "admin" {
		data["Lang"] = "zh-CN"
		data["LangAttr"] = "zh-CN"
	} else {
		// cookieWriter 传 nil：geo 判定成功时 handler 装配层已写回偏好 cookie
		//（webLangOfRequest 每请求被 handler+renderPage 各调一次，此处置 nil 防双份 Set-Cookie）
		lang := webLangOfRequest(r, nil)
		data["Lang"] = lang
		data["LangAttr"] = webLangAttrOf(lang)
	}

	// R162: 伪静态出站生成参数——站点档案 urlStyle（默认站点/站群站点各自生效）+ 书页族
	// 当前书上下文（data["Novel"].id，嵌套式章节模板需要；pseo 等跨书页面无 Novel 键 → 0）。
	urStyle := int64(defaultURLStyle)
	if st := settingsFromData(data); st != nil && st.URLStyle > 0 {
		urStyle = st.URLStyle
	}
	urBook := int64(0)
	if m, ok := data["Novel"].(map[string]any); ok {
		urBook = toInt64(m["id"])
	}
	for _, th := range []string{theme, fallbackTheme} {
		t := loadPageTemplateStyled(th, page, urStyle)
		if t == nil {
			continue
		}
		// R162: 非默认方案时 Clone 未 escape 原版并覆盖 URL 函数族（styleTplCache 本体
		// 永不直接 Execute——escape 烧定语义见 loadPageTemplateStyled 注释；Clone 失败
		// 理论不发生，回退默认形态渲染不中断）。
		if urStyle != defaultURLStyle {
			if t2, err2 := t.Clone(); err2 == nil {
				t = t2.Funcs(urlStyleFuncs(urStyle, urBook))
			}
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		var buf strings.Builder
		if err := t.ExecuteTemplate(&buf, "layout", data); err == nil {
			html := buf.String()
			// R164: 渲染出口全站 CJK 清扫（用户指令：只要不是恒简体中文，全站所有文字
			// 都按对应语种翻译显示）——数据面 T/Tf+字典+显式字段管线之后的最后兜底闸：
			// 非 zh-CN 语种凡含汉字的可见文本节点统一走 TranslationCache 管线
			// （命中替换/zh-Hant 同步 OpenCC/en ja ko 异步预热收敛），详见 webi18n_sweep.go。
			// flightBase：章节页与 i18nChapterParas 预热键同键去重不双飞；其它页按 page 隔离。
			if langStr, _ := data["Lang"].(string); langStr != "" && langStr != "zh-CN" {
				fb := "pg|" + page
				if cm, okc := data["Chapter"].(map[string]any); okc {
					if cid := toInt64(cm["id"]); cid > 0 {
						fb = strconv.FormatInt(cid, 10)
					}
				}
				html = i18nSweepHTML(langStr, fb, urBook, html)
			}
			// Task 45-a: 渲染层对抗后置处理（实现唯一权威 obfuscate.go）——页面结构混淆/
			// 关键词转码/干扰注入，视觉与交互零变化；admin 后台页跳过，panic 兜底回原文
			html = obfMaybe(html, page)
			// R190: 客户端动态文字字典注入（主题 JS 运行时注入的 UI 文字绕过服务端
			// sweep——app.js MutationObserver 用同口径字典在客户端补齐；zh-CN 零注入
			// 零载荷；置于 obf 之后防混淆触碰脚本数据）
			if ls, _ := data["Lang"].(string); ls != "" && ls != "zh-CN" {
				dictScript := i18nDictScript(ls)
				if i := strings.LastIndex(html, "</head>"); i >= 0 {
					html = html[:i] + dictScript + html[i:]
				} else {
					html = dictScript + html
				}
			}
			// R139: reader 前端翻译控件已下线（用户指令）；后端翻译链路保留——
			// /api/translate 代理、TranslationCache、translatewarm 预热、TXT 导出 ?lang= 译文替换均不受影响
			_, _ = w.Write([]byte(html))
			return
		} else if th == theme {
			log.Printf("[web] 模板渲染失败 %s/%s: %v（降级 _fallback）", theme, page, err)
			continue
		}
	}
	// 最终兜底：极简 HTML（绝不 500 白屏）——R164 同过语种清扫（直写路径显式接入）
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	name, _ := data["siteName"].(string)
	errHTML := "<!doctype html><html lang=" + webLangAttrOf(webLangOfRequest(r, nil)) + "><meta charset=utf-8><title>" + template.HTMLEscapeString(name) +
		"</title><p style='padding:40px;text-align:center;color:#666'>页面渲染异常，请稍后刷新。</p>"
	if langStr, _ := data["Lang"].(string); langStr != "" && langStr != "zh-CN" {
		errHTML = i18nSweepHTML(langStr, "pg|err", 0, errHTML)
	}
	_, _ = w.Write([]byte(errHTML))
}

// ---------- 路由注册 ----------

func init() {
	register("GET", "/", func(w http.ResponseWriter, r *http.Request, _ map[string]string) { handleWebHome(w, r) })
	register("GET", "/category/{id}", handleWebCategory)
	register("GET", "/list/{kind}", handleWebList) // R145: 首页角标「全部 N 本」真实落点（频道全集分页页）
	register("GET", "/book/{id}", handleWebBook)
	register("GET", "/book/{id}/toc", handleWebToc)
	register("GET", "/chapter/{id}", handleWebChapter)
	register("GET", "/search", func(w http.ResponseWriter, r *http.Request, _ map[string]string) { handleWebSearch(w, r) })
	register("GET", "/pseo/{kw}", handleWebPseo)
	register("GET", "/admin", func(w http.ResponseWriter, r *http.Request, _ map[string]string) { handleWebAdmin(w, r) })
	register("GET", "/robots.txt", func(w http.ResponseWriter, r *http.Request, _ map[string]string) { handleRobots(w, r) })
	register("GET", "/sitemap.xml", func(w http.ResponseWriter, r *http.Request, _ map[string]string) { handleSitemap(w, r) })

	registerPrefix("GET", "/static/", handleStatic)
	registerPrefix("GET", "/covers/", handleCovers)
	registerPrefix("HEAD", "/static/", handleStatic)
	registerPrefix("HEAD", "/covers/", handleCovers)
}

// ---------- 静态资源 ----------

// handleStatic /static/* → web/static（css/js）；防目录穿越，缓存 1h
func handleStatic(w http.ResponseWriter, r *http.Request) {
	rel := strings.TrimPrefix(r.URL.Path, "/static/")
	rel = filepath.Clean("/" + rel) // 防穿越：强制根相对
	abs := filepath.Join(webRoot, "static", rel)
	if !strings.HasPrefix(abs, filepath.Join(webRoot, "static")+string(os.PathSeparator)) {
		http.Error(w, "forbidden", http.StatusForbidden) // R131（staticcheck ST1013）
		return
	}
	st, err := os.Stat(abs)
	if err != nil || st.IsDir() {
		http.Error(w, "not found", 404)
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=3600")
	http.ServeFile(w, r, abs)
}

// handleCovers /covers/{id}.jpg → public/covers/{id}.jpg（与渲染层封面契约一致）
func handleCovers(w http.ResponseWriter, r *http.Request) {
	rel := strings.TrimPrefix(r.URL.Path, "/covers/")
	if rel == "" || strings.Contains(rel, "..") || strings.Contains(rel, "/") {
		http.Error(w, "not found", 404)
		return
	}
	abs := filepath.Join(coversDir(), filepath.Base(rel))
	if _, err := os.Stat(abs); err != nil {
		http.Error(w, "not found", 404)
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeFile(w, r, abs)
}

// ---------- SEO：robots / sitemap ----------

// webBaseURL 站点绝对地址（Task 47：sitemap <loc> 与 robots Sitemap: 指令按规范必须是
// 绝对 URL——Task 36-b 相对形态会被搜索引擎整文件拒收）。scheme 取 X-Forwarded-Proto
// （Caddy 网关反代场景）→ TLS → http 兜底；host 取请求 Host，站群 Host 匹配下每个站点
// 自行拿到各自的绝对地址。
func webBaseURL(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		scheme = "https"
	}
	return scheme + "://" + strings.TrimSpace(r.Host)
}

func handleRobots(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	// Task 47: Sitemap: 指令按规范必须为绝对 URL（相对路径部分爬虫直接忽略）
	_, _ = w.Write([]byte("User-agent: *\nAllow: /\nDisallow: /admin\n\nSitemap: " + webBaseURL(r) + "/sitemap.xml\n"))
}

// handleSitemap 首页 + 分类 + 书籍（上限 5000，含 lastmod）+ pseo 关键词聚合页。
// Task 47: <loc> 改为绝对 URL（sitemaps.org 规范，相对地址被搜索引擎整文件拒收）。
func handleSitemap(w http.ResponseWriter, r *http.Request) {
	// Task 47-a 深审：base 一次性 XML 转义——Host 头来自请求方可含 &/< 等字符，
	// 首页行此前的点态转义与分类/书籍/pseo 行的裸插值不一致（畸形 Host 可产出非法 XML）。
	base := xmlEscape(webBaseURL(r))
	// R162: sitemap loc 按当前站点伪静态方案生成（SEO 与前台出站链接形态一致；
	// 章节/pseo 不入 sitemap 不涉及嵌套上下文，curBook 恒 0）
	smStyle := int64(defaultURLStyle)
	if st := resolveSite(r); st != nil && st.URLStyle > 0 {
		smStyle = st.URLStyle
	}
	smFuncs := urlStyleFuncs(smStyle, 0)
	smBook, _ := smFuncs["bookURL"].(func(any) string)
	smCat, _ := smFuncs["catURL"].(func(any) string)
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>` + "\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n")
	b.WriteString("  <url><loc>" + base + "/</loc></url>\n")
	_ = queryList(`SELECT "id" FROM "Category" ORDER BY "sort" ASC LIMIT 200`, func(rows *sql.Rows) error {
		var id int64
		if err := rows.Scan(&id); err == nil {
			fmt.Fprintf(&b, "  <url><loc>%s%s</loc></url>\n", base, smCat(id))
		}
		return nil
	})
	// Task 47-a 深审：updatedAt 走 any+normalizeMillis 容错扫描——本库实证存在 TEXT 存储
	// 类时间戳行（Task 33-b），int64 直扫失败会令该行 scan 整体报错 → 书籍 URL 被静默
	// 整行丢弃出 sitemap（非仅缺 lastmod）
	_ = queryList(`SELECT "id","updatedAt" FROM "Novel" ORDER BY "updatedAt" DESC LIMIT 5000`, func(rows *sql.Rows) error {
		var id int64
		var updatedRaw any
		if err := rows.Scan(&id, &updatedRaw); err == nil {
			updated := int64(0)
			if ms, ok := normalizeMillis(updatedRaw); ok {
				updated = ms
			}
			if updated > 0 {
				fmt.Fprintf(&b, "  <url><loc>%s%s</loc><lastmod>%s</lastmod></url>\n",
					base, smBook(id), time.UnixMilli(updated).UTC().Format("2006-01-02"))
			} else {
				fmt.Fprintf(&b, "  <url><loc>%s%s</loc></url>\n", base, smBook(id))
			}
		}
		return nil
	})
	_ = queryList(`SELECT "keyword" FROM "PseoKeyword" WHERE "status" = 'generated' LIMIT 5000`, func(rows *sql.Rows) error {
		var kw string
		if err := rows.Scan(&kw); err == nil {
			// Task 36-b: PathEscape 不转义 &（path 段合法字符），XML 文本上下文必须再转义
			fmt.Fprintf(&b, "  <url><loc>%s/pseo/%s</loc></url>\n", base, xmlEscape(url.PathEscape(kw)))
		}
		return nil
	})
	b.WriteString("</urlset>")
	w.Header().Set("Content-Type", "application/xml; charset=utf-8")
	_, _ = w.Write([]byte(b.String()))
}
