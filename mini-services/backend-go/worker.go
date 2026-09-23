/**
 * backend-go —— 采集任务 Worker（两阶段并发架构）。
 *
 * TS 源：src/lib/scrape/worker.ts（逐行移植）
 *
 * 数据流（list 范围模式）：
 *   Phase 0 列表页翻页收集条目（模板优先，猜测回退）
 *   Phase 1 书目骨架：有界并发抓书页+目录 → upsert 书籍 + 章节骨架入库（content=''、wordCount=0）
 *   Phase 2 正文填充：跨书平铺所有空骨架，有界并发抓正文 → update 填充
 *
 * 语义与可靠性（与 TS 对齐 + 暂停/恢复扩展）：
 * - 进度：list 模式 done/total=书、chaptersDone/chaptersTotal=章节；single 模式 done/total=章节
 * - 协作式停止贯穿三阶段（throttledCheck 250ms 节流查 DB，canceled/paused/记录删除即停）
 * - 暂停（paused）：用户指令「任务可随时暂停/重启」——API 置 paused 后 worker 在安全点
 *   停手且不覆盖该状态（进度字段保留），恢复=重新入队 pending，Phase 1/2 依骨架自动续传
 * - 可续跑：Phase 2 只填充 wordCount=0 的骨架；任务中断/暂停后重发或恢复即续传
 * - 快速终止：列表连续 3 页全败、或书页连续 5 本全败且 0 成功 → 提前中止
 * - finalize 终态条件更新（仅 status=running 时写终态）
 * - 合规红线：仅抓取公开页面；robots 提示与域名限速由 scraper-go 引擎层负责（runner 不额外加抓取间隔）
 *
 * 移植差异：
 * - TS 单线程事件循环 → Go 显式并发安全：Phase 1 共享状态经互斥锁保护；Phase 2 计数
 *   用原子变量；Run 日志缓冲内部自带锁
 * - running Set（防同任务并发）→ map[int]bool + 互斥锁；同一任务同时只允许一个 worker
 * - 僵尸任务回收 recoverStaleTasks：TS 在模块加载时异步执行；Go 在 startRunner 启动时
 *   同步执行一次（Go runner 是独立进程，天然只有 runner 写任务状态，语义等价更直接）
 * - Phase 2 遍历 fillMap：TS Map 为插入序；Go map 无序 → 按 novelId 升序确定性处理
 * - wordCount 计算：content.replace(/\s/g,'').length → 逐 rune 统计非 unicode.IsSpace 字符
 * - TS storeChapterSkeletons 抛出的非唯一冲突错误沿 runPool→runTask 冒泡 → Go 经
 *   Phase1Outcome.Fatal 通道传递，runList/runSingle 收到后按「任务执行异常」收尾
 * - 限长常量来自 limits.go（novelTitleMax 等，与 limits.ts 同口径）
 */
package main

import (
	"database/sql"
	"fmt"
	"log"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"
)

// ==================== 可配置参数（环境变量 > 默认值） ====================

// envInt 读取正整数环境变量（非法/缺省用默认值）
func envInt(name string, def int) int {
	v := strings.TrimSpace(os.Getenv(name))
	if v == "" {
		return def
	}
	if n, err := strconv.Atoi(v); err == nil && n > 0 {
		return n
	}
	return def
}

var (
	// MAX_CHAPTERS_PER_BOOK 单本书章节数上限（用户指令「取消采集数量的限制」：默认放宽至
	// 10000，仍保留 env 应急阀避免失控任务堆内存）
	MAX_CHAPTERS_PER_BOOK = envInt("SCRAPE_MAX_CHAPTERS_PER_BOOK", 10_000)
	// MAX_BOOKS_PER_TASK 单任务书籍数上限（同上，默认 5000）
	MAX_BOOKS_PER_TASK = envInt("SCRAPE_MAX_BOOKS_PER_TASK", 5_000)
	// MAX_CONTENT_CHARS 正文单章最大字符数（防异常超长页撑爆内存与存储）
	MAX_CONTENT_CHARS = 50_000
	// BOOK_CONCURRENCY Phase 1 书页并发
	BOOK_CONCURRENCY = envInt("SCRAPE_BOOK_CONCURRENCY", 4)
	// CHAPTER_CONCURRENCY Phase 2 章节正文并发（过高易触发站点限速；限速由引擎层负责）
	CHAPTER_CONCURRENCY = envInt("SCRAPE_CHAPTER_CONCURRENCY", 12)
	// PHASE2_DELAY_MS Phase 1→Phase 2 阶段间休整（源站礼貌间隔：任务 41 实证 Phase 1 猛抓后
	// 立即爆发性抓正文加速触发封禁，这里给站点一拍喘息；仅延迟不新增请求，合规只减不增）
	PHASE2_DELAY_MS = envInt("SCRAPE_PHASE2_DELAY_MS", 3000)
	// PHASE2_FAIL_BREAKER Phase 2 连败熔断阈值：连续失败这么多章且期间零成功 → 判定
	// 源站封禁/不可达，任务自动转 paused 防烧穿（任务 41 实证熔断打开后引擎快速失败，
	// 旧版把 46836 章全部烧成 failed；0=禁用）。阈值需显著高于正常散在失败（实证健康站
	// 连败个位数）又低于「烧穿有价值数据」的量级
	PHASE2_FAIL_BREAKER = envInt("SCRAPE_FAIL_BREAKER", 60)
	// PHASE1_BOOK_FAIL_BREAKER Phase 1 无条件连败熔断：不管此前是否成功过，连续失败
	// 达阈值即提前中止（旧版仅在 okBooks==0 时停，站点中途封禁会把余下书目全部烧完）
	PHASE1_BOOK_FAIL_BREAKER = envInt("SCRAPE_BOOK_FAIL_BREAKER", 30)
	// SKELETON_BATCH Phase 2 骨架分批大小
	SKELETON_BATCH = 200
	// FLUSH_INTERVAL_MS 进度 flush 最小间隔（防 SQLite 写放大）
	FLUSH_INTERVAL_MS = 800
	// MAX_CONSECUTIVE_PAGE_FAILS 列表页连续失败快速终止阈值
	MAX_CONSECUTIVE_PAGE_FAILS = 3
	// MAX_CONSECUTIVE_BOOK_FAILS 书页连续失败快速终止阈值（且 0 本成功）
	MAX_CONSECUTIVE_BOOK_FAILS = 5
)

// ==================== 进程级防重与僵尸回收 ====================

var (
	gRunningMu sync.Mutex
	gRunning   = map[int]bool{} // 同一任务 id 同时只允许一个 worker 实例（TS running Set）
	gBootAt    = nowMillis()    // 本进程启动时刻（包初始化时定值）
)

func runningHas(taskID int) bool {
	gRunningMu.Lock()
	defer gRunningMu.Unlock()
	return gRunning[taskID]
}

func runningDelete(taskID int) {
	gRunningMu.Lock()
	delete(gRunning, taskID)
	gRunningMu.Unlock()
}

// lastLines 保留最后 n 行（与 Run 同规约：只保留最近 MAX_LOG_LINES 行）
func lastLines(s string, n int) string {
	lines := strings.Split(s, "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

// recoverStaleTasks 服务重启恢复：进程首次启动时处理「创建于本进程启动之前」且仍处于
// running 的任务——它们只可能属于已消失的旧进程，自动转为 paused（已采进度保留，
// 可手动恢复续传）；pending 任务保持不动，新 runner 2s 内会重新领取。配合
// 「任务可随时暂停/重启」指令，重启不再把长任务（数万章 Phase 2）破坏成 failed。
// 条件更新（status 仍为 running）保证与 worker 终态写入竞态安全。
//
// Task 26-d 修复（createdAt 失配）：旧版把过滤条件放进 SQL（`createdAt < ?` 传 int64），
// 但库里 DateTime 列存在两种存储类——integer ms（Go/Prisma 主径）与 TEXT
// （历史工具写入，本库 ScrapeRule.updatedAt 实证存在 'YYYY-MM-DD HH:MM:SS' 文本行）。
// SQLite 比较规则下 TEXT 恒 > INTEGER，TEXT 行对 `createdAt < 整数` 永远不命中 →
// 僵尸任务被静默跳过、永不恢复。改为：SQL 只按 status 捞 running，createdAt 读出后
// 在 Go 侧归一化比较（integer/float/文本多格式解析；无法解析视为 pre-boot 僵尸一并暂停，
// 因为启动时刻本进程必然没有任何 worker，running 任务本身就是僵尸，宁暂停勿悬挂）。
func recoverStaleTasks() {
	type staleRow struct {
		id        int
		logv      string
		createdAt any // integer ms / float / TEXT（ historic 工具写入），由 normalizeMillis 归一
	}
	var stale []staleRow
	err := queryList(
		"SELECT id, log, createdAt FROM ScrapeTask WHERE status = 'running' ORDER BY id ASC",
		func(rows *sql.Rows) error {
			var r staleRow
			if err := rows.Scan(&r.id, &r.logv, &r.createdAt); err != nil {
				return err
			}
			stale = append(stale, r)
			return nil
		})
	if err != nil {
		// 恢复失败不阻塞启动，但必须留痕（旧版静默 return，故障无从排查）
		log.Printf("[scrape-worker] 服务重启恢复查询失败（本轮未做恢复，running 任务可能悬挂）: %v", err)
		return
	}
	paused := 0
	for _, t := range stale {
		if runningHas(t.id) { // 本进程仍在执行（防御性；启动时刻 running 恒为空）
			continue
		}
		if createdMs, ok := normalizeMillis(t.createdAt); ok && createdMs >= gBootAt {
			continue // 本进程启动之后创建：非僵尸
		}
		line := "[" + time.Now().Format("15:04:05") + "] 服务重启，任务中断自动暂停（已采进度保留，可恢复继续采集）"
		logv := t.logv
		if logv != "" {
			logv += "\n"
		}
		logv = lastLines(logv+line, MAX_LOG_LINES)
		res, err := execRetry(
			"UPDATE ScrapeTask SET status = 'paused', message = '服务重启，任务自动暂停（可恢复继续采集）', log = ?, updatedAt = ? WHERE id = ? AND status = 'running'",
			logv, nowMillis(), t.id)
		if err == nil && rowCountOf(res) > 0 {
			paused++
			createdDesc := "<无法解析>"
			if ms, ok := normalizeMillis(t.createdAt); ok {
				createdDesc = time.UnixMilli(ms).Format("2006-01-02 15:04:05")
			}
			log.Printf("[scrape-worker] 僵尸任务 #%d（createdAt %s）已转 paused", t.id, createdDesc)
		}
	}
	if paused > 0 {
		log.Printf("[scrape-worker] 服务重启恢复: %d 条运行中任务已自动暂停（可恢复续传）", paused)
	}
}

// normalizeMillis DB DateTime 列值 → epoch ms（Task 26-d）。
// 支持：INTEGER/REAL ms、纯数字文本、ISO（T/Z 形态）、Prisma SQLite 文本
// （'YYYY-MM-DD HH:MM:SS[.mmm][ ±HH:MM]'）等历史形态；解析失败返回 false。
func normalizeMillis(v any) (int64, bool) {
	switch x := v.(type) {
	case int64:
		return x, x > 0
	case int:
		return int64(x), x > 0
	case float64:
		return int64(x), x > 0
	case []byte:
		return parseMillisText(string(x))
	case string:
		return parseMillisText(x)
	case nil:
		return 0, false
	default:
		return 0, false
	}
}

// parseMillisText 文本形态时间 → epoch ms（尽力多格式；失败 false）
func parseMillisText(s string) (int64, bool) {
	s = trimSpaceStr(s)
	if s == "" {
		return 0, false
	}
	if n, err := strconv.ParseInt(s, 10, 64); err == nil {
		return n, n > 0
	}
	if f, err := strconv.ParseFloat(s, 64); err == nil && f > 0 {
		return int64(f), true
	}
	layouts := []string{
		"2006-01-02T15:04:05.000Z07:00", // JS toISOString / Go isoFromMillis
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02 15:04:05.000 -07:00", // Prisma Rust 引擎 SQLite 文本形态
		"2006-01-02 15:04:05.000",
		"2006-01-02 15:04:05",
		"2006-01-02T15:04:05",
		"2006/01/02 15:04:05",
	}
	for _, l := range layouts {
		if t, err := time.Parse(l, s); err == nil {
			return t.UnixMilli(), true
		}
	}
	return 0, false
}

// ==================== 协作式取消与暂停 ====================

// stopState 协作式停止检查（isCanceled 的暂停/恢复扩展版）：
//   - "canceled"：记录被取消或已删除（删除视为取消，沿用 TS 语义）
//   - "paused"  ：用户手动暂停（API 已置 paused，worker 在安全点停手且不覆盖该状态）
//   - ""        ：继续执行
//
// DB 瞬时错误不误判为停止（fail-open，避免瞬时 DB 错误误停任务）
func stopState(taskID int) string {
	var status string
	err := queryOne("SELECT status FROM ScrapeTask WHERE id = ?", []any{&status}, taskID)
	if err != nil {
		if isNoRows(err) {
			return "canceled" // 记录删除视为取消
		}
		return "" // 查询失败 ≠ 被停止，避免瞬时 DB 错误误停任务
	}
	if status == "canceled" {
		return "canceled"
	}
	if status == "paused" {
		return "paused"
	}
	return ""
}

// ==================== 共用工具 ====================

// shapeBook 引擎响应未经 schema 校验，关键字段做形态兜底（Go 反序列化已兜底字符串/null，
// 这里补 chapterCount 缺省 → len(chapters)）
func shapeBook(book BookData) BookData {
	if book.ChapterCount == nil {
		n := len(book.Chapters)
		book.ChapterCount = &n
	}
	return book
}

// noiseTOCTitles 目录页噪声按钮/导航文案（与引擎 NOISE_TOC_TITLES 同步，
// 双保险：引擎已滤，此处兜底）
var noiseTOCTitles = map[string]bool{
	"立即阅读": true, "开始阅读": true, "点击阅读": true, "进入阅读": true, "继续阅读": true,
	"全文阅读": true, "免费阅读": true, "无弹窗阅读": true, "最新章节": true, "最新章节列表": true,
	"查看目录": true, "章节目录": true, "全部目录": true, "目录": true,
	"书签": true, "加入书签": true, "上一章": true, "下一章": true, "上一页": true, "下一页": true,
	"推荐票": true, "投推荐票": true,
}

// normalizeRefs 章节链接规范化：过滤无 URL、噪声按钮文案、trim、URL 去重（同 URL 不同标题视为同章）
func normalizeRefs(refs []ChapterRef) []refPair {
	seen := map[string]bool{}
	out := []refPair{}
	for _, r := range refs {
		u := trimSpaceStr(r.URL)
		if u == "" {
			continue
		}
		title := trimSpaceStr(r.Title)
		if noiseTOCTitles[title] {
			continue
		}
		if seen[u] {
			continue
		}
		seen[u] = true
		out = append(out, refPair{Title: truncateRunes(title, chapterTitleMax), URL: u})
	}
	return out
}

// safeOrigin 从章节 URL 提取同源 origin 作 referer 兜底（续跑场景 referer 缺失时用）
func safeOrigin(u string) string {
	p, err := url.Parse(u)
	if err != nil || p.Scheme == "" || p.Host == "" {
		return ""
	}
	return p.Scheme + "://" + p.Host
}

// countNonSpaceRunes 对齐 TS content.replace(/\s/g,”).length（逐 rune、unicode.IsSpace 判定）
func countNonSpaceRunes(s string) int {
	n := 0
	for _, r := range s {
		if !unicode.IsSpace(r) {
			n++
		}
	}
	return n
}

// sqlPlaceholders "?,?,..." × n
func sqlPlaceholders(n int) string {
	if n <= 0 {
		return "NULL"
	}
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}

// ==================== Phase 1：书目骨架（并发） ====================

// Phase1Outcome Phase 1 结果
type Phase1Outcome struct {
	OKBooks         int
	FailBooks       int
	StoppedEarly    bool
	BookFailBreaker bool // 无条件连败熔断触发（不管此前是否成功过；Task 26-d）
	FirstError      string
	NovelIDs        []int
	FillMap         map[int]fillPlan // novelId → 填充计划：书页 referer + 待填充 (title,url) 行
	TotalRefs       int              // 全部有效章节链接数（含已填充跳过）——single 模式进度分母
	SkippedFilled   int              // 其中已有正文而跳过的数量——single 模式进度初值
	FillTotal       int              // 待填充总行数——list 模式 chaptersTotal 的来源
	Fatal           error            // TS 语义：store 层非唯一冲突错误向上抛 → 任务按 failed 收尾
}

// phase1Skeletons 书目骨架（BOOK_CONCURRENCY 有界并发）：抓书页 → 目录二次提取 →
// 分类保障 → upsert 书籍 → 骨架入库，产出 Phase 2 填充计划。
func phase1Skeletons(run *Run, rule LoadedRule, items []ListItem, listURL string) Phase1Outcome {
	var mu sync.Mutex
	fillMap := map[int]fillPlan{}
	var novelIDs []int
	okBooks, failBooks, failStreak := 0, 0, 0
	firstError := ""
	totalRefs, skippedFilled, fillTotal := 0, 0, 0
	sawCatalog := 0
	bookFailBreaker := false
	var fatal error

	setFirstError := func(msg string) {
		if firstError == "" {
			firstError = msg
		}
	}

	// 取消/暂停 + 快速终止（连续多本全败且 0 成功 → 判定站点不可达，中止防空转）；
	// Task 26-d 增加无条件连败熔断（PHASE1_BOOK_FAIL_BREAKER）：站点中途封禁时旧版
	// （okBooks>0 则永不提前停）会把余下书目全部烧成失败——连败达阈值即中止。
	shouldStop := throttledCheck(func() bool {
		if stopState(run.TaskID) != "" {
			return true
		}
		mu.Lock()
		defer mu.Unlock()
		if fatal != nil {
			return true
		}
		if failStreak >= PHASE1_BOOK_FAIL_BREAKER {
			bookFailBreaker = true
			return true
		}
		return failStreak >= MAX_CONSECUTIVE_BOOK_FAILS && okBooks == 0
	})

	runPool(items, BOOK_CONCURRENCY, func(item ListItem, _ int) {
		bookURL := item.URL
		page := fetchBookPage(run, bookURL, rule, listURL, false)
		if !page.OK {
			mu.Lock()
			setFirstError(page.Err)
			failBooks++
			failStreak++
			mu.Unlock()
			run.Log(fmt.Sprintf("书页失败(%s): %s", truncateRunes(bookURL, 90), truncateRunes(page.Err, 120)))
			return
		}
		book := shapeBook(page.Book)
		authorPart := ""
		if a := truncateRunes(book.Author, 20); a != "" {
			authorPart = " / " + a
		}
		run.Log(fmt.Sprintf("书页命中《%s》%s，章节链接 %d 条",
			truncateRunes(book.Title, 40), authorPart, *book.ChapterCount))

		// 完整目录页二次提取（书页仅含最新几章时）
		allRefs := book.Chapters
		catalogSel := rule.BookRule["catalogLinkSelector"]
		if catalogSel != "" && book.CatalogURL != "" {
			catalogRefs := fetchCatalogChapters(run, book.CatalogURL, rule, bookURL, false)
			if len(catalogRefs) > len(allRefs) {
				mu.Lock()
				sawCatalog++
				mu.Unlock()
				allRefs = catalogRefs
			}
		}
		refs := normalizeRefs(allRefs)
		// refs 为空：仍入库书籍（原语义「书籍已入库（未提取到章节链接）」），不计失败

		// 源站分类名归并失败时用书名+简介 LLM 推断（防「未分类」堆积）
		categoryID, cerr := ensureCategory(book.Category, book.Title, book.Description)
		if cerr != nil {
			msg := cerr.Error()
			mu.Lock()
			setFirstError(msg)
			failBooks++
			failStreak++
			mu.Unlock()
			run.Log(fmt.Sprintf("《%s》%s", truncateRunes(book.Title, 24), msg))
			return
		}

		up := upsertBook(run, book, categoryID, rule.Proxy)
		if !up.OK {
			mu.Lock()
			setFirstError(up.Message)
			failBooks++
			failStreak++
			mu.Unlock()
			run.Log(fmt.Sprintf("《%s》入库失败: %s", truncateRunes(book.Title, 24), up.Message))
			return
		}

		sk, skerr := storeChapterSkeletons(run, up.NovelID, refs, MAX_CHAPTERS_PER_BOOK)
		if skerr != nil {
			mu.Lock()
			setFirstError(skerr.Error())
			failBooks++
			failStreak++
			fatal = skerr
			mu.Unlock()
			run.Log(fmt.Sprintf("《%s》骨架入库异常: %s", truncateRunes(up.Title, 24), truncateRunes(skerr.Error(), 120)))
			return
		}
		if sk.Capped {
			run.Log(fmt.Sprintf("《%s》已达单本上限（%d 章），超出部分未采集", truncateRunes(up.Title, 24), MAX_CHAPTERS_PER_BOOK))
		}
		mu.Lock()
		novelIDs = append(novelIDs, up.NovelID)
		okBooks++
		failStreak = 0
		totalRefs += sk.Total
		skippedFilled += sk.SkippedFilled
		fillTotal += len(sk.FillRows)
		if len(sk.FillRows) > 0 {
			fillMap[up.NovelID] = fillPlan{Referer: bookURL, Rows: sk.FillRows}
		}
		mu.Unlock()
		run.Log(fmt.Sprintf("《%s》骨架入库 %d 章（已有正文跳过 %d，待填充 %d）",
			truncateRunes(up.Title, 24), sk.Stored, sk.SkippedFilled, len(sk.FillRows)))
	}, shouldStop)

	if sawCatalog > 0 {
		run.Log(fmt.Sprintf("目录页二次提取生效 %d 本", sawCatalog))
	}
	mu.Lock()
	defer mu.Unlock()
	return Phase1Outcome{
		OKBooks: okBooks, FailBooks: failBooks, FirstError: firstError,
		BookFailBreaker: bookFailBreaker,
		NovelIDs:        novelIDs, FillMap: fillMap,
		TotalRefs: totalRefs, SkippedFilled: skippedFilled, FillTotal: fillTotal,
		Fatal: fatal,
	}
}

// ==================== Phase 2：正文填充（跨书平铺并发） ====================

// Phase2Outcome Phase 2 结果
type Phase2Outcome struct {
	Filled       int
	Failed       int
	StoppedEarly bool
	// FailBreaker 连败熔断触发（Task 26-d）：连续 PHASE2_FAIL_BREAKER 章失败且期间零成功，
	// 判定源站封禁/不可达 → 任务自动转 paused 而非把全部骨架烧成 failed（任务 41 实证）
	FailBreaker bool
	ConsecFails int64 // 触发时的连续失败计数（供终态消息）
}

// phase2Fill 消费 Phase 1 的填充计划：逐书分批（200/批）拉取 DB 空骨架行（wordCount=0，
// 含历史中断遗留的同名重复行），书内有界并发抓正文并 update 填充；处理完一本书即从
// fillMap 释放其 rows（内存渐减）。章节抓取失败保留骨架（wordCount=0），重发任务自动续传。
// onProgress(doneSoFar) 由调用方节流落库进度；返回 false 表示任务记录已删除，立即停止。
func phase2Fill(run *Run, rule LoadedRule, fillMap map[int]fillPlan, onProgress func(doneSoFar int) bool) Phase2Outcome {
	var filledCtr, failedCtr atomic.Int64
	var warnLogged atomic.Int64
	// Task 26-d 连败熔断：连续失败计数（成功归零），达阈值置位；书间/批间检查后停手。
	// 注意熔断打开后引擎对封禁主机快速结构化失败（毫秒级），不加熔断时 12 车道每秒
	// 可烧数千章（任务 41：46836 章全部 failed）
	var consecFails atomic.Int64
	var failBreaker atomic.Bool
	stoppedEarly := false
	breakerStopped := false
	isStopped := throttledCheck(func() bool { return stopState(run.TaskID) != "" })

	noteChapterFail := func() {
		if PHASE2_FAIL_BREAKER <= 0 {
			return // 0=禁用
		}
		if n := consecFails.Add(1); int(n) >= PHASE2_FAIL_BREAKER && failBreaker.CompareAndSwap(false, true) {
			run.Log(fmt.Sprintf("正文连续失败 %d 章（期间零成功）：疑似源站封禁或站点不可达，提前停止防烧穿（已采进度保留，可稍后恢复续传）", n))
		}
	}

	// TS Map 迭代=插入序（Phase 1 并发完成序）；Go map 无序 → 按 novelId 升序确定性处理
	ids := make([]int, 0, len(fillMap))
	for id := range fillMap {
		ids = append(ids, id)
	}
	sort.Ints(ids)

	for _, novelID := range ids {
		if stoppedEarly || breakerStopped {
			break
		}
		if isStopped() {
			stoppedEarly = true
			break
		}
		if failBreaker.Load() {
			breakerStopped = true
			break
		}
		plan := fillMap[novelID]
		var bookFilled, bookFailed atomic.Int64
		for off := 0; off < len(plan.Rows); off += SKELETON_BATCH {
			end := min(off+SKELETON_BATCH, len(plan.Rows))
			slice := plan.Rows[off:end]
			titles := make([]string, len(slice))
			for i, r := range slice {
				titles[i] = r.Title
			}
			// 同名行可能有多条（历史遗留重复）：一起拉出来填同一内容，后续由目录体检工具去重
			type dbRow struct {
				id    int
				title string
			}
			var dbRows []dbRow
			q := "SELECT id, title FROM Chapter WHERE novelId = ? AND wordCount = 0 AND title IN (" +
				sqlPlaceholders(len(titles)) + ")"
			args := make([]any, 0, len(titles)+1)
			args = append(args, novelID)
			for _, t := range titles {
				args = append(args, t)
			}
			_ = queryList(q, func(rows *sql.Rows) error { // 失败 → 空数组（与 TS catch 一致）
				var r dbRow
				if err := rows.Scan(&r.id, &r.title); err != nil {
					return err
				}
				dbRows = append(dbRows, r)
				return nil
			}, args...)
			if len(dbRows) == 0 {
				continue
			}
			urlByTitle := map[string]string{}
			for _, r := range slice {
				urlByTitle[r.Title] = r.URL
			}
			runPool(dbRows, CHAPTER_CONCURRENCY, func(row dbRow, _ int) {
				u, ok := urlByTitle[row.title]
				if !ok {
					return
				}
				referer := plan.Referer
				if referer == "" {
					referer = safeOrigin(u)
				}
				res := fetchChapterPaged(u, rule, referer)
				if !res.OK {
					failedCtr.Add(1)
					bookFailed.Add(1)
					noteChapterFail()
					return
				}
				cleaned := cleanChapterContent(res.Data.Content)
				content := truncateRunes(cleaned.Text, MAX_CONTENT_CHARS)
				if trimSpaceStr(content) == "" {
					failedCtr.Add(1) // 源站空壳章：保留骨架，重发任务自动重试
					bookFailed.Add(1)
					noteChapterFail()
					return
				}
				if len(res.Warnings) > 0 && warnLogged.Load() < 10 {
					warnLogged.Add(1)
					run.LogWarnings(res.Warnings)
				}
				wordCount := countNonSpaceRunes(content)
				title := trimSpaceStr(row.title)
				if title == "" {
					title = trimSpaceStr(res.Data.Title)
				}
				if title == "" {
					title = "第" + itoa(row.id) + "章"
				}
				title = truncateRunes(title, chapterTitleMax)
				res2, uerr := execRetry("UPDATE Chapter SET title = ?, content = ?, wordCount = ? WHERE id = ?",
					title, content, wordCount, row.id)
				if uerr == nil && rowCountOf(res2) > 0 {
					filledCtr.Add(1)
					bookFilled.Add(1)
					consecFails.Store(0) // 成功即复位连败计数
					run.IncChapters()
				} else {
					failedCtr.Add(1)
					bookFailed.Add(1)
					noteChapterFail()
				}
			}, func() bool { return isStopped() || failBreaker.Load() })
			if failBreaker.Load() {
				breakerStopped = true
			}
			if !onProgress(int(filledCtr.Load())) {
				stoppedEarly = true
				break
			}
			if isStopped() {
				stoppedEarly = true
				break
			}
			if breakerStopped {
				break
			}
		}
		run.Log(fmt.Sprintf("书籍 #%d 正文填充完成：成功 %d / 失败 %d", novelID, bookFilled.Load(), bookFailed.Load()))
		delete(fillMap, novelID) // 处理完即释放，长任务内存渐减
	}
	return Phase2Outcome{Filled: int(filledCtr.Load()), Failed: int(failedCtr.Load()), StoppedEarly: stoppedEarly,
		FailBreaker: breakerStopped || failBreaker.Load(), ConsecFails: consecFails.Load()}
}

// ==================== 字数汇总 ====================

// recalcWordCountsFor 任务收尾：对涉及的书籍统一重算字数（GROUP BY 汇总，避免逐书聚合）
func recalcWordCountsFor(novelIDs []int) {
	if len(novelIDs) == 0 {
		return
	}
	const chunk = 500
	for i := 0; i < len(novelIDs); i += chunk {
		part := novelIDs[i:min(i+chunk, len(novelIDs))]
		args := make([]any, 0, len(part))
		for _, id := range part {
			args = append(args, id)
		}
		type sumRow struct {
			novelID int
			total   int64
		}
		var sums []sumRow
		q := "SELECT novelId, SUM(wordCount) FROM Chapter WHERE novelId IN (" + sqlPlaceholders(len(part)) + ") GROUP BY novelId"
		if err := queryList(q, func(rows *sql.Rows) error {
			var s sumRow
			if err := rows.Scan(&s.novelID, &s.total); err != nil {
				return err
			}
			sums = append(sums, s)
			return nil
		}, args...); err != nil {
			continue
		}
		for _, s := range sums {
			_, _ = execRetry("UPDATE Novel SET wordCount = ?, updatedAt = ? WHERE id = ?", int(s.total), nowMillis(), s.novelID)
		}
	}
}

// ==================== Phase 0：列表页条目收集 ====================

// collectListItems 列表页翻页收集（模板优先、连续失败快速终止、合并去重、任务上限截断）。
// 返回 (条目, 最后命中的列表页 URL 作 referer)。
func collectListItems(run *Run, task TaskRecord, rule LoadedRule) ([]ListItem, string) {
	run.Log("抓取列表页第 1 页…")
	first := fetchListPage(run, task.TargetURL, rule, "")
	if len(first) == 0 {
		run.Log("列表页未提取到书籍条目")
		return nil, task.TargetURL
	}
	run.Log(fmt.Sprintf("第 1 页提取 %d 条", len(first)))

	items := append([]ListItem(nil), first...)
	currentListURL := task.TargetURL
	consecutiveFails := 0
	if hasPaginationTemplate(rule.ListRule) {
		run.Log("分页模板生效: " + truncateRunes(rule.ListRule["paginationTemplate"], 120))
	}

	for k := 2; k <= task.Pages; k++ {
		if stopState(run.TaskID) != "" {
			break
		}
		got := 0
		hit := false
		for _, v := range buildPageVariants(rule.ListRule, task.TargetURL, k) {
			pageItems := fetchListPage(run, v, rule, "")
			if len(pageItems) > 0 {
				got = len(pageItems)
				hit = true
				currentListURL = v
				items = append(items, pageItems...)
				break
			}
		}
		if !hit {
			consecutiveFails++
			run.Log(fmt.Sprintf("第 %d 页无结果（连续失败 %d）", k, consecutiveFails))
			if consecutiveFails >= MAX_CONSECUTIVE_PAGE_FAILS {
				run.Log(fmt.Sprintf("连续 %d 页翻页失败，提前终止翻页", MAX_CONSECUTIVE_PAGE_FAILS))
				break
			}
			continue
		}
		consecutiveFails = 0
		run.Log(fmt.Sprintf("第 %d 页命中: %s，提取 %d 条", k, truncateRunes(currentListURL, 100), got))
	}

	// 合并去重（按 URL，缺 URL 按标题）
	seen := map[string]bool{}
	merged := []ListItem{}
	for _, it := range items {
		key := it.URL
		if key == "" {
			key = "t:" + it.Title
		}
		if seen[key] {
			continue
		}
		seen[key] = true
		merged = append(merged, it)
	}
	if len(merged) > MAX_BOOKS_PER_TASK {
		merged = merged[:MAX_BOOKS_PER_TASK]
		run.Log(fmt.Sprintf("条目数超出单任务上限（%d），已截断", MAX_BOOKS_PER_TASK))
	}
	return merged, currentListURL
}

// ==================== 两种模式 ====================

// runList list 范围模式：Phase 0 列表 → Phase 1 骨架 → Phase 2 填充
func runList(run *Run, task TaskRecord, rule LoadedRule) {
	// ---- Phase 0：列表页 ----
	collected, currentListURL := collectListItems(run, task, rule)
	if reason := stopState(run.TaskID); reason != "" {
		finalizeStopped(run, reason, "任务已取消", "已暂停（列表阶段中断，进度保留，可恢复继续）")
		return
	}
	if len(collected) == 0 {
		finalize(run, "failed", "列表页未提取到书籍条目")
		return
	}
	total := len(collected)
	zero := 0
	run.Flush(&TaskFlushFields{Total: &total, Done: &zero})
	run.Log(fmt.Sprintf("去重后共 %d 本书待采集", total))

	// ---- Phase 1：书目骨架 ----
	run.Log(fmt.Sprintf("━━ 阶段 1/2 书目骨架（并发 %d）", BOOK_CONCURRENCY))
	p1 := phase1Skeletons(run, rule, collected, currentListURL)
	if p1.Fatal != nil { // TS：store 层非唯一冲突错误沿 promise 链冒泡 → catch 收尾
		run.Log("发生未预期错误: " + truncateRunes(p1.Fatal.Error(), 200))
		finalize(run, "failed", "任务执行异常")
		return
	}
	if reason := stopState(run.TaskID); reason != "" {
		recalcWordCountsFor(p1.NovelIDs)
		finalizeStopped(run, reason,
			fmt.Sprintf("已取消（书目完成 %d/%d 本）", p1.OKBooks, total),
			fmt.Sprintf("已暂停（书目完成 %d/%d 本，进度保留，可恢复继续）", p1.OKBooks, total))
		return
	}
	created, updated, _ := run.Snapshot()
	run.Flush(&TaskFlushFields{Done: &p1.OKBooks, ChaptersTotal: &p1.FillTotal, ChaptersDone: &zero, Created: &created, Updated: &updated})

	if p1.OKBooks == 0 {
		msg := p1.FirstError
		if msg == "" {
			msg = "无书籍采集成功"
		}
		finalize(run, "failed", msg)
		return
	}
	if p1.BookFailBreaker {
		// Task 26-d 无条件连败熔断：站点中途封禁/不可达，余下书目不再空烧；
		// 已入库书目的骨架保留，重启任务可自动续传
		recalcWordCountsFor(p1.NovelIDs)
		finalize(run, "partial", fmt.Sprintf("书目连续失败达阈值（%d 本，疑似源站封禁或站点不可达），提前中止：已入库 %d/%d 本，进度保留", PHASE1_BOOK_FAIL_BREAKER, p1.OKBooks, total))
		return
	}

	// ---- Phase 2：正文填充 ----
	run.Log(fmt.Sprintf("━━ 阶段 2/2 正文填充（并发 %d，待填充 %d 章）", CHAPTER_CONCURRENCY, p1.FillTotal))
	phase2Breather(run)
	var lastFlush int64
	p2 := phase2Fill(run, rule, p1.FillMap, func(doneSoFar int) bool {
		now := nowMillis()
		if now-lastFlush < int64(FLUSH_INTERVAL_MS) {
			return true
		}
		lastFlush = now
		c2, u2, ch := run.Snapshot()
		return run.Flush(&TaskFlushFields{ChaptersDone: &doneSoFar, Chapters: &ch, Created: &c2, Updated: &u2})
	})
	recalcWordCountsFor(p1.NovelIDs)
	created, updated, chapters := run.Snapshot()
	run.Flush(&TaskFlushFields{ChaptersDone: &p2.Filled, Chapters: &chapters, Created: &created, Updated: &updated})

	if p2.FailBreaker && stopState(run.TaskID) == "" {
		// Task 26-d：连败熔断（疑似源站封禁/不可达）→ 转 paused 而非把数万骨架烧成 failed；
		// 恢复=PATCH resume 重入队，Phase 2 依空骨架自动续传（每次重试至多再烧阈值内的失败）
		finalize(run, "paused", fmt.Sprintf("正文连续失败 %d 章（疑似源站封禁或站点不可达），已自动暂停防烧穿（成功 %d 章，进度保留，可恢复继续采集）", p2.ConsecFails, p2.Filled))
		return
	}
	if p2.StoppedEarly {
		reason := stopState(run.TaskID)
		if reason == "" {
			reason = "canceled" // 兑底（记录删除等异常路径）
		}
		finalizeStopped(run, reason,
			fmt.Sprintf("已取消（正文填充 %d/%d 章）", p2.Filled, p1.FillTotal),
			fmt.Sprintf("已暂停（正文填充 %d/%d 章，进度保留，可恢复继续）", p2.Filled, p1.FillTotal))
		return
	}
	if p2.Filled == 0 && p1.FillTotal == 0 {
		// 可续跑语义：重发已完成任务时骨架全部已有正文（FillTotal=0），Phase 2 无事可做
		// 应报成功而非「正文采集全部失败」（旧版误报 failed 会诱导用户无意义重跑；
		// FillTotal>0 且全败的失败语义保持不变）
		finalize(run, "success", fmt.Sprintf("书目 %d 本已全部有正文，无需续采", p1.OKBooks))
		return
	}
	if p2.Filled == 0 {
		finalize(run, "failed", fmt.Sprintf("书目 %d 本入库，但正文采集全部失败", p1.OKBooks))
		return
	}
	if p2.Failed > 0 {
		finalize(run, "partial", fmt.Sprintf("%d 本书 / 正文 %d 章成功，%d 章失败", p1.OKBooks, p2.Filled, p2.Failed))
		return
	}
	finalize(run, "success", fmt.Sprintf("范围采集完成：%d 本书，正文 %d 章", p1.OKBooks, p2.Filled))
}

// runSingle single 单本模式：复用两阶段管线，一个条目 → 骨架 → 填充；done/total 主口径=章节
func runSingle(run *Run, task TaskRecord, rule LoadedRule) {
	items := []ListItem{{Title: "", URL: task.TargetURL}}
	run.Log(fmt.Sprintf("━━ 阶段 1/2 书目骨架（并发 %d）", BOOK_CONCURRENCY))
	p1 := phase1Skeletons(run, rule, items, "")
	if p1.Fatal != nil {
		run.Log("发生未预期错误: " + truncateRunes(p1.Fatal.Error(), 200))
		finalize(run, "failed", "任务执行异常")
		return
	}
	if p1.OKBooks == 0 {
		msg := p1.FirstError
		if msg == "" {
			msg = "书页提取失败"
		}
		finalize(run, "failed", msg)
		return
	}
	if reason := stopState(run.TaskID); reason != "" {
		recalcWordCountsFor(p1.NovelIDs)
		finalizeStopped(run, reason, "任务已取消", "已暂停（进度保留，可恢复继续）")
		return
	}
	totalChapters := p1.TotalRefs
	run.Flush(&TaskFlushFields{Total: &totalChapters, Done: &p1.SkippedFilled, ChaptersTotal: &totalChapters, ChaptersDone: &p1.SkippedFilled})
	if totalChapters == 0 {
		finalize(run, "success", "书籍已入库（未提取到章节链接）")
		return
	}

	run.Log(fmt.Sprintf("━━ 阶段 2/2 正文填充（并发 %d，待填充 %d 章）", CHAPTER_CONCURRENCY, p1.FillTotal))
	phase2Breather(run)
	var lastFlush int64
	p2 := phase2Fill(run, rule, p1.FillMap, func(doneSoFar int) bool {
		now := nowMillis()
		if now-lastFlush < int64(FLUSH_INTERVAL_MS) {
			return true
		}
		lastFlush = now
		done := p1.SkippedFilled + doneSoFar
		return run.Flush(&TaskFlushFields{Done: &done, ChaptersDone: &done})
	})

	recalcWordCountsFor(p1.NovelIDs)
	done := p1.SkippedFilled + p2.Filled
	_, _, chapters := run.Snapshot()
	run.Flush(&TaskFlushFields{Done: &done, ChaptersDone: &done, Chapters: &chapters})

	if p2.FailBreaker && stopState(run.TaskID) == "" {
		// Task 26-d：连败熔断 → 转 paused（同 runList 注释）
		finalize(run, "paused", fmt.Sprintf("正文连续失败 %d 章（疑似源站封禁或站点不可达），已自动暂停防烧穿（成功 %d 章，进度保留，可恢复继续采集）", p2.ConsecFails, p2.Filled))
		return
	}
	if p2.StoppedEarly {
		reason := stopState(run.TaskID)
		if reason == "" {
			reason = "canceled" // 兑底（记录删除等异常路径）
		}
		finalizeStopped(run, reason, "任务已取消", "已暂停（进度保留，可恢复继续）")
		return
	}
	if p2.Filled == 0 && p1.FillTotal == 0 {
		// 同 runList：骨架已全部有正文的可续跑重发报成功（旧版误报 failed）
		finalize(run, "success", fmt.Sprintf("书籍已入库且正文齐全（%d 章，续跑无待填充章节）", p1.SkippedFilled))
		return
	}
	if p2.Filled == 0 {
		finalize(run, "failed", "章节采集全部失败")
		return
	}
	if p2.Failed > 0 {
		finalize(run, "partial", fmt.Sprintf("%d 章成功 / %d 章失败", p2.Filled, p2.Failed))
		return
	}
	finalize(run, "success", fmt.Sprintf("采集完成：%d 章", p2.Filled))
}

// ==================== 收尾与入口 ====================

// finalizeStopped 按停止原因收尾：paused → 走 finalize 的暂停确认分支（保持 paused
// 状态、仅刷新 message/log，进度字段由最后一次 Flush 保留）；canceled/其他 → 取消
// 语义（API 已置 canceled 时 finalize 仅补日志，状态保持 API 写入值）。
func finalizeStopped(run *Run, reason, canceledMsg, pausedMsg string) {
	if reason == "paused" {
		finalize(run, "paused", pausedMsg)
		return
	}
	finalize(run, "canceled", canceledMsg)
}

// phase2Breather Phase 1→Phase 2 阶段间休整（Task 26-d，源站礼貌间隔）：任务 41 实证
// Phase 1 猛抓后立即爆发性抓正文会加速触发站点封禁；此处按 SCRAPE_PHASE2_DELAY_MS
// （默认 3s）小憩一拍。只延迟不新增请求；期间每 200ms 检查暂停/取消，及时让位。
func phase2Breather(run *Run) {
	if PHASE2_DELAY_MS <= 0 {
		return
	}
	deadline := nowMillis() + int64(PHASE2_DELAY_MS)
	for nowMillis() < deadline {
		if stopState(run.TaskID) != "" {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
}

// finalize 终态写入：running → 写终态；paused + paused → 暂停确认（保状态刷新 message/log）；
// 已被取消/暂停/删除的其他情况只保留日志（绝不复活或改写 API 已写入的状态）
func finalize(run *Run, status, message string) {
	var cur string
	if err := queryOne("SELECT status FROM ScrapeTask WHERE id = ?", []any{&cur}, run.TaskID); err != nil {
		return
	}
	msg := truncateRunes(message, 500)
	switch {
	case cur == "running":
		_, _ = execRetry("UPDATE ScrapeTask SET status = ?, message = ?, log = ?, updatedAt = ? WHERE id = ? AND status = 'running'",
			status, msg, run.LogText(), nowMillis(), run.TaskID)
	case cur == "paused" && status == "paused":
		// 暂停确认：不触碰 status/进度字段 → 恢复后 Phase 1/2 依骨架自动续传
		_, _ = execRetry("UPDATE ScrapeTask SET message = ?, log = ?, updatedAt = ? WHERE id = ? AND status = 'paused'",
			msg, run.LogText(), nowMillis(), run.TaskID)
	default:
		_, _ = execRetry("UPDATE ScrapeTask SET log = ?, updatedAt = ? WHERE id = ?", run.LogText(), nowMillis(), run.TaskID)
	}
}

// runTask 任务执行主链路（pending → running 条件更新 → 分模式执行 → 终态）
func runTask(taskID int) {
	run := NewRun(taskID)
	defer func() {
		if r := recover(); r != nil {
			run.Log("发生未预期错误: " + truncateRunes(fmt.Sprintf("%v", r), 200))
			finalize(run, "failed", "任务执行异常")
		}
	}()

	// pending → running 条件更新：pending 阶段已被取消/删除的任务不再启动
	res, err := execRetry("UPDATE ScrapeTask SET status = 'running' WHERE id = ? AND status = 'pending'", taskID)
	if err != nil || rowCountOf(res) == 0 {
		return
	}
	var mode, targetURL string
	var pages int
	var ruleID sql.NullInt64
	if err := queryOne("SELECT mode, targetUrl, pages, ruleId FROM ScrapeTask WHERE id = ?",
		[]any{&mode, &targetURL, &pages, &ruleID}, taskID); err != nil {
		return
	}
	task := TaskRecord{ID: taskID, Mode: mode, TargetURL: targetURL, Pages: pages}
	if ruleID.Valid {
		v := int(ruleID.Int64)
		task.RuleID = &v
	}
	rule := loadRule(task.RuleID)
	if task.Mode == "list" {
		run.Log(fmt.Sprintf("任务开始（范围采集·两阶段并发）目标: %s，页数上限: %d", task.TargetURL, task.Pages))
	} else {
		run.Log(fmt.Sprintf("任务开始（单本采集·两阶段并发）目标: %s", task.TargetURL))
	}
	if task.RuleID != nil {
		name := rule.Name
		if name == "" {
			name = itoa(*task.RuleID)
		}
		charset := rule.Charset
		if charset == "" {
			charset = "auto"
		}
		run.Log(fmt.Sprintf("使用规则「%s」（charset=%s）", name, charset))
	} else {
		run.Log("未使用规则，依赖引擎内置启发式提取")
	}
	run.Flush(nil)
	if task.Mode == "list" {
		runList(run, task, rule)
	} else {
		runSingle(run, task, rule)
	}
}

// triggerScrapeTask fire-and-forget 入口：runner 轮询与任务创建 API 共用，不阻塞调用方
func triggerScrapeTask(taskID int) {
	gRunningMu.Lock()
	if gRunning[taskID] {
		gRunningMu.Unlock()
		return
	}
	gRunning[taskID] = true
	gRunningMu.Unlock()
	go func() {
		defer runningDelete(taskID)
		defer func() {
			if r := recover(); r != nil {
				log.Printf("[scrape-worker] task %d 兜底异常: %v", taskID, r)
			}
		}()
		runTask(taskID)
	}()
}
