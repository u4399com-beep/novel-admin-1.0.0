/**
 * api_novels.go —— 业务 API：小说列表/详情/管理 + 书籍章节目录。
 *
 * 对应 TS 源：
 *   - src/app/api/novels/route.ts               → handleNovelsList / handleNovelsCreate
 *   - src/app/api/novels/[id]/route.ts          → handleNovelDetail / handleNovelUpdate / handleNovelDelete
 *   - src/app/api/novels/[id]/chapters/route.ts → handleNovelChapters
 *
 * 本文件同时承载全包共享的 JS 语义小工具（数值解析 / 分页参数 / 小说列表行映射 /
 * 请求体读取），供 home/pseo/chapters/scrape 等域复用。骨架 httpx.go 的 readJSON
 * 错误文案与 TS 契约不一致（TS 各路由文案不同），故请求体统一走 readBodyValue，
 * 由各路由自行还原 TS 错误文案。
 *
 * 移植语义差异（诚实标注）：
 *   1. JS slice() 按 UTF-16 码元截断，Go 按 rune（仅 astral 字符（如 emoji）计数不同，中文无差异）
 *   2. Prisma contains 在 SQLite 下编译为 LIKE（ASCII 大小写不敏感），移植用 LIKE 且
 *      不转义 %/_（与 Prisma 行为一致）
 *   3. TS 列表 ORDER BY 未指定并列顺序，Go 追加 id DESC 兜底，保证分页确定性
 *   4. 病理输入（如 description 传数字 → TS TypeError 500）在 Go 按空串/缺省处理，不再 500
 *   5. 未捕获 DB 异常 TS 返回 Next 500（HTML），Go 统一返回 {error,detail} JSON 500
 */
package main

import (
	"database/sql"
	"encoding/json"
	"math"
	"math/rand"
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

func init() {
	register("GET", "/api/novels", handleNovelsList)
	register("POST", "/api/novels", handleNovelsCreate)
	// 骨架 dispatch 对参数路由「方法盲」（同 pattern 首个路径匹配者吞掉所有 method），
	// 故同一 pattern 按 method 各注册一次 mux，mux 内按真实 method 分发——
	// 该注册方式在骨架现行为与未来 dispatch 方法感知修复两种语义下均正确。
	register("GET", "/api/novels/{id}", handleNovelByID)
	register("PUT", "/api/novels/{id}", handleNovelByID)
	register("DELETE", "/api/novels/{id}", handleNovelByID)
	register("GET", "/api/novels/{id}/chapters", handleNovelChaptersRoute)
}

// methodNotAllowed 405（结构与骨架 dispatch 的 405 一致）
func methodNotAllowed(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 405, map[string]string{"error": "方法不允许", "detail": strings.ToUpper(r.Method) + " 不支持该路径"})
}

// handleNovelByID /api/novels/{id} 方法分发（GET/PUT/DELETE，HEAD 走 GET）
func handleNovelByID(w http.ResponseWriter, r *http.Request, ps map[string]string) {
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		handleNovelDetail(w, r, ps)
	case http.MethodPut:
		handleNovelUpdate(w, r, ps)
	case http.MethodDelete:
		handleNovelDelete(w, r, ps)
	default:
		methodNotAllowed(w, r)
	}
}

// handleNovelChaptersRoute /api/novels/{id}/chapters 仅 GET（TS 只导出 GET）
func handleNovelChaptersRoute(w http.ResponseWriter, r *http.Request, ps map[string]string) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		methodNotAllowed(w, r)
		return
	}
	handleNovelChapters(w, r, ps)
}

// ==================== JS 语义共享工具 ====================

// jsParseFloat 模拟 JS Number(string)：空白串→0，非法→NaN(false)
func jsParseFloat(s string) (float64, bool) {
	t := trimSpaceStr(s)
	if t == "" {
		return 0, true
	}
	f, err := strconv.ParseFloat(t, 64)
	if err != nil {
		return math.NaN(), false
	}
	return f, true
}

// numIsInt JS Number.isInteger 数值判定
func numIsInt(f float64) bool {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return false
	}
	return f == math.Trunc(f)
}

// intFieldStrict 严格类型整数字段（JS Number.isInteger(v)：v 必须本身是 number）
func intFieldStrict(v any) (int, bool) {
	f, ok := v.(float64)
	if !ok || !numIsInt(f) {
		return 0, false
	}
	return int(f), true
}

// jsNumber JS Number() 对 JSON 值的宽式转换
func jsNumber(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case bool:
		if x {
			return 1
		}
		return 0
	case nil:
		return 0
	case string:
		f, _ := jsParseFloat(x)
		return f
	case []any:
		if len(x) == 0 {
			return 0
		}
		if len(x) == 1 {
			return jsNumber(x[0])
		}
		return math.NaN()
	default:
		return math.NaN()
	}
}

// parsePositiveInt 移植 src/lib/scrape/api-utils.ts parsePositiveInt：
// Number(raw) 后必须为正整数，否则失败
func parsePositiveInt(v any) (int64, bool) {
	f := jsNumber(v)
	if !numIsInt(f) || f <= 0 {
		return 0, false
	}
	return int64(f), true
}

// routeIntID 路径段 id 解析（Number(id) 须为整数，可负/零——与 TS Number.isInteger 对齐）。
// 非法时写 400 {error: errMsg}。
func routeIntID(w http.ResponseWriter, raw, errMsg string) (int, bool) {
	f, ok := jsParseFloat(raw)
	if !ok || !numIsInt(f) || f < math.MinInt32 || f > math.MaxInt32 {
		writeJSON(w, 400, map[string]string{"error": errMsg})
		return 0, false
	}
	return int(f), true
}

// routePosIntID 路径段 id 解析（整数且 > 0，对齐 TS `!isInteger || <= 0` 校验）
func routePosIntID(w http.ResponseWriter, raw, errMsg string) (int, bool) {
	n, ok := routeIntID(w, raw, errMsg)
	if !ok {
		return 0, false
	}
	if n <= 0 {
		writeJSON(w, 400, map[string]string{"error": errMsg})
		return 0, false
	}
	return n, true
}

// pageParamFloor 对齐 TS `Math.floor(Number(v) || def)`（Number(”)/NaN/0 → def）
func pageParamFloor(raw string, def int) int {
	if raw == "" {
		return def
	}
	f, ok := jsParseFloat(raw)
	if !ok || f == 0 {
		return def
	}
	if f > 2e9 {
		return 2_000_000_000
	}
	if f < -2e9 {
		return -2_000_000_000
	}
	return int(math.Floor(f))
}

// pageParamList 对齐 TS `Math.max(1, Math.floor(Number(v) || 1))`
func pageParamList(raw string) int {
	p := pageParamFloor(raw, 1)
	if p < 1 {
		return 1
	}
	return p
}

// readBodyValue 读请求体为任意 JSON 值（不写错误响应；由路由按 TS 契约还原文案）。
// TS 的 req.json() 无大小上限，这里 32MB 兜底防滥用。
func readBodyValue(r *http.Request) (any, bool) {
	b, err := readAllLimited(r.Body, 32<<20)
	if err != nil {
		return nil, false
	}
	var v any
	if json.Unmarshal(b, &v) != nil {
		return nil, false
	}
	return v, true
}

// bodyMap 断言请求体为 JSON 对象；数组/原始值 → nil map（字段读取等价 undefined）
func bodyMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

// jsStringify 模拟 JS String(v) 的字符串化（用于 scrape-tasks PUT mode 等宽式转换）
func jsStringify(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case nil:
		return "null"
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return fmtF(x)
	default:
		b, err := json.Marshal(x)
		if err != nil {
			return "[object Object]"
		}
		return string(b)
	}
}

// firstLineErr 移植 src/lib/errors.ts firstLine：错误首行 200 字截断（防泄露内部路径）
func firstLineErr(err error) string {
	if err == nil {
		return ""
	}
	msg := err.Error()
	if i := strings.IndexByte(msg, '\n'); i >= 0 {
		msg = msg[:i]
	}
	return truncateRunes(msg, 200)
}

// ---- JS 空白语义（\s 全集：Go \s 缺 \v 与 unicode 空白，必须显式补齐）----

var (
	jsSpaceClass    = `[\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`
	jsSpacePlusRe   = regexp.MustCompile(`[\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+`)
	jsTrimLeadRe    = regexp.MustCompile(`^[\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+`)
	jsTrimTrailRe   = regexp.MustCompile(`[\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+$`)
	jsSpaceRuneSet  = map[rune]bool{'\t': true, '\n': true, '\v': true, '\f': true, '\r': true, ' ': true, 0x00a0: true, 0x1680: true, 0x2028: true, 0x2029: true, 0x202f: true, 0x205f: true, 0x3000: true, 0xfeff: true}
	jsSpaceRuneFold = func() map[rune]bool {
		m := map[rune]bool{}
		for r := rune(0x2000); r <= 0x200a; r++ {
			m[r] = true
		}
		for r := range jsSpaceRuneSet {
			m[r] = true
		}
		return m
	}()
)

func isJSSpace(r rune) bool { return jsSpaceRuneFold[r] }

// wordCountJS 模拟 content.replace(/\s/g, ”).length（rune 计数，见头注差异 1）
func wordCountJS(s string) int {
	n := 0
	for _, r := range s {
		if !isJSSpace(r) {
			n++
		}
	}
	return n
}

// jsTrim JS String.prototype.trim 精确语义
func jsTrim(s string) string {
	return jsTrimTrailRe.ReplaceAllString(jsTrimLeadRe.ReplaceAllString(s, ""), "")
}

// splitJSSpace 模拟 s.split(/\s+/).filter(Boolean)
func splitJSSpace(s string) []string {
	parts := jsSpacePlusRe.Split(s, -1)
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// likeWrap Prisma contains 语义：'%kw%'（不转义通配符，与 Prisma 一致）
func likeWrap(s string) string { return "%" + s + "%" }

// marshalCompact JSON.stringify 等价（无 HTML 转义、无缩进、无尾随换行）
func marshalCompact(v any) string {
	var buf strings.Builder
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return "{}"
	}
	return strings.TrimRight(buf.String(), "\n")
}

// ==================== 小说列表行映射（home / pseo 复用） ====================

const novelListCols = `n."id", n."title", n."author", n."description", n."cover", n."categoryId", c."name", n."status", n."isFeatured", n."isHot", n."wordCount", n."clicks", n."updatedAt", (SELECT COUNT(*) FROM "Chapter" ch WHERE ch."novelId" = n."id") AS "chapterCount", (SELECT ch2."title" FROM "Chapter" ch2 WHERE ch2."novelId" = n."id" ORDER BY ch2."idx" DESC LIMIT 1) AS "lastChapterTitle"`

const novelListFrom = ` FROM "Novel" n LEFT JOIN "Category" c ON c."id" = n."categoryId"`

// scanNovelListItem 扫一行 → TS NovelListItem 形状的 map（字段名逐一对照 src/lib/types.ts）
func scanNovelListItem(rows *sql.Rows) (map[string]any, error) {
	var id, categoryID, wordCount, clicks, chapterCount, isFeatured, isHot, updatedAt int64
	var title, author, description, cover, status string
	var catName, lastChapterTitle sql.NullString
	if err := rows.Scan(&id, &title, &author, &description, &cover, &categoryID, &catName, &status, &isFeatured, &isHot, &wordCount, &clicks, &updatedAt, &chapterCount, &lastChapterTitle); err != nil {
		return nil, err
	}
	categoryName := "未分类"
	if catName.Valid && catName.String != "" {
		categoryName = catName.String
	}
	st := "serial"
	if status == "finished" {
		st = "finished"
	}
	var last any
	if lastChapterTitle.Valid {
		last = lastChapterTitle.String
	}
	return map[string]any{
		"id":               id,
		"title":            title,
		"author":           author,
		"description":      description,
		"cover":            cover,
		"categoryId":       categoryID,
		"categoryName":     categoryName,
		"status":           st,
		"isFeatured":       isFeatured != 0,
		"isHot":            isHot != 0,
		"wordCount":        wordCount,
		"clicks":           clicks,
		"chapterCount":     chapterCount,
		"lastChapterTitle": last,
		"updatedAt":        isoFromMillis(updatedAt),
	}, nil
}

// queryNovelList 执行列表查询并映射（whereSQL 含 WHERE 前缀或空串）
func queryNovelList(whereSQL, orderSQL string, args []any, limit, offset int) ([]map[string]any, error) {
	q := "SELECT " + novelListCols + novelListFrom + whereSQL + orderSQL + " LIMIT ? OFFSET ?"
	all := make([]map[string]any, 0)
	err := queryList(q, func(rows *sql.Rows) error {
		item, err := scanNovelListItem(rows)
		if err != nil {
			return err
		}
		all = append(all, item)
		return nil
	}, append(args, limit, offset)...)
	if err != nil {
		return nil, err
	}
	return all, nil
}

// ==================== GET /api/novels ====================

func handleNovelsList(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	sp := r.URL.Query()
	q := truncateRunes(trimSpaceStr(sp.Get("q")), 100)
	status := sp.Get("status")
	sort := sp.Get("sort")
	if sort == "" {
		sort = "latest"
	}
	page := pageParamList(sp.Get("page"))
	pageSize := clampInt(pageParamFloor(sp.Get("pageSize"), 20), 4, 60)

	// 非法 categoryId（abc/1.5/-3）→ 400（对齐 TS 明确报错而非静默全库查询）
	categoryId := 0
	if raw := sp.Get("categoryId"); raw != "" {
		f, ok := jsParseFloat(raw)
		if !ok || !numIsInt(f) || f < 0 {
			writeJSON(w, 400, map[string]string{"error": "无效 categoryId"})
			return
		}
		categoryId = int(f)
	}

	conds := []string{}
	args := []any{}
	if categoryId > 0 {
		conds = append(conds, `n."categoryId" = ?`)
		args = append(args, categoryId)
	}
	if status == "serial" || status == "finished" {
		conds = append(conds, `n."status" = ?`)
		args = append(args, status)
	}
	if q != "" {
		conds = append(conds, `(n."title" LIKE ? OR n."author" LIKE ? OR n."description" LIKE ?)`)
		like := likeWrap(q)
		args = append(args, like, like, like)
	}
	whereSQL := ""
	if len(conds) > 0 {
		whereSQL = " WHERE " + strings.Join(conds, " AND ")
	}
	var orderSQL string
	switch sort {
	case "clicks":
		orderSQL = ` ORDER BY n."clicks" DESC, n."id" DESC`
	case "words":
		orderSQL = ` ORDER BY n."wordCount" DESC, n."id" DESC`
	case "featured":
		orderSQL = ` ORDER BY n."isFeatured" DESC, n."updatedAt" DESC, n."id" DESC`
	default:
		orderSQL = ` ORDER BY n."updatedAt" DESC, n."id" DESC`
	}

	var total int64
	countQ := `SELECT COUNT(*) FROM "Novel" n` + whereSQL
	if err := queryOne(countQ, []any{&total}, args...); err != nil {
		failJSON(w, "查询失败", firstLineErr(err), 500)
		return
	}
	list, err := queryNovelList(whereSQL, orderSQL, args, pageSize, (page-1)*pageSize)
	if err != nil {
		failJSON(w, "查询失败", firstLineErr(err), 500)
		return
	}
	totalPages := (total + int64(pageSize) - 1) / int64(pageSize)
	if totalPages < 1 {
		totalPages = 1
	}
	writeJSON(w, 200, map[string]any{
		"list":       list,
		"total":      total,
		"page":       page,
		"pageSize":   pageSize,
		"totalPages": totalPages,
	})
}

// ==================== POST /api/novels（管理端新增，可含初始章节由前端另行调用） ====================

var coverTokens = []string{"g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8", "g9", "g10", "g11", "g12"}

func handleNovelsCreate(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	v, ok := readBodyValue(r)
	body := bodyMap(v)
	if !ok {
		writeJSON(w, 400, map[string]string{"error": "请求体不是合法 JSON"})
		return
	}
	title := strField(body["title"], 0)
	if trimSpaceStr(title) == "" {
		writeJSON(w, 400, map[string]string{"error": "书名不能为空"})
		return
	}
	categoryId, okCat := intFieldStrict(body["categoryId"])
	if !okCat || categoryId == 0 {
		writeJSON(w, 400, map[string]string{"error": "请选择分类"})
		return
	}
	var catID int64
	if err := queryOne(`SELECT "id" FROM "Category" WHERE "id" = ?`, []any{&catID}, categoryId); err != nil {
		if isNoRows(err) {
			writeJSON(w, 400, map[string]string{"error": "分类不存在"})
			return
		}
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}

	// cover：仅接受 g1-g12 字符串，否则随机（对齐 covers.includes 严格相等）
	cover, _ := body["cover"].(string)
	validCover := false
	for _, c := range coverTokens {
		if c == cover {
			validCover = true
			break
		}
	}
	if !validCover {
		cover = coverTokens[rand.Intn(len(coverTokens))]
	}
	author := trimSpaceStr(strField(body["author"], 0))
	if author == "" {
		author = "佚名"
	}
	description := truncateRunes(strField(body["description"], 0), novelDescriptionMax)
	st := "serial"
	if s, _ := body["status"].(string); s == "finished" {
		st = "finished"
	}
	now := nowMillis()
	id, err := execReturningID(
		`INSERT INTO "Novel" ("title","author","description","cover","categoryId","status","isFeatured","isHot","wordCount","clicks","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,0,0,?,?)`,
		truncateRunes(trimSpaceStr(title), novelTitleMax),
		truncateRunes(author, novelAuthorMax),
		description,
		cover,
		categoryId,
		st,
		jsTruthy(body["isFeatured"]), // TS !!body.isFeatured：JS 真值语义（实现见 api_scrape_rules.go）
		jsTruthy(body["isHot"]),
		now, now,
	)
	if err != nil {
		if isUniqueConflict(err) {
			writeJSON(w, 409, map[string]string{"error": "同名同作者的书已存在"})
			return
		}
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	writeJSON(w, 201, map[string]any{"id": id})
}

// ==================== GET /api/novels/{id} ====================

func handleNovelDetail(w http.ResponseWriter, r *http.Request, ps map[string]string) {
	nid, ok := routeIntID(w, ps["id"], "无效 ID")
	if !ok {
		return
	}
	var id, categoryID, wordCount, clicks, chapterCount, isFeatured, isHot, updatedAt int64
	var title, author, description, cover, status string
	var catName sql.NullString
	err := queryOne(
		`SELECT n."id", n."title", n."author", n."description", n."cover", n."categoryId", c."name", n."status", n."isFeatured", n."isHot", n."wordCount", n."clicks", n."updatedAt", (SELECT COUNT(*) FROM "Chapter" ch WHERE ch."novelId" = n."id") FROM "Novel" n LEFT JOIN "Category" c ON c."id" = n."categoryId" WHERE n."id" = ?`,
		[]any{&id, &title, &author, &description, &cover, &categoryID, &catName, &status, &isFeatured, &isHot, &wordCount, &clicks, &updatedAt, &chapterCount},
		nid,
	)
	if err != nil {
		if isNoRows(err) {
			writeJSON(w, 404, map[string]string{"error": "小说不存在"})
			return
		}
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}

	// 浏览计数 fire-and-forget（Prisma update 会自动触碰 @updatedAt，故显式 set）
	_, _ = exec(`UPDATE "Novel" SET "clicks" = "clicks" + 1, "updatedAt" = ? WHERE "id" = ?`, nowMillis(), nid)

	var lastID sql.NullInt64
	var lastTitle sql.NullString
	_ = queryOne(`SELECT "id", "title" FROM "Chapter" WHERE "novelId" = ? ORDER BY "idx" DESC LIMIT 1`, []any{&lastID, &lastTitle}, nid)

	type chRow struct {
		id, idx, wordCount int64
		title              string
	}
	chapters := make([]map[string]any, 0)
	firstID := int64(0)
	hasFirst := false
	err = queryList(`SELECT "id", "idx", "title", "wordCount" FROM "Chapter" WHERE "novelId" = ? ORDER BY "idx" ASC LIMIT 12`, func(rows *sql.Rows) error {
		var cid, cidx, cwc int64
		var ctitle string
		if err := rows.Scan(&cid, &cidx, &ctitle, &cwc); err != nil {
			return err
		}
		if !hasFirst {
			firstID, hasFirst = cid, true
		}
		chapters = append(chapters, map[string]any{"id": cid, "idx": cidx, "title": ctitle, "wordCount": cwc})
		return nil
	}, nid)
	if err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}

	categoryName := "未分类"
	if catName.Valid && catName.String != "" {
		categoryName = catName.String
	}
	st := "serial"
	if status == "finished" {
		st = "finished"
	}
	var lastChapterTitle any
	var lastChapterID any
	if lastTitle.Valid {
		lastChapterTitle = lastTitle.String
	}
	if lastID.Valid {
		lastChapterID = lastID.Int64
	}
	var firstChapterID any
	if hasFirst {
		firstChapterID = firstID
	}
	writeJSON(w, 200, map[string]any{
		"id":               id,
		"title":            title,
		"author":           author,
		"description":      description,
		"cover":            cover,
		"categoryId":       categoryID,
		"categoryName":     categoryName,
		"status":           st,
		"isFeatured":       isFeatured != 0,
		"isHot":            isHot != 0,
		"wordCount":        wordCount,
		"clicks":           clicks,
		"chapterCount":     chapterCount,
		"lastChapterTitle": lastChapterTitle,
		"updatedAt":        isoFromMillis(updatedAt),
		"totalChapters":    chapterCount,
		"firstChapterId":   firstChapterID,
		"lastChapterId":    lastChapterID,
		"chapters":         chapters,
	})
}

// ==================== PUT /api/novels/{id} ====================

var coverTokenRe = regexp.MustCompile(`^g\d+$`)

func handleNovelUpdate(w http.ResponseWriter, r *http.Request, ps map[string]string) {
	nid, ok := routePosIntID(w, ps["id"], "无效 ID")
	if !ok {
		return
	}
	v, ok := readBodyValue(r)
	if !ok {
		writeJSON(w, 400, map[string]string{"error": "请求体不是合法 JSON"})
		return
	}
	body := bodyMap(v)

	sets := []string{}
	args := []any{}
	if s, ok2 := body["title"].(string); ok2 {
		if t := trimSpaceStr(s); t != "" {
			sets = append(sets, `"title" = ?`)
			args = append(args, truncateRunes(t, novelTitleMax))
		}
	}
	if s, ok2 := body["author"].(string); ok2 {
		if t := trimSpaceStr(s); t != "" {
			sets = append(sets, `"author" = ?`)
			args = append(args, truncateRunes(t, novelAuthorMax))
		}
	}
	if s, ok2 := body["description"].(string); ok2 {
		sets = append(sets, `"description" = ?`)
		args = append(args, truncateRunes(s, novelDescriptionMax))
	}
	if s, ok2 := body["cover"].(string); ok2 {
		if coverTokenRe.MatchString(s) {
			sets = append(sets, `"cover" = ?`)
			args = append(args, s)
		}
	}
	if n, ok2 := intFieldStrict(body["categoryId"]); ok2 && n > 0 {
		sets = append(sets, `"categoryId" = ?`)
		args = append(args, n)
	}
	if s, ok2 := body["status"].(string); ok2 && (s == "serial" || s == "finished") {
		sets = append(sets, `"status" = ?`)
		args = append(args, s)
	}
	if b, ok2 := body["isFeatured"].(bool); ok2 {
		sets = append(sets, `"isFeatured" = ?`)
		args = append(args, b)
	}
	if b, ok2 := body["isHot"].(bool); ok2 {
		sets = append(sets, `"isHot" = ?`)
		args = append(args, b)
	}
	// Prisma @updatedAt 任何 update 都会触碰 → 显式 set now
	sets = append(sets, `"updatedAt" = ?`)
	args = append(args, nowMillis())

	res, err := exec(`UPDATE "Novel" SET `+strings.Join(sets, ", ")+` WHERE "id" = ?`, append(args, nid)...)
	if err != nil {
		// P2025 之外的一切错误（分类外键不存在等）→ 400（对齐 TS 分类注释语义）
		// TS 输出 {error} 单字段（无 detail），逐字段对齐
		writeJSON(w, 400, map[string]string{"error": "更新失败（分类不存在？）"})
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeJSON(w, 404, map[string]string{"error": "小说不存在"})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// ==================== DELETE /api/novels/{id} ====================

func handleNovelDelete(w http.ResponseWriter, r *http.Request, ps map[string]string) {
	nid, ok := routePosIntID(w, ps["id"], "无效 ID")
	if !ok {
		return
	}
	res, err := exec(`DELETE FROM "Novel" WHERE "id" = ?`, nid)
	// 章节行经 FK ON DELETE CASCADE 级联删除（与 Prisma schema 一致）
	if err != nil {
		writeJSON(w, 404, map[string]string{"error": "小说不存在或删除失败"})
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeJSON(w, 404, map[string]string{"error": "小说不存在或删除失败"})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// ==================== GET /api/novels/{id}/chapters ====================

func handleNovelChapters(w http.ResponseWriter, r *http.Request, ps map[string]string) {
	nid, ok := routeIntID(w, ps["id"], "无效 ID")
	if !ok {
		return
	}
	out := make([]map[string]any, 0)
	err := queryList(`SELECT "id", "idx", "title", "wordCount" FROM "Chapter" WHERE "novelId" = ? ORDER BY "idx" ASC`, func(rows *sql.Rows) error {
		var id, idx, wordCount int64
		var title string
		if err := rows.Scan(&id, &idx, &title, &wordCount); err != nil {
			return err
		}
		out = append(out, map[string]any{"id": id, "idx": idx, "title": title, "wordCount": wordCount})
		return nil
	}, nid)
	if err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	writeJSON(w, 200, out)
}
