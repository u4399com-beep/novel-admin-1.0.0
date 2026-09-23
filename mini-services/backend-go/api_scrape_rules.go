/**
 * api_scrape_rules.go —— 业务 API：采集规则 CRUD + 内置模板 seed。
 *
 * 对应 TS 源：src/app/api/scrape-rules/route.ts（逐行移植）
 *   - GET    → handleScrapeRulesList（safeParseRule 解析三个规则 JSON）
 *   - POST   → handleSave（新建；body.id 存在时为更新）
 *   - PUT    → {seed:true} 内置 4 模板事务入库（幂等按 name 跳过）；否则与 POST 相同
 *   - DELETE → ?id= 删除（规则不存在视为成功，幂等）
 *
 * 契约要点：
 * - 列表行字段：id/name/siteUrl/enabled/charset/proxy/insecureTLS/listRule/bookRule/
 *   chapterRule/notes（三个规则为对象，{} 兜底）
 * - handleSave 校验顺序与文案逐条对齐（name/enabled/insecureTLS/charset/notes/siteUrl/proxy/id）
 * - 保存失败唯一冲突 → 409 {error:'规则名称已存在'}（无 detail 键，对齐 JSON.stringify 丢弃 undefined）
 * - 更新不存在（P2025 语义）→ 404 {error:'规则不存在'}；其余 500 {error:'保存失败',detail}
 *
 * 移植语义差异：
 * 1. Prisma @updatedAt → UPDATE 显式 set updatedAt=nowMillis()；INSERT 显式双时间戳
 * 2. seed 的 $transaction → database/sql Begin/Commit（同进程单写者，BEGIN IMMEDIATE 级语义等价）
 * 3. seed 规则 JSON 的键序：JSON.stringify 按插入序、Go map 序列化按字母序（引擎按键读取，语义一致）
 */
package main

import (
	"database/sql"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

func init() {
	register("GET", "/api/scrape-rules", handleScrapeRulesList)
	register("POST", "/api/scrape-rules", handleScrapeRulesSave)
	register("PUT", "/api/scrape-rules", handleScrapeRulesPut)
	register("DELETE", "/api/scrape-rules", handleScrapeRulesDelete)
}

// ==================== GET /api/scrape-rules ====================

func handleScrapeRulesList(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	rows := make([]map[string]any, 0)
	err := queryList(
		`SELECT "id","name","siteUrl","enabled","charset","proxy","insecureTLS","listRule","bookRule","chapterRule","notes" FROM "ScrapeRule" ORDER BY "id" ASC`,
		func(rs *sql.Rows) error {
			var id int64
			var name, siteURL, charset, proxy, listRule, bookRule, chapterRule, notes string
			var enabled, insecureTLS bool
			if err := rs.Scan(&id, &name, &siteURL, &enabled, &charset, &proxy, &insecureTLS, &listRule, &bookRule, &chapterRule, &notes); err != nil {
				return err
			}
			rows = append(rows, map[string]any{
				"id":          id,
				"name":        name,
				"siteUrl":     siteURL,
				"enabled":     enabled,
				"charset":     charset,
				"proxy":       proxy,
				"insecureTLS": insecureTLS,
				"listRule":    safeParseRule(listRule),
				"bookRule":    safeParseRule(bookRule),
				"chapterRule": safeParseRule(chapterRule),
				"notes":       notes,
			})
			return nil
		})
	if err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	writeJSON(w, 200, rows)
}

// ==================== proxy 字段解析（TS parseProxyField 逐行移植） ====================

type proxyFieldResult struct {
	value string
	err   string
}

func parseProxyField(raw any) proxyFieldResult {
	if raw == nil {
		return proxyFieldResult{value: ""}
	}
	s, isStr := raw.(string)
	if !isStr {
		return proxyFieldResult{err: "proxy 必须是字符串"}
	}
	if s == "" {
		return proxyFieldResult{value: ""}
	}
	t := trimSpaceStr(s)
	if t == "" {
		return proxyFieldResult{value: ""}
	}
	if runeLen(t) > 1024 {
		return proxyFieldResult{err: "proxy 过长（上限 1024 字符）"}
	}
	parts := make([]string, 0)
	for _, p := range strings.Split(t, ",") {
		p = trimSpaceStr(p)
		if p == "" {
			continue
		}
		u, err := url.Parse(p)
		badForm := proxyFieldResult{err: "proxy 形态非法（" + truncateRunes(p, 40) + "；示例：socks5h://user:pass@host:port，多个用英文逗号分隔）"}
		if err != nil || u.Host == "" {
			// JS new URL(p) 抛异常（含空主机/非法端口）
			return badForm
		}
		switch u.Scheme {
		case "http", "https", "socks5", "socks5h", "socks4":
		default:
			return proxyFieldResult{err: "proxy 仅支持 http/https/socks5/socks5h/socks4 形态（如 socks5h://127.0.0.1:1080）"}
		}
		if port := u.Port(); port != "" {
			if n, perr := strconv.Atoi(port); perr != nil || n < 0 || n > 65535 {
				return badForm
			}
		}
		parts = append(parts, p)
	}
	return proxyFieldResult{value: strings.Join(parts, ",")}
}

// ==================== 保存（POST/PUT 共用） ====================

// scrapeRulesBodyOK TS `if (!body) return 400`：null/原始类型失败，数组通过（后续 name 校验兜住）
func scrapeRulesBodyOK(v any, ok bool) bool {
	if !ok || v == nil {
		return false
	}
	switch v.(type) {
	case map[string]any, []any:
		return true
	}
	return false
}

func handleScrapeRulesSave(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	v, ok := readBodyValue(r)
	if !scrapeRulesBodyOK(v, ok) {
		writeJSON(w, 400, map[string]string{"error": "请求体必须是 JSON 对象"})
		return
	}
	handleScrapeRulesSaveBody(w, bodyMap(v))
}

func handleScrapeRulesSaveBody(w http.ResponseWriter, body map[string]any) {
	name, _ := body["name"].(string)
	if trimSpaceStr(name) == "" {
		writeJSON(w, 400, map[string]string{"error": "name 必填"})
		return
	}
	if val, present := body["enabled"]; present {
		if _, isBool := val.(bool); !isBool {
			writeJSON(w, 400, map[string]string{"error": "enabled 必须是布尔值"})
			return
		}
	}
	if val, present := body["insecureTLS"]; present {
		if _, isBool := val.(bool); !isBool {
			writeJSON(w, 400, map[string]string{"error": "insecureTLS 必须是布尔值"})
			return
		}
	}
	if val, present := body["charset"]; present && val != nil {
		if _, isStr := val.(string); !isStr {
			writeJSON(w, 400, map[string]string{"error": "charset 必须是字符串"})
			return
		}
	}
	if val, present := body["notes"]; present && val != nil {
		if _, isStr := val.(string); !isStr {
			writeJSON(w, 400, map[string]string{"error": "notes 必须是字符串"})
			return
		}
	}
	site := parseHttpURL(body["siteUrl"], "siteUrl", 200)
	if !site.ok {
		writeJSON(w, 400, map[string]string{"error": site.message})
		return
	}
	proxy := parseProxyField(body["proxy"])
	if proxy.err != "" {
		writeJSON(w, 400, map[string]string{"error": proxy.err})
		return
	}
	if val, present := body["id"]; present {
		f, isNum := val.(float64)
		if !isNum || !numIsInt(f) || f <= 0 {
			writeJSON(w, 400, map[string]string{"error": "无效 id"})
			return
		}
	}

	// ---- 规则三字段（listRule/bookRule/chapterRule）提取与校验 ----
	// 更新路径语义（Task 26-d 修复）：字段缺失/null → 保留 DB 旧值（部分更新）；
	// 字段为 JSON 对象 → sanitize 后整体覆盖；字段为其他类型 → 400 拒绝，
	// 绝不静默置 {}（Task 24-d 实证：PUT 只传 name+notes 会把三条规则连清）。
	// 新建路径语义不变：缺失 → {}（对齐 TS Prisma 写入）。
	isUpdate := false
	if f, isNum := body["id"].(float64); isNum && numIsInt(f) && f > 0 {
		isUpdate = true
	}
	listObj, listProvided, listErr := ruleFieldObj(body["listRule"], "listRule")
	if listErr != "" {
		writeJSON(w, 400, map[string]string{"error": listErr})
		return
	}
	bookObj, bookProvided, bookErr := ruleFieldObj(body["bookRule"], "bookRule")
	if bookErr != "" {
		writeJSON(w, 400, map[string]string{"error": bookErr})
		return
	}
	chapObj, chapProvided, chapErr := ruleFieldObj(body["chapterRule"], "chapterRule")
	if chapErr != "" {
		writeJSON(w, 400, map[string]string{"error": chapErr})
		return
	}
	listJSON, bookJSON, chapJSON := "{}", "{}", "{}"
	if isUpdate {
		var oldList, oldBook, oldChap sql.NullString
		if err := queryOne(`SELECT "listRule","bookRule","chapterRule" FROM "ScrapeRule" WHERE "id" = ?`,
			[]any{&oldList, &oldBook, &oldChap}, int(body["id"].(float64))); err != nil && !isNoRows(err) {
			failJSON(w, "服务器错误", firstLineErr(err), 500)
			return
		}
		if !listProvided {
			listJSON = nonEmptyJSON(oldList.String)
		}
		if !bookProvided {
			bookJSON = nonEmptyJSON(oldBook.String)
		}
		if !chapProvided {
			chapJSON = nonEmptyJSON(oldChap.String)
		}
	}
	if listProvided {
		listJSON = marshalCompact(sanitizeRuleMap(listObj))
	}
	if bookProvided {
		bookJSON = marshalCompact(sanitizeRuleMap(bookObj))
	}
	if chapProvided {
		chapJSON = marshalCompact(sanitizeRuleMap(chapObj))
	}

	enabled := true
	if b, isBool := body["enabled"].(bool); isBool {
		enabled = b
	}
	charset := "utf-8"
	if cs, isStr := body["charset"].(string); isStr && trimSpaceStr(cs) != "" {
		charset = cs
	}
	charset = truncateRunes(strings.ToLower(charset), 32)
	insecureTLS, _ := body["insecureTLS"].(bool)
	notes, _ := body["notes"].(string)

	name = truncateRunes(trimSpaceStr(name), 80)

	if f, isNum := body["id"].(float64); isNum && numIsInt(f) && f > 0 {
		id := int(f)
		res, err := exec(
			`UPDATE "ScrapeRule" SET "name"=?, "siteUrl"=?, "enabled"=?, "charset"=?, "proxy"=?, "insecureTLS"=?, "listRule"=?, "bookRule"=?, "chapterRule"=?, "notes"=?, "updatedAt"=? WHERE "id"=?`,
			name, site.value, enabled, charset, proxy.value, insecureTLS,
			listJSON, bookJSON, chapJSON,
			truncateRunes(notes, 1000), nowMillis(), id,
		)
		if err != nil {
			failJSON(w, "服务器错误", firstLineErr(err), 500)
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			writeJSON(w, 404, map[string]string{"error": "规则不存在"})
			return
		}
		writeJSON(w, 200, map[string]any{"id": id})
		return
	}

	newID, err := execReturningID(
		`INSERT INTO "ScrapeRule" ("name","siteUrl","enabled","charset","proxy","insecureTLS","listRule","bookRule","chapterRule","notes","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
		name, site.value, enabled, charset, proxy.value, insecureTLS,
		listJSON, bookJSON, chapJSON,
		truncateRunes(notes, 1000), nowMillis(), nowMillis(),
	)
	if err != nil {
		if isUniqueConflict(err) {
			// TS conflict 分支 detail 为 undefined → JSON 无 detail 键
			writeJSON(w, 409, map[string]string{"error": "规则名称已存在"})
			return
		}
		writeJSON(w, 500, map[string]string{"error": "保存失败", "detail": firstLineErr(err)})
		return
	}
	writeJSON(w, 201, map[string]any{"id": newID})
}

// ==================== DELETE /api/scrape-rules?id= ====================

func handleScrapeRulesDelete(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	id, ok := parsePositiveInt(parseQueryStr(r, "id"))
	if !ok {
		writeJSON(w, 400, map[string]string{"error": "无效 id"})
		return
	}
	res, err := exec(`DELETE FROM "ScrapeRule" WHERE "id" = ?`, id)
	if err != nil {
		// 规则不存在视为删除成功（幂等）；其他真实 DB 错误如实 500
		writeJSON(w, 500, map[string]string{"error": "删除规则失败", "detail": firstLineErr(err)})
		return
	}
	_ = res // RowsAffected==0（P2025 语义）同样返回 ok:true
	writeJSON(w, 200, map[string]any{"ok": true})
}

// ==================== PUT /api/scrape-rules（seed 或全字段保存） ====================

func handleScrapeRulesPut(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	v, ok := readBodyValue(r)
	if !scrapeRulesBodyOK(v, ok) {
		// TS PUT 非 seed 分支与 POST 同一保存函数，body 缺失时 POST 返回
		// 400「请求体必须是 JSON 对象」→ PUT 保持同文案（修复旧版落到「name 必填」的文案漂移）
		writeJSON(w, 400, map[string]string{"error": "请求体必须是 JSON 对象"})
		return
	}
	body := bodyMap(v)
	if jsTruthy(body["seed"]) {
		handleScrapeRulesSeed(w)
		return
	}
	handleScrapeRulesSaveBody(w, body)
}

// ruleFieldObj 提取 listRule/bookRule/chapterRule 字段：
//   - 缺失/JSON null → (nil, false, "")      → 调用方按「未提供」处理（更新保留旧值）
//   - JSON 对象      → (map, true, "")
//   - 其他类型（字符串/数字/数组）→ (nil, false, 错误文案) —— 显式 400，
//     杜绝 Task 24-d 实证事故：listRule 传字符串被静默 sanitize 成 {} 且连清
//     bookRule/chapterRule，规则被整条清空
func ruleFieldObj(v any, field string) (map[string]any, bool, string) {
	if v == nil {
		return nil, false, ""
	}
	if m, ok := v.(map[string]any); ok {
		return m, true, ""
	}
	return nil, false, field + " 必须是 JSON 对象（如 {\"itemSelector\":\"…\"}），收到 " + jsTypeName(v)
}

func jsTypeName(v any) string {
	switch v.(type) {
	case string:
		return "字符串"
	case float64:
		return "数字"
	case bool:
		return "布尔"
	case []any:
		return "数组"
	default:
		return "非对象值"
	}
}

// nonEmptyJSON DB 规则 JSON 列兜底：空/损坏 → "{}"（保留旧值路径专用，防写出非法 JSON）
func nonEmptyJSON(s string) string {
	t := strings.TrimSpace(s)
	if t == "" || t[0] != '{' {
		return "{}"
	}
	return t
}

// jsTruthy TS 真值判定（body?.seed）
func jsTruthy(v any) bool {
	switch x := v.(type) {
	case bool:
		return x
	case float64:
		return x != 0
	case string:
		return x != ""
	case nil:
		return false
	default:
		return true
	}
}

// seedRuleDef 内置模板定义（与 TS SEED_RULES 逐字段一致）
type seedRuleDef struct {
	name        string
	siteURL     string
	charset     string
	listRule    map[string]string
	bookRule    map[string]string
	chapterRule map[string]string
	notes       string
}

var seedRules = []seedRuleDef{
	{
		name:     "笔趣阁系通用模板",
		siteURL:  "https://www.23qb.net/",
		charset:  "utf-8",
		listRule: map[string]string{"itemSelector": ".module-item", "titleSelector": ".module-item-title", "linkSelector": ".module-item-title", "authorSelector": ".module-item-text"},
		bookRule: map[string]string{
			"titleSelector":       "h1.page-title",
			"authorSelector":      "a[href*=\"/author/\"]@title",
			"descriptionSelector": ".novel-info-content",
			"coverSelector":       ".novel-cover img@data-src, .novel-cover img@src",
			"chapterLinkSelector": ".module-row-text",
			"catalogLinkSelector": "a.catalog-more",
		},
		chapterRule: map[string]string{"titleSelector": "h1", "contentSelector": ".article-content"},
		notes: "2026-09 实测对齐「铅笔小说」（原 23qb）module 系新模板：书页仅含最新 9 章，" +
			"catalogLinkSelector=a.catalog-more 指向完整目录 /book/{id}/catalog 由 worker 整目提取；章节单页无分页。",
	},
	{
		name:     "顶点系通用模板",
		siteURL:  "https://www.ddyueshu.cc/",
		charset:  "gbk",
		listRule: map[string]string{"itemSelector": "#hotcontent .item, #newscontent .l ul li", "titleSelector": "dt a, .s2 a", "authorSelector": "dt span, .s4"},
		bookRule: map[string]string{
			"titleSelector":       "#info h1",
			"authorSelector":      "#info p:first-of-type",
			"descriptionSelector": "#intro",
			"coverSelector":       "#fmimg img@src",
			"chapterLinkSelector": "#list dl dd a",
		},
		chapterRule: map[string]string{"titleSelector": "h1", "contentSelector": "#content"},
		notes: "2026-09 实测对齐顶点（杰奇结构）：书页 #info/#intro/#list dl dd 全目录（注意该站 href=\"…\" 等号前带空格的反爬写法，cheerio 可正常解析）；" +
			"作者「作 者：」前缀由引擎自动剥离；章节单页无 link_next。charset=gbk（直连会被重置，需引擎 fetch-browser 策略）。",
	},
	{
		name:     "ShipSay CMS 模板",
		siteURL:  "http://demo.shipsay.com/",
		charset:  "utf-8",
		listRule: map[string]string{"itemSelector": ".book-list .book", "titleSelector": ".title a", "authorSelector": ".author"},
		bookRule: map[string]string{"titleSelector": "h1.book-title", "authorSelector": ".book-author", "descriptionSelector": ".book-intro", "chapterLinkSelector": ".chapter-list a"},
		chapterRule: map[string]string{
			"titleSelector":   "h1.chapter-title",
			"contentSelector": ".chapter-content",
			"nextSelector":    "a.next-chapter",
		},
		notes: "ShipSay CMS 模板（原演示站 demo.shipsay.com 已下线 502，规则保留供同结构站点复用）。",
	},
	{
		name:     "爱尚系现代模板",
		siteURL:  "https://www.aijjxs.com/",
		charset:  "utf-8",
		listRule: map[string]string{"itemSelector": ".catalog .listbg, .listbg", "titleSelector": ".title a", "linkSelector": ".title a", "authorSelector": ".mainGreen a"},
		bookRule: map[string]string{
			"titleSelector":       "h3",
			"authorSelector":      ".kv a, .author-name",
			"descriptionSelector": ".intro-panel .desc, .novel-desc",
			"coverSelector":       ".pic img@src",
			"statusSelector":      ".kv .sfwj",
			"chapterLinkSelector": "none",
			"excludeSelector":     "h1.logo, .top, .search",
		},
		chapterRule: map[string]string{
			"titleSelector":   "h1.chapter-heading",
			"contentSelector": ".chapter-body",
			"nextSelector":    "a[rel=\"next\"]",
			"excludeSelector": "h1.logo, .top, .search",
		},
		notes: "帝国CMS TXT下载站（久久小说下载网）实测对齐：全站 h1.logo 为站标「站内搜索…」需排除；" +
			"书页 h3 书名/.kv 作者/.desc 简介；chapterLinkSelector=none 表示仅采书籍信息（下载站无章节列表，" +
			"避免启发式把其他书籍链接误判为章节）。",
	},
}

// handleScrapeRulesSeed 事务内逐条幂等入库（已存在按 name 跳过），全部成功才提交
func handleScrapeRulesSeed(w http.ResponseWriter) {
	db, err := getDB()
	if err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	tx, err := db.Begin()
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "内置模板入库失败", "detail": firstLineErr(err)})
		return
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	added := 0
	now := nowMillis()
	for _, def := range seedRules {
		var existsID int64
		err := tx.QueryRow(`SELECT "id" FROM "ScrapeRule" WHERE "name" = ?`, def.name).Scan(&existsID)
		if err == nil {
			continue // 已存在按 name 跳过（幂等）
		}
		if !isNoRows(err) {
			writeJSON(w, 500, map[string]string{"error": "内置模板入库失败", "detail": firstLineErr(err)})
			return
		}
		if _, err := tx.Exec(
			`INSERT INTO "ScrapeRule" ("name","siteUrl","enabled","charset","proxy","insecureTLS","listRule","bookRule","chapterRule","notes","createdAt","updatedAt") VALUES (?,?,1,?,'',0,?,?,?,?,?,?)`,
			def.name, def.siteURL, def.charset,
			marshalCompact(def.listRule), marshalCompact(def.bookRule), marshalCompact(def.chapterRule),
			def.notes, now, now,
		); err != nil {
			writeJSON(w, 500, map[string]string{"error": "内置模板入库失败", "detail": firstLineErr(err)})
			return
		}
		added++
	}
	if err := tx.Commit(); err != nil {
		writeJSON(w, 500, map[string]string{"error": "内置模板入库失败", "detail": firstLineErr(err)})
		return
	}
	committed = true
	writeJSON(w, 200, map[string]any{"added": added})
}
