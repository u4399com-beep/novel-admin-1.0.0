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

const webRoot = "/home/z/my-project/mini-services/backend-go/web"
const templatesRoot = webRoot + "/templates"

// fallbackTheme 模板缺失/渲染失败时的兜底主题
const fallbackTheme = "_fallback"

// themeNames admin 主题切换下拉的可选清单（与 src/themes registry 对齐）
var themeNames = []string{"aijjxs", "pilishuwu", "ddyueshu", "shipsay", "x2552", "trxsw", "23qb", "101kks", "huangjinwu", "ggd66"}

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

func webFuncMap() template.FuncMap {
	return template.FuncMap{
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
		// cntFmt 点击数格式化（React 万单位语义对齐）：12345 → 1.2万；890 → 890
		"cntFmt": func(v any) string {
			n := toInt64(v)
			if n <= 0 {
				return "0"
			}
			if n >= 10000 {
				w := float64(n) / 10000.0
				s := strconv.FormatFloat(w, 'f', 1, 64)
				s = strings.TrimSuffix(s, ".0")
				return s + "万"
			}
			return strconv.FormatInt(n, 10)
		},
		// dateFmt 毫秒时间戳 → MM-DD（零值返回空串）
		"dateFmt": func(v any) string {
			ms := toInt64(v)
			if ms <= 0 {
				return ""
			}
			return time.UnixMilli(ms).Format("01-02")
		},
		// fullFmt 毫秒时间戳 → 2006-01-02
		"fullFmt": func(v any) string {
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
		"catURL":     func(v any) string { return "/category/" + strconv.FormatInt(toInt64(v), 10) },
		"bookURL":    func(v any) string { return "/book/" + strconv.FormatInt(toInt64(v), 10) },
		"chapterURL": func(v any) string { return "/chapter/" + strconv.FormatInt(toInt64(v), 10) },
		"tocURL":     func(v any) string { return "/book/" + strconv.FormatInt(toInt64(v), 10) + "/toc" },
		"searchURL":  func(q string) string { return "/search?q=" + url.QueryEscape(q) },
		"add":        func(a, b any) int64 { return toInt64(a) + toInt64(b) },
		"sub":        func(a, b any) int64 { return toInt64(a) - toInt64(b) },
		// trimSuffixStr 模板字符串后缀裁剪（长尾词去站点后缀等）
		"trimSuffixStr": strings.TrimSuffix,
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
func loadPageTemplate(theme, page string) *template.Template {
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
	mt := latestMtime(dir)
	if v, ok := tplCache.Load(key); ok {
		if e := v.(tplCacheEntry); !mt.After(e.modTime) {
			return e.tpl
		}
	}
	t, err := template.New(page + ".html").Funcs(webFuncMap()).ParseFiles(files...)
	if err != nil {
		log.Printf("[web] 模板解析失败 %s/%s: %v", theme, page, err)
		return nil
	}
	tplCache.Store(key, tplCacheEntry{tpl: t, modTime: mt})
	return t
}

// renderPage 按激活主题渲染页面；支持 ?theme= 预览覆盖（白名单校验防穿越）；
// 主题模板缺失或渲染失败 → _fallback 兜底 → 极简错误页
func renderPage(w http.ResponseWriter, r *http.Request, page string, data map[string]any) {
	theme, _ := data["theme"].(string)
	themeFixed := theme != "" // Task 25-b: 固定主题页（admin）不允许被 ?theme= 覆盖
	if theme == "" {
		if s := loadWebSettings(); s != nil {
			theme = s.ActiveTheme
		}
	}
	// Task 25-b: 设置层主题名防御校验——activeTheme 来自 DB（历史脏数据/异常写入），
	// 此前直接 filepath.Join(templatesRoot, theme) 存在目录穿越面；非白名单一律降级兜底。
	// 注意 admin 页主题 "admin" 与兜底 "_fallback" 为保留名。
	if theme != "admin" && theme != fallbackTheme && !isKnownTheme(theme) {
		theme = fallbackTheme
	}
	// ?theme= 主题预览（仅白名单内主题生效；后台切换/逐主题核查用）
	// Task 25-b: 固定主题页（admin）不再被 ?theme= 覆盖——旧逻辑下 /admin?theme=xx
	// 会因 xx 主题无 admin.html 双双 miss 而降级到极简错误页
	if !themeFixed {
		if q := r.URL.Query().Get("theme"); q != "" && isKnownTheme(q) {
			theme = q
		}
	}
	data["theme"] = theme

	for _, th := range []string{theme, fallbackTheme} {
		t := loadPageTemplate(th, page)
		if t == nil {
			continue
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		var buf strings.Builder
		if err := t.ExecuteTemplate(&buf, "layout", data); err == nil {
			_, _ = w.Write([]byte(buf.String()))
			return
		} else if th == theme {
			log.Printf("[web] 模板渲染失败 %s/%s: %v（降级 _fallback）", theme, page, err)
			continue
		} else {
			// Task 25-b: 兜底主题渲染也失败时必须留痕（此前静默落极简页，排障无据）
			log.Printf("[web] 兜底模板渲染失败 _fallback/%s: %v（降级极简页）", page, err)
		}
	}
	// 最终兜底：极简 HTML（绝不 500 白屏）
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	name, _ := data["siteName"].(string)
	_, _ = w.Write([]byte("<!doctype html><html lang=zh-CN><meta charset=utf-8><title>" + template.HTMLEscapeString(name) +
		"</title><p style='padding:40px;text-align:center;color:#666'>页面渲染异常，请稍后刷新。</p>"))
}

// ---------- 路由注册 ----------

func init() {
	register("GET", "/", func(w http.ResponseWriter, r *http.Request, _ map[string]string) { handleWebHome(w, r) })
	register("GET", "/category/{id}", handleWebCategory)
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
		http.Error(w, "forbidden", 403)
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

// siteAbsURL Task 25-b: 由请求推导站点绝对地址（sitemap/robots 协议要求绝对 URL；
// 经 Caddy:81 代理时以 X-Forwarded-Proto 为准）。Host 为空（畸形请求）返回空串，
// 调用方回退相对路径保持旧行为。
func siteAbsURL(r *http.Request) string {
	if r == nil || r.Host == "" {
		return ""
	}
	scheme := "http"
	if p := r.Header.Get("X-Forwarded-Proto"); p == "https" || p == "http" {
		scheme = p
	} else if r.TLS != nil {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

func handleRobots(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	// Task 25-b: Sitemap 行协议要求绝对 URL（相对路径部分爬虫忽略）
	sm := "/sitemap.xml"
	if base := siteAbsURL(r); base != "" {
		sm = base + sm
	}
	_, _ = w.Write([]byte("User-agent: *\nAllow: /\nDisallow: /admin\n\nSitemap: " + sm + "\n"))
}

// handleSitemap 首页 + 分类 + 书籍（上限 5000）+ pseo 关键词聚合页
func handleSitemap(w http.ResponseWriter, r *http.Request) {
	var b strings.Builder
	// Task 25-b: <loc> 协议要求绝对 URL；Host 缺失时保留旧的相对路径行为
	locPrefix := ""
	if base := siteAbsURL(r); base != "" {
		locPrefix = base
	}
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>` + "\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n")
	b.WriteString("  <url><loc>" + locPrefix + "/</loc></url>\n")
	_ = queryList(`SELECT "id" FROM "Category" ORDER BY "sort" ASC LIMIT 200`, func(rows *sql.Rows) error {
		var id int64
		if err := rows.Scan(&id); err == nil {
			fmt.Fprintf(&b, "  <url><loc>%s/category/%d</loc></url>\n", locPrefix, id)
		}
		return nil
	})
	_ = queryList(`SELECT "id" FROM "Novel" ORDER BY "updatedAt" DESC LIMIT 5000`, func(rows *sql.Rows) error {
		var id int64
		if err := rows.Scan(&id); err == nil {
			fmt.Fprintf(&b, "  <url><loc>%s/book/%d</loc></url>\n", locPrefix, id)
		}
		return nil
	})
	_ = queryList(`SELECT "keyword" FROM "PseoKeyword" WHERE "status" = 'generated' LIMIT 2000`, func(rows *sql.Rows) error {
		var kw string
		if err := rows.Scan(&kw); err == nil {
			fmt.Fprintf(&b, "  <url><loc>%s/pseo/%s</loc></url>\n", locPrefix, url.PathEscape(kw))
		}
		return nil
	})
	b.WriteString("</urlset>")
	w.Header().Set("Content-Type", "application/xml; charset=utf-8")
	_, _ = w.Write([]byte(b.String()))
}
