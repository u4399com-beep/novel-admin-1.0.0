/**
 * api_chapters.go —— 业务 API：章节管理 + 存量清洗 + 目录体检修复。
 *
 * 对应 TS 源：
 *   - src/app/api/chapters/route.ts            → handleChapterCreate
 *   - src/app/api/chapters/[id]/route.ts       → handleChapterDetail / handleChapterUpdate / handleChapterDelete
 *   - src/app/api/chapters/clean-all/route.ts  → handleChapterCleanAllGet / handleChapterCleanAllPost
 *                                                （scanChapters + cleanChapterContent 全量移植）
 *   - src/app/api/chapters/audit/route.ts      → handleChapterAuditGet / handleChapterAuditPost
 *                                                （中文数字解析/extractNum/分卷/去重/重排逐行移植）
 *   - src/lib/content-clean.ts                 → cleanChapterContent（NOISE_PATTERNS 逐条对齐）
 *
 * 移植语义差异：
 *   1. RE2 不支持负向先行断言：URL_LINE 的 (?![a-z]) 改写为消费式 (?:[^a-z]|$)，布尔判定等价
 *      （cleaner 本体在 cleanx.go，本文件原重复定义已收敛至该处）
 *   2. Prisma update 的 @updatedAt 自动触碰 → Novel 更新处显式 set updatedAt=now
 *   3. clean-all 的 globalThis 互斥标志 → 包级互斥锁+标志位（同进程语义等价）
 *   4. TS 未捕获异常（clean-all 批量更新失败第二次等）→ 500 {error,detail} JSON（TS 为 Next HTML 500）
 *   5. 标题截断/样例截断按 rune 计（中文等价；差异说明见 api_novels.go 头注）
 */
package main

import (
	"database/sql"
	"net/http"
	"regexp"
	"strings"
	"sync"
)

func init() {
	register("POST", "/api/chapters", handleChapterCreate)
	// /api/chapters/{id} 方法分发 mux（骨架 dispatch 参数路由方法盲，见 api_novels.go 注）
	register("GET", "/api/chapters/{id}", handleChapterByID)
	register("PUT", "/api/chapters/{id}", handleChapterByID)
	register("DELETE", "/api/chapters/{id}", handleChapterByID)
	register("GET", "/api/chapters/clean-all", handleChapterCleanAllGet)
	register("POST", "/api/chapters/clean-all", handleChapterCleanAllPost)
	register("GET", "/api/chapters/audit", handleChapterAuditGet)
	register("POST", "/api/chapters/audit", handleChapterAuditPost)
	// Task 45-b: 分卷结构只读端点（admin「章节工具」面板；volume 列分组与前台 TOC 同口径）
	register("GET", "/api/chapters/volumes", handleChapterVolumesGet)
}

// handleChapterByID /api/chapters/{id} 方法分发（GET/PUT/DELETE，HEAD 走 GET）
func handleChapterByID(w http.ResponseWriter, r *http.Request, ps map[string]string) {
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		handleChapterDetail(w, r, ps)
	case http.MethodPut:
		handleChapterUpdate(w, r, ps)
	case http.MethodDelete:
		handleChapterDelete(w, r, ps)
	default:
		methodNotAllowed(w, r)
	}
}

// ==================== POST /api/chapters（管理端新增章节） ====================

func handleChapterCreate(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	v, ok := readBodyValue(r)
	if !ok {
		writeJSON(w, 400, map[string]string{"error": "请求体不是合法 JSON"})
		return
	}
	body := bodyMap(v)

	novelId, okN := intFieldStrict(body["novelId"])
	if !okN || novelId == 0 {
		writeJSON(w, 400, map[string]string{"error": "novelId 必填"})
		return
	}
	rawTitle := strField(body["title"], 0)
	if trimSpaceStr(rawTitle) == "" {
		writeJSON(w, 400, map[string]string{"error": "章节标题不能为空"})
		return
	}
	var nid int64
	if err := queryOne(`SELECT "id" FROM "Novel" WHERE "id" = ?`, []any{&nid}, novelId); err != nil {
		if isNoRows(err) {
			writeJSON(w, 404, map[string]string{"error": "小说不存在"})
			return
		}
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}

	chTitle := truncateRunes(trimSpaceStr(rawTitle), 120) // TS 内联 slice(0,120)
	// 非字符串 content 按空正文处理（与 PUT 语义一致）
	content := strField(body["content"], 0)
	wc := wordCountJS(content)

	createChapter := func(idxVal int64) (int64, error) {
		// Task 32-b: 垂直分表 —— Chapter 行 content 恒空串，非空正文入库后写 ChapterContent
		//（chapterId 键；写在拿到 chapterID 之后统一进行，idx 顺延重试不致正文错位）
		return execReturningID(
			`INSERT INTO "Chapter" ("novelId","idx","title","content","wordCount","createdAt") VALUES (?,?,?,'',?,?)`,
			novelId, idxVal, chTitle, wc, nowMillis(),
		)
	}

	var maxIdx sql.NullInt64
	if err := queryOne(`SELECT MAX("idx") FROM "Chapter" WHERE "novelId" = ?`, []any{&maxIdx}, novelId); err != nil && !isNoRows(err) {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	idx := maxIdx.Int64 + 1
	chapterID, err := createChapter(idx)
	if err != nil {
		// 并发竞态兜底：撞 [novelId, idx] 唯一约束后重读最大 idx 重试一次
		if !isUniqueConflict(err) {
			failJSON(w, "服务器错误", firstLineErr(err), 500)
			return
		}
		var retryIdx sql.NullInt64
		if err2 := queryOne(`SELECT MAX("idx") FROM "Chapter" WHERE "novelId" = ?`, []any{&retryIdx}, novelId); err2 != nil && !isNoRows(err2) {
			failJSON(w, "服务器错误", firstLineErr(err2), 500)
			return
		}
		idx = retryIdx.Int64 + 1
		chapterID, err = createChapter(idx)
		if err != nil {
			failJSON(w, "创建章节失败", firstLineErr(err), 500)
			return
		}
	}
	// Task 32-b: 非空正文写分表（chapterId 键）；写败删刚建行防僵尸，不静默丢正文
	if content != "" {
		if _, err := exec(`INSERT OR REPLACE INTO "ChapterContent" ("chapterId","content") VALUES (?,?)`, chapterID, content); err != nil {
			_, _ = exec(`DELETE FROM "Chapter" WHERE "id" = ?`, chapterID)
			failJSON(w, "创建章节失败", firstLineErr(err), 500)
			return
		}
	}

	// 同步小说字数与更新时间（显式 updatedAt，对齐 Prisma @updatedAt）
	var sumWC sql.NullInt64
	if err := queryOne(`SELECT SUM("wordCount") FROM "Chapter" WHERE "novelId" = ?`, []any{&sumWC}, novelId); err != nil && !isNoRows(err) {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	if _, err := exec(`UPDATE "Novel" SET "wordCount" = ?, "updatedAt" = ? WHERE "id" = ?`, sumWC.Int64, nowMillis(), novelId); err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	writeJSON(w, 201, map[string]any{"id": chapterID, "idx": idx})
}

// ==================== GET /api/chapters/{id} ====================

func handleChapterDetail(w http.ResponseWriter, r *http.Request, ps map[string]string) {
	cid, ok := routeIntID(w, ps["id"], "无效 ID")
	if !ok {
		return
	}
	var id, novelId, idx, wordCount int64
	var title, content string
	var novelTitle sql.NullString
	err := queryOne(
		`SELECT ch."id", ch."novelId", ch."idx", ch."title", ch."content", ch."wordCount", n."title" FROM "Chapter" ch LEFT JOIN "Novel" n ON n."id" = ch."novelId" WHERE ch."id" = ?`,
		[]any{&id, &novelId, &idx, &title, &content, &wordCount, &novelTitle},
		cid,
	)
	if err != nil {
		if isNoRows(err) {
			writeJSON(w, 404, map[string]string{"error": "章节不存在"})
			return
		}
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	// Task 32-b: 正文三级回落（ChapterContent 分表 → Chapter.content 存量 → TXT 文件）
	content = loadChapterContent(id, novelId, idx, content, wordCount)
	var prevID, nextID sql.NullInt64
	_ = queryOne(`SELECT "id" FROM "Chapter" WHERE "novelId" = ? AND "idx" < ? ORDER BY "idx" DESC LIMIT 1`, []any{&prevID}, novelId, idx)
	_ = queryOne(`SELECT "id" FROM "Chapter" WHERE "novelId" = ? AND "idx" > ? ORDER BY "idx" ASC LIMIT 1`, []any{&nextID}, novelId, idx)

	var prev, next any
	if prevID.Valid {
		prev = prevID.Int64
	}
	if nextID.Valid {
		next = nextID.Int64
	}
	nt := ""
	if novelTitle.Valid {
		nt = novelTitle.String
	}
	writeJSON(w, 200, map[string]any{
		"id":         id,
		"novelId":    novelId,
		"novelTitle": nt,
		"idx":        idx,
		"title":      title,
		"content":    content,
		"wordCount":  wordCount,
		"prevId":     prev,
		"nextId":     next,
	})
}

// ==================== PUT /api/chapters/{id} ====================

func handleChapterUpdate(w http.ResponseWriter, r *http.Request, ps map[string]string) {
	cid, ok := routePosIntID(w, ps["id"], "无效 ID")
	if !ok {
		return
	}
	v, ok := readBodyValue(r)
	if !ok {
		writeJSON(w, 400, map[string]string{"error": "请求体不是合法 JSON"})
		return
	}
	body := bodyMap(v)

	var novelId, chIdx int64
	var curTitle string
	if err := queryOne(`SELECT "novelId", "idx", "title" FROM "Chapter" WHERE "id" = ?`, []any{&novelId, &chIdx, &curTitle}, cid); err != nil {
		// TS update 抛错（含不存在）一律 404
		writeJSON(w, 404, map[string]string{"error": "章节不存在或更新失败"})
		return
	}

	sets := []string{}
	args := []any{}
	finalTitle := curTitle // Task 32-b: TXT 分章文件名含标题，编辑后同步重写需最终标题
	if s, ok2 := body["title"].(string); ok2 {
		if t := trimSpaceStr(s); t != "" {
			finalTitle = truncateRunes(t, 120)
			sets = append(sets, `"title" = ?`)
			args = append(args, finalTitle)
		}
	}
	contentStr, hasContent := "", false
	if s, ok2 := body["content"].(string); ok2 {
		hasContent = true
		contentStr = s
		// Task 32-b: 垂直分表 —— 编辑正文写 ChapterContent（chapterId 键），Chapter.content
		// 列位保留恒空；保存成功后同步重写该章 TXT 分章文件（txt/both 模式书，旧题名文件顺带清理）
		sets = append(sets, `"wordCount" = ?`)
		args = append(args, wordCountJS(s))
		// Task 33-b: 旧版 defer syncChapterTxt 在 UPDATE/分表写败路径也会执行——
		// 404 响应的同时 txt 文件已被重写为新内容，文件与 DB 内容漂移（三级回落
		// 读到旧值、文件却是新值的中间态）。改为成功路径显式同步（见下方）。
	}
	if len(sets) > 0 {
		if _, err := exec(`UPDATE "Chapter" SET `+strings.Join(sets, ", ")+` WHERE "id" = ?`, append(args, cid)...); err != nil {
			writeJSON(w, 404, map[string]string{"error": "章节不存在或更新失败"})
			return
		}
		// Task 32-b: content 编辑同步分表（chapterId 键）
		if hasContent {
			if _, err := exec(`INSERT OR REPLACE INTO "ChapterContent" ("chapterId","content") VALUES (?,?)`, cid, contentStr); err != nil {
				writeJSON(w, 404, map[string]string{"error": "章节不存在或更新失败"})
				return
			}
			// Task 33-b: 仅在 DB 双写全部成功后同步 txt 文件（成功路径；旧版 defer
			// 会把失败路径也同步，文件/DB 漂移）
			syncChapterTxt(int(novelId), int(chIdx), finalTitle, contentStr)
		}
	}
	// 内容变化同步书籍字数合计并触碰 updatedAt（对齐 TS 语义）
	// TS 的 agg/novel.update 也在同一 try 内，任何失败 → 404「章节不存在或更新失败」
	if err := resumNovelWordCount(novelId, true); err != nil {
		writeJSON(w, 404, map[string]string{"error": "章节不存在或更新失败"})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// ==================== DELETE /api/chapters/{id} ====================

func handleChapterDelete(w http.ResponseWriter, r *http.Request, ps map[string]string) {
	cid, ok := routePosIntID(w, ps["id"], "无效 ID")
	if !ok {
		return
	}
	var novelId, chIdx int64
	if err := queryOne(`SELECT "novelId", "idx" FROM "Chapter" WHERE "id" = ?`, []any{&novelId, &chIdx}, cid); err != nil {
		writeJSON(w, 404, map[string]string{"error": "章节不存在"})
		return
	}
	res, err := exec(`DELETE FROM "Chapter" WHERE "id" = ?`, cid)
	if err != nil {
		writeJSON(w, 404, map[string]string{"error": "章节不存在"})
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeJSON(w, 404, map[string]string{"error": "章节不存在"})
		return
	}
	// Task 32-b: ChapterContent 经 chapterId FK 级联自动清理；TXT 分章文件需手动同步删除
	removeChapterTxt(int(novelId), int(chIdx))
	// 与 PUT/POST 对齐：内容变化同时触碰 updatedAt，让「最近更新」排序如实反映删章
	// TS 的 agg/novel.update 也在同一 try 内，任何失败 → 404「章节不存在」
	if err := resumNovelWordCount(novelId, true); err != nil {
		writeJSON(w, 404, map[string]string{"error": "章节不存在"})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// resumNovelWordCount 重算书籍字数合计（touch=true 时同步触碰 updatedAt）
func resumNovelWordCount(novelId int64, touch bool) error {
	var sumWC sql.NullInt64
	if err := queryOne(`SELECT SUM("wordCount") FROM "Chapter" WHERE "novelId" = ?`, []any{&sumWC}, novelId); err != nil {
		return err
	}
	if touch {
		_, err := exec(`UPDATE "Novel" SET "wordCount" = ?, "updatedAt" = ? WHERE "id" = ?`, sumWC.Int64, nowMillis(), novelId)
		return err
	}
	_, err := exec(`UPDATE "Novel" SET "wordCount" = ? WHERE "id" = ?`, sumWC.Int64, novelId)
	return err
}

// ==================== 正文噪声清洗 ====================
// src/lib/content-clean.ts（cleanChapterContent/isNoiseLine/CleanResult）已移植到
// cleanx.go（与 worker Phase 2 共用同一实现，保证 clean-all 与采集入库同口径），
// 此处直接调用，不再重复定义。

// ==================== /api/chapters/clean-all ====================

const cleanAllBatchSize = 500

var (
	cleanAllMu      sync.Mutex
	cleanAllRunning bool
)

// scanChapters 遍历全部章节做清洗比对；write=true 落库（章节 content/wordCount + 书籍字数合计）。
// Task 32-b: 正文经三级回落读取（分表→存量列→TXT），写回统一落 ChapterContent（chapterId 键）
// 并同步 Chapter.wordCount；纯 txt 模式书（分表/存量列均空）只读不写（txt 文件重写由
// syncChapterTxt 场景覆盖，批量清洗不碰文件保持幂等简单）。
func scanChapters(write bool) (checked, changed, novels int, err error) {
	cursor := int64(0)
	touchedNovels := map[int64]bool{}
	for {
		type row struct {
			id      int64
			novelId int64
			idx     int64
			content string
			wc      int64
		}
		batch := make([]row, 0, cleanAllBatchSize)
		err := queryList(`SELECT "id", "novelId", "idx", "content", "wordCount" FROM "Chapter" WHERE "id" > ? ORDER BY "id" ASC LIMIT ?`,
			func(rows *sql.Rows) error {
				var r row
				if err := rows.Scan(&r.id, &r.novelId, &r.idx, &r.content, &r.wc); err != nil {
					return err
				}
				batch = append(batch, r)
				return nil
			}, cursor, cleanAllBatchSize)
		if err != nil {
			return checked, changed, len(touchedNovels), err
		}
		if len(batch) == 0 {
			break
		}
		for _, ch := range batch {
			cursor = ch.id
			checked++
			content := loadChapterContent(ch.id, ch.novelId, ch.idx, ch.content, ch.wc)
			if content == "" {
				continue // 空骨架/纯 txt 空读不参与清洗
			}
			res := cleanChapterContent(content)
			if res.Text == content {
				continue // 无变化不写库
			}
			if write {
				// 更新失败（瞬时锁等）不计入 cleaned，避免虚报；下轮 dryRun 可复查
				if _, err := exec(`INSERT OR REPLACE INTO "ChapterContent" ("chapterId","content") VALUES (?,?)`, ch.id, res.Text); err != nil {
					continue
				}
				if _, err := exec(`UPDATE "Chapter" SET "wordCount" = ? WHERE "id" = ?`, wordCountJS(res.Text), ch.id); err != nil {
					continue
				}
			}
			changed++
			touchedNovels[ch.novelId] = true
		}
	}
	if write && len(touchedNovels) > 0 {
		// 章节 wordCount 变了，书籍级字数合计一并重算（update 触碰 @updatedAt → 显式 set）
		for novelId := range touchedNovels {
			var sumWC sql.NullInt64
			if err := queryOne(`SELECT SUM("wordCount") FROM "Chapter" WHERE "novelId" = ?`, []any{&sumWC}, novelId); err != nil {
				continue
			}
			_, _ = exec(`UPDATE "Novel" SET "wordCount" = ?, "updatedAt" = ? WHERE "id" = ?`, sumWC.Int64, nowMillis(), novelId)
		}
	}
	return checked, changed, len(touchedNovels), nil
}

func handleChapterCleanAllGet(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	dryRun := r.URL.Query().Get("dryRun") == "1"
	// GET 恒为只读预览：write=false，绝不写库
	checked, changed, _, err := scanChapters(false)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "存量章节预览失败", "detail": firstLineErr(err)})
		return
	}
	writeJSON(w, 200, map[string]any{"checked": checked, "toClean": changed, "dryRun": dryRun})
}

func handleChapterCleanAllPost(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	cleanAllMu.Lock()
	if cleanAllRunning {
		cleanAllMu.Unlock()
		writeJSON(w, 409, map[string]string{"error": "存量清洗正在进行中，请稍后再试"})
		return
	}
	cleanAllRunning = true
	cleanAllMu.Unlock()
	defer func() {
		cleanAllMu.Lock()
		cleanAllRunning = false
		cleanAllMu.Unlock()
	}()

	checked, changed, novels, err := scanChapters(true)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "存量章节清洗失败", "detail": firstLineErr(err)})
		return
	}
	writeJSON(w, 200, map[string]any{"checked": checked, "cleaned": changed, "novels": novels})
}

// ==================== /api/chapters/audit：中文数字解析 ====================

var cnDigit = map[rune]int{
	'零': 0, '〇': 0, '一': 1, '壹': 1, '二': 2, '贰': 2, '两': 2, '三': 3, '叁': 3, '四': 4, '肆': 4,
	'五': 5, '伍': 5, '六': 6, '陆': 6, '七': 7, '柒': 7, '八': 8, '捌': 8, '九': 9, '玖': 9,
}
var cnUnit = map[rune]int{'十': 10, '拾': 10, '百': 100, '佰': 100, '千': 1000, '仟': 1000}

// parseChapterNumber 中文/全角数字 → 阿拉伯数字；不可解析返回 false
func parseChapterNumber(raw string) (int64, bool) {
	var b strings.Builder
	for _, c := range raw {
		if c >= 0xFF10 && c <= 0xFF19 { // 全角０-９ → ASCII
			c = c - 0xFEE0
		}
		b.WriteRune(c)
	}
	s := jsTrim(b.String())
	if s == "" {
		return 0, false
	}
	if allDigitsRe.MatchString(s) {
		return parseDigitsASCII(s), true
	}
	var result, section int64
	cur := int64(-1)
	for _, ch := range s {
		switch {
		case ch == '万' || ch == '萬':
			section = (section + maxInt64(cur, 0)) * 10000
			result += section
			section = 0
			cur = -1
		default:
			if d, ok := cnDigit[ch]; ok {
				cur = int64(d)
			} else if u, ok := cnUnit[ch]; ok {
				base := cur
				if base < 0 {
					base = 1
				}
				section += base * int64(u)
				cur = -1
			} else {
				return 0, false
			}
		}
	}
	return result + section + maxInt64(cur, 0), true
}

var allDigitsRe = regexp.MustCompile(`^\d+$`)

// parseDigitsASCII 纯数字串转 int64（标题编号场景，不适用 strconv 以外的错误分支）
func parseDigitsASCII(s string) int64 {
	var n int64
	for _, c := range s {
		n = n*10 + int64(c-'0')
		if n > 1<<53 {
			break // JS Number 超出安全整数后精度丢失，截断即可（章节编号不会这么大）
		}
	}
	return n
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

const auditCNClass = `[0-9\x{ff10}-\x{ff19}]+|[零〇一二三四五六七八九十百千两壹贰叁肆伍陆柒捌玖拾佰仟萬万]+`

var (
	// 第N章/节/開頭（严格版：章回体「回」量词排除；\s 用 JS 空白全集）
	chNumRe  = regexp.MustCompile(`^第` + jsSpaceClass + `*(` + auditCNClass + `)` + jsSpaceClass + `*(?:章|节|節)`)
	volumeRe = regexp.MustCompile(`第` + jsSpaceClass + `*(?:` + auditCNClass + `)` + jsSpaceClass + `*(?:卷|部|篇)`)
)

// extractNum 提取章节编号（严格版）：标题必须以「第N章/节」开头；编号后剩余超 30 字不参与判定
func extractNum(title string) (int64, bool) {
	m := chNumRe.FindStringSubmatch(title)
	if m == nil {
		return 0, false
	}
	restRunes := []rune(title)
	prefixRunes := len([]rune(m[0]))
	if prefixRunes < len(restRunes) {
		restRunes = restRunes[prefixRunes:]
	} else {
		restRunes = nil
	}
	if len(restRunes) > 30 {
		return 0, false
	}
	return parseChapterNumber(m[1])
}

// ==================== /api/chapters/audit：体检核心 ====================

// auditNovel 逐书体检 → NovelAuditItem 形状（字段名与 TS 完全一致）
func auditNovel(novelId int64, title string) map[string]any {
	type row struct {
		id, idx, wordCount int64
		title              string
	}
	rows := make([]row, 0)
	_ = queryList(`SELECT "id", "idx", "title", "wordCount" FROM "Chapter" WHERE "novelId" = ? ORDER BY "idx" ASC`,
		func(rs *sql.Rows) error {
			var r row
			if err := rs.Scan(&r.id, &r.idx, &r.title, &r.wordCount); err != nil {
				return err
			}
			rows = append(rows, r)
			return nil
		}, novelId)

	// 重复标题分组
	byTitle := map[string]int{}
	for _, r := range rows {
		byTitle[r.title]++
	}
	dupGroups, dupRows := 0, 0
	for _, c := range byTitle {
		if c > 1 {
			dupGroups++
			dupRows += c - 1
		}
	}

	// idx 断档（rows 与 maxIdx 不符；idx 从 1 连续为健康）
	var maxIdx int64
	for _, r := range rows {
		if r.idx > maxIdx {
			maxIdx = r.idx
		}
	}
	idxGaps := maxIdx - int64(len(rows))
	if idxGaps < 0 {
		idxGaps = 0
	}

	emptyRows := 0
	for _, r := range rows {
		if r.wordCount == 0 {
			emptyRows++
		}
	}

	// 编号乱序：相邻回退检测（前章编号大于后章编号）
	disorderSamples := make([]string, 0)
	var prevN int64
	var prevTitle string
	hasPrev := false
	for _, r := range rows {
		n, ok := extractNum(r.title)
		if !ok {
			continue
		}
		if hasPrev && n < prevN && len(disorderSamples) < 3 {
			disorderSamples = append(disorderSamples, "「"+truncateRunes(prevTitle, 24)+"」→「"+truncateRunes(r.title, 24)+"」")
		}
		prevN, prevTitle, hasPrev = n, r.title, true
	}

	item := map[string]any{
		"novelId":         novelId,
		"title":           title,
		"chapters":        len(rows),
		"dupGroups":       dupGroups,
		"dupRows":         dupRows,
		"idxGaps":         idxGaps,
		"emptyRows":       emptyRows,
		"disordered":      len(disorderSamples) > 0,
		"disorderSamples": disorderSamples,
	}

	// 分卷结构：以「第X卷/部/篇」标题行为卷边界
	if len(rows) > 0 {
		volumes := make([]map[string]any, 0)
		var current map[string]any
		for _, r := range rows {
			if volumeRe.MatchString(r.title) {
				current = map[string]any{"title": truncateRunes(r.title, 60), "from": r.idx, "to": r.idx, "chapters": 0}
				volumes = append(volumes, current)
			}
			if current != nil {
				current["to"] = r.idx
				current["chapters"] = current["chapters"].(int) + 1
			}
		}
		if len(volumes) > 0 {
			item["volumes"] = volumes
		}
	}
	return item
}

// ==================== GET /api/chapters/audit ====================

func handleChapterAuditGet(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	novelIdParam := r.URL.Query().Get("novelId")
	if novelIdParam != "" {
		f, ok := jsParseFloat(novelIdParam)
		if !ok || !numIsInt(f) || f <= 0 {
			writeJSON(w, 400, map[string]string{"error": "novelId 非法"})
			return
		}
		novelId := int64(f)
		var title string
		if err := queryOne(`SELECT "title" FROM "Novel" WHERE "id" = ?`, []any{&title}, novelId); err != nil {
			if isNoRows(err) {
				writeJSON(w, 404, map[string]string{"error": "书籍不存在"})
				return
			}
			writeJSON(w, 500, map[string]string{"error": "目录体检失败", "detail": firstLineErr(err)})
			return
		}
		item := auditNovel(novelId, title)
		writeJSON(w, 200, map[string]any{"mode": "single", "item": item})
		return
	}

	// 全站概览：逐书体检
	type novelRow struct {
		id    int64
		title string
	}
	novels := make([]novelRow, 0)
	if err := queryList(`SELECT "id", "title" FROM "Novel" ORDER BY "id" ASC`, func(rows *sql.Rows) error {
		var n novelRow
		if err := rows.Scan(&n.id, &n.title); err != nil {
			return err
		}
		novels = append(novels, n)
		return nil
	}); err != nil {
		writeJSON(w, 500, map[string]string{"error": "目录体检失败", "detail": firstLineErr(err)})
		return
	}
	items := make([]map[string]any, 0, len(novels))
	for _, n := range novels {
		items = append(items, auditNovel(n.id, n.title))
	}
	type scored struct {
		item  map[string]any
		score int
	}
	problem := make([]scored, 0)
	for _, it := range items {
		if it["dupRows"].(int) > 0 || it["idxGaps"].(int64) > 0 || it["disordered"].(bool) {
			problem = append(problem, scored{it, it["dupRows"].(int)*10 + int(it["idxGaps"].(int64))})
		}
	}
	// 稳定降序（对齐 JS Array.prototype.sort 稳定性）后取 100
	for i := 1; i < len(problem); i++ {
		for j := i; j > 0 && problem[j].score > problem[j-1].score; j-- {
			problem[j], problem[j-1] = problem[j-1], problem[j]
		}
	}
	if len(problem) > 100 {
		problem = problem[:100]
	}
	out := make([]map[string]any, 0, len(problem))
	for _, p := range problem {
		out = append(out, p.item)
	}
	writeJSON(w, 200, map[string]any{
		"mode":    "overview",
		"novels":  len(items),
		"healthy": len(items) - len(out),
		"problem": out,
	})
}

// ==================== POST /api/chapters/audit（dedupe / reindex） ====================

func handleChapterAuditPost(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	v, ok := readBodyValue(r)
	if !ok {
		writeJSON(w, 400, map[string]string{"error": "请求体非法 JSON"})
		return
	}
	body := bodyMap(v)
	action := strField(body["action"], 0)
	novelIdF := jsNumber(body["novelId"])
	if action != "dedupe" && action != "reindex" {
		writeJSON(w, 400, map[string]string{"error": "action 仅支持 dedupe / reindex"})
		return
	}
	if !numIsInt(novelIdF) || novelIdF <= 0 {
		writeJSON(w, 400, map[string]string{"error": "novelId 必填（正整数）"})
		return
	}
	novelId := int64(novelIdF)

	var title string
	if err := queryOne(`SELECT "title" FROM "Novel" WHERE "id" = ?`, []any{&title}, novelId); err != nil {
		if isNoRows(err) {
			writeJSON(w, 404, map[string]string{"error": "书籍不存在"})
			return
		}
		writeJSON(w, 500, map[string]string{"error": "目录修复失败", "detail": firstLineErr(err)})
		return
	}

	type row struct {
		id, idx, wordCount int64
		title              string
	}
	rows := make([]row, 0)
	if err := queryList(`SELECT "id", "idx", "title", "wordCount" FROM "Chapter" WHERE "novelId" = ? ORDER BY "idx" ASC, "id" ASC`,
		func(rs *sql.Rows) error {
			var x row
			if err := rs.Scan(&x.id, &x.idx, &x.title, &x.wordCount); err != nil {
				return err
			}
			rows = append(rows, x)
			return nil
		}, novelId); err != nil {
		writeJSON(w, 500, map[string]string{"error": "目录修复失败", "detail": firstLineErr(err)})
		return
	}
	if len(rows) == 0 {
		writeJSON(w, 400, map[string]string{"error": "该书无章节"})
		return
	}

	// ---- 去重 + 重排（Task 33-b: 单事务原子执行）----
	// 旧版缺陷：①去重 DELETE 与重排两段式 UPDATE 均在事务外且忽略错误——第二段落位
	// 失败（瞬时锁等）时该章永久滞留负数暂存区 idx=-1000000-i（阅读序消失、TXT/导出
	// 错位）而 API 仍返回 ok；②去重删除行的 TXT 分章文件未清理，重排压实后新 idx 命中
	// 已删行的旧文件 → txt 回落读到已删章节内容（串章）。
	// 修复：sql.Tx 内完成「去重删除 → 负数暂存 → 落位 1..n」，任一步失败整体回滚
	// 零中间态；提交后按迁移记录同步 txt 文件（删行清理 + 变号改名，txtdir.go）。
	removed, moved := 0, 0
	var droppedRows []row         // 去重删除的行（提交后清理其 txt 文件）
	var txtMoves []chapterTxtMove // idx 变化的行（提交后同步 txt 文件名）
	db, derr := getDB()
	if derr != nil {
		writeJSON(w, 500, map[string]string{"error": "目录修复失败", "detail": firstLineErr(derr)})
		return
	}
	tx, terr := db.Begin()
	if terr != nil {
		writeJSON(w, 500, map[string]string{"error": "目录修复失败", "detail": firstLineErr(terr)})
		return
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	txErr := func() error {
		if action == "dedupe" {
			type best struct {
				id, wordCount, idx int64
			}
			keep := map[string]best{}
			for _, x := range rows {
				b, exists := keep[x.title]
				if !exists || x.wordCount > b.wordCount || (x.wordCount == b.wordCount && x.idx < b.idx) {
					keep[x.title] = best{id: x.id, wordCount: x.wordCount, idx: x.idx}
				}
			}
			if len(keep) < len(rows) {
				keepIDs := map[int64]bool{}
				for _, b := range keep {
					keepIDs[b.id] = true
				}
				dropIDs := make([]int64, 0)
				for _, x := range rows {
					if !keepIDs[x.id] {
						dropIDs = append(dropIDs, x.id)
						droppedRows = append(droppedRows, x)
					}
				}
				// 分批 IN 删除（SQLite 变量上限防御）
				for i := 0; i < len(dropIDs); i += 500 {
					end := i + 500
					if end > len(dropIDs) {
						end = len(dropIDs)
					}
					part := dropIDs[i:end]
					ph := strings.TrimSuffix(strings.Repeat("?,", len(part)), ",")
					args := make([]any, len(part))
					for j, idv := range part {
						args[j] = idv
					}
					res, err := tx.Exec(`DELETE FROM "Chapter" WHERE "id" IN (`+ph+`)`, args...)
					if err != nil {
						return err
					}
					n, _ := res.RowsAffected()
					removed += int(n)
				}
			}
		}

		// ---- 重排：有编号按编号升序（稳定），无编号按原相对顺序置后；压实 idx 1..n ----
		// 去重后在事务内重查（必须看到已删行状态）
		kept, kerr := func() ([]row, error) {
			krows, kerr := tx.Query(`SELECT "id", "idx", "title" FROM "Chapter" WHERE "novelId" = ? ORDER BY "idx" ASC, "id" ASC`, novelId)
			if kerr != nil {
				return nil, kerr
			}
			defer krows.Close() // Task 33-b: Commit 前必须关闭（打开 Rows 时 Commit 可能报 in progress）
			out := make([]row, 0)
			for krows.Next() {
				var x row
				if err := krows.Scan(&x.id, &x.idx, &x.title); err != nil {
					return nil, err
				}
				out = append(out, x)
			}
			return out, krows.Err()
		}()
		if kerr != nil {
			return kerr
		}
		type numberedRow struct {
			r row
			i int
			n int64
		}
		numbered := make([]numberedRow, 0)
		unnumbered := make([]row, 0)
		for i, x := range kept {
			if n, ok := extractNum(x.title); ok {
				numbered = append(numbered, numberedRow{r: x, i: i, n: n})
			} else {
				unnumbered = append(unnumbered, x)
			}
		}
		// 稳定排序（n 升序，并列保持原相对顺序 i）
		for i := 1; i < len(numbered); i++ {
			for j := i; j > 0 && (numbered[j].n < numbered[j-1].n); j-- {
				numbered[j], numbered[j-1] = numbered[j-1], numbered[j]
			}
		}
		ordered := make([]row, 0, len(kept))
		for _, x := range numbered {
			ordered = append(ordered, x.r)
		}
		ordered = append(ordered, unnumbered...)

		// 两段式重排：先全部移出到负数暂存区（避开目标 idx 被占），再落位 1..n
		// Task 33-b: 任一步失败即整体回滚（旧版忽略错误会留下 -1000000 僵尸序号）
		// Task 42-b: 暂存区改取 min(0, 全书最小 idx) - 1 起算的连续负数段。旧版固定
		// -1_000_000-i 会与存量滞留行相撞——旧二进制段落位失败曾把章永久留在
		// -1_000_000-i（上文 33-b 所述病灶，本系统自身历史损伤类），对这类书 reindex
		// 的暂存 UPDATE 必撞 (novelId,idx) 唯一约束 → 整个事务回滚 500，该损伤类永久
		// 不可 reindex（P2-9「再次 reindex 即修复」的恢复路径失效）。压到全书最小 idx
		// 之下后，暂存值与任何存量 idx（含滞留负数行）及落位目标 1..n 均无交集
		//（kept 即事务内全书快照、无并发写），碰撞在构造上不可能。
		stageBase := int64(0)
		for _, x := range kept {
			if x.idx < stageBase {
				stageBase = x.idx
			}
		}
		stageBase--
		for i, x := range ordered {
			if x.idx != int64(i+1) {
				if _, err := tx.Exec(`UPDATE "Chapter" SET "idx" = ? WHERE "id" = ?`, stageBase-int64(i), x.id); err != nil {
					return err
				}
			}
		}
		for i, x := range ordered {
			target := int64(i + 1)
			if x.idx != target {
				res, err := tx.Exec(`UPDATE "Chapter" SET "idx" = ? WHERE "id" = ?`, target, x.id)
				if err != nil {
					return err
				}
				if n, _ := res.RowsAffected(); n > 0 {
					moved++
					txtMoves = append(txtMoves, chapterTxtMove{ChapterID: x.id, OldIdx: x.idx, NewIdx: target, Title: x.title})
				}
			}
		}
		return tx.Commit()
	}()
	if txErr != nil {
		writeJSON(w, 500, map[string]string{"error": "目录修复失败", "detail": firstLineErr(txErr)})
		return
	}
	committed = true
	// Task 33-b: 提交后尽力同步 TXT 分章文件：去重删除行按旧 idx 清理（防压实后新 idx
	// 命中已删行旧文件串章）；重排变号行按迁移记录改名（txtdir.go 两段式 rename 防 swap 互覆）
	for _, d := range droppedRows {
		removeChapterTxt(int(novelId), int(d.idx))
	}
	reindexChapterTxtFiles(novelId, txtMoves)

	// 重算字数（去重可能删行；update 触碰 @updatedAt → 显式 set）
	if removed > 0 {
		var sumWC sql.NullInt64
		if err := queryOne(`SELECT SUM("wordCount") FROM "Chapter" WHERE "novelId" = ?`, []any{&sumWC}, novelId); err == nil {
			_, _ = exec(`UPDATE "Novel" SET "wordCount" = ?, "updatedAt" = ? WHERE "id" = ?`, sumWC.Int64, nowMillis(), novelId)
		}
	}

	after := auditNovel(novelId, title)
	writeJSON(w, 200, map[string]any{
		"ok":      true,
		"action":  action,
		"novelId": novelId,
		"removed": removed,
		"moved":   moved,
		"audit":   after,
	})
}

// ==================== GET /api/chapters/volumes（Task 45-b 分卷结构只读端点） ====================

// handleChapterVolumesGet 单书分卷结构（admin「章节工具」面板数据源）：
// GET /api/chapters/volumes?novelId=N →
//
//	{ novelId, title, total, volumeCount, ungrouped,
//	  volumes: [{name, chapters, firstIdx, lastIdx}] }
//
// 分组复用 groupChaptersByVolume（web_data.go，与前台 TOC 渲染同口径：idx 升序连续同卷
// 运行段切组，name="" 为未分卷块）。路由风格与 handleChapterAuditGet 一致（jsParseFloat
// 校验 novelId、404 书不存在、500 带首行错误）。
func handleChapterVolumesGet(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	novelIdParam := r.URL.Query().Get("novelId")
	f, ok := jsParseFloat(novelIdParam)
	if !ok || !numIsInt(f) || f <= 0 {
		writeJSON(w, 400, map[string]string{"error": "novelId 非法"})
		return
	}
	novelId := int64(f)
	var title string
	if err := queryOne(`SELECT "title" FROM "Novel" WHERE "id" = ?`, []any{&title}, novelId); err != nil {
		if isNoRows(err) {
			writeJSON(w, 404, map[string]string{"error": "书籍不存在"})
			return
		}
		writeJSON(w, 500, map[string]string{"error": "分卷结构读取失败", "detail": firstLineErr(err)})
		return
	}
	chapters := make([]map[string]any, 0)
	if err := queryList(`SELECT "idx", "title", "volume" FROM "Chapter" WHERE "novelId" = ? ORDER BY "idx" ASC`,
		func(rs *sql.Rows) error {
			var idx int64
			var t, vol string
			if err := rs.Scan(&idx, &t, &vol); err != nil {
				return err
			}
			chapters = append(chapters, map[string]any{"idx": idx, "title": t, "volume": vol})
			return nil
		}, novelId); err != nil {
		writeJSON(w, 500, map[string]string{"error": "分卷结构读取失败", "detail": firstLineErr(err)})
		return
	}
	groups := groupChaptersByVolume(chapters)
	volumes := make([]map[string]any, 0, len(groups))
	volumeCount, ungrouped := 0, 0
	for _, g := range groups {
		name, _ := g["name"].(string)
		chs, _ := g["chapters"].([]map[string]any)
		firstIdx, _ := chs[0]["idx"].(int64)
		lastIdx, _ := chs[len(chs)-1]["idx"].(int64)
		if name == "" {
			ungrouped += len(chs)
		} else {
			volumeCount++
		}
		volumes = append(volumes, map[string]any{
			"name": name, "chapters": len(chs), "firstIdx": firstIdx, "lastIdx": lastIdx,
		})
	}
	if len(groups) == 0 {
		ungrouped = len(chapters) // 全书无卷：groups 为空，未分组=全部章节
	}
	writeJSON(w, 200, map[string]any{
		"novelId":     novelId,
		"title":       title,
		"total":       len(chapters),
		"volumeCount": volumeCount,
		"ungrouped":   ungrouped,
		"volumes":     volumes,
	})
}
