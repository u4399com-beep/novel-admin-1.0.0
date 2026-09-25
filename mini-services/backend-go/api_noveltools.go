/**
 * api_noveltools.go —— 业务 API：存量数据维护端点（字数审计/目录重排）。
 *
 * TS 源：
 *   - src/app/api/novels/recalc-words/route.ts   → handleNovelsRecalcWordsGet / Post
 *   - src/app/api/novels/resort-chapters/route.ts → handleNovelsResortChaptersGet / Post
 *   - src/lib/scrape/ordering.ts（chineseNumeralToInt/parseChapterNo/reorderChapterRefs）
 *     → chapterorder.go（22-a 纯序号语义版逐行移植）
 *
 * GET  /api/novels/recalc-words：只读审计——比对每本书 Novel.wordCount 与 Chapter 聚合合计，
 *      返回不符清单与全站总量 { books, mismatches:[{id,title,stored,actual}], totalStored, totalActual }。
 * POST /api/novels/recalc-words：全站重算——仅对不符的书执行 update（避免无谓写放大），
 *      返回 { books, mismatched, fixed }。
 *
 * GET  /api/novels/resort-chapters：只读审计——逐书解析章节标题序号检测阅读顺序乱序，
 *      返回 { books, candidates:[{id,title,chapters,numbered,disorder}] }（不写库）。
 * POST /api/novels/resort-chapters：按审计结果重排——以章节序号为主键重新编 idx（未编号章节
 *      锚定在前一编号章节之后），两阶段事务改号避免 (novelId,idx) 唯一冲突；重排只改 idx
 *      不动内容，重排后触碰 updatedAt。POST 期间存在 pending/running 采集任务时 409 拒绝
 *      （两阶段改号会使骨架 baseIdx 快照失效，P2-9 并发防护语义对齐）。
 *
 * 移植语义差异：
 * 1. Prisma update/novel.update 自动触碰 @updatedAt → 显式 set updatedAt=nowMillis()
 * 2. Prisma $transaction → sql.Tx；两阶段负数暂存区 -(i+1)-1_000_000 与 TS 完全一致
 * 3. 响应字段名与 TS 完全一致（前端管理后台按字段消费）
 */
package main

import (
	"database/sql"
	"math"
	"net/http"
	"strconv"
)

func init() {
	register("GET", "/api/novels/recalc-words", handleNovelsRecalcWordsGet)
	register("POST", "/api/novels/recalc-words", handleNovelsRecalcWordsPost)
	register("GET", "/api/novels/resort-chapters", handleNovelsResortChaptersGet)
	register("POST", "/api/novels/resort-chapters", handleNovelsResortChaptersPost)
	register("GET", "/api/novels/smart-fill", handleNovelsSmartFillGet)
	register("POST", "/api/novels/smart-fill", handleNovelsSmartFillPost)
}

// ==================== /api/novels/recalc-words ====================

// wordMismatch 不符清单元素（字段名与 TS Mismatch 一致）
type wordMismatch struct {
	id     int64
	title  string
	stored int64
	actual int64
}

// auditWordCounts 审计：全部书籍 stored/actual 比对（一次 groupBy 聚合，无 N+1）
func auditWordCounts() (books int, mismatches []wordMismatch, totalStored, totalActual int64, err error) {
	type novelRow struct {
		id     int64
		title  string
		stored int64
	}
	novels := []novelRow{}
	if err = queryList(`SELECT "id","title","wordCount" FROM "Novel"`, func(rows *sql.Rows) error {
		var n novelRow
		if err := rows.Scan(&n.id, &n.title, &n.stored); err != nil {
			return err
		}
		novels = append(novels, n)
		return nil
	}); err != nil {
		return
	}
	sumMap := map[int64]int64{}
	if err = queryList(`SELECT "novelId", SUM("wordCount") FROM "Chapter" GROUP BY "novelId"`, func(rows *sql.Rows) error {
		var novelID int64
		var sum sql.NullInt64
		if err := rows.Scan(&novelID, &sum); err != nil {
			return err
		}
		sumMap[novelID] = sum.Int64 // TS g._sum.wordCount ?? 0
		return nil
	}); err != nil {
		return
	}
	mismatches = []wordMismatch{}
	for _, n := range novels {
		actual := sumMap[n.id] // 无章节书 → 0（TS sumMap.get(n.id) ?? 0）
		totalStored += n.stored
		totalActual += actual
		if actual != n.stored {
			mismatches = append(mismatches, wordMismatch{id: n.id, title: n.title, stored: n.stored, actual: actual})
		}
	}
	books = len(novels)
	return
}

func handleNovelsRecalcWordsGet(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	books, mismatches, totalStored, totalActual, err := auditWordCounts()
	if err != nil {
		failJSON(w, "字数审计失败", firstLineErr(err), 500)
		return
	}
	list := make([]map[string]any, 0, len(mismatches))
	for _, m := range mismatches {
		list = append(list, map[string]any{"id": m.id, "title": m.title, "stored": m.stored, "actual": m.actual})
	}
	writeJSON(w, 200, map[string]any{
		"books":       books,
		"mismatches":  list,
		"totalStored": totalStored,
		"totalActual": totalActual,
	})
}

func handleNovelsRecalcWordsPost(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	books, mismatches, _, _, err := auditWordCounts()
	if err != nil {
		failJSON(w, "字数重算失败", firstLineErr(err), 500)
		return
	}
	fixed := 0
	for _, m := range mismatches {
		// TS update().then(ok).catch(false)：单本失败不中断批次
		if _, uerr := execRetry(`UPDATE "Novel" SET "wordCount" = ?, "updatedAt" = ? WHERE "id" = ?`, m.actual, nowMillis(), m.id); uerr == nil {
			fixed++
		}
	}
	writeJSON(w, 200, map[string]any{"books": books, "mismatched": len(mismatches), "fixed": fixed})
}

// ==================== /api/novels/resort-chapters ====================

type resortChapterRow struct {
	id    int64
	idx   int64
	title string
}

// resortDetectOrder 单本书的重排检测：返回新顺序（nil=无需重排）与审计指标。
// url 复用为章节 id 载体（与 TS detectOrder 一致）。
func resortDetectOrder(chapters []resortChapterRow) (order []int64, numbered int, disorder float64) {
	refs := make([]ChapterRef, len(chapters))
	nums := make([]numOpt, len(chapters))
	for i, c := range chapters {
		refs[i] = ChapterRef{Title: c.title, URL: strconv.FormatInt(c.id, 10)}
		nums[i] = parseNumOpt(c.title)
		if nums[i].ok {
			numbered++
		}
	}
	// 与 reorderChapterRefs 同一套阈值/算法：直接复用其判定
	rr := reorderChapterRefs(refs)
	if rr.reordered {
		order = make([]int64, len(rr.refs))
		for i, r := range rr.refs {
			order[i], _ = strconv.ParseInt(r.URL, 10, 64)
		}
	}
	// 位置错乱占比：仅统计有编号章节的错位情况（展示用）
	vals := make([]int64, 0, len(nums))
	for _, n := range nums {
		if n.ok {
			vals = append(vals, n.v)
		}
	}
	if len(vals) >= 8 {
		sorted := append([]int64(nil), vals...)
		for i := 1; i < len(sorted); i++ { // 插入排序（val 范围有限，等价 sort 升序）
			for j := i; j > 0 && sorted[j] < sorted[j-1]; j-- {
				sorted[j], sorted[j-1] = sorted[j-1], sorted[j]
			}
		}
		mismatch := 0
		for i := range vals {
			if vals[i] != sorted[i] {
				mismatch++
			}
		}
		disorder = float64(mismatch) / float64(len(vals))
	}
	return order, numbered, disorder
}

// resortAudit 全站审计：返回将触发重排的书清单（不写库）
func resortAudit() (books int, candidates []map[string]any, err error) {
	type novelRow struct {
		id    int64
		title string
	}
	novels := []novelRow{}
	if err = queryList(`SELECT "id","title" FROM "Novel"`, func(rows *sql.Rows) error {
		var n novelRow
		if err := rows.Scan(&n.id, &n.title); err != nil {
			return err
		}
		novels = append(novels, n)
		return nil
	}); err != nil {
		return
	}
	candidates = []map[string]any{}
	for _, n := range novels {
		chapters := []resortChapterRow{}
		if err = queryList(`SELECT "id","idx","title" FROM "Chapter" WHERE "novelId" = ? ORDER BY "idx" ASC`, func(rows *sql.Rows) error {
			var c resortChapterRow
			if err := rows.Scan(&c.id, &c.idx, &c.title); err != nil {
				return err
			}
			chapters = append(chapters, c)
			return nil
		}, n.id); err != nil {
			return
		}
		if len(chapters) < 8 {
			continue
		}
		order, numbered, disorder := resortDetectOrder(chapters)
		if order != nil {
			candidates = append(candidates, map[string]any{
				"id":       n.id,
				"title":    n.title,
				"chapters": len(chapters),
				"numbered": numbered,
				"disorder": disorder,
			})
		}
	}
	books = len(novels)
	return
}

// resortApplyReorder 两阶段事务改号：先整体移入负数区（互不冲突），再按新顺序写回正数 idx。
// 返回 moved = len(order)。
func resortApplyReorder(novelID int64, order []int64) (int, error) {
	db, err := getDB()
	if err != nil {
		return 0, err
	}
	tx, err := db.Begin()
	if err != nil {
		return 0, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	for i := 0; i < len(order); i++ {
		if _, err := tx.Exec(`UPDATE "Chapter" SET "idx" = ? WHERE "id" = ?`, -(int64(i)+1)-1_000_000, order[i]); err != nil {
			return 0, err
		}
	}
	for i := 0; i < len(order); i++ {
		if _, err := tx.Exec(`UPDATE "Chapter" SET "idx" = ? WHERE "id" = ?`, int64(i)+1, order[i]); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	committed = true
	// novel.update ... .catch(() => undefined)：失败忽略
	_, _ = exec(`UPDATE "Novel" SET "updatedAt" = ? WHERE "id" = ?`, nowMillis(), novelID)
	return len(order), nil
}

// resortTxtMoves 重排前后 idx 迁移表（Task 38-b）：order 为重排后的章节 id 顺序，
// 落位目标=位置 i+1；与重排前 idx 不同的行才需要同步分章 txt 文件名。
// 与 api_chapters.go audit 重排（Task 33-b）同口径：reindexChapterTxtFiles 对无文件行
// （db 模式/未落盘）自动跳过，两段式 rename 防 swap 互覆。
func resortTxtMoves(chapters []resortChapterRow, order []int64) []chapterTxtMove {
	byID := make(map[int64]resortChapterRow, len(chapters))
	for _, ch := range chapters {
		byID[ch.id] = ch
	}
	moves := make([]chapterTxtMove, 0)
	for i, id := range order {
		ch, ok := byID[id]
		if !ok {
			continue
		}
		if target := int64(i + 1); ch.idx != target {
			moves = append(moves, chapterTxtMove{ChapterID: ch.id, OldIdx: ch.idx, NewIdx: target, Title: ch.title})
		}
	}
	return moves
}

func handleNovelsResortChaptersGet(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	books, candidates, err := resortAudit()
	if err != nil {
		failJSON(w, "目录重排审计失败", firstLineErr(err), 500)
		return
	}
	writeJSON(w, 200, map[string]any{"books": books, "candidates": candidates})
}

func handleNovelsResortChaptersPost(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	// P2-9 并发防护：重排两阶段改号期间，采集端骨架 baseIdx 快照失效 → 撞 (novelId,idx)
	// 唯一约束。ScrapeTask 无 novelId 外键无法按书精确关联，且骨架顺延逻辑全库共享——
	// 只要有任务在跑/待跑就一律 409 拒绝（重排属低频管理操作）。
	var activeTasks int64
	if err := queryOne(`SELECT COUNT(*) FROM "ScrapeTask" WHERE "status" IN ('pending','running')`, []any{&activeTasks}); err != nil {
		failJSON(w, "目录重排失败", firstLineErr(err), 500)
		return
	}
	if activeTasks > 0 {
		writeJSON(w, 409, map[string]string{"error": "存在进行中的采集任务，请先取消或等待其完成后再重排目录"})
		return
	}
	// body 解析：空 body/非法 JSON = 全站（对齐 TS try/catch）；novelId 需为正整数
	var novelID int64
	if v, ok := readBodyValue(r); ok {
		if f, isNum := bodyMap(v)["novelId"].(float64); isNum && f == math.Trunc(f) && f > 0 {
			novelID = int64(f)
		}
	}
	_, candidates, err := resortAudit()
	if err != nil {
		failJSON(w, "目录重排失败", firstLineErr(err), 500)
		return
	}
	results := []map[string]any{}
	for _, c := range candidates {
		cid := c["id"].(int64)
		if novelID > 0 && cid != novelID {
			continue
		}
		title := c["title"].(string)
		chapters := []resortChapterRow{}
		if err := queryList(`SELECT "id","idx","title" FROM "Chapter" WHERE "novelId" = ? ORDER BY "idx" ASC`, func(rows *sql.Rows) error {
			var ch resortChapterRow
			if err := rows.Scan(&ch.id, &ch.idx, &ch.title); err != nil {
				return err
			}
			chapters = append(chapters, ch)
			return nil
		}, cid); err != nil {
			failJSON(w, "目录重排失败", firstLineErr(err), 500)
			return
		}
		order, _, _ := resortDetectOrder(chapters)
		if order == nil {
			continue
		}
		moved, aerr := resortApplyReorder(cid, order)
		if aerr != nil {
			failJSON(w, "目录重排失败", firstLineErr(aerr), 500)
			return
		}
		// Task 38-b: 重排落库后同步分章 txt 文件名。旧版遗漏（与 Task 33-b audit 重排
		// 同形态的姊妹路径）：txt/both 模式书的分章文件名内嵌 idx，DB 重排后文件仍挂旧
		// idx → readChapterFromTxt 按「新 idx」前缀命中别的章（串章）或读不到
		//（txt 书正文"丢失"），三级回落读到错误内容。
		reindexChapterTxtFiles(cid, resortTxtMoves(chapters, order))
		results = append(results, map[string]any{"id": cid, "title": title, "moved": moved})
	}
	writeJSON(w, 200, map[string]any{"scanned": len(candidates), "reordered": len(results), "results": results})
}

// ==================== /api/novels/smart-fill（Task 33 智能补全） ====================

// junkAuthorSQL 占位作者集合的 SQL IN 字面量（与 storex.go junkAuthorSet 口径一致；
// resolveAuthor 的落库终值「佚名」也在内）
const junkAuthorSQL = `('佚名','佚名者','未知','未知作者','未知作家','无','无作者','匿名','不详','佚','anonymous','unknown','unknow','none','null')`

// smartFillReport 全库不完整面体检（只读）
type smartFillReport struct {
	JunkAuthor    int      `json:"junkAuthor"`
	EmptyDesc     int      `json:"emptyDescription"`
	FallbackCat   int      `json:"fallbackCategory"`
	SerialEnding  int      `json:"serialWithFinishedEnding"`
	GradientCover int      `json:"gradientCover"` // Task 34: 渐变 token 封面（源站无图/下载失败，重采可升级）
	Samples       []string `json:"samples"`
}

func buildSmartFillReport() smartFillReport {
	var rep smartFillReport
	_ = queryOne(`SELECT COUNT(*) FROM "Novel" WHERE "author" IN `+junkAuthorSQL, []any{&rep.JunkAuthor})
	_ = queryOne(`SELECT COUNT(*) FROM "Novel" WHERE TRIM("description") = ''`, []any{&rep.EmptyDesc})
	_ = queryOne(`SELECT COUNT(*) FROM "Novel" n JOIN "Category" c ON c."id" = n."categoryId" WHERE c."name" = ?`, []any{&rep.FallbackCat}, FALLBACK_CATEGORY)
	// serial 且末章标题命中完结词（与 smartCompleteStatus 同口径）
	_ = queryOne(`SELECT COUNT(*) FROM "Novel" n WHERE n."status" = 'serial' AND EXISTS (
                SELECT 1 FROM "Chapter" c WHERE c."novelId" = n."id" AND c."idx" = (SELECT MAX("idx") FROM "Chapter" WHERE "novelId" = n."id")
                  AND (c."title" LIKE '%大结局%' OR c."title" LIKE '%终章%' OR c."title" LIKE '%終章%' OR c."title" LIKE '%全书完%' OR c."title" LIKE '%全書完%' OR c."title" LIKE '%完本%' OR c."title" LIKE '%The End%'))`,
		[]any{&rep.SerialEnding})
	// Task 34: 渐变 token 封面计数（cover ∈ g1..g12；本地 /covers/*.jpg 与 http(s) 远程均不算）
	_ = queryOne(`SELECT COUNT(*) FROM "Novel" WHERE "cover" GLOB 'g[1-9]' OR "cover" = 'g10' OR "cover" = 'g11' OR "cover" = 'g12'`, []any{&rep.GradientCover})
	rep.Samples = []string{}
	return rep
}

// handleNovelsSmartFillGet GET /api/novels/smart-fill：四类不完整面统计
func handleNovelsSmartFillGet(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	writeJSON(w, 200, map[string]any{"ok": true, "report": buildSmartFillReport()})
}

// handleNovelsSmartFillPost POST /api/novels/smart-fill {limit?:30}：
// 有界批量智能修复（单次至多 50 本），逐书四步：
//  1. 空简介 → 首章正文预览（backfillDescriptions 同源）→ LLM 生成（冷却治理）
//  2. 占位作者 → LLM 推断（书名+简介）→ 仍失败保留占位（不虚构）
//  3. 分类=其他 → 本地关键词（标题+简介）→ LLM 推断 → 命中规范类则迁移
//  4. serial 且末章命中完结词且无进行时负向词 → finished（smartCompleteStatus 同口径）
//
// 返回 { scanned, descFilled, authorFilled, categoryMoved, statusFixed }。
// 幂等可重复调用：每轮只处理仍不完整的书；LLM 失败静默跳过（下轮再试）。
func handleNovelsSmartFillPost(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	limit := 30
	if v, ok := readBodyValue(r); ok {
		if m := bodyMap(v); m != nil {
			if f, isNum := m["limit"].(float64); isNum && numIsInt(f) && f > 0 {
				limit = int(f)
			}
		}
	}
	if limit > 50 {
		limit = 50
	}
	type candRow struct {
		id      int
		title   string
		author  string
		desc    string
		catID   int
		catName string
	}
	var cands []candRow
	// Task 34 毒丸堵塞修复：旧实现固定 ORDER BY n.id ASC —— 修复不动的书（LLM 持续冷却/
	// 推断未果）永远占据候选队首，后续可修书全被 LIMIT 截掉。改随机抽样：每轮从全池等概率取样，
	// 毒丸不堵塞，多轮调用天然覆盖全池（候选池通常 ≤ 数百，RANDOM() 扫描可接受）
	err := queryList(`SELECT n."id", n."title", n."author", n."description", n."categoryId", c."name"
                FROM "Novel" n JOIN "Category" c ON c."id" = n."categoryId"
                WHERE n."author" IN `+junkAuthorSQL+` OR TRIM(n."description") = '' OR c."name" = '`+FALLBACK_CATEGORY+`'
                ORDER BY RANDOM() LIMIT ?`,
		func(rs *sql.Rows) error {
			var x candRow
			if err := rs.Scan(&x.id, &x.title, &x.author, &x.desc, &x.catID, &x.catName); err != nil {
				return err
			}
			cands = append(cands, x)
			return nil
		}, limit)
	if err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	var descFilled, authorFilled, categoryMoved, statusFixed int
	for _, x := range cands {
		changed := false
		// 取末章标题（四步共用）
		var lastTitle string
		_ = queryOne(`SELECT "title" FROM "Chapter" WHERE "novelId" = ? ORDER BY "idx" DESC LIMIT 1`, []any{&lastTitle}, x.id)
		// 1. 空简介
		if trimSpaceStr(x.desc) == "" {
			generated := firstChapterPreview(x.id)
			if trimSpaceStr(generated) == "" {
				generated = trimSpaceStr(llmGenerateDescription(x.title, x.author))
			}
			if trimSpaceStr(generated) != "" {
				if _, err := execRetry(`UPDATE "Novel" SET "description" = ?, "updatedAt" = ? WHERE "id" = ? AND TRIM("description") = ''`,
					truncateRunes(trimSpaceStr(generated), novelDescriptionMax), nowMillis(), x.id); err == nil {
					x.desc = trimSpaceStr(generated)
					descFilled++
					changed = true
				}
			}
		}
		// 2. 占位作者
		if authorIsJunk(x.author) {
			if a := trimSpaceStr(llmGuessAuthor(x.title, x.desc)); !authorIsJunk(a) {
				if _, err := execRetry(`UPDATE "Novel" SET "author" = ?, "updatedAt" = ? WHERE "id" = ?`,
					truncateRunes(a, novelAuthorMax), nowMillis(), x.id); err == nil {
					authorFilled++
					changed = true
				}
			}
		}
		// 3. 分类滞留「其他」
		if x.catName == FALLBACK_CATEGORY {
			canon := classifyBookLocal(x.title, x.desc)
			if canon == "" {
				canon = llmClassifyBook(x.title, x.desc)
			}
			if canon != "" && canon != FALLBACK_CATEGORY {
				var targetID int64
				if qerr := queryOne(`SELECT "id" FROM "Category" WHERE "name" = ?`, []any{&targetID}, canon); qerr == nil {
					if _, uerr := execRetry(`UPDATE "Novel" SET "categoryId" = ?, "updatedAt" = ? WHERE "id" = ?`,
						targetID, nowMillis(), x.id); uerr == nil {
						categoryMoved++
						changed = true
					}
				}
			}
		}
		// 4. 智能完结（末章标题；负向词先行）
		if lastTitle != "" && novelStatusFinishedRE.MatchString(lastTitle) {
			if !novelStatusOngoingRE.MatchString(lastTitle) && !novelStatusOngoingRE.MatchString(x.desc) {
				if _, uerr := execRetry(`UPDATE "Novel" SET "status" = 'finished', "updatedAt" = ? WHERE "id" = ? AND "status" = 'serial'`,
					nowMillis(), x.id); uerr == nil {
					statusFixed++
					changed = true
				}
			}
		}
		_ = changed
	}
	// 独立批次：仅状态不完整的书（简介/作者/分类完好，不占候选配额；纯 DB 判定零 LLM 开销）
	// 与 runner finalize 的 smartCompleteStatus 同语义，此处面向存量历史数据
	var serialFix []int
	_ = queryList(`SELECT n."id" FROM "Novel" n WHERE n."status" = 'serial' AND EXISTS (
                SELECT 1 FROM "Chapter" c WHERE c."novelId" = n."id" AND c."idx" = (SELECT MAX("idx") FROM "Chapter" WHERE "novelId" = n."id")
                  AND (c."title" LIKE '%大结局%' OR c."title" LIKE '%终章%' OR c."title" LIKE '%終章%' OR c."title" LIKE '%全书完%' OR c."title" LIKE '%全書完%' OR c."title" LIKE '%完本%' OR c."title" LIKE '%The End%'))
                  LIMIT 100`,
		func(rs *sql.Rows) error {
			var id int
			if err := rs.Scan(&id); err != nil {
				return err
			}
			serialFix = append(serialFix, id)
			return nil
		})
	for _, id := range serialFix {
		var lastTitle, desc string
		if err := queryOne(`SELECT (SELECT "title" FROM "Chapter" WHERE "novelId" = ? ORDER BY "idx" DESC LIMIT 1), "description" FROM "Novel" WHERE "id" = ?`,
			[]any{&lastTitle, &desc}, id, id); err != nil {
			continue
		}
		if lastTitle == "" || !novelStatusFinishedRE.MatchString(lastTitle) {
			continue
		}
		if novelStatusOngoingRE.MatchString(lastTitle) || novelStatusOngoingRE.MatchString(desc) {
			continue
		}
		if _, uerr := execRetry(`UPDATE "Novel" SET "status" = 'finished', "updatedAt" = ? WHERE "id" = ? AND "status" = 'serial'`,
			nowMillis(), id); uerr == nil {
			statusFixed++
		}
	}
	writeJSON(w, 200, map[string]any{
		"ok":            true,
		"scanned":       len(cands),
		"descFilled":    descFilled,
		"authorFilled":  authorFilled,
		"categoryMoved": categoryMoved,
		"statusFixed":   statusFixed,
	})
}
