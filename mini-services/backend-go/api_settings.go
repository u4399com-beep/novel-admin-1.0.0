/**
 * api_settings.go —— 业务 API：站点设置（TDK 模板/页脚/主题）+ SEO 配置工具。
 *
 * 对应 TS 源：
 *   - src/app/api/settings/route.ts   → handleSettingsGet / handleSettingsPatch
 *   - src/lib/db.ts                   → serializeSettingsWrite（进程内串行锁 → 包级互斥锁）
 *   - src/lib/seo.ts                  → DEFAULT_SEO / renderTpl / sanitizeSeoConfig（autoKeywords
 *                                       等前台专用函数不在 API 契约内，未移植）
 *   - src/lib/footer.ts               → sanitizeFooterConfig / parseFooterConfig
 *
 * 移植语义差异：
 *   1. TS 对象键序 = 插入序；Go map 序列化按字母序（JSON 键序无语义，结构逐字段一致）
 *   2. 存储序列化用 marshalCompact（等价 JSON.stringify：紧凑 + 不转义 HTML 字符）
 *   3. footer 为数组等病理输入：TS typeof 'object' 也会进入 sanitize 并被丢弃，行为一致
 */
package main

import (
	"database/sql"
	"encoding/json"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

func init() {
	register("GET", "/api/settings", handleSettingsGet)
	register("PATCH", "/api/settings", handleSettingsPatch)
}

// serializeSettingsWrite：SiteSetting 单例行读-改-写的进程内串行锁（防并发 PATCH 互覆丢字段）
var settingsWriteMu sync.Mutex

func withSettingsLock(fn func()) {
	settingsWriteMu.Lock()
	defer settingsWriteMu.Unlock()
	fn()
}

// ==================== DEFAULT_SEO（逐字段照抄 src/lib/seo.ts） ====================

var defaultSeo = map[string]string{
	"homeTitle":           "{siteName} - 免费小说在线阅读_原创小说网站",
	"homeDescription":     "{siteName}是领先的免费原创小说在线阅读网站，提供玄幻、仙侠、都市、历史、科幻等全品类小说，每日更新，畅享极致阅读体验。",
	"homeKeywords":        "小说,免费小说,在线阅读,{siteName},玄幻小说,都市小说",
	"categoryTitle":       "{categoryName}小说大全_最新{categoryName}小说排行榜 - {siteName}",
	"categoryDescription": "{siteName}{categoryName}频道为您提供海量精品{categoryName}小说在线阅读，{categoryName}小说每日更新，尽在{siteName}。",
	"bookTitle":           "{novelTitle}最新章节列表_{author}小说 - {siteName}",
	"bookDescription":     "{novelTitle}连载于{siteName}，作者{author}，{statusText}。{descShort}",
	"bookKeywords":        "{novelTitle},{novelTitle}最新章节,{author},{categoryName}小说",
	"tocTitle":            "{novelTitle}目录_全部章节列表 - {siteName}",
	"tocDescription":      "{novelTitle}全部章节目录一览，按顺序阅读《{novelTitle}》最新章节，尽在{siteName}。",
	"chapterTitle":        "{chapterTitle}_《{novelTitle}》第{idx}章 - {siteName}",
	"chapterDescription":  "《{novelTitle}》{chapterTitle}在线阅读，作者{author}，精彩章节尽在{siteName}。",
	"chapterKeywords":     "{novelTitle},{chapterTitle},{author}",
	"searchTitle":         "“{query}”的搜索结果 - {siteName}",
	"searchDescription":   "在{siteName}搜索“{query}”找到的相关小说列表。",
	"pseoTitle":           "{keyword}小说推荐_关于{keyword}的小说 - {siteName}",
	"pseoDescription":     "{siteName}为您精选与“{keyword}”相关的小说合集，包含 {count} 本热门作品，在线免费阅读。",
	"pseoKeywords":        "{keyword},{keyword}小说,{keyword}推荐",
}

// seoStringKeys TDK 字符串模板键（DEFAULT_SEO 中除 autoFromContent 外的全部键）
var seoStringKeys = []string{
	"homeTitle", "homeDescription", "homeKeywords",
	"categoryTitle", "categoryDescription",
	"bookTitle", "bookDescription", "bookKeywords",
	"tocTitle", "tocDescription",
	"chapterTitle", "chapterDescription", "chapterKeywords",
	"searchTitle", "searchDescription",
	"pseoTitle", "pseoDescription", "pseoKeywords",
}

var tplVarRe = regexp.MustCompile(`\{(\w+)\}`)

// renderTpl 模板变量替换：命中替换，未命中 {xxx} → 空串（与 TS renderTpl 一致）
func renderTpl(tpl string, vars map[string]string) string {
	return tplVarRe.ReplaceAllStringFunc(tpl, func(m string) string {
		k := m[1 : len(m)-1]
		if v, ok := vars[k]; ok {
			return v
		}
		return ""
	})
}

// sanitizeSeoConfig TDK 白名单清洗：非字符串回落默认并 1000 截断；pseo 对象原样透传；未知键丢弃
func sanitizeSeoConfig(raw any) map[string]any {
	out := map[string]any{}
	for _, k := range seoStringKeys {
		out[k] = defaultSeo[k]
	}
	out["autoFromContent"] = true
	r, ok := raw.(map[string]any)
	if !ok {
		return out
	}
	for _, k := range seoStringKeys {
		if s, ok := r[k].(string); ok {
			out[k] = truncateRunes(s, 1000)
		}
	}
	if b, ok := r["autoFromContent"].(bool); ok {
		out["autoFromContent"] = b
	}
	if p, ok := r["pseo"].(map[string]any); ok {
		out["pseo"] = p
	}
	return out
}

// ==================== 页脚配置（移植 src/lib/footer.ts） ====================

const (
	footerTextMax   = 300
	footerExtraMax  = 300
	footerLinkCount = 10
	footerLabelMax  = 20
	footerHrefMax   = 300
)

var (
	hrefAbsRe     = regexp.MustCompile(`(?i)^https?://`)
	hrefRelRe     = regexp.MustCompile(`^[/#?]`)
	hrefJSProtoRe = regexp.MustCompile(`(?i)^javascript:`)
)

// sanitizeHref href 白名单：http(s) 绝对地址或站内相对路径（/、#、? 开头）
func sanitizeHref(raw string) string {
	h := trimSpaceStr(raw)
	if h == "" {
		return ""
	}
	if hrefAbsRe.MatchString(h) {
		return truncateRunes(h, footerHrefMax)
	}
	if hrefRelRe.MatchString(h) && !hrefJSProtoRe.MatchString(h) {
		return truncateRunes(h, footerHrefMax)
	}
	return ""
}

// sanitizeFooterConfig 清洗任意输入为安全 FooterConfig（非法字段丢弃，绝不抛错）
func sanitizeFooterConfig(raw any) map[string]any {
	out := map[string]any{}
	r, ok := raw.(map[string]any)
	if !ok {
		return out
	}
	if s, ok := r["text"].(string); ok {
		out["text"] = truncateRunes(trimSpaceStr(s), footerTextMax)
	}
	if s, ok := r["extra"].(string); ok {
		out["extra"] = truncateRunes(trimSpaceStr(s), footerExtraMax)
	}
	if arr, ok := r["links"].([]any); ok {
		links := make([]map[string]string, 0)
		seen := map[string]bool{}
		for _, item := range arr {
			if len(links) >= footerLinkCount {
				break
			}
			m, ok := item.(map[string]any)
			if !ok {
				continue
			}
			label := ""
			if s, ok := m["label"].(string); ok {
				label = truncateRunes(trimSpaceStr(s), footerLabelMax)
			}
			href := ""
			if s, ok := m["href"].(string); ok {
				href = sanitizeHref(s)
			}
			if label == "" || href == "" {
				continue
			}
			key := label + "|" + href
			if seen[key] {
				continue
			}
			seen[key] = true
			links = append(links, map[string]string{"label": label, "href": href})
		}
		if len(links) > 0 {
			out["links"] = links
		}
	}
	return out
}

// parseFooterConfig 解析 DB footerConfig JSON（损坏回退空配置）
func parseFooterConfig(blob sql.NullString) map[string]any {
	if !blob.Valid || blob.String == "" {
		return map[string]any{}
	}
	var v any
	if json.Unmarshal([]byte(blob.String), &v) != nil {
		return map[string]any{}
	}
	return sanitizeFooterConfig(v)
}

// safeParseJSONBlob 安全解析 JSON 文本（损坏/空 → {}）
func safeParseJSONBlob(blob sql.NullString) map[string]any {
	if !blob.Valid || blob.String == "" {
		return map[string]any{}
	}
	var v any
	if json.Unmarshal([]byte(blob.String), &v) != nil {
		return map[string]any{}
	}
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

// ensureSettingRow 单例行 upsert 兜底（避免首次并发 GET 双 create 撞 id 唯一约束）
func ensureSettingRow() error {
	_, err := exec(
		`INSERT INTO "SiteSetting" ("id","siteName","activeTheme","notice","seoConfig","footerConfig") VALUES (1,'青阅文学','aijjxs','本站所有小说仅供学习演示使用，请支持正版。','{}','{}') ON CONFLICT("id") DO NOTHING`,
	)
	return err
}

// ==================== GET /api/settings ====================

func handleSettingsGet(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	if err := ensureSettingRow(); err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	var siteName, activeTheme, notice string
	var seoConfig, footerConfig, homeConfig sql.NullString
	err := queryOne(`SELECT "siteName","activeTheme","notice","seoConfig","footerConfig","homeConfig" FROM "SiteSetting" WHERE "id" = 1`,
		[]any{&siteName, &activeTheme, &notice, &seoConfig, &footerConfig, &homeConfig})
	if err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	// 读回也过白名单：历史行可能已存入非字符串 TDK（旧版 PATCH 不设防）
	seo := sanitizeSeoConfig(safeParseJSONBlob(seoConfig))
	footer := parseFooterConfig(footerConfig)
	home := parseHomeConfig(homeConfig)
	writeJSON(w, 200, map[string]any{
		"siteName":    siteName,
		"activeTheme": activeTheme,
		"notice":      notice,
		"seo":         seo,
		"footer":      footer,
		"home":        home,
	})
}

// ==================== PATCH /api/settings ====================

func handleSettingsPatch(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	v, ok := readBodyValue(r)
	if !ok {
		writeJSON(w, 400, map[string]string{"error": "请求体不是合法 JSON"})
		return
	}
	body := bodyMap(v)

	sets := []string{}
	args := []any{}
	if s, ok2 := body["siteName"].(string); ok2 {
		if t := trimSpaceStr(s); t != "" {
			sets = append(sets, `"siteName" = ?`)
			args = append(args, truncateRunes(t, 50))
		}
	}
	if s, ok2 := body["activeTheme"].(string); ok2 {
		t := trimSpaceStr(s)
		// Task 25-b: activeTheme 白名单校验——该值会流入 renderPage 的模板目录拼接
		// （templatesRoot/{theme}），此前接受任意 ≤50 字符串：脏值/恶意值（含 ../）
		// 会让全站页面降级兜底甚至探测模板目录外文件。非白名单主题 → 400 拒绝。
		if t != "" && !isKnownTheme(t) {
			writeJSON(w, 400, map[string]string{"error": "未知主题： " + truncateRunes(t, 50)})
			return
		}
		if t != "" {
			sets = append(sets, `"activeTheme" = ?`)
			args = append(args, truncateRunes(t, 50))
		}
	}
	if s, ok2 := body["notice"].(string); ok2 {
		sets = append(sets, `"notice" = ?`)
		args = append(args, truncateRunes(s, 500))
	}
	if h, exists := body["home"]; exists {
		if _, isObj := h.(map[string]any); isObj {
			sets = append(sets, `"homeConfig" = ?`)
			args = append(args, marshalCompact(sanitizeHomeConfig(h)))
		} else {
			// 病理输入（数组/标量）：TS 版 sanitize 返回 {blocks:[]}，行为一致
			sets = append(sets, `"homeConfig" = ?`)
			args = append(args, marshalCompact(map[string]any{"blocks": []any{}}))
		}
	}
	if f, exists := body["footer"]; exists {
		if _, isObj := f.(map[string]any); isObj {
			sets = append(sets, `"footerConfig" = ?`)
			args = append(args, marshalCompact(sanitizeFooterConfig(f)))
		} else if _, isArr := f.([]any); isArr {
			// TS typeof [] === 'object' → sanitize 丢弃全部字段 → 空对象
			sets = append(sets, `"footerConfig" = ?`)
			args = append(args, marshalCompact(map[string]any{}))
		}
	}

	// seoConfig 为「读旧 JSON → 合并 → 写回」的读改写，与 PSEO 配置共用一行存储，
	// 统一经进程内串行锁执行（serializeSettingsWrite 语义）
	patchSeo, hasPatchSeo := body["seo"].(map[string]any)
	hasSeoArr := false
	if !hasPatchSeo {
		if _, isArr := body["seo"].([]any); isArr {
			hasSeoArr = true // TS 会 spread 数组（等价无 TDK 字段），sanitize 后无变化
		}
	}

	var siteName, activeTheme string
	withSettingsLock(func() {
		if err := ensureSettingRow(); err != nil {
			return
		}
		if hasPatchSeo || hasSeoArr {
			var seoBlob sql.NullString
			if err := queryOne(`SELECT "seoConfig" FROM "SiteSetting" WHERE "id" = 1`, []any{&seoBlob}); err == nil {
				current := safeParseJSONBlob(seoBlob)
				// 合并后过白名单：非字符串 TDK 丢弃回落默认；pseo 运行配置原样保留
				merged := map[string]any{}
				for k, val := range current {
					merged[k] = val
				}
				for k, val := range patchSeo {
					merged[k] = val
				}
				sets = append(sets, `"seoConfig" = ?`)
				args = append(args, marshalCompact(sanitizeSeoConfig(merged)))
			}
		}
		if len(sets) > 0 {
			_, _ = exec(`UPDATE "SiteSetting" SET `+strings.Join(sets, ", ")+` WHERE "id" = 1`, args...)
		}
		_ = queryOne(`SELECT "siteName","activeTheme" FROM "SiteSetting" WHERE "id" = 1`, []any{&siteName, &activeTheme})
	})

	if siteName == "" && activeTheme == "" {
		failJSON(w, "服务器错误", "设置行不可用", 500)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "siteName": siteName, "activeTheme": activeTheme})
}

// ==================== homeConfig（首页自定义图文区块，Task 23 对齐 src/lib/home-blocks.ts） ====================

var catSourceRe = regexp.MustCompile(`^cat:\d{1,6}$`)

// isHomeBlockSource 数据来源白名单：latest / hot / featured / cat:<正整数>
func isHomeBlockSource(v any) (string, bool) {
	s, ok := v.(string)
	if !ok {
		return "", false
	}
	if s == "latest" || s == "hot" || s == "featured" {
		return s, true
	}
	if catSourceRe.MatchString(s) {
		return s, true
	}
	return "", false
}

// sanitizeHomeBlock 单区块白名单（title 1-30 字、count 4-24、id ≤40 字符）
func sanitizeHomeBlock(raw any) map[string]any {
	obj, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	title, _ := obj["title"].(string)
	title = trimSpaceStr(title)
	if title == "" || runeLen(title) > 30 {
		return nil
	}
	source, ok := isHomeBlockSource(obj["source"])
	if !ok {
		return nil
	}
	count := 8
	if f, ok2 := obj["count"].(float64); ok2 && !math.IsNaN(f) && !math.IsInf(f, 0) {
		c := int(math.Floor(f))
		if c < 4 {
			c = 4
		}
		if c > 24 {
			c = 24
		}
		count = c
	}
	id, _ := obj["id"].(string)
	if id == "" || runeLen(id) > 40 {
		id = "blk" + strconv.FormatInt(time.Now().UnixNano()%1e12, 36)
	}
	return map[string]any{"id": id, "title": title, "source": source, "count": count}
}

// sanitizeHomeConfig 区块数组白名单（上限 8 个区块，防止配置爆炸）
func sanitizeHomeConfig(raw any) map[string]any {
	out := map[string]any{"blocks": []any{}}
	obj, ok := raw.(map[string]any)
	if !ok {
		return out
	}
	arr, ok := obj["blocks"].([]any)
	if !ok {
		return out
	}
	blocks := []any{}
	for i, b := range arr {
		if i >= 8 {
			break
		}
		if s := sanitizeHomeBlock(b); s != nil {
			blocks = append(blocks, s)
		}
	}
	out["blocks"] = blocks
	return out
}

// parseHomeConfig 读回白名单过滤（历史行可能存非法结构，渲染链不抛错）
func parseHomeConfig(blob sql.NullString) map[string]any {
	if !blob.Valid || blob.String == "" {
		return map[string]any{"blocks": []any{}}
	}
	var parsed any
	if err := json.Unmarshal([]byte(blob.String), &parsed); err != nil {
		return map[string]any{"blocks": []any{}}
	}
	return sanitizeHomeConfig(parsed)
}
