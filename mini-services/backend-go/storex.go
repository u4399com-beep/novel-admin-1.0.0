/**
 * backend-go —— 采集数据入库层：规则加载/清洗、书籍 upsert（并发冲突回读）、
 * 章节骨架批量入库（唯一冲突退化为逐条顺延重试）、章节入库、字数重算。
 *
 * TS 源：src/lib/scrape/store.ts（逐行移植）+ Prisma Client → raw SQL（modernc.org/sqlite）
 *
 * 移植差异：
 * - Prisma DateTime（SQLite 存 ms 整数）在 INSERT/UPDATE 显式写入 nowMillis()，
 *   绕开 SQLite DDL 的 CURRENT_TIMESTAMP 文本默认值，保持与 Prisma 写入格式一致
 * - P2002 唯一冲突 → isUniqueConflict（骨架 db.go：UNIQUE constraint 消息判定）
 * - SQLITE_BUSY：execRetry/execRetryReturningID 统一封装（错误含 locked/busy 时
 *   200ms 退避重试一次）——WAL 多进程（api 3005 与 runner 并存）下必需
 * - createMany → 多值 INSERT（500 行/条语句分块，避开 SQLite 变量参数上限；
 *   Prisma 单语句原子性由 SQLite 多值 INSERT 事务语义保证）
 * - 字符串截断统一按 rune（JS slice 为 UTF-16 码元，中文 BMP 内一致）
 * - loadExistingChapters 未移植（仅 audit 脚本使用，worker 不依赖）
 */
package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"
)

// ==================== SQLITE_BUSY 容忍封装 ====================

// isBusyErr 判定 SQLite 锁忙（modernc 驱动消息含 database is locked / busy）
func isBusyErr(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return containsFoldStr(msg, "locked") || containsFoldStr(msg, "busy")
}

// execRetry 执行写语句；busy/locked 时 200ms 退避重试一次
func execRetry(query string, args ...any) (sql.Result, error) {
	res, err := exec(query, args...)
	if err != nil && isBusyErr(err) {
		time.Sleep(200 * time.Millisecond)
		res, err = exec(query, args...)
	}
	return res, err
}

// execRetryReturningID 执行 INSERT 并返回 last_insert_rowid（busy 退避重试）
func execRetryReturningID(query string, args ...any) (int64, error) {
	res, err := execRetry(query, args...)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// ==================== 规则 ====================

// 单条规则映射的键数与键长上限（引擎只读取固定键名，防止畸形输入撑爆规则 JSON 存储）
const (
	MAX_RULE_KEYS   = 60
	MAX_RULE_KEYLEN = 100
)

// sanitizeRuleMap 运行时清洗规则对象：仅保留非空字符串值并限长（API 输入与 DB 读出共用）
func sanitizeRuleMap(raw any) RuleMap {
	out := RuleMap{}
	m, ok := raw.(map[string]any)
	if !ok || m == nil {
		return out
	}
	for k, v := range m {
		s, ok := v.(string)
		if !ok {
			continue
		}
		if trimSpaceStr(s) == "" {
			continue
		}
		// chapterListApi 为 JSON 目录接口配置字符串（与引擎白名单同步：普通选择器 300、配置串 1200）
		capLen := 300
		if k == "chapterListApi" {
			capLen = 1200
		}
		out[truncateRunes(k, MAX_RULE_KEYLEN)] = truncateRunes(trimSpaceStr(s), capLen)
		if len(out) >= MAX_RULE_KEYS {
			break
		}
	}
	return out
}

// safeParseRule 安全解析 DB 中的规则 JSON（历史数据可能损坏）
func safeParseRule(s string) RuleMap {
	if s == "" {
		return RuleMap{}
	}
	var raw any
	if err := json.Unmarshal([]byte(s), &raw); err != nil {
		return RuleMap{}
	}
	return sanitizeRuleMap(raw)
}

// loadRule 加载 ScrapeRule → LoadedRule（未配置/加载失败 → 全空规则，走引擎内置启发式）
func loadRule(ruleID *int) LoadedRule {
	empty := LoadedRule{ListRule: RuleMap{}, BookRule: RuleMap{}, ChapterRule: RuleMap{}}
	if ruleID == nil || *ruleID == 0 {
		return empty
	}
	var name, charset, proxy, listRule, bookRule, chapterRule sql.NullString
	var insecure bool
	err := queryOne(
		"SELECT name, charset, proxy, insecureTLS, listRule, bookRule, chapterRule FROM ScrapeRule WHERE id = ?",
		[]any{&name, &charset, &proxy, &insecure, &listRule, &bookRule, &chapterRule}, *ruleID)
	if err != nil {
		return empty
	}
	return LoadedRule{
		Name:        name.String,
		Charset:     strings.ToLower(charset.String),
		Proxy:       strings.TrimSpace(proxy.String),
		InsecureTLS: insecure,
		ListRule:    safeParseRule(listRule.String),
		BookRule:    safeParseRule(bookRule.String),
		ChapterRule: safeParseRule(chapterRule.String),
	}
}

// mapNovelStatus 源站连载状态 → serial|finished
var novelStatusRE = regexp.MustCompile(`(?i)完|fin`)

func mapNovelStatus(raw string) string {
	if novelStatusRE.MatchString(raw) {
		return "finished"
	}
	return "serial"
}

// httpsURLRE 远程封面 URL 判定（^https?:\/\//）
var httpsURLRE = regexp.MustCompile(`^https?://`)

// ==================== 书籍 upsert ====================

// UpsertOutcome 书籍 upsert 结果
type UpsertOutcome struct {
	OK         bool
	Canceled   bool // 记录级失败（入库/更新失败、并发冲突后找不到记录）为 true
	NovelID    int
	CreatedNew bool
	Title      string
	Message    string
}

// upsertBook 书籍 upsert（title+author 查重，先 trim 规范化再截断；DB 层
// @@unique([title,author]) 兜底并发）。新书 created+1 / 已有书 updated+1（run.counters）。
// canceled 仅对「记录级失败」为 true；空标题返回 canceled=false（任务按 failed 收尾）。
func upsertBook(run *Run, book BookData, categoryID int, proxy string) UpsertOutcome {
	fail := func(message string, canceled bool) UpsertOutcome {
		return UpsertOutcome{OK: false, Canceled: canceled, Message: message}
	}

	title := truncateRunes(trimSpaceStr(book.Title), novelTitleMax)
	if title == "" {
		return fail("书籍标题为空，入库中止", false)
	}
	author := trimSpaceStr(book.Author)
	if author == "" {
		author = "佚名"
	}
	author = truncateRunes(author, novelAuthorMax)
	description := truncateRunes(book.Description, novelDescriptionMax)

	var novelID int64
	createdNew := false
	hasExisting := false
	existingCover := ""

	var id int64
	var cov string
	err := queryOne("SELECT id, cover FROM Novel WHERE title = ? AND author = ? LIMIT 1", []any{&id, &cov}, title, author)
	if err == nil {
		novelID, existingCover, hasExisting = id, cov, true
	} else if !isNoRows(err) {
		// 查询瞬时失败：按「无既有记录」继续 create，唯一约束兜底并发
	}

	if !hasExisting {
		newID, ierr := execRetryReturningID(
			"INSERT INTO Novel (title, author, description, cover, categoryId, status, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?)",
			title, author, description,
			gradientTokenFor(title, author), // 无封面时的确定性渐变 token；抓到封面后立即覆写为 /covers/*.jpg
			categoryID, mapNovelStatus(book.Status), nowMillis(), nowMillis(),
		)
		if ierr == nil {
			novelID = newID
			createdNew = true
		} else if isUniqueConflict(ierr) {
			// 并发另一任务已抢先创建同一本书（撞 @@unique([title,author])）→ 回读命中查重，走更新路径
			var wid int64
			var wcov string
			if err2 := queryOne("SELECT id, cover FROM Novel WHERE title = ? AND author = ? LIMIT 1", []any{&wid, &wcov}, title, author); err2 != nil {
				return fail("书籍入库失败（并发冲突后未找到记录）", true)
			}
			novelID = wid
			run.Log(fmt.Sprintf("并发入库冲突，命中已有书籍 #%d", novelID))
		} else {
			run.Log("书籍入库失败: " + truncateRunes(ierr.Error(), 120))
			return fail("书籍入库失败", true)
		}
	}

	// ---- 封面采集落盘（下载远程封面 → 解码 → public/covers/{id}.jpg）----
	// 触发条件：引擎提取到远程封面 URL，且（新书 或 已有书仍是渐变 token 可升级）；
	// 并发冲突回读路径（winner）与 TS 一致不触发封面升级（existing 仍为 null）
	remoteCover := ""
	if httpsURLRE.MatchString(book.Cover) {
		remoteCover = book.Cover
	}
	if remoteCover != "" && (createdNew || (hasExisting && !isLocalCoverPath(existingCover))) {
		// 封面与目标站常同域同封锁策略：经规则代理出口下载（图床直连不可达时必须走代理）
		stored := fetchAndStoreCover(int(novelID), remoteCover, proxy)
		if stored != "" {
			_, _ = execRetry("UPDATE Novel SET cover = ?, updatedAt = ? WHERE id = ?", stored, nowMillis(), novelID)
			run.Log("封面已保存 " + truncateRunes(stored, 40) + "（jpg）")
		} else {
			run.Log("封面下载失败，保留渐变封面（" + truncateRunes(remoteCover, 80) + "）")
		}
	}

	if createdNew {
		run.IncCreated()
		run.Log(fmt.Sprintf("新建书籍 #%d《%s》", novelID, truncateRunes(title, 30)))
	} else {
		res, uerr := execRetry(
			"UPDATE Novel SET description = ?, categoryId = ?, status = ?, updatedAt = ? WHERE id = ?",
			description, categoryID, mapNovelStatus(book.Status), nowMillis(), novelID)
		if uerr != nil || rowCountOf(res) == 0 {
			return fail("书籍更新失败（记录可能已被删除）", true)
		}
		run.IncUpdated()
		run.Log(fmt.Sprintf("书籍已存在，更新信息（#%d）", novelID))
	}
	// PSEO 书名种子：每本书入库（新建或更新）即登记书名关键词（source=book，pending），
	// runner 的 pseoEnrichLoop 异步取下拉词并生成聚合页（网络调用不阻塞采集热路径）
	enqueuePseoBookSeed(title)
	return UpsertOutcome{OK: true, Canceled: false, NovelID: int(novelID), CreatedNew: createdNew, Title: title}
}

// ==================== 章节入库与字数 ====================

// ChapterRow 章节入库行
type ChapterRow struct {
	Title     string
	Content   string
	WordCount int
}

// MAX_IDX_BUMPS 首次尝试外最多顺延 4 次（共 5 次尝试）
const MAX_IDX_BUMPS = 4

// storeChapter 章节入库。唯一冲突（并发任务写同一本书撞 (novelId,idx)）时顺延 idx
// 有界重试（并发双写同书可能连锁占用多个连续序号，单次重试会漏），
// 避免序号停滞导致后续所有章节连锁失败。
// 成功返回实际落库使用的 idx（调用方据此推进下一章序号）；失败返回错误消息。
func storeChapter(run *Run, novelID, idx int, row ChapterRow) (usedIdx int, ok bool, message string) {
	attempt := func(idxVal int) error {
		_, err := execRetry(
			"INSERT INTO Chapter (novelId, idx, title, content, wordCount, createdAt) VALUES (?,?,?,?,?,?)",
			novelID, idxVal, row.Title, row.Content, row.WordCount, nowMillis())
		return err
	}
	err := attempt(idx)
	for bumps := 0; err != nil && isUniqueConflict(err) && bumps < MAX_IDX_BUMPS; bumps++ {
		run.Log(fmt.Sprintf("章节序号 %d 已被占用，顺延重试", idx))
		idx++
		err = attempt(idx)
	}
	if err == nil {
		return idx, true, ""
	}
	return idx, false, err.Error()
}

// recalcNovelWordCount 重算书籍字数合计（失败静默，不影响任务状态机）
func recalcNovelWordCount(novelID int) {
	var sum sql.NullInt64
	if err := queryOne("SELECT SUM(wordCount) FROM Chapter WHERE novelId = ?", []any{&sum}, novelID); err != nil {
		return
	}
	wc := int64(0)
	if sum.Valid {
		wc = sum.Int64
	}
	_, _ = execRetry("UPDATE Novel SET wordCount = ?, updatedAt = ? WHERE id = ?", int(wc), nowMillis(), novelID)
}

// ==================== 两阶段采集：骨架批量入库 ====================

// SkeletonOutcome Phase 1 骨架批量入库结果
type SkeletonOutcome struct {
	// Stored 新入库骨架数
	Stored int
	// SkippedFilled 已有正文而跳过数（同名标题且 wordCount>0）
	SkippedFilled int
	// Total 有效章节链接总数（stored + fillRows + skippedFilled，single 模式进度分母）
	Total int
	// Capped 是否因单本章节数上限截断
	Capped bool
	// FillRows 待填充行（title→URL）：新建骨架 + 已存在但 wordCount=0 的空骨架（续传）。
	// URL 仅驻留内存，任务中断后重发即自动续传（Phase 1 重新匹配空骨架）。
	FillRows []refPair
}

// skeletonChunk 多值 INSERT 每条语句行数（SQLite 变量参数上限兜底；TS Prisma createMany
// 由驱动内部分批，此处显式 500/条）
const skeletonChunk = 500

// skeletonLocks 单本书骨架写入分片锁（Task 27-c，25-a 遗留 a 收尾）：按 novelID 分片 64 把，
// 无 map 增长/清理负担。旧版并发任务采到同一本书（同名书跨任务/重启重叠窗口）时，
// 各自读 MAX(idx) 后连续分配——混合 idx 场景下 (novelId,idx) 唯一约束拦不住「同 title 不同 idx」
// 的插入，产生同名重复行（phase2Fill 兼容填充、靠去重工具收敛，TS 同源设计）。
// 现以分片锁序列化同书骨架入库（读 existing/MAX(idx) → 批量 INSERT 全程持锁；
// SQLite 单写者下批内语句原子，进程内锁即已充分——章节写入仅 runner 进程发生），
// 恢复 TS 单线程事件循环的实际串行语义。
var skeletonLocks [64]sync.Mutex

func lockNovelSkeleton(novelID int) func() {
	m := &skeletonLocks[novelID%len(skeletonLocks)]
	m.Lock()
	return m.Unlock
}

// storeChapterSkeletons Phase 1 骨架批量入库：按标题去重（批内 + 与既有章节），
// idx 从现有最大值连续分配。
// - 全新标题 → 建骨架（content=”、wordCount=0），title 为空用「第{idx}章」占位
// - 同名但 wordCount=0（历史中断遗留的空骨架） → 不重建，其 title/URL 计入 fillRows 续传
// - 同名且 wordCount>0 → 跳过
// 并发同书建骨架撞 (novelId,idx) 唯一约束时退化为逐条顺延重试（复用 storeChapter）；
// 非唯一冲突错误返回 error（TS 语义为向上抛 → 任务按 failed 收尾）。
func storeChapterSkeletons(run *Run, novelID int, refs []refPair, capLimit int) (SkeletonOutcome, error) {
	// Task 27-c: 同书骨架入库全程持分片锁（见 skeletonLocks 注释）；defer 兑底释放
	unlock := lockNovelSkeleton(novelID)
	defer unlock()

	// 批内按标题去重（同书同名章只保留首个 URL；保持首次出现顺序——idx 分配与 TS Map 序一致）
	var order []string
	urlByTitle := map[string]string{}
	for _, r := range refs {
		t := trimSpaceStr(r.Title)
		if _, ok := urlByTitle[t]; !ok {
			urlByTitle[t] = r.URL
			order = append(order, t)
		}
	}

	// 与既有章节对齐：区分「已填充跳过」与「空骨架续传」（查询失败视为全新目录，与 TS catch 一致）
	type existingRow struct {
		title string
		wc    int
	}
	var existing []existingRow
	_ = queryList("SELECT title, wordCount FROM Chapter WHERE novelId = ?", func(rows *sql.Rows) error {
		var e existingRow
		if err := rows.Scan(&e.title, &e.wc); err != nil {
			return err
		}
		existing = append(existing, e)
		return nil
	}, novelID)
	filledTitles := map[string]bool{}
	emptyTitles := map[string]bool{}
	for _, e := range existing {
		if e.wc > 0 {
			filledTitles[e.title] = true
		} else {
			emptyTitles[e.title] = true
		}
	}

	fresh := []refPair{}
	resume := []refPair{}
	skippedFilled := 0
	for _, t := range order {
		switch {
		case filledTitles[t]:
			skippedFilled++
		case emptyTitles[t]:
			resume = append(resume, refPair{Title: t, URL: urlByTitle[t]})
		default:
			fresh = append(fresh, refPair{Title: t, URL: urlByTitle[t]})
		}
	}

	capped := false
	if len(fresh) > capLimit {
		fresh = fresh[:capLimit]
		capped = true
	}
	total := len(order)
	if len(fresh) == 0 {
		return SkeletonOutcome{Stored: 0, SkippedFilled: skippedFilled, Total: total, Capped: capped, FillRows: resume}, nil
	}

	// idx 从现有最大值+1 连续分配
	var maxIdx sql.NullInt64
	_ = queryOne("SELECT MAX(idx) FROM Chapter WHERE novelId = ?", []any{&maxIdx}, novelID)
	idx := 1
	if maxIdx.Valid {
		idx = int(maxIdx.Int64) + 1
	}
	type skelRow struct {
		idx   int
		title string
		url   string
	}
	data := make([]skelRow, 0, len(fresh))
	for _, r := range fresh {
		t := r.Title
		if t == "" {
			t = "第" + itoa(idx) + "章"
		}
		data = append(data, skelRow{idx: idx, title: t, url: r.URL})
		idx++
	}

	// 快路径：多值 INSERT 分块落库（纯本地 SQLite，远快于逐行 INSERT）
	stored := 0
	var lastErr error
	for i := 0; i < len(data); i += skeletonChunk {
		end := min(i+skeletonChunk, len(data))
		chunk := data[i:end]
		var sb strings.Builder
		sb.WriteString("INSERT INTO Chapter (novelId, idx, title, content, wordCount, createdAt) VALUES ")
		args := make([]any, 0, len(chunk)*4)
		for j, r := range chunk {
			if j > 0 {
				sb.WriteByte(',')
			}
			sb.WriteString("(?,?,?,'',0,?)")
			args = append(args, novelID, r.idx, r.title, nowMillis())
		}
		res, err := execRetry(sb.String(), args...)
		if err != nil {
			lastErr = err
			break
		}
		stored += int(rowCountOf(res))
	}
	if lastErr == nil {
		fillRows := make([]refPair, 0, len(data)+len(resume))
		for _, r := range data {
			fillRows = append(fillRows, refPair{Title: r.title, URL: r.url})
		}
		fillRows = append(fillRows, resume...)
		return SkeletonOutcome{Stored: stored, SkippedFilled: skippedFilled, Total: total, Capped: capped, FillRows: fillRows}, nil
	}
	// 并发任务同书建骨架撞唯一约束 → 逐条入库（storeChapter 自带 idx 顺延重试）
	if !isUniqueConflict(lastErr) {
		return SkeletonOutcome{}, lastErr // 与 TS throw 语义一致，由任务级异常收尾
	}
	run.Log("骨架批量入库冲突，退化为逐条写入")
	fillRows := []refPair{}
	okStored := 0
	for _, row := range data {
		// Task 27-c（25-a 遗留 a 收尾）：逐条路径先按标题查重——行可能已被另一任务
		//（持锁前提交）以不同 idx 入库；直接走 (novelId,idx) 顺延重试会在空序号上
		// 再造同名重复行。已存在即照常计入填充计划（同下方失败回查语义）
		var existID0 int64
		if qerr := queryOne("SELECT id FROM Chapter WHERE novelId = ? AND title = ? LIMIT 1",
			[]any{&existID0}, novelID, row.title); qerr == nil {
			fillRows = append(fillRows, refPair{Title: row.title, URL: row.url})
			continue
		}
		_, ok, msg := storeChapter(run, novelID, row.idx, ChapterRow{Title: row.title, Content: "", WordCount: 0})
		if ok {
			okStored++
			fillRows = append(fillRows, refPair{Title: row.title, URL: row.url})
		} else {
			// 冲突失败 ≠ 行不在库：批量路径可能在**更早的分块已插入**部分行（多值 INSERT
			// 逐块提交，后续块撞唯一约束才退化），这些行逐条重写必撞 (novelId,idx)。
			// 旧版直接记失败 → 早块行漏进 fillRows → 本轮 Phase 2 不填充（只剩重跑自愈）。
			// 此处回查 (novelId,title)：行已在库（空骨架）则照常计入填充计划，本轮即补正文。
			var existID int64
			if qerr := queryOne("SELECT id FROM Chapter WHERE novelId = ? AND title = ? LIMIT 1",
				[]any{&existID}, novelID, row.title); qerr == nil {
				fillRows = append(fillRows, refPair{Title: row.title, URL: row.url})
			} else {
				run.Log("骨架入库失败(" + truncateRunes(row.title, 30) + "): " + truncateRunes(msg, 100))
			}
		}
	}
	return SkeletonOutcome{Stored: okStored, SkippedFilled: skippedFilled, Total: total, Capped: capped, FillRows: append(fillRows, resume...)}, nil
}
