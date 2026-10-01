/**
 * web_data.go —— 页面数据装配（模板数据契约的唯一权威来源）。
 *
 * 模板数据 map key 契约（html/template 大小写敏感，均以此为准）：
 *
 * 通用（webCommon，所有页面共享）：
 *   .Site  → {siteName, notice, activeTheme, seoTitle, seoDescription, footerText,
 *             footerExtra, footerLinks[]{label,url}}
 *             （seoTitle/seoDescription = seoConfig homeTitle/homeDescription 模板渲染结果，Task 28-b；
 *               各页 <title>/<meta description> 由 pageTitle/pageDescription 承载，见 applyWebTDK）
 *   .FriendLinks → [{name,url}]（页脚友情链接，Task 32-a，web_footer.go；空则区块不渲染）
 *   .FleetLinks  → [{host,siteName,url}]（页脚站群内链轮，SiteSite enabled 排除当前 Host，
 *                  Task 32-a，web_footer.go；空则区块不渲染）
 *   .Nav   → [{id,name,sort,novelCount}]（导航分类，其他=9999 天然最后）
 *   .Path  → 当前请求路径（导航高亮）
 *
 * novel 条目字段（queryNovelList 输出，与 novelListCols 一致）：
 *   id,title,author,description,cover,categoryId,categoryName,status,
 *   isFeatured,isHot,wordCount,clicks,updatedAt,chapterCount,lastChapterTitle
 *
 * home:      .Featured[12] .Hot[10] .Latest[14] .RankClicks[10] .RankUpdates[10]
 *            .RankFinished[10] .Stats{novelCount,chapterCount,totalWordCount,todayUpdates}
 *            .HomeBlocks[{id,title,source,count,novels[]}]（后台自定义图文区块，小编精选等）
 * category:  .Category{id,name} .Novels[]（全量，无分页） .FeaturedBlock[6] .HotBlock[8] .Stats
 * book:      .Novel{...同上+updatedAt} .Tags[]（书名+作者+pseo 下拉词）
 *            .Chapters[12]（预览） .ChaptersTotal .LastChapter{idx,title} .Related[6]（同分类）
 * toc:       .Novel .Chapters[]（全量 {id,idx,title,wordCount}）
 * chapter:   .Chapter{id,idx,title,wordCount,Paragraphs[]} .Novel{id,title,author,cover}
 *            .Prev{id,idx,title} .Next{id,idx,title}（可空 → 模板 {{if}}）
 * search:    .Q .Novels[] .Total
 * pseo:      .Keyword .Description .Novels[]
 * admin:     .Rules[] .Tasks[] .Categories[] .Novels[]（前 50） .Settings .Pseo[] .Themes[] .Stats{...}
 */
package main

import (
	"database/sql"
	"encoding/json"
	"html/template"
	"log"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
)

// ---------- 站点设置 ----------

type webSettings struct {
	SiteName      string
	ActiveTheme   string
	Notice        string
	SeoConfig     map[string]any
	FooterConfig  map[string]any
	HomeConfigRaw sql.NullString
}

// loadWebSettings 读取 SiteSetting 单例行（不存在时返回 nil）
func loadWebSettings() *webSettings {
	var s webSettings
	var seoBlob, footerBlob sql.NullString
	err := queryOne(
		`SELECT "siteName","activeTheme","notice","seoConfig","footerConfig","homeConfig" FROM "SiteSetting" WHERE "id" = 1`,
		[]any{&s.SiteName, &s.ActiveTheme, &s.Notice, &seoBlob, &footerBlob, &s.HomeConfigRaw},
	)
	if err != nil {
		return nil
	}
	s.SeoConfig = map[string]any{}
	s.FooterConfig = map[string]any{}
	if seoBlob.Valid && seoBlob.String != "" {
		_ = json.Unmarshal([]byte(seoBlob.String), &s.SeoConfig)
	}
	if footerBlob.Valid && footerBlob.String != "" {
		_ = json.Unmarshal([]byte(footerBlob.String), &s.FooterConfig)
	}
	return &s
}

// ---------- 站群 Host 匹配（Task 30-a「站群模式」：一库多站按 Host 分站点渲染） ----------

// requestHost 请求 Host 归一化：去端口（含 IPv6 括号形态）+ 小写；空返回空串。
// SiteSite.host 存储口径与此一致（api_sites.go 写入时同样归一化），保证精确匹配闭环。
func requestHost(r *http.Request) string {
	h := strings.TrimSpace(r.Host)
	if h == "" {
		return ""
	}
	if host, _, err := net.SplitHostPort(h); err == nil {
		h = host
	}
	return strings.ToLower(strings.Trim(h, "[]"))
}

// resolveSite 站群 Host 匹配：请求 Host（去端口小写）在 SiteSite（enabled=1）中精确命中
// 则返回该站点档案（siteName/activeTheme/notice/seoConfig/footerConfig/homeConfig 全量
// 覆盖默认站点渲染数据），未命中/空表/表未建/查询故障一律回落 SiteSetting 单例——
// 默认站点行为完全不变（fail-open，绝不因站群层故障 500）。host 不做 * 通配/后缀匹配，
// 兑底语义即默认站点（SiteSetting）。空表 = 纯默认站点（seed 不预置站点行）。
func resolveSite(r *http.Request) *webSettings {
	if r != nil {
		if host := requestHost(r); host != "" {
			var s webSettings
			var seoBlob, footerBlob sql.NullString
			err := queryOne(
				`SELECT "siteName","activeTheme","notice","seoConfig","footerConfig","homeConfig" FROM "SiteSite" WHERE "host" = ? AND "enabled" = 1`,
				[]any{&s.SiteName, &s.ActiveTheme, &s.Notice, &seoBlob, &footerBlob, &s.HomeConfigRaw},
				host,
			)
			if err == nil {
				s.SeoConfig = map[string]any{}
				s.FooterConfig = map[string]any{}
				if seoBlob.Valid && seoBlob.String != "" {
					_ = json.Unmarshal([]byte(seoBlob.String), &s.SeoConfig)
				}
				if footerBlob.Valid && footerBlob.String != "" {
					_ = json.Unmarshal([]byte(footerBlob.String), &s.FooterConfig)
				}
				return &s
			}
		}
	}
	return loadWebSettings()
}

// settingsFromData 取 webCommon 已解析的站点档案（data["siteSettings"]）；无该键（非标准
// 路径直调）回落 SiteSetting 单例。Task 30-a：applyWebTDK/applyWebKeywords/gatherHomeBlocks
// 由「各自 loadWebSettings」改为经此取站点口径——同一次请求内 Site/TDK/页脚/首页区块同源。
func settingsFromData(data map[string]any) *webSettings {
	if data != nil {
		if s, ok := data["siteSettings"].(*webSettings); ok && s != nil {
			return s
		}
	}
	return loadWebSettings()
}

// webCommon 组装所有页面共享的 Site/Nav/Path 数据块
func webCommon(r *http.Request) map[string]any {
	s := resolveSite(r) // Task 30-a: 站群 Host 匹配（未命中=默认站点，行为不变）
	if s == nil {
		s = &webSettings{SiteName: "青阅文学", ActiveTheme: fallbackTheme, Notice: ""}
	}
	nav := []map[string]any{}
	_ = queryList(
		`SELECT c."id", c."name", c."sort", (SELECT COUNT(*) FROM "Novel" n WHERE n."categoryId" = c."id") FROM "Category" c ORDER BY c."sort" ASC, c."id" ASC`,
		func(rows *sql.Rows) error {
			var id, sort_, count int64
			var name string
			if err := rows.Scan(&id, &name, &sort_, &count); err == nil {
				nav = append(nav, map[string]any{"id": id, "name": name, "sort": sort_, "novelCount": count})
			}
			return nil
		},
	)

	// Task 28-b: 旧代码读 SeoConfig["title"]/"description"——seoConfig 白名单里根本不存在
	// 这两个键（键集是 homeTitle/homeDescription/…，见 api_settings.go seoStringKeys），
	// Site.seoTitle/seoDescription 恒为空串。改为白名单清洗后渲染 home 模板填充（语义归位）
	seoCfg := sanitizeSeoConfig(s.SeoConfig)
	homeVars := map[string]string{"siteName": s.SiteName}
	seoTitle, _ := seoCfg["homeTitle"].(string)
	seoDescription, _ := seoCfg["homeDescription"].(string)
	footerText, _ := s.FooterConfig["text"].(string)
	footerExtra, _ := s.FooterConfig["extra"].(string)
	footerLinks := []map[string]any{}
	if rawLinks, ok := s.FooterConfig["links"].([]any); ok {
		for _, l := range rawLinks {
			if m, ok := l.(map[string]any); ok {
				label, _ := m["label"].(string)
				u, _ := m["url"].(string)
				if u == "" {
					// Task 30-a: 兼容 sanitizeFooterConfig 落库的 href 键（后台页脚 JSON
					// 形态为 {"links":[{"label","href"}]}，旧读取只认 url 键导致链接永不渲染）
					u, _ = m["href"].(string)
				}
				if label != "" && u != "" {
					footerLinks = append(footerLinks, map[string]any{"label": label, "url": u})
				}
			}
		}
	}

	// Task 32-a: 页脚扩展区块数据——友链（footerConfig.friendLinks 读取侧防御复检）
	// 与站群内链轮（SiteSite enabled=1 排除当前 Host，60s 缓存），实现在 web_footer.go；
	// 空切片时模板 {{if}} 判空 → 区块零 DOM 痕迹。
	friendLinks := gatherFooterFriendLinks(s.FooterConfig)
	fleetLinks := gatherFleetLinks(requestHost(r))
	// Task 46: 链轮三类型（站内随机书籍页/站群随机首页/站群随机书籍页，每请求随机抽样）
	wheelLinks := gatherWheelLinks(requestHost(r))

	// Task 30-a: 站点档案透传——applyWebTDK/applyWebKeywords/gatherHomeBlocks 经
	// settingsFromData 取此解析结果（保证同请求内 Site/TDK/页脚/区块口径一致）；
	// theme 由站点档案决定（renderPage 据此选模板；admin handler 随后覆盖为 "admin"）
	data := map[string]any{
		"Site": map[string]any{
			"siteName":       s.SiteName,
			"notice":         s.Notice,
			"activeTheme":    s.ActiveTheme,
			"seoTitle":       renderTpl(seoTitle, homeVars),
			"seoDescription": renderTpl(seoDescription, homeVars),
			"footerText":     footerText,
			"footerExtra":    footerExtra,
			"footerLinks":    footerLinks,
		},
		"Nav":          nav,
		"Path":         r.URL.Path,
		"FriendLinks":  friendLinks,
		"FleetLinks":   fleetLinks,
		"WheelLinks":   wheelLinks,
		"siteSettings": s,
		// Task 36-b: 缺省空串——个别主题 home 模板消费 {{.Q}}（101kks 首页搜索框），
		// map 缺键时 html/template 会渲染字面量「<no value>」而非空串；搜索页随后覆盖。
		"Q": "",
	}
	// Task 31-d: 主题白名单纵深校验——站点档案 activeTheme 理论上已被写入侧白名单约束
	// （api_sites.go / settings PATCH 31-d 起），但历史行/手改库仍可能存在任意字符串，
	// renderPage→loadPageTemplate 的 filepath.Join(templatesRoot, theme) 不容穿越面。
	// 非白名单主题不注入 data["theme"]（renderPage 走默认/回落主题）。
	if t := trimSpaceStr(s.ActiveTheme); t != "" && isKnownTheme(t) {
		data["theme"] = t
	}
	return data
}

// gatherHomeStats 首页/分类页共用的统计块
func gatherHomeStats() map[string]any {
	var novelCount, chapterCount, totalWordCount, todayUpdates int64
	dayAgo := nowMillis() - 24*3600*1000
	_ = queryOne(`SELECT COUNT(*) FROM "Novel"`, []any{&novelCount})
	_ = queryOne(`SELECT COUNT(*) FROM "Chapter"`, []any{&chapterCount})
	var sumWC sql.NullInt64
	_ = queryOne(`SELECT SUM("wordCount") FROM "Novel"`, []any{&sumWC})
	totalWordCount = sumWC.Int64
	_ = queryOne(`SELECT COUNT(*) FROM "Chapter" WHERE "createdAt" >= ?`, []any{&todayUpdates}, dayAgo)
	return map[string]any{
		"novelCount":     novelCount,
		"chapterCount":   chapterCount,
		"totalWordCount": totalWordCount,
		"todayUpdates":   todayUpdates,
	}
}

// ---------- TDK（Task 28-b: 页面 TDK 按 seoConfig 模板渲染） ----------

// applyWebTDK 按后台 seoConfig 中 titleKey/descKey 两个模板键渲染页面 <title>/meta description，
// 写入 data["pageTitle"]/data["pageDescription"]。
//
// 背景：Go 化后各页面 handler 硬编码标题/简介，后台「SEO 设置」的 18 个 TDK 模板
// （homeTitle/bookTitle/…）对前台页面从未生效（仅 pseo 聚合页生成用过 renderTpl）。
// 本函数补齐 TS SeoSync 等价链路：
//   - 模板经 sanitizeSeoConfig 白名单清洗——非字符串/越权键一律回落默认（历史「注入
//     object 致前端炸掉」病根在 Go 侧由类型守卫封死：renderTpl 只接受 string 模板与
//     string 变量表，html/template 自动转义兜底）；
//   - 模板渲染结果为空（用户清空模板/模板全变量未命中）时回落 fbTitle/fbDesc 内置文案，
//     绝不产出空 <title>；
//   - 变量命名与 TS renderTpl 语义一致：{siteName} 自动注入，其余由调用方按页传入；
//     未命中的 {xxx} 占位替换为空串（与 TS renderTpl 一致）。
//
// seoTplCore 取请求站点档案的 seoConfig 并注入 siteName 变量（Task 59-R6：applyWebTDK/
// applyWebKeywords 同构核心收敛；Task 30-a 站群语义不变）。
// 返回 (seo, vars)：vars 为 nil 时新建并回传——若仅局部重赋值，siteName 注入会丢失
// （R6 初版回归实证：home 传 nil vars → 标题变「 - 免费小说…」siteName 空）
func seoTplCore(data map[string]any, vars map[string]string) (map[string]any, map[string]string) {
	if vars == nil {
		vars = map[string]string{}
	}
	s := settingsFromData(data)   // 站群——模板按请求站点档案（默认站点行为不变）
	seo := sanitizeSeoConfig(nil) // 无设置行 → 全默认模板
	if s != nil {
		seo = sanitizeSeoConfig(s.SeoConfig)
	}
	siteName, _ := data["Site"].(map[string]any)["siteName"].(string)
	vars["siteName"] = siteName
	return seo, vars
}

// renderSeoKey 单键模板渲染 + 空模板回退默认句
func renderSeoKey(seo map[string]any, key string, vars map[string]string, fb string) string {
	tpl, _ := seo[key].(string)
	out := renderTpl(tpl, vars)
	if trimSpaceStr(out) == "" {
		out = fb
	}
	return out
}

func applyWebTDK(data map[string]any, titleKey, descKey string, vars map[string]string, fbTitle, fbDesc string) {
	seo, vars := seoTplCore(data, vars)
	data["pageTitle"] = renderSeoKey(seo, titleKey, vars, fbTitle)
	data["pageDescription"] = renderSeoKey(seo, descKey, vars, fbDesc)
}

// applyWebKeywords 渲染后台 seoConfig 关键词模板 → data["pageKeywords"]（Task 28-c）。
// 28-b 移交项：seoConfig 早已具备 homeKeywords/bookKeywords/chapterKeywords/pseoKeywords
// 四个关键词模板键，但模板层无 <meta name="keywords"> 渲染位、数据层也无产出变量。
// 本函数与 applyWebTDK 同构（sanitizeSeoConfig 白名单 + renderTpl 变量注入 + 空回落），
// 仅服务带 keywords 键的四个页面；category/toc/search 源契约无关键词键，不产出（模板侧 {{if}} 兜底）。
func applyWebKeywords(data map[string]any, key string, vars map[string]string, fb string) {
	seo, vars := seoTplCore(data, vars)
	data["pageKeywords"] = renderSeoKey(seo, key, vars, fb)
}

// ---------- 首页 ----------

// gFeaturedBootDone 进程级一次性闸：自愈检查每进程只做一次（命中与否都不再重复查库）
var gFeaturedBootDone atomic.Bool

// ensureFeaturedBootstrap 首页「编辑推荐」空态自愈（Task 59-R4）：DB 重建/沙箱回收后
// isFeatured 无人打标，首页推荐区永久「暂无数据」。守卫触发条件：库内 ≥8 本且
// isFeatured=1 计数为 0 → 按字数 Top8 补标（Task 58 手工补标口径代码化，重启后
// 若存量推荐书全被删亦可重新武装）。AppMeta 锁防并发双跑与重复打标扰动。
func ensureFeaturedBootstrap() {
	if gFeaturedBootDone.Load() {
		return
	}
	gFeaturedBootDone.Store(true) // 无论结果如何本进程只检一次（后台再重建→重启自愈）
	var featured, total int
	if err := queryOne(`SELECT (SELECT COUNT(*) FROM "Novel" WHERE "isFeatured" = 1), (SELECT COUNT(*) FROM "Novel")`, []any{&featured, &total}); err != nil {
		return
	}
	if featured > 0 || total < 8 {
		return
	}
	if _, err := exec(`UPDATE "Novel" SET "isFeatured" = 1 WHERE "id" IN (SELECT "id" FROM "Novel" ORDER BY "wordCount" DESC, "id" DESC LIMIT 8)`); err != nil {
		log.Printf("[web-home] 编辑推荐空态补标失败: %v", err)
		return
	}
	log.Printf("[web-home] 编辑推荐空态自愈：已按字数 Top8 补标 isFeatured=1（库内 %d 本）", total)
}

func handleWebHome(w http.ResponseWriter, r *http.Request) {
	data := webCommon(r)
	ensureFeaturedBootstrap()
	featured, _ := queryNovelList(` WHERE n."isFeatured" = 1`, ` ORDER BY n."updatedAt" DESC, n."id" DESC`, nil, 12, 0)
	hot, _ := queryNovelList(` WHERE n."isHot" = 1`, ` ORDER BY n."clicks" DESC, n."id" DESC`, nil, 10, 0)
	latest, _ := queryNovelList("", ` ORDER BY n."updatedAt" DESC, n."id" DESC`, nil, 14, 0)
	rankClicks, _ := queryNovelList("", ` ORDER BY n."clicks" DESC, n."id" DESC`, nil, 10, 0)
	rankUpdates, _ := queryNovelList("", ` ORDER BY n."updatedAt" DESC, n."id" DESC`, nil, 10, 0)
	rankFinished, _ := queryNovelList(` WHERE n."status" = 'finished'`, ` ORDER BY n."clicks" DESC, n."id" DESC`, nil, 10, 0)
	data["Featured"] = featured
	data["Hot"] = hot
	data["Latest"] = latest
	data["RankClicks"] = rankClicks
	data["RankUpdates"] = rankUpdates
	data["RankFinished"] = rankFinished
	data["Stats"] = gatherHomeStats()
	data["HomeBlocks"] = gatherHomeBlocks(data) // Task 30-a: homeConfig 按请求站点档案

	s := settingsFromData(data)
	siteName := "青阅文学"
	if s != nil && s.SiteName != "" {
		siteName = s.SiteName
	}
	data["siteName"] = siteName
	// Task 28-b: TDK 改由 seoConfig homeTitle/homeDescription 模板渲染（原硬编码降为回落文案）
	applyWebTDK(data, "homeTitle", "homeDescription", nil,
		siteName+" - 免费小说阅读", "最新热门小说免费在线阅读")
	// Task 28-c: 后台 seoConfig homeKeywords 模板 → <meta name="keywords">（28-b 移交项）
	applyWebKeywords(data, "homeKeywords", nil, "")
	renderPage(w, r, "home", data)
}

// gatherHomeBlocks 按后台 homeConfig 渲染自定义图文区块（小编精选等）。
// 白名单语义与 home-blocks.ts / api_settings.go sanitizeHomeConfig 一致。
// Task 30-a: homeConfig 按请求站点档案（站群站点可自定义首页区块；默认站点行为不变）。
func gatherHomeBlocks(data map[string]any) []map[string]any {
	s := settingsFromData(data)
	if s == nil || !s.HomeConfigRaw.Valid || s.HomeConfigRaw.String == "" {
		return []map[string]any{}
	}
	cfg := parseHomeConfig(s.HomeConfigRaw)
	rawBlocks, _ := cfg["blocks"].([]any)
	out := []map[string]any{}
	for _, rb := range rawBlocks {
		b, ok := rb.(map[string]any)
		if !ok {
			continue
		}
		id, _ := b["id"].(string)
		title, _ := b["title"].(string)
		source, _ := b["source"].(string)
		count := int(toInt64(b["count"]))
		if count < 4 {
			count = 4
		}
		if count > 24 {
			count = 24
		}
		if title == "" || source == "" {
			continue
		}
		novels := homeBlockNovels(source, count)
		out = append(out, map[string]any{
			"id": id, "title": title, "source": source, "count": count, "novels": novels,
		})
	}
	return out
}

// homeBlockNovels 按来源取书：latest | hot | featured | cat:<id>
func homeBlockNovels(source string, count int) []map[string]any {
	switch {
	case source == "latest":
		v, _ := queryNovelList("", ` ORDER BY n."updatedAt" DESC, n."id" DESC`, nil, count, 0)
		return v
	case source == "hot":
		v, _ := queryNovelList(` WHERE n."isHot" = 1`, ` ORDER BY n."clicks" DESC, n."id" DESC`, nil, count, 0)
		return v
	case source == "featured":
		v, _ := queryNovelList(` WHERE n."isFeatured" = 1`, ` ORDER BY n."updatedAt" DESC, n."id" DESC`, nil, count, 0)
		return v
	case strings.HasPrefix(source, "cat:"):
		cid, err := strconv.Atoi(strings.TrimPrefix(source, "cat:"))
		if err != nil || cid <= 0 {
			return []map[string]any{}
		}
		v, _ := queryNovelList(` WHERE n."categoryId" = ?`, ` ORDER BY n."updatedAt" DESC, n."id" DESC`, []any{int64(cid)}, count, 0)
		return v
	}
	return []map[string]any{}
}

// ---------- 分类页 ----------

func handleWebCategory(w http.ResponseWriter, r *http.Request, ps map[string]string) {
	data := webCommon(r)
	cid, err := strconv.ParseInt(ps["id"], 10, 64)
	if err != nil || cid <= 0 {
		web404(w, r, "分类不存在")
		return
	}
	var catName string
	if err := queryOne(`SELECT "name" FROM "Category" WHERE "id" = ?`, []any{&catName}, cid); err != nil {
		web404(w, r, "分类不存在")
		return
	}
	novels, _ := queryNovelList(` WHERE n."categoryId" = ?`, ` ORDER BY n."updatedAt" DESC, n."id" DESC`, []any{cid}, 500, 0)
	featuredBlock, _ := queryNovelList(` WHERE n."categoryId" = ? AND n."isFeatured" = 1`, ` ORDER BY n."updatedAt" DESC, n."id" DESC`, []any{cid}, 6, 0)
	hotBlock, _ := queryNovelList(` WHERE n."categoryId" = ?`, ` ORDER BY n."clicks" DESC, n."id" DESC`, []any{cid}, 8, 0)
	data["Category"] = map[string]any{"id": cid, "name": catName}
	data["Novels"] = novels
	data["FeaturedBlock"] = featuredBlock
	data["HotBlock"] = hotBlock
	data["Stats"] = gatherHomeStats()
	data["siteName"] = data["Site"].(map[string]any)["siteName"]
	// Task 28-b: TDK 改由 seoConfig categoryTitle/categoryDescription 模板渲染
	applyWebTDK(data, "categoryTitle", "categoryDescription", map[string]string{"categoryName": catName},
		catName+"分类小说列表", catName+"分类热门小说免费在线阅读")
	renderPage(w, r, "category", data)
}

// ---------- 书籍页 ----------

// chapterMetaBlock 书籍页/聚合页主打书区块共用的章节元数据（Task 50-① 自 handleWebBook
// 抽出）：12 章预览（idx 升序）+ 总数 + 末章。键名与 handleWebBook 顶层契约一致。
func chapterMetaBlock(nid int64) map[string]any {
	chapters := []map[string]any{}
	var chaptersTotal int64
	_ = queryOne(`SELECT COUNT(*) FROM "Chapter" WHERE "novelId" = ?`, []any{&chaptersTotal}, nid)
	_ = queryList(
		`SELECT "id","idx","title","wordCount" FROM "Chapter" WHERE "novelId" = ? ORDER BY "idx" ASC LIMIT 12`,
		func(rows *sql.Rows) error {
			var id, idx, wc int64
			var t string
			if err := rows.Scan(&id, &idx, &t, &wc); err == nil {
				chapters = append(chapters, map[string]any{"id": id, "idx": idx, "title": t, "wordCount": wc})
			}
			return nil
		}, nid)
	block := map[string]any{"Chapters": chapters, "ChaptersTotal": chaptersTotal}
	var lastID, lastIdx int64
	var lastTitle string
	if err := queryOne(`SELECT "id","idx","title" FROM "Chapter" WHERE "novelId" = ? ORDER BY "idx" DESC LIMIT 1`, []any{&lastID, &lastIdx, &lastTitle}, nid); err == nil {
		block["LastChapter"] = map[string]any{"id": lastID, "idx": lastIdx, "title": lastTitle}
	}
	return block
}

func handleWebBook(w http.ResponseWriter, r *http.Request, ps map[string]string) {
	data := webCommon(r)
	nid, err := strconv.ParseInt(ps["id"], 10, 64)
	if err != nil || nid <= 0 {
		web404(w, r, "书籍不存在")
		return
	}
	novel, err := webNovelFull(nid)
	if err != nil {
		web404(w, r, "书籍不存在")
		return
	}
	data["Novel"] = novel
	title, _ := novel["title"].(string)
	author, _ := novel["author"].(string)
	data["Tags"] = novelPseoTags(title, author)
	for k, v := range chapterMetaBlock(nid) {
		data[k] = v
	}

	related, _ := queryNovelList(
		` WHERE n."categoryId" = (SELECT "categoryId" FROM "Novel" WHERE "id" = ?) AND n."id" != ?`,
		` ORDER BY n."clicks" DESC, n."id" DESC`, []any{nid, nid}, 6, 0)
	data["Related"] = related

	s := data["Site"].(map[string]any)
	siteName, _ := s["siteName"].(string)
	data["siteName"] = siteName
	// Task 28-b: TDK 改由 seoConfig bookTitle/bookDescription 模板渲染；
	// {statusText} 由 Novel.status 映射（已完结/连载中），{descShort} 简介截 100 字，{categoryName} 分类名
	statusText := "连载中"
	if st, _ := novel["status"].(string); st == "finished" {
		statusText = "已完结"
	}
	desc, _ := novel["description"].(string)
	descShort := ""
	if desc != "" {
		descShort = excerptN(desc, 100)
	}
	categoryName, _ := novel["categoryName"].(string)
	vars := map[string]string{
		"novelTitle": title, "author": author, "statusText": statusText,
		"descShort": descShort, "categoryName": categoryName,
	}
	applyWebTDK(data, "bookTitle", "bookDescription", vars,
		title+"（"+author+"）最新章节列表 - "+siteName, descShort)
	// Task 28-c: 后台 seoConfig bookKeywords 模板 → <meta name="keywords">（28-b 移交项）
	applyWebKeywords(data, "bookKeywords", vars,
		title+","+title+"最新章节,"+author+","+categoryName+"小说")
	renderPage(w, r, "book", data)
}

// webNovelFull 书籍完整行（含 description；novelListCols 不含部分字段，这里单独查全）。
// 查无此书返回 sql.ErrNoRows（调用方据 err 走 404，绝不以 nil,nil 落入渲染分支）
func webNovelFull(nid int64) (map[string]any, error) {
	v, err := queryNovelList(` WHERE n."id" = ?`, ``, []any{nid}, 1, 0)
	if err != nil {
		return nil, err
	}
	if len(v) == 0 {
		return nil, sql.ErrNoRows
	}
	return v[0], nil
}

// ---------- 目录页 ----------

func handleWebToc(w http.ResponseWriter, r *http.Request, ps map[string]string) {
	data := webCommon(r)
	nid, err := strconv.ParseInt(ps["id"], 10, 64)
	if err != nil || nid <= 0 {
		web404(w, r, "书籍不存在")
		return
	}
	novel, err := webNovelFull(nid)
	if err != nil {
		web404(w, r, "书籍不存在")
		return
	}
	data["Novel"] = novel
	chapters := []map[string]any{}
	_ = queryList(
		`SELECT "id","idx","title","volume","wordCount" FROM "Chapter" WHERE "novelId" = ? ORDER BY "idx" ASC`,
		func(rows *sql.Rows) error {
			var id, idx, wc int64
			var t, vol string
			if err := rows.Scan(&id, &idx, &t, &vol, &wc); err == nil {
				chapters = append(chapters, map[string]any{"id": id, "idx": idx, "title": t, "volume": vol, "wordCount": wc})
			}
			return nil
		}, nid)
	// Task 45-b: .Chapters 原样保留（向后兼容——11 主题模板未全适配分卷渲染，未适配主题
	// 仍走平铺分支零变化）；.Volumes 新增分卷分组（无卷书为空切片，模板判空回退平铺）
	data["Chapters"] = chapters
	data["Volumes"] = groupChaptersByVolume(chapters)
	title, _ := novel["title"].(string)
	s := data["Site"].(map[string]any)
	siteName, _ := s["siteName"].(string)
	data["siteName"] = siteName
	// Task 28-b: TDK 改由 seoConfig tocTitle/tocDescription 模板渲染（目录页原先无 description）
	applyWebTDK(data, "tocTitle", "tocDescription", map[string]string{"novelTitle": title},
		title+" 全部章节目录 - "+siteName, "")
	renderPage(w, r, "toc", data)
}

// groupChaptersByVolume 目录分卷分组（Task 45-b，前台 TOC 与 admin 分卷结构共用口径）：
// 按 idx 升序的「连续同卷运行段」切组——渲染序恰为平铺序插卷头，阅读顺序零变化；
// 同卷名不连续（劣质数据）自然拆为多块，不做归并。
//   - 组 name=volume 列值；name=""（未分卷章）只在书内存在至少一个分卷时作为独立块出现
//     （模板负责展示名「未分卷」）
//   - 全书无卷（分卷列全空，绝大多数书）→ 返回空切片，模板判空回退平铺渲染零变化
func groupChaptersByVolume(chapters []map[string]any) []map[string]any {
	hasVol := false
	for _, c := range chapters {
		if v, _ := c["volume"].(string); v != "" {
			hasVol = true
			break
		}
	}
	if !hasVol {
		return []map[string]any{}
	}
	vols := make([]map[string]any, 0)
	var curName string
	var cur []map[string]any
	flush := func() {
		if cur != nil {
			vols = append(vols, map[string]any{"name": curName, "chapters": cur})
			cur = nil
		}
	}
	for _, c := range chapters {
		v, _ := c["volume"].(string)
		if cur == nil || v != curName {
			flush()
			curName = v
			cur = make([]map[string]any, 0, 8)
		}
		cur = append(cur, c)
	}
	flush()
	return vols
}

// ---------- 阅读页 ----------

func handleWebChapter(w http.ResponseWriter, r *http.Request, ps map[string]string) {
	data := webCommon(r)
	chid, err := strconv.ParseInt(ps["id"], 10, 64)
	if err != nil || chid <= 0 {
		web404(w, r, "章节不存在")
		return
	}
	var chID, chNovelID, chIdx, chWC int64
	var chTitle, chContent string
	if err := queryOne(
		`SELECT "id","novelId","idx","title","content","wordCount" FROM "Chapter" WHERE "id" = ?`,
		[]any{&chID, &chNovelID, &chIdx, &chTitle, &chContent, &chWC}, chid); err != nil {
		web404(w, r, "章节不存在")
		return
	}
	// Task 32-b: 正文三级回落（ChapterContent 分表 → Chapter.content 存量 → TXT 文件）
	chContent = loadChapterContent(chID, chNovelID, chIdx, chContent, chWC)
	novel, err := webNovelFull(chNovelID)
	if err != nil {
		web404(w, r, "书籍不存在")
		return
	}
	paras := []string{}
	for _, p := range strings.Split(chContent, "\n") {
		p = strings.TrimSpace(p)
		if p != "" {
			paras = append(paras, p)
		}
	}
	data["Chapter"] = map[string]any{
		"id": chID, "idx": chIdx, "title": chTitle, "wordCount": chWC, "Paragraphs": paras,
	}
	// Paragraphs 顶层副本：主题模板存在 {{range .Paragraphs}} 顶层用法（双挂载兼容两种路径）
	data["Paragraphs"] = paras
	data["Novel"] = novel

	// 上一章/下一章（Task 35-a 修复：idx 相邻存在性查询而非 idx±1 精确匹配）。
	// idx 非连续是常态（storeChapter 唯一冲突顺延、audit 去重删行、历史数据断档），
	// 旧版 idx±1 精确命中在断档处 Prev/Next 恒空 → 阅读页翻页死链；
	// 与 api_chapters.go handleChapterDetail 的 idx</> 邻接查询同口径。
	fetchPrev := func() map[string]any {
		var id, aidx int64
		var t string
		if err := queryOne(
			`SELECT "id","idx","title" FROM "Chapter" WHERE "novelId" = ? AND "idx" < ? ORDER BY "idx" DESC LIMIT 1`,
			[]any{&id, &aidx, &t}, chNovelID, chIdx); err != nil {
			return nil
		}
		return map[string]any{"id": id, "idx": aidx, "title": t}
	}
	fetchNext := func() map[string]any {
		var id, aidx int64
		var t string
		if err := queryOne(
			`SELECT "id","idx","title" FROM "Chapter" WHERE "novelId" = ? AND "idx" > ? ORDER BY "idx" ASC LIMIT 1`,
			[]any{&id, &aidx, &t}, chNovelID, chIdx); err != nil {
			return nil
		}
		return map[string]any{"id": id, "idx": aidx, "title": t}
	}
	data["Prev"] = fetchPrev()
	data["Next"] = fetchNext()

	title, _ := novel["title"].(string)
	chAuthor, _ := novel["author"].(string)
	s := data["Site"].(map[string]any)
	siteName, _ := s["siteName"].(string)
	data["siteName"] = siteName
	// Task 28-b: TDK 改由 seoConfig chapterTitle/chapterDescription 模板渲染（阅读页原先无 description）
	vars := map[string]string{
		"novelTitle": title, "chapterTitle": chTitle, "idx": itoa(int(chIdx)), "author": chAuthor,
	}
	applyWebTDK(data, "chapterTitle", "chapterDescription", vars,
		title+" "+chTitle+" - "+siteName, "")
	// Task 28-c: 后台 seoConfig chapterKeywords 模板 → <meta name="keywords">（28-b 移交项）
	applyWebKeywords(data, "chapterKeywords", vars, title+","+chTitle+","+chAuthor)
	renderPage(w, r, "chapter", data)
}

// ---------- 搜索页 ----------

func handleWebSearch(w http.ResponseWriter, r *http.Request) {
	data := webCommon(r)
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if len([]rune(q)) > 60 {
		q = string([]rune(q)[:60])
	}
	data["Q"] = q
	novels := []map[string]any{}
	if q != "" {
		// Task 36-b: 反斜杠先行转义——ESCAPE '\' 语义下孤立 \ 会吞掉后续 %/_ 转义符，
		// 含 \ 的查询词匹配错乱（35-a 移交观察项落地）
		like := "%" + strings.NewReplacer(`\`, `\\`, "%", `\%`, "_", `\_`).Replace(q) + `%`
		var total int64
		_ = queryOne(
			`SELECT COUNT(*) FROM "Novel" n WHERE n."title" LIKE ? ESCAPE '\' OR n."author" LIKE ? ESCAPE '\'`,
			[]any{&total}, like, like)
		novels, _ = queryNovelList(
			` WHERE n."title" LIKE ? ESCAPE '\' OR n."author" LIKE ? ESCAPE '\'`,
			` ORDER BY n."clicks" DESC, n."id" DESC`, []any{like, like}, 100, 0)
		data["Total"] = total
	} else {
		data["Total"] = int64(0)
	}
	data["Novels"] = novels
	s := data["Site"].(map[string]any)
	siteName, _ := s["siteName"].(string)
	data["siteName"] = siteName
	// Task 28-b: TDK 改由 seoConfig searchTitle/searchDescription 模板渲染
	applyWebTDK(data, "searchTitle", "searchDescription", map[string]string{"query": q},
		"搜索："+q+" - "+siteName, "在"+siteName+"搜索“"+q+"”找到的相关小说列表。")
	renderPage(w, r, "search", data)
}

// ---------- pseo 聚合页 ----------

func handleWebPseo(w http.ResponseWriter, r *http.Request, ps map[string]string) {
	kw := ps["kw"]
	// Task 47: 与 api_pseo handlePseoKeywordPage 同款二次解码兜底（路由已解码一次，
	// 此处仅对残留 % 序列生效；畸形转义回退原值）
	if decoded, err := url.PathUnescape(kw); err == nil {
		kw = decoded
	}
	kw = sanitizeKeyword(kw)
	if kw == "" {
		web404(w, r, "聚合页不存在")
		return
	}
	data := webCommon(r)
	var status, srcCol, seedCol string
	var pageData sql.NullString
	err := queryOne(`SELECT "status","pageData","source","seed" FROM "PseoKeyword" WHERE "keyword" = ?`, []any{&status, &pageData, &srcCol, &seedCol}, kw)
	generated := err == nil && status == "generated" && pageData.Valid && pageData.String != ""
	var saved struct {
		Description string    `json:"generatedDescription"`
		NovelIDs    []float64 `json:"novelIds"`
	}
	generated = generated && json.Unmarshal([]byte(pageData.String), &saved) == nil
	var novels []map[string]any
	desc := ""
	if generated {
		// 按 novelIds 原序取书（绑定书置顶=最佳匹配语义，与 api_pseo 一致）
		seen := map[int64]bool{}
		for _, fid := range saved.NovelIDs {
			id := int64(fid)
			if id <= 0 || seen[id] {
				continue
			}
			seen[id] = true
			v, err := webNovelFull(id)
			if err == nil {
				novels = append(novels, v)
			}
		}
		desc = saved.Description
	} else {
		// Task 47: 实时计算兜底（与 API handlePseoKeywordPage 语义对齐，消灭 chips→404）：
		// 词池 pending/failed 行、生成窗口期的书名词/作者词（不入池）均实时聚合并渲染；
		// 词面零命中的任意 URL 仍 404（防垃圾词软 404 页堆积）
		rt, ok := pseoRealtimeNovels(kw)
		if !ok {
			web404(w, r, "聚合页不存在")
			return
		}
		novels = rt
	}
	// Task 59 v4-③: 种子书置顶主打——pSEO 页书籍信息+简介应为种子书（血缘 seed/source
	// 解析）的信息，而非匹配列表里点击最高的另一本；种子书不可考时维持 novels[0] 语义。
	// 存量已生成页 novelIds 非种子书置顶的，也在此处重排（渲染时根治，不依赖重新生成）。
	// Task 67-②: 血缘不可考时按词面兜底（keyword 恰为某书名 → 该书即种子书）
	if sn, sid := pseoFeaturedNovel(kw, srcCol, seedCol, novels); sn != nil {
		novels = pseoPromoteSeedNovel(novels, sn, sid)
	}
	if desc == "" {
		s := data["Site"].(map[string]any)
		siteName, _ := s["siteName"].(string)
		desc = siteName + "为您精选与“" + kw + "”相关的小说合集，在线免费阅读。"
	}
	data["Keyword"] = kw
	data["Description"] = desc
	data["Novels"] = novels
	s := data["Site"].(map[string]any)
	siteName, _ := s["siteName"].(string)
	data["siteName"] = siteName

	// Task 50-①: 主打书区块（书籍页前两区块语义复刻：封面属性盒 + 简介/标签）——
	// Task 59 起 novels[0] 已由种子书置顶保证（有血缘时=种子书；无血缘时=最佳匹配）。
	// 章节元数据借 chapterMetaBlock（与书籍页同口径），键名加 Featured 前缀避免与顶层契约撞车。
	if len(novels) > 0 {
		fn := novels[0]
		if fid, _ := fn["id"].(int64); fid > 0 {
			data["Featured"] = fn
			ft, _ := fn["title"].(string)
			fa, _ := fn["author"].(string)
			data["FeaturedTags"] = novelPseoTags(ft, fa)
			for k, v := range chapterMetaBlock(fid) {
				data["Featured"+k] = v
			}
		}
	}

	// Task 28-b: TDK 改由 seoConfig pseoTitle/pseoDescription 模板渲染（与聚合页生成链路同变量集）
	vars := map[string]string{"keyword": kw, "count": itoa(len(novels))}
	applyWebTDK(data, "pseoTitle", "pseoDescription", vars,
		"关于“"+kw+"”的小说推荐 - "+siteName, excerptN(desc, 100))
	// Task 28-c: 后台 seoConfig pseoKeywords 模板 → <meta name="keywords">（28-b 移交项）
	applyWebKeywords(data, "pseoKeywords", vars, kw+","+kw+"小说,"+kw+"推荐")
	renderPage(w, r, "pseo", data)
}

// pseoRealtimeNovels 聚合页实时兜底取书（Task 47）：关键词词面确有命中书目（标题/作者/
// 简介/分类 LIKE ≥1）时返回 matchNovels 聚合结果；零命中返回 false（调用方 404，
// 防任意垃圾 URL 软 404 页）。词池 pending/failed 行与不入池的作者词均由此获得有效页面。
func pseoRealtimeNovels(kw string) ([]map[string]any, bool) {
	parts := splitJSSpace(kw)
	if len(parts) == 0 {
		return nil, false
	}
	conds := make([]string, 0, len(parts))
	args := make([]any, 0, len(parts)*4)
	for _, p := range parts {
		conds = append(conds, `(n."title" LIKE ? OR n."author" LIKE ? OR n."description" LIKE ? OR c."name" LIKE ?)`)
		like := likeWrap(p)
		args = append(args, like, like, like, like)
	}
	var total int64
	if err := queryOne(`SELECT COUNT(*) FROM "Novel" n LEFT JOIN "Category" c ON c."id" = n."categoryId" WHERE `+strings.Join(conds, " OR "), []any{&total}, args...); err != nil || total <= 0 {
		return nil, false
	}
	novels, err := matchNovels(kw)
	if err != nil {
		return nil, false
	}
	return novels, true
}

// ---------- 管理后台 ----------

func handleWebAdmin(w http.ResponseWriter, r *http.Request) {
	data := webCommon(r)
	// admin 页面固定用 templates/admin/admin.html（自包含 layout，不随前台主题切换）
	data["theme"] = "admin"

	rules := []map[string]any{}
	_ = queryList(
		// Task 53: cookies 列与 admin.html Cookie 列契约对齐（服务端首屏 {{if .cookies}}
		// 需要该键，缺失恒渲染「—」；JS 刷新前的降级首屏也如实显示）
		`SELECT "id","name","siteUrl","enabled","charset","proxy","insecureTLS","cookies","notes","updatedAt" FROM "ScrapeRule" ORDER BY "id" ASC`,
		func(rows *sql.Rows) error {
			var id int64
			var name, siteUrl, charset, proxy, cookies, notes string
			var enabled, insecure bool
			var updated any
			if err := rows.Scan(&id, &name, &siteUrl, &enabled, &charset, &proxy, &insecure, &cookies, &notes, &updated); err == nil {
				rules = append(rules, map[string]any{
					"id": id, "name": name, "siteUrl": siteUrl, "enabled": enabled,
					"charset": charset, "proxy": proxy, "insecureTLS": insecure,
					"cookies": cookies, "notes": notes, "updatedAt": updated,
				})
			}
			return nil
		})
	// E19（61-R4）: 巡检结果装配（读败降级空 map → 首屏全部「未巡检」，不影响主功能）
	healthMap := ruleHealthByRule()
	for i := range rules {
		if idv, ok := rules[i]["id"].(int64); ok {
			rules[i]["health"] = healthMap[idv]
		}
	}
	data["Rules"] = rules

	tasks := []map[string]any{}
	_ = queryList(
		`SELECT t."id", COALESCE(t."ruleId",0), COALESCE(r."name",''), t."mode", t."targetUrl", t."pages", t."status", t."total", t."done", t."created", t."updated", t."chapters", t."message", t."updatedAt" FROM "ScrapeTask" t LEFT JOIN "ScrapeRule" r ON r."id" = t."ruleId" ORDER BY t."id" DESC LIMIT 100`,
		func(rows *sql.Rows) error {
			var id, ruleID, pages, total, done, created, updatedN, chapters int64
			var ruleName, mode, targetUrl, status, message string
			var updatedAt any
			if err := rows.Scan(&id, &ruleID, &ruleName, &mode, &targetUrl, &pages, &status, &total, &done, &created, &updatedN, &chapters, &message, &updatedAt); err == nil {
				tasks = append(tasks, map[string]any{
					"id": id, "ruleId": ruleID, "ruleName": ruleName, "mode": mode,
					"targetUrl": targetUrl, "pages": pages, "status": status,
					"total": total, "done": done, "created": created, "updated": updatedN,
					"chapters": chapters, "message": message, "updatedAt": updatedAt,
				})
			}
			return nil
		})
	data["Tasks"] = tasks
	data["Categories"] = navCategoriesAll()
	data["Pseo"] = pseoList(50)
	data["Themes"] = themeNames
	data["Settings"] = adminSettings()

	novels, _ := queryNovelList("", ` ORDER BY n."updatedAt" DESC, n."id" DESC`, nil, 50, 0)
	data["Novels"] = novels
	data["Stats"] = adminStats()

	s := data["Site"].(map[string]any)
	siteName, _ := s["siteName"].(string)
	data["siteName"] = siteName
	data["pageTitle"] = "站点管理后台"
	renderPage(w, r, "admin", data)
}

func navCategoriesAll() []map[string]any {
	out := []map[string]any{}
	_ = queryList(
		`SELECT c."id", c."name", c."sort", (SELECT COUNT(*) FROM "Novel" n WHERE n."categoryId" = c."id") FROM "Category" c ORDER BY c."sort" ASC, c."id" ASC`,
		func(rows *sql.Rows) error {
			var id, sort_, count int64
			var name string
			if err := rows.Scan(&id, &name, &sort_, &count); err == nil {
				out = append(out, map[string]any{"id": id, "name": name, "sort": sort_, "novelCount": count})
			}
			return nil
		})
	return out
}

func pseoList(limit int) []map[string]any {
	out := []map[string]any{}
	_ = queryList(
		`SELECT "id","keyword","source","status","createdAt" FROM "PseoKeyword" ORDER BY "id" DESC LIMIT ?`,
		func(rows *sql.Rows) error {
			var id int64
			var kw, source, status string
			var createdAt any
			if err := rows.Scan(&id, &kw, &source, &status, &createdAt); err == nil {
				out = append(out, map[string]any{"id": id, "keyword": kw, "source": source, "status": status, "createdAt": createdAt})
			}
			return nil
		}, limit)
	return out
}

func adminSettings() map[string]any {
	s := loadWebSettings()
	if s == nil {
		return map[string]any{}
	}
	return map[string]any{
		"siteName":    s.SiteName,
		"activeTheme": s.ActiveTheme,
		"notice":      s.Notice,
	}
}

func adminStats() map[string]any {
	var novelCount, chapterCount, taskCount, ruleCount, pseoCount int64
	_ = queryOne(`SELECT COUNT(*) FROM "Novel"`, []any{&novelCount})
	_ = queryOne(`SELECT COUNT(*) FROM "Chapter"`, []any{&chapterCount})
	_ = queryOne(`SELECT COUNT(*) FROM "ScrapeTask"`, []any{&taskCount})
	_ = queryOne(`SELECT COUNT(*) FROM "ScrapeRule"`, []any{&ruleCount})
	_ = queryOne(`SELECT COUNT(*) FROM "PseoKeyword"`, []any{&pseoCount})
	return map[string]any{
		"novelCount": novelCount, "chapterCount": chapterCount,
		"taskCount": taskCount, "ruleCount": ruleCount, "pseoCount": pseoCount,
	}
}

// ---------- 404 ----------

// web404 极简 404 页（不走主题模板，避免主题缺页时二次失败）
func web404(w http.ResponseWriter, r *http.Request, msg string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(404)
	s := loadWebSettings()
	name := "青阅文学"
	if s != nil && s.SiteName != "" {
		name = s.SiteName
	}
	// Task 36-b: 站名过 HTML 转义（DB 值手改/历史行非可信输入，与 renderPage 终极兜底同口径）
	_, _ = w.Write([]byte(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>404 - ` + template.HTMLEscapeString(name) + `</title></head>` +
		`<body style="margin:0;font-family:system-ui,sans-serif;background:#fafafa"><div style="max-width:480px;margin:12vh auto;text-align:center;padding:0 16px">` +
		`<p style="font-size:64px;margin:0;color:#d4d4d4;font-weight:700">404</p>` +
		`<p style="color:#525252;margin:16px 0">` + msg + `</p>` +
		`<a href="/" style="display:inline-block;padding:10px 24px;background:#171717;color:#fff;border-radius:8px;text-decoration:none">返回首页</a>` +
		`</div></body></html>`))
}
