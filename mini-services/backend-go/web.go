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
	if theme == "" {
		// Task 30-a: 主题解析走站群 Host 匹配（站点档案决定 theme；未命中回落默认站点）。
		// tplCache key 仍为 theme+"/"+page——主题隔离天然成立，无需改 key。
		// Task 31-d: 站点档案主题同样过白名单（与 webCommon 纵深校验同款，防历史行穿越）。
		if s := resolveSite(r); s != nil && isKnownTheme(s.ActiveTheme) {
			theme = s.ActiveTheme
		}
	}
	// ?theme= 主题预览（仅白名单内主题生效；后台切换/逐主题核查用）
	if q := r.URL.Query().Get("theme"); q != "" && isKnownTheme(q) {
		theme = q
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

func handleRobots(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write([]byte("User-agent: *\nAllow: /\nDisallow: /admin\n\nSitemap: /sitemap.xml\n"))
}

// handleSitemap 首页 + 分类 + 书籍（上限 5000）+ pseo 关键词聚合页
func handleSitemap(w http.ResponseWriter, _ *http.Request) {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>` + "\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n")
	b.WriteString("  <url><loc>/</loc></url>\n")
	_ = queryList(`SELECT "id" FROM "Category" ORDER BY "sort" ASC LIMIT 200`, func(rows *sql.Rows) error {
		var id int64
		if err := rows.Scan(&id); err == nil {
			fmt.Fprintf(&b, "  <url><loc>/category/%d</loc></url>\n", id)
		}
		return nil
	})
	_ = queryList(`SELECT "id" FROM "Novel" ORDER BY "updatedAt" DESC LIMIT 5000`, func(rows *sql.Rows) error {
		var id int64
		if err := rows.Scan(&id); err == nil {
			fmt.Fprintf(&b, "  <url><loc>/book/%d</loc></url>\n", id)
		}
		return nil
	})
	_ = queryList(`SELECT "keyword" FROM "PseoKeyword" WHERE "status" = 'generated' LIMIT 2000`, func(rows *sql.Rows) error {
		var kw string
		if err := rows.Scan(&kw); err == nil {
			fmt.Fprintf(&b, "  <url><loc>/pseo/%s</loc></url>\n", url.PathEscape(kw))
		}
		return nil
	})
	b.WriteString("</urlset>")
	w.Header().Set("Content-Type", "application/xml; charset=utf-8")
	_, _ = w.Write([]byte(b.String()))
}
