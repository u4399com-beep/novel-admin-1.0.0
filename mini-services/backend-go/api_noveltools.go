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
 * 2. Prisma $transaction → sql.Tx；两阶段负数暂存区 Task 42-b 起取 min(0,全书最小idx)-1
 *    起算的连续负数段（旧固定值 -(i+1)-1_000_000 与存量滞留行 idx=-1000000-k 相撞，
 *    见 resortApplyReorder 注）
 * 3. 响应字段名与 TS 完全一致（前端管理后台按字段消费）
 */
package main

import (
        "database/sql"
        "log"
        "math"
        "net/http"
        "os"
        "strconv"
        "sync"
        "time"
)

func init() {
        register("GET", "/api/novels/recalc-words", handleNovelsRecalcWordsGet)
        register("POST", "/api/novels/recalc-words", handleNovelsRecalcWordsPost)
        register("GET", "/api/novels/resort-chapters", handleNovelsResortChaptersGet)
        register("POST", "/api/novels/resort-chapters", handleNovelsResortChaptersPost)
        register("GET", "/api/novels/smart-fill", handleNovelsSmartFillGet)
        register("POST", "/api/novels/smart-fill", handleNovelsSmartFillPost)
        register("POST", "/api/novels/backfill-covers", handleNovelsBackfillCovers)
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
// Task 42-b: 暂存区取 min(0, 全书最小 idx) - 1 起算的连续负数段——旧版固定 -(i+1)-1_000_000
// 自 -1_000_001 起算，与存量滞留行（旧二进制 audit 两段式段落位失败遗留的 idx=-1_000_000-k
// 损伤类）相撞 → UNIQUE 冲突 → 事务回滚 500，该书永久不可重排。压到全书最小 idx 之下后，
// 暂存值与任何存量 idx（含滞留负数行）及落位目标 1..n 均无交集，碰撞在构造上不可能。
// MIN(idx) 在事务外读取即安全：并发删最小行只会让实际存量 idx 更大（暂存值仍更低）；
// 并发新插入 idx=MAX(idx)+1 > MAX ≥ MIN > 暂存值，同样无交集。
func resortApplyReorder(novelID int64, order []int64) (int, error) {
        db, err := getDB()
        if err != nil {
                return 0, err
        }
        var minIdx sql.NullInt64
        if err := queryOne(`SELECT MIN("idx") FROM "Chapter" WHERE "novelId" = ?`, []any{&minIdx}, novelID); err != nil && !isNoRows(err) {
                return 0, err
        }
        stageBase := int64(0)
        if minIdx.Valid && minIdx.Int64 < stageBase {
                stageBase = minIdx.Int64
        }
        stageBase--
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
                if _, err := tx.Exec(`UPDATE "Chapter" SET "idx" = ? WHERE "id" = ?`, stageBase-int64(i), order[i]); err != nil {
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
        // body 解析：空 body/非法 JSON = 全站（对齐 TS try/catch）；novelId 需为正整数。
        // Task 49-b: 补 2^53 上界（taskRuleIDParam 同族）——旧版 f=1e300 时 int64(f) 为
        // 实现定义溢出（amd64 得 MinInt64 负值），负值使 novelID>0 判定失效、退化为全站重排
        var novelID int64
        force := false
        if v, ok := readBodyValue(r); ok {
                m := bodyMap(v)
                if f, isNum := m["novelId"].(float64); isNum && f == math.Trunc(f) && f > 0 && f <= 9_007_199_254_740_992 {
                        novelID = int64(f)
                }
                if b, isBool := m["force"].(bool); isBool {
                        force = b
                }
        }
        // R86 force 分支：指定单书强制重排（忽略 20% 错乱占比审计阈值）。配套「追加式目录
        // 补全修复截断书」——旧最新章节块残留中间仅 1-2% 错位，审计永不命中；管理员可对
        // 修复书逐一强制。仍受并发防护（上方 409）与编号下限保护（reorderChapterRefsImpl）。
        if force && novelID > 0 {
                chapters := []resortChapterRow{}
                if err := queryList(`SELECT "id","idx","title" FROM "Chapter" WHERE "novelId" = ? ORDER BY "idx" ASC`, func(rows *sql.Rows) error {
                        var ch resortChapterRow
                        if err := rows.Scan(&ch.id, &ch.idx, &ch.title); err != nil {
                                return err
                        }
                        chapters = append(chapters, ch)
                        return nil
                }, novelID); err != nil {
                        failJSON(w, "目录重排失败", firstLineErr(err), 500)
                        return
                }
                if len(chapters) == 0 {
                        writeJSON(w, 404, map[string]string{"error": "书籍不存在或无章节"})
                        return
                }
                refs := make([]ChapterRef, len(chapters))
                for i, ch := range chapters {
                        refs[i] = ChapterRef{Title: ch.title, URL: strconv.FormatInt(ch.id, 10)}
                }
                rr := reorderChapterRefsForce(refs)
                if !rr.reordered {
                        writeJSON(w, 200, map[string]any{"scanned": 1, "reordered": 0, "results": []map[string]any{}})
                        return
                }
                order := make([]int64, len(rr.refs))
                for i, rf := range rr.refs {
                        order[i], _ = strconv.ParseInt(rf.URL, 10, 64)
                }
                moved, aerr := resortApplyReorder(novelID, order)
                if aerr != nil {
                        failJSON(w, "目录重排失败", firstLineErr(aerr), 500)
                        return
                }
                reindexChapterTxtFiles(novelID, resortTxtMoves(chapters, order))
                writeJSON(w, 200, map[string]any{"scanned": 1, "reordered": 1,
                        "results": []map[string]any{{"id": novelID, "moved": moved, "force": true, "note": rr.note}}})
                return
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

// smartFillLimitParam 提取校验 body.limit（缺省 30、上限 50）。
// Task 49-b: float 域完成 2^53 上界判定后再转 int（taskRuleIDParam 同族）——旧版
// int(f) 对 1e300 是实现定义溢出（amd64 得 MinInt64 负值），负 limit 传入 SQLite
// `LIMIT ?` 语义=无上限（候选全表展开，逐书 LLM 调用），越界值与缺省同口径回落 30
func smartFillLimitParam(m map[string]any) int {
        limit := 30
        if m != nil {
                if f, isNum := m["limit"].(float64); isNum && numIsInt(f) && f > 0 && f <= 9_007_199_254_740_992 {
                        limit = int(f)
                }
        }
        if limit > 50 {
                limit = 50
        }
        return limit
}

func handleNovelsSmartFillPost(w http.ResponseWriter, r *http.Request, _ map[string]string) {
        var body map[string]any
        if v, ok := readBodyValue(r); ok {
                body = bodyMap(v)
        }
        limit := smartFillLimitParam(body)
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

// ==================== POST /api/novels/backfill-covers（Task 50 封面补抓） ====================

// coverBackfillItem 补抓结果明细
type coverBackfillItem struct {
        ID     int64  `json:"id"`
        Title  string `json:"title"`
        Reason string `json:"reason,omitempty"`
}

// coverBackfillBudget 单次补抓请求的下载总时长预算（Task 50-b）。
// main.go HTTP server 的 WriteTimeout=65s 覆盖「请求头读完 → 响应写完」全程：本端点
// 串行下载封面，单本最坏 ≈17s（assertPublicHttpURL DNS 5s + COVER_DL_TIMEOUT 12s），
// 旧版无总预算——默认 limit=20 的批次只要撞上 4-6 个慢/死图床就会打爆 65s 写窗口，
// 客户端响应被半途掐断（含 remaining 的循环调用契约断裂），服务端却继续把整批空烧完。
// 预算 40s：预算耗尽即停止发起新的下载（在途一本最多再 ~17s），响应必在窗口内写回。
// var（非 const）：测试注入超小预算用（audit50b_test.go），生产路径只读。
var coverBackfillBudget = 40 * time.Second

// coverBackfillCand 封面补抓候选行
type coverBackfillCand struct {
        id       int64
        title    string
        coverSrc string
}

// coverBackfillCandidates 封面补抓候选扫描（Task 50-b 自 handler 抽出供测试共用）：
// cover 仍为渐变 token 且 coverSrc（Task 50 起落库的源站封面 URL）非空的书，按 id
// 升序全量返回（分批截断由调用方做）。
// Task 50-b 修复漏扫：旧条件 `LENGTH("cover") = 2 AND "cover" LIKE 'g_'` 只命中
// g1-g9——gradientTokenFor/coverTokens 的 token 空间是 g1-g12，g10/g11/g12（3 字符）
// 的书被永久排除在补抓之外（token 面缺 1/4）。LIKE 'g_'/'g__' 的定长通配自带长度
// 约束，等价「2-3 字符 g 前缀」精确覆盖 token 空间（SQLite LIKE ASCII 大小写不敏感
// 为无害超集；本地封面路径 /covers/*.jpg 长度恒 >3 天然不命中）。
func coverBackfillCandidates() ([]coverBackfillCand, error) {
        cands, _, err := coverBackfillCandidatesPaged(0, true, 0)
        return cands, err
}

// coverBackfillCandidatesPaged 分页候选扫描（Task 69 全量重取驱动）。
// afterID：id 游标（只返回 id > afterID，调用方拿 nextAfterId 循环翻页）；
// onlyToken=true：常规补抓面（cover 为渐变 token 且 coverSrc 非空）；
// onlyToken=false：force 全量面（cover 任意形态——本地路径/渐变 token——只要
// coverSrc 非空即重取：按采集落库的封面源 URL 重下真实封面，修正错位/陈旧封面；
// coverSrc 为空的书无源可循，两面均排除）；
// limit：返回上限（<=0 = 不限，兼容旧全量扫描语义）。
// hasMore：LIMIT limit+1 探测——恒精确，无「恰等于 limit」边界歧义。
func coverBackfillCandidatesPaged(afterID int64, onlyToken bool, limit int) (cands []coverBackfillCand, hasMore bool, err error) {
        q := `SELECT "id","title","coverSrc" FROM "Novel" WHERE "coverSrc" != '' AND "id" > ?`
        if onlyToken {
                q = `SELECT "id","title","coverSrc" FROM "Novel" WHERE ("cover" LIKE 'g_' OR "cover" LIKE 'g__') AND "coverSrc" != '' AND "id" > ?`
        }
        q += ` ORDER BY "id" ASC`
        args := []any{afterID}
        if limit > 0 {
                q += ` LIMIT ?`
                args = append(args, limit+1) // 多取一行探测 hasMore
        }
        cands = []coverBackfillCand{}
        err = queryList(q, func(rows *sql.Rows) error {
                var c coverBackfillCand
                if err := rows.Scan(&c.id, &c.title, &c.coverSrc); err != nil {
                        return err
                }
                cands = append(cands, c)
                return nil
        }, args...)
        if err != nil {
                return nil, false, err
        }
        if limit > 0 && len(cands) > limit {
                cands = cands[:limit]
                hasMore = true
        }
        return cands, hasMore, nil
}

// coverBackfillSummary 单批补抓结果（handler 响应与后台巡检共用，Task 69）。
type coverBackfillSummary struct {
        Scanned     int                 `json:"scanned"`
        Attempted   int                 `json:"attempted"`
        Fixed       int                 `json:"fixed"`
        Failed      int                 `json:"failed"`
        Failures    []coverBackfillItem `json:"failures"`
        Remaining   int                 `json:"remaining"`
        NextAfterID int64               `json:"nextAfterId"`
        HasMore     bool                `json:"hasMore"`
}

// runCoverBackfillBatch 执行单批补抓（手动端点与后台巡检共用，Task 69）。
// force=true：全量重取（fetchCoverWithFallbackOpt 跳幂等复用，成功原子覆盖旧图，
// 失败旧图原样保留）；force=false：幂等补抓（已落盘直接复用）。
// afterID：id 游标；limit：批大小；proxy：主出口代理（空=直连，网络类失败自动
// 回退规则代理池）。总时长预算 coverBackfillBudget 与 65s 写窗口护栏不变。
// R86 饥饿修复：非 force 路径改走可见流精确分页（coverBackfillCandidatesVisible：
// SQL 分块 + 失败记忆过滤 + limit+1 探测）——近期失败的书本批不可见，防早期 id
// 不可达图床书每轮烧尽 40s 预算饿死其后书目；force 路径不过滤（显式全量重取语义，
// 用户指令「重新获取所有」必须逐本重下）。
func runCoverBackfillBatch(force bool, afterID int64, limit int, proxy string) (coverBackfillSummary, error) {
        sum := coverBackfillSummary{Failures: []coverBackfillItem{}}
        var cands []coverBackfillCand
        var hasMore bool
        var err error
        if !force && limit > 0 {
                cands, hasMore, err = coverBackfillCandidatesVisible(afterID, limit)
        } else {
                cands, hasMore, err = coverBackfillCandidatesPaged(afterID, !force, limit)
        }
        if err != nil {
                return sum, err
        }
        sum.Scanned = len(cands)
        start := time.Now()
        hardDeadline := start.Add(coverBackfillBudget)
        for _, c := range cands {
                // 总时长预算——超预算即停止发起新下载（剩余计入 remaining，游标不推进，
                // 调用方重试同批即可续上；与 Task 50-b 契约同语义）
                if time.Since(start) > coverBackfillBudget {
                        break
                }
                sum.Attempted++
                sum.NextAfterID = c.id
                stored, reason := fetchCoverWithFallbackOpt(int(c.id), c.coverSrc, proxy, hardDeadline, force)
                if stored == "" {
                        coverFailMemoryRecord(int64(c.id))
                        sum.Failures = append(sum.Failures, coverBackfillItem{ID: c.id, Title: c.title, Reason: reason})
                        continue
                }
                if _, err := execRetry(`UPDATE "Novel" SET "cover" = ?, "updatedAt" = ? WHERE "id" = ?`,
                        stored, nowMillis(), c.id); err != nil {
                        sum.Failures = append(sum.Failures, coverBackfillItem{ID: c.id, Title: c.title, Reason: firstLineErr(err)})
                        continue
                }
                coverFailMemoryClear(int64(c.id))
                sum.Fixed++
        }
        sum.Failed = len(sum.Failures)
        sum.Remaining = len(cands) - sum.Attempted
        sum.HasMore = hasMore
        return sum, nil
}

// coverFailMemory 封面补抓失败记忆（R86 饥饿修复）：非 force 路径（30min 巡检）
// 跳过近期失败的书，防不可达图床书每轮烧尽 40s 预算饿死其后待补书。
// 进程内态（重启即清——重启后首轮多烧几本属可接受代价），成功率路由语义：
// 成功即清除，失败记录时间戳，coverFailRetryGap 后重新参选。
var coverFailMemory sync.Map // int64(novelID) -> int64(failAtMillis)

// coverFailRetryGap 失败记忆有效窗：窗内不重试（30min 巡检 × 6 轮 = 3h 后再试）
const coverFailRetryGap = 3 * 60 * 60 * 1000

// coverFailMemoryRecentlyFailed 失败记忆谓词：窗口内失败过 = true
func coverFailMemoryRecentlyFailed(novelID int64) bool {
        if v, ok := coverFailMemory.Load(novelID); ok {
                if failAt, _ := v.(int64); nowMillis()-failAt < coverFailRetryGap {
                        return true
                }
        }
        return false
}

// coverBackfillCandidatesVisible 可见流精确分页（R86 饥饿修复）：SQL 分块扫描 +
// 失败记忆过滤，返回至多 limit 个可见候选；hasMore = 可见流是否还有更多
// （limit+1 探测，恒精确——被记忆隐藏的书不产生空页、不虚报 hasMore，
// 调用方游标翻页至 hasMore=false 即穷尽当前可见面）。
// 仅非 force 路径使用；limit<=0 回退旧全量扫描语义（当前无此调用方，防御保留）。
func coverBackfillCandidatesVisible(afterID int64, limit int) ([]coverBackfillCand, bool, error) {
        if limit <= 0 {
                cands, _, err := coverBackfillCandidatesPaged(afterID, true, 0)
                return cands, false, err
        }
        visible := make([]coverBackfillCand, 0, limit+1)
        cursor := afterID
        const chunk = 50
        for {
                rows, more, err := coverBackfillCandidatesPaged(cursor, true, chunk)
                if err != nil {
                        return nil, false, err
                }
                for _, c := range rows {
                        if coverFailMemoryRecentlyFailed(int64(c.id)) {
                                continue // 近期失败：本批不可见，窗口过后自然重新参选
                        }
                        visible = append(visible, c)
                        if len(visible) > limit {
                                return visible[:limit], true, nil
                        }
                }
                if !more {
                        return visible, false, nil
                }
                cursor = rows[len(rows)-1].id
        }
}

// coverFailMemoryRecord 记录失败（时间戳覆盖旧值，滑动窗口语义）
func coverFailMemoryRecord(novelID int64) {
        coverFailMemory.Store(novelID, nowMillis())
}

// coverFailMemoryClear 成功清除记忆
func coverFailMemoryClear(novelID int64) {
        coverFailMemory.Delete(novelID)
}

// handleNovelsBackfillCovers 封面批量补抓（用户指令「很多书没有封面……修复完善，杜绝后患」）：
// 旧版封面下载对双栈站点（DNS 含 AAAA 记录）被 isPrivateIp 的「含冒号一律拒绝」catch-all
// 整体误判私网 → 全站静默丢封面（101kks 实证）。根修后新采集自动恢复；本端点消化存量——
// 扫描 cover 仍为渐变 token 且 coverSrc 非空的书，逐本补抓落盘。串行 + 总时长预算
// （coverBackfillBudget，防慢/死图床拖爆 WriteTimeout），单次最多 limit 本（缺省 20、
// 上限 100），响应含 remaining/nextAfterId/hasMore 供循环调用。代理走查询参数
// （缺省直连；被封锁图床需重采走规则出口）。幂等：已落盘的书 fetchAndStoreCover 直接复用不重下。
// Task 69 全量重取（用户指令「根据采集任务日志重新获取所有在库书籍封面」）：
// force=1 时扫描面扩大到「coverSrc 非空的全部书」（含已落盘本地路径形态），逐本强制
// 重下按 coverSrc（采集时落库的源站封面 URL）原子覆盖——修正错位/陈旧封面；失败时
// 旧图原样保留不降级。afterId=id 游标（返回 id > afterId 的候选），驱动全量翻页。
func handleNovelsBackfillCovers(w http.ResponseWriter, r *http.Request, _ map[string]string) {
        limit := 20
        if raw := trimSpaceStr(r.URL.Query().Get("limit")); raw != "" {
                if n, err := strconv.Atoi(raw); err == nil {
                        limit = clampInt(n, 1, 100)
                }
        }
        proxy := trimSpaceStr(r.URL.Query().Get("proxy"))
        force := trimSpaceStr(r.URL.Query().Get("force")) == "1"
        var afterID int64
        if raw := trimSpaceStr(r.URL.Query().Get("afterId")); raw != "" {
                if n, err := strconv.ParseInt(raw, 10, 64); err == nil && n > 0 {
                        afterID = n
                }
        }

        sum, err := runCoverBackfillBatch(force, afterID, limit, proxy)
        if err != nil {
                failJSON(w, "服务器错误", firstLineErr(err), 500)
                return
        }
        writeJSON(w, 200, map[string]any{
                "ok":          true,
                "force":       force,
                "scanned":     sum.Scanned,
                "attempted":   sum.Attempted,
                "fixed":       sum.Fixed,
                "failed":      sum.Failed,
                "failures":    sum.Failures,
                "remaining":   sum.Remaining,
                "nextAfterId": sum.NextAfterID,
                "hasMore":     sum.HasMore,
        })
}

// startCoverSweepLoop 封面巡检自愈（Task 69）：30min/轮，常规面（渐变 token + coverSrc
// 非空）补抓至多 20 本/轮（复用 40s 预算护栏与出口回退）——采集内联失败/网络抖动/
// 图床瞬断造成的存量缺口无人值守收敛；force 全量重取属显式运营动作（手动端点
// ?force=1），不入巡检（避免周期性全站重下载流量）。COVERSWEEP_OFF=1 停用。
func startCoverSweepLoop() {
        const interval = 30 * time.Minute
        const batchLimit = 20
        for {
                time.Sleep(interval) // 先睡后扫：boot 自愈链（backfillBrokenCoverLocal）先行
                if os.Getenv("COVERSWEEP_OFF") == "1" {
                        continue
                }
                sum, err := runCoverBackfillBatch(false, 0, batchLimit, "")
                if err != nil {
                        log.Printf("[coversweep] 巡检批失败: %v", err)
                        continue
                }
                if sum.Attempted > 0 {
                        log.Printf("[coversweep] 补抓轮：attempted=%d fixed=%d failed=%d（%s 后再巡）", sum.Attempted, sum.Fixed, sum.Failed, interval)
                }
        }
}
