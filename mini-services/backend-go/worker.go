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
	"regexp"
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
	// laneSoftStartLanes Task 34: Phase 2 软起步活跃车道上限——新任务/无降档记忆时
	// 从这里起步（连续成功逐档回开），避免全速起步对严格限流站首波烧穿
	laneSoftStartLanes = envInt("SCRAPE_LANE_SOFT_START", 4)
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

// sweepOrphanRunningTasks 进程内 running 孤儿自查（Task 44-b，recoverStaleTasks 的运行期补位）：
// gRunning 是本进程 worker 在册表——status='running' 且不在表中，意味着本进程已无 worker
// 执行该任务（worker 在 finalize 终态写入前因存储瞬时异常提前退出、或任何未来路径漏写
// 终态），任务将悬挂 running（runner 只轮询 pending，重启前无自愈，管理端 409 拒编辑）。
// 自查命中 → 条件更新转 paused（进度保留，手动可恢复；文案不含限流字样，不进
// autoResumePausedTasks 词表）。与 worker 写终态竞态安全：worker 在触发前先登记 gRunning
// （triggerScrapeTask），退出后才注销；条件更新 WHERE status='running' 保证不覆盖任何终态。
// 多 runner 进程误配置（Task 19-b 双写事故形态）下，本自查会把另一进程的在跑任务转
// paused——后者 stopState 250ms 内感知并在安全点停手，把「双跑」收敛为「单跑」，属防护
// 而非误伤。runner 每 5 轮（≈10s）扫描一次，status 索引查询成本可忽略。
func sweepOrphanRunningTasks() {
	var ids []int
	err := queryList(`SELECT id FROM ScrapeTask WHERE status = 'running'`, func(rows *sql.Rows) error {
		var id int
		if err := rows.Scan(&id); err != nil {
			return err
		}
		ids = append(ids, id)
		return nil
	})
	if err != nil {
		return // 查询失败静默跳过（自查为 best-effort 防线，下轮再试）
	}
	for _, id := range ids {
		if runningHas(id) {
			continue // 本进程 worker 在册执行中
		}
		res, err := execRetry(
			`UPDATE ScrapeTask SET status = 'paused', message = '孤儿运行态自动回收（已无执行中 worker），可恢复继续采集', updatedAt = ? WHERE id = ? AND status = 'running'`,
			nowMillis(), id)
		if err == nil && rowCountOf(res) > 0 {
			log.Printf("[scrape-worker] 孤儿 running 任务 #%d 已自动暂停（进程内无在册 worker）", id)
		}
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

// chapterPageOrderFromURL Task 31-b: 从顺序页 URL 提取章节序号（/read/{bid}/p{order}.html → order）。
// 用于顺序页可预测站点的「按序爬取/智能续传」排序；无序号形态返回大常数排到最后（稳定排序保持原序）。
var chapterPageOrderRE = regexp.MustCompile(`/p(\d{1,9})\.html?$`)

func chapterPageOrderFromURL(u string) int64 {
	if u == "" {
		return int64(1) << 62
	}
	if m := chapterPageOrderRE.FindStringSubmatch(strings.ToLower(u)); m != nil {
		if n, err := strconv.ParseInt(m[1], 10, 64); err == nil {
			return n
		}
	}
	return int64(1) << 62
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
	// Task 32-b: convertT2S 规则开关（auto|on|off）——书字段/骨架章题入库前繁转简
	t2sMode := t2sModeFromRule(rule)

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
		// Task 32-b: 骨架章节标题入库前繁转简（off 透传；auto 短文本按 ≥2 繁体特征字判定）。
		// 转换在按标题去重/入库之前 → 简繁同题去重合一，续传 fillMap 标题亦为简体
		if t2sMode != "off" {
			for i := range refs {
				refs[i].Title = t2sField(t2sMode, refs[i].Title)
			}
		}
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

		// Task 32-b: item.Author 作列表页条目作者兜底（书页作者占位/缺失时智能填充第一优先）
		up := upsertBook(run, book, categoryID, rule.Proxy, item.Author, t2sMode)
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

// isRateLimitErrText 限流类失败判定（Task 33: 提取为包级函数供单测与车道控制复用）。
// Task 33 实证扩容（2026-09-25 23qb 六站实采）：引擎顶层失败文案的主形态是
// 「fetch-ua-rotate: budget-exhausted（限速排队后预算耗尽）」与「目标主机熔断中」——
// 旧词表只有「429/503/限流/rate」，这些形态全部不命中 → 车道降档永不触发（熔断时活跃
// 车道仍 12）、熔断被误分类「封禁/不可达」。补齐：限速（限速排队）/预算耗尽与
// budget-exhausted（同一形态中英文）/熔断与整链失败（引擎主机熔断期，降档完全正确）。
// 「timeout-budget」单看可能是慢站而非限流，不纳入（宁窄勿宽，防误降档）。
// Task 35-b: 补「全部可用策略」——引擎整链失败的另一顶层文案（huangjinwu/xinjianpan
// 实证「全部可用策略均抓取失败（…timeout…）」）；旧词表只有「整链失败」永不命中，
// 导致这两站列表阶段直接 failed 终态而非可自动恢复的 paused。整链失败多因自拥堵/
// 限速封锁（35-b 诊断 ixds8 同源），降档+自动恢复均为正确响应。
func isRateLimitErrText(err string) bool {
	if err == "" {
		return false
	}
	low := strings.ToLower(err)
	// Task 36-a: 429/503/rate 改词元边界匹配——裸子串两面误伤：
	// ① Contains("rate") 会命中 generate/operate/moderate/separate/accurate 等
	//   无关英文词（当前错误文本流未出现，属潜在误伤面——新增错误文案一经带入即误转 paused）；
	// ② Contains("429"/"503") 会命中内嵌数字（如「第1429章抓取失败」「HTTP 1429」）。
	// 真实限流文案（"HTTP 429"/"（429/503）"/"rate limit"）全部保持命中。
	if reRateLimitToken.MatchString(low) {
		return true
	}
	return strings.Contains(low, "限流") ||
		strings.Contains(low, "限速") || strings.Contains(low, "预算耗尽") ||
		strings.Contains(low, "budget-exhausted") ||
		strings.Contains(low, "熔断") || strings.Contains(low, "整链失败") ||
		strings.Contains(low, "全部可用策略")
}

// reRateLimitToken 429/503/rate 词元边界（两侧非同类字符即成词元；low 已小写）
var reRateLimitToken = regexp.MustCompile(`(?:^|[^0-9])(?:429|503)(?:[^0-9]|$)|(?:^|[^a-z])rate(?:[^a-z]|$)`)

// isTransientScrapeErr 瞬态失败判定（Task 35-b 抽取共用）：限流/软拦截/引擎主机熔断冷却/
// 引擎不可达——这些形态重入即可续传，任务应转 paused（自动恢复资格）而非 failed 终态。
// Task 33 落在 runList Phase 0；Task 35-b 补齐 runList Phase 1 / runSingle 书目全败路径
// （单书重入撞引擎熔断冷却被误定 failed，数千章进度恢复成本全由人工承担）。
func isTransientScrapeErr(err string) bool {
	return isRateLimitErrText(err) || isSoftBlockErrText(err) ||
		strings.Contains(err, "引擎不可达") || strings.Contains(err, "引擎请求超时")
}

// isSoftBlockErrText 软拦截判定（Task 31 引入，Task 33 提取为包级函数供单测）：
// 限流窗口的主要形态是 200 空壳/挑战循环失败，Error 文案不含限流字样。口径：挑战/空壳/正文空。
func isSoftBlockErrText(err string) bool {
	if err == "" {
		return false
	}
	low := strings.ToLower(err)
	return strings.Contains(low, "challenge") || strings.Contains(low, "挑战") ||
		strings.Contains(low, "空壳") || strings.Contains(low, "正文为空") ||
		strings.Contains(low, "正文提取为空") || strings.Contains(low, "软拦截")
}

// gLaneFloor 任务级车道下限记忆（Task 33：跨 resume 持久化）。
// 根因：laneLimiter 每次 runChapterFillPhase 重建都从 CHAPTER_CONCURRENCY(12) 起步，
// 熔断前刚降档到 2 车道的知识在 resume 后丢失 → resume 即全速烧穿再熔断的抖动循环
// （ixdzs8/23qb 实证）。key=任务 id，value=历史最低活跃车道；resume 起步取
// min(记忆值, 配置值)，成功回开逻辑不变（连续 24 章成功 +2 直到封顶）。
// 不删除条目：任务量级 ≤百，内存可忽略；同任务重发永远受益于历史降档经验。
var gLaneFloor sync.Map // map[int]int

// laneFloorLoad 取任务历史车道下限（无记忆返回 0 表示无约束）
func laneFloorLoad(taskID int) int {
	if v, ok := gLaneFloor.Load(taskID); ok {
		if n, ok2 := v.(int); ok2 && n > 0 {
			return n
		}
	}
	return 0
}

// laneFloorStore 记录任务历史车道下限（只降不升：取历史最小值）。
// 首写必须 LoadOrStore（Task 35-a 修复，与 scraper-go Task 33 TestLaneFloorConcurrent 同类竞态）：
// 并发双 shrink 在首写窗口各自 Load 到 cur==0 后裸 Store，后写的较大值会覆盖先写的更小值，
// 丢失更深降档记忆 → resume 起步偏高速烧穿。
func laneFloorStore(taskID, limit int) {
	if limit <= 0 {
		return
	}
	for {
		cur := laneFloorLoad(taskID)
		if cur != 0 && cur <= limit {
			return
		}
		if cur == 0 {
			if _, loaded := gLaneFloor.LoadOrStore(taskID, limit); !loaded {
				return // 首写成功
			}
			continue // 并发者已抢先写入：重新取值比较
		}
		if gLaneFloor.CompareAndSwap(taskID, cur, limit) {
			return
		}
	}
}

// laneRestoreEvery 连续成功多少章回开一档（+2 车道）；软起步日志与 bumpLaneOnSuccess 共用
const laneRestoreEvery = int64(24)

// Phase2Outcome Phase 2 结果
type Phase2Outcome struct {
	Filled       int
	Failed       int
	StoppedEarly bool
	// FailBreaker 连败熔断触发（Task 26-d）：连续 PHASE2_FAIL_BREAKER 章失败且期间零成功，
	// 判定源站封禁/不可达 → 任务自动转 paused 而非把全部骨架烧成 failed（任务 41 实证）
	FailBreaker bool
	ConsecFails int64 // 触发时的连续失败计数（供终态消息）
	// BreakerRateLimit Task 29: 熔断原因分类=true 表示失败形态呈限流特征（429/503/rate），
	// 终态消息据此给出「等窗口恢复」而非「疑似封禁」的处置建议
	BreakerRateLimit bool
	// Task 31-b: 车道感知观测指标——本次 Phase 2 限流降档次数与最终活跃车道数
	LaneShrinks int
	LaneFinal   int
}

// phase2Fill 消费 Phase 1 的填充计划：逐书分批（200/批）拉取 DB 空骨架行（wordCount=0，
// 含历史中断遗留的同名重复行），书内有界并发抓正文并 update 填充；处理完一本书即从
// fillMap 释放其 rows（内存渐减）。章节抓取失败保留骨架（wordCount=0），重发任务自动续传。
// onProgress(doneSoFar) 由调用方节流落库进度；返回 false 表示任务记录已删除，立即停止。
// Task 32-b: storageMode=db|txt|both（TXT 文件存储模式，任务参数；正文落盘语义见
// persistChapterFill）。续传语义不变：填充判定恒依 wordCount>0——txt 模式下已写文件的
// 章节 wordCount 照记（content 留空），不会被判为未填充重复抓取。
func phase2Fill(run *Run, rule LoadedRule, fillMap map[int]fillPlan, storageMode string, onProgress func(doneSoFar int) bool) Phase2Outcome {
	// Task 32-b: convertT2S 规则开关（正文/章题入库前繁转简）
	t2sMode := t2sModeFromRule(rule)
	var filledCtr, failedCtr atomic.Int64
	var warnLogged atomic.Int64
	// Task 26-d 连败熔断：连续失败计数（成功归零），达阈值置位；书间/批间检查后停手。
	// 注意熔断打开后引擎对封禁主机快速结构化失败（毫秒级），不加熔断时 12 车道每秒
	// 可烧数千章（任务 41：46836 章全部 failed）
	var consecFails atomic.Int64
	var failBreaker atomic.Bool
	// Task 29: 熔断触发瞬间的连败数快照。consecFails 会被并发车道成功复位（Store(0)），
	// 若 Outcome 直读 consecFails.Load() 会产出「正文连续失败 0 章却已暂停」的矛盾消息
	// （实证 task1：日志行 60 章 vs 终态 message 0 章）。
	var breakerConsec atomic.Int64
	// Task 29: 限流感知——失败 Error 采样（最近一次）+ 熔断原因分类。
	// 源站 429/503 限流与真封禁/不可达对用户的处置建议不同（限流等窗口恢复即可，
	// 不可达需查站点状态），resume 抖动循环时消息必须能区分两者。
	var lastFailErr atomic.Pointer[string]
	breakerKindLimit := false
	// Task 35-b: 改 atomic.Bool——章级 onProgress 回调（多车道并发）也会写入
	var stoppedEarly atomic.Bool
	breakerStopped := false
	isStopped := throttledCheck(func() bool { return stopState(run.TaskID) != "" })

	// Task 31-b: 车道感知自适应并发。固定 12 车道对严格限流站（ixdzs8 实证）太猛：
	// 高频触发 429/503 + 200 空壳窗口 → 成功 2/失败 69 后熔断停摆，resume 后又少量成功+熔断循环。
	// 检测到限流类失败（复用 Task 29 的 isRateLimitErr）时动态收缩活跃车道（12→4→2），
	// 成功恢复后缓慢回升（每连续 24 章成功 +2 车道，封顶配置值）；与引擎 AIMD 自适应间隔
	//（scraper-go ratelimit.go）配合形成双层自适应：引擎层控制单请求节奏，本层控制并发宽度。
	laneCtl := newLaneLimiter(CHAPTER_CONCURRENCY)
	var laneLimit atomic.Int64
	// Task 33: 起步车道取历史降档记忆（跨 resume 持久化，防 resume 即全速烧穿循环）
	// Task 34: 软起步（soft-start）——无历史记忆时起步 4 车道（非 12 全速），连续成功后
	// 经 bumpLaneOnSuccess 逐档回开到配置值。新任务首次 Phase 2 直接全速对严格限流站
	// 等于烧一波才学会降档；起步即温和，失败后不再需要降档（历史记忆取两者更保守值）。
	laneStart := CHAPTER_CONCURRENCY
	if floor := laneFloorLoad(run.TaskID); floor > 0 {
		laneStart = floor
	}
	if laneStart > laneSoftStartLanes {
		laneStart = laneSoftStartLanes
	}
	if laneStart < CHAPTER_CONCURRENCY {
		laneLimit.Store(int64(laneStart))
		laneCtl.setLimit(laneStart)
		run.Log(fmt.Sprintf("[lane-control] 软起步活跃车道 %d（连续 %d 章成功逐档回开至 %d）", laneStart, laneRestoreEvery, CHAPTER_CONCURRENCY))
	} else {
		laneLimit.Store(int64(CHAPTER_CONCURRENCY))
	}
	var laneShrinks atomic.Int64
	var laneOKStreak atomic.Int64

	isRateLimitErr := func(err string) bool {
		return isRateLimitErrText(err)
	}
	// Task 31: 软拦截判定——ixdzs8 实证限流窗口的主要形态是 200 空壳/挑战循环失败
	//（显式 429/503 反而少），这类失败 Error 文案不含"限流"字样，若不单列则车道降档
	// 与熔断分类（BreakerRateLimit）永不触发，resume 循环烧穿。口径：挑战/空壳/正文空。
	isSoftBlockErr := func(err string) bool {
		return isSoftBlockErrText(err)
	}

	shrinkLanes := func(errClass string) {
		cur := laneLimit.Load()
		next := laneShrinkStep(cur)
		if next >= cur {
			return // 已在最低档
		}
		if laneLimit.CompareAndSwap(cur, next) {
			laneCtl.setLimit(int(next))
			laneFloorStore(run.TaskID, int(next)) // Task 33: 跨 resume 记忆
			laneShrinks.Add(1)
			laneOKStreak.Store(0)
			run.Log(fmt.Sprintf("[lane-control] 检测到限流类失败（%s），活跃车道 %d→%d（引擎已同步 AIMD 放缓请求间隔）", errClass, cur, next))
		}
	}
	bumpLaneOnSuccess := func() {
		if laneOKStreak.Add(1) >= laneRestoreEvery {
			laneOKStreak.Store(0)
			cur := laneLimit.Load()
			next := laneRestoreStep(cur, int64(CHAPTER_CONCURRENCY))
			if next > cur && laneLimit.CompareAndSwap(cur, next) {
				laneCtl.setLimit(int(next))
				run.Log(fmt.Sprintf("[lane-control] 连续 %d 章成功，活跃车道回升 %d→%d", laneRestoreEvery, cur, next))
			}
		}
	}

	noteChapterFail := func() {
		if PHASE2_FAIL_BREAKER <= 0 {
			return // 0=禁用
		}
		if n := consecFails.Add(1); int(n) >= PHASE2_FAIL_BREAKER && failBreaker.CompareAndSwap(false, true) {
			breakerConsec.Store(n) // Task 29: 快照（CAS 赢家独写，无竞态）
			kindDesc := "疑似源站封禁或站点不可达"
			if e := lastFailErr.Load(); e != nil && isRateLimitErr(*e) {
				breakerKindLimit = true // CAS 赢家独写，无竞态
				kindDesc = "失败形态呈限流/空壳软拦截特征（非封禁）"
			}
			// Task 31-b: 日志带上当时活跃车道快照，与降档日志形成完整证据链
			run.Log(fmt.Sprintf("正文连续失败 %d 章（期间零成功，%s）：提前停止防烧穿（已采进度保留，可稍后恢复续传；当前活跃车道 %d）", n, kindDesc, laneLimit.Load()))
		}
	}

	// TS Map 迭代=插入序（Phase 1 并发完成序）；Go map 无序 → 按 novelId 升序确定性处理
	ids := make([]int, 0, len(fillMap))
	for id := range fillMap {
		ids = append(ids, id)
	}
	sort.Ints(ids)

	var failSampleLogged atomic.Int64 // Task 31: phase2 失败原因采样（前 6 条进任务日志，ixdzs8 排障实证：无失败明细无法区分限流空壳/挑战失败/选择器失效）
	// Task 34: 失败形态统计（仅失败章计数，成功不计）——采样只有前 6 条看不到全貌，
	// 终态/熔断消息带形态摘要（timeout×N/熔断×N/空壳×N/挑战×N）才能定位主体失败形态
	var failTimeout, failCircuit, failSoftBlock, failOther atomic.Int64
	for _, novelID := range ids {
		if stoppedEarly.Load() || breakerStopped {
			break
		}
		if isStopped() {
			stoppedEarly.Store(true)
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
			// 同名行可能有多条（历史遗留重复）：一起拉出来填同一内容，后续由目录体检工具去重。
			// Task 32-b: dbRow 增 idx（TXT 分章文件名需要；ChapterContent 以 chapterId=id 为主键，
			// idx 重排/顺延不致正文错位）
			type dbRow struct {
				id    int
				idx   int
				title string
			}
			var dbRows []dbRow
			q := "SELECT id, idx, title FROM Chapter WHERE novelId = ? AND wordCount = 0 AND title IN (" +
				sqlPlaceholders(len(titles)) + ")"
			args := make([]any, 0, len(titles)+1)
			args = append(args, novelID)
			for _, t := range titles {
				args = append(args, t)
			}
			_ = queryList(q, func(rows *sql.Rows) error { // 失败 → 空数组（与 TS catch 一致）
				var r dbRow
				if err := rows.Scan(&r.id, &r.idx, &r.title); err != nil {
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
			// Task 31-b: 顺序页智能续传——ixdzs8 等章节 URL 呈 /read/{bid}/p{order}.html
			// 顺序可预测形态时按 URL 序号升序爬取：对源站更友好（连续页面访问），
			// 且断点续传/重发每次都从同一位置推进，进度确定可预期；无序号 URL 排最后
			sort.SliceStable(dbRows, func(i, j int) bool {
				return chapterPageOrderFromURL(urlByTitle[dbRows[i].title]) <
					chapterPageOrderFromURL(urlByTitle[dbRows[j].title])
			})
			runPoolDynamic(dbRows, laneCtl, func(row dbRow, _ int) {
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
					e := res.Error // Task 29: 采样最近失败原因供熔断分类
					lastFailErr.Store(&e)
					// Task 34: 失败形态统计（与 isRateLimitErrText/isSoftBlockErrText 同口径分桶）
					low := strings.ToLower(e)
					switch {
					case isSoftBlockErr(e):
						failSoftBlock.Add(1)
					case strings.Contains(low, "熔断"):
						failCircuit.Add(1)
					case strings.Contains(low, "timeout") || strings.Contains(low, "超时") || strings.Contains(low, "budget-exhausted"):
						failTimeout.Add(1)
					default:
						failOther.Add(1)
					}
					if failSampleLogged.Add(1) <= 6 { // Task 31: 失败原因采样进任务日志（前 6 条）
						run.Log(fmt.Sprintf("[失败采样 %d/6] %s → %s", failSampleLogged.Load(), truncateRunes(row.title, 30), truncateRunes(e, 120)))
					}
					if isRateLimitErr(e) || isSoftBlockErr(e) { // Task 31-b/31: 限流/软拦截 → 收缩活跃车道
						shrinkLanes("HTTP 429/503 或引擎限流/软拦截判定")
					}
					noteChapterFail()
					return
				}
				cleaned := cleanChapterContent(res.Data.Content)
				content := truncateRunes(cleaned.Text, MAX_CONTENT_CHARS)
				if trimSpaceStr(content) == "" {
					failedCtr.Add(1) // 源站空壳章：保留骨架，重发任务自动重试
					bookFailed.Add(1)
					// Task 31-b: HTTP 200 空壳按限流类软拦截采样（ixdzs8 实证该形态是
					// 限流窗口的主要表现——200 但 .page-content 为空）
					e := "章节正文为空（HTTP 200 空壳响应，疑似限流软拦截/挑战竞态）"
					lastFailErr.Store(&e)
					if failSampleLogged.Add(1) <= 6 { // Task 31: 空壳同样进采样
						run.Log(fmt.Sprintf("[失败采样 %d/6] %s → 200 空壳（正文区无内容）", failSampleLogged.Load(), truncateRunes(row.title, 30)))
					}
					shrinkLanes("200 空壳软拦截")
					noteChapterFail()
					return
				}
				if len(res.Warnings) > 0 && warnLogged.Load() < 10 {
					warnLogged.Add(1)
					run.LogWarnings(res.Warnings)
				}
				// Task 32-b: 正文/章题繁转简（convertT2S 规则开关；off 零开销透传）
				content = t2sField(t2sMode, content)
				title := trimSpaceStr(row.title)
				if title == "" {
					title = trimSpaceStr(res.Data.Title)
				}
				if title == "" {
					title = "第" + itoa(row.id) + "章"
				}
				title = truncateRunes(t2sField(t2sMode, title), chapterTitleMax)
				// Task 32-b: 持久化抽 persistChapterFill（垂直分表 ChapterContent +
				// TXT 存储模式统一写序，见函数注释）；false=未填充（保留骨架续传）
				if persistChapterFill(run, novelID, row.id, row.idx, title, content, storageMode) {
					filledCtr.Add(1)
					bookFilled.Add(1)
					consecFails.Store(0) // 成功即复位连败计数
					bumpLaneOnSuccess()  // Task 31-b: 成功回开车道
					run.IncChapters()
				} else {
					failedCtr.Add(1)
					bookFailed.Add(1)
					noteChapterFail()
				}
				// Task 35-b: 章级节流进度落库——onProgress 原先只在书级循环末尾
				// 调用（:904），单书超长任务（ixdzs8 单本 369 章实测）整本书采完前
				// chDone 永不刷新（用户看到的进度静止十几分钟，分表实际每 3s +1 章）。
				// 回调内部自带 FLUSH_INTERVAL_MS(800ms) 节流，书级调用保持不变。
				if !onProgress(int(filledCtr.Load())) {
					stoppedEarly.Store(true)
					return
				}
			}, func() bool { return isStopped() || failBreaker.Load() || stoppedEarly.Load() })
			if failBreaker.Load() {
				breakerStopped = true
			}
			if !onProgress(int(filledCtr.Load())) {
				stoppedEarly.Store(true)
				break
			}
			if isStopped() {
				stoppedEarly.Store(true)
				break
			}
			if breakerStopped {
				break
			}
		}
		run.Log(fmt.Sprintf("书籍 #%d 正文填充完成：成功 %d / 失败 %d", novelID, bookFilled.Load(), bookFailed.Load()))
		delete(fillMap, novelID) // 处理完即释放，长任务内存渐减
	}
	// Task 34: 失败形态摘要进日志（仅有失败时；采样 6 条之外的聚合视图）
	if f := failedCtr.Load(); f > 0 {
		parts := []string{}
		if v := failSoftBlock.Load(); v > 0 {
			parts = append(parts, fmt.Sprintf("限流/空壳×%d", v))
		}
		if v := failCircuit.Load(); v > 0 {
			parts = append(parts, fmt.Sprintf("熔断快速失败×%d", v))
		}
		if v := failTimeout.Load(); v > 0 {
			parts = append(parts, fmt.Sprintf("超时/预算耗尽×%d", v))
		}
		if v := failOther.Load(); v > 0 {
			parts = append(parts, fmt.Sprintf("其他×%d", v))
		}
		run.Log("[失败形态统计] 共 " + itoa(int(f)) + " 章失败：" + strings.Join(parts, "、"))
	}
	return Phase2Outcome{Filled: int(filledCtr.Load()), Failed: int(failedCtr.Load()), StoppedEarly: stoppedEarly.Load(),
		FailBreaker: breakerStopped || failBreaker.Load(), ConsecFails: breakerConsec.Load(), // Task 29: 用熔断瞬间快照
		BreakerRateLimit: breakerKindLimit,
		// Task 31-b: 车道感知观测指标
		LaneShrinks: int(laneShrinks.Load()), LaneFinal: int(laneLimit.Load())}
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

// ==================== 正文持久化与简介回填（Task 32-b） ====================

// persistChapterFill phase2 单章持久化（垂直分表 + TXT 存储模式统一写序）：
//  1. ChapterContent upsert（db/both 模式；cc 写败 → 返回 false，Chapter.wordCount 保持 0，
//     重发任务自动重试——绝不出现「已采但正文丢失」）；键=chapterId（chRowID=Chapter.id，
//     idx 重排/顺延不致正文错位，见 db.go chapterContentDDL 注释）；
//  2. TXT 分章文件（txt/both 模式；txt 模式写败同样视为未填充续传重试，both 模式 DB 已有
//     正文，文件失败仅记日志；按指令「写文件失败不影响任务状态机」，只计章节失败不判任务失败）；
//  3. Chapter 行 title/wordCount 落库（content 恒空串，正文一律在分表/文件）——本步成功
//     才算已填充（resume 依 wordCount>0 判已采，txt 模式 content 为空不参与判定）。
//
// storageMode 语义：db=仅分表；txt=仅文件（分表不写，读路径靠 readChapterFromTxt 兜底）；
// both=分表+文件双写。返回 true=已填充。
func persistChapterFill(run *Run, novelID, chRowID, chIdx int, title, content, storageMode string) bool {
	storeContent := content
	if storageMode == "txt" {
		storeContent = "" // txt 模式：正文只落文件；wordCount 照记（resume 判据 wordCount>0 不受影响）
	}
	if storeContent != "" {
		if _, err := execRetry(`INSERT OR REPLACE INTO "ChapterContent" ("chapterId","content") VALUES (?,?)`,
			chRowID, storeContent); err != nil {
			return false
		}
	}
	if storageMode == "txt" || storageMode == "both" {
		if err := writeChapterTxt(novelID, chIdx, title, content); err != nil {
			run.Log(fmt.Sprintf("TXT 写入失败(%s): %s", truncateRunes(chapterTxtPath(novelID, chIdx, title), 80), truncateRunes(err.Error(), 100)))
			if storageMode == "txt" {
				return false // 文件即唯一存储：按未填充处理（骨架保留续传），不影响任务状态机
			}
		}
	}
	res, err := execRetry("UPDATE Chapter SET title = ?, wordCount = ? WHERE id = ?", title, countNonSpaceRunes(content), chRowID)
	return err == nil && rowCountOf(res) > 0
}

// backfillDescriptions 简介缺失回填（Task 32-b，finalize 前批量执行，限 10 本/任务）：
// description 为空的书取第一章正文首 200 字清洗截断（干净截断，无前缀）；无正文可取走
// LLM 生成（5s 超时+静默降级，llm.go），仍未果跳过。条件更新（description=”）防与编辑竞态。
func backfillDescriptions(novelIDs []int) {
	if len(novelIDs) == 0 {
		return
	}
	args := make([]any, 0, len(novelIDs))
	for _, id := range novelIDs {
		args = append(args, id)
	}
	var emptyCount int
	if err := queryOne(`SELECT COUNT(*) FROM "Novel" WHERE "description" = '' AND "id" IN (`+sqlPlaceholders(len(novelIDs))+`)`,
		[]any{&emptyCount}, args...); err != nil || emptyCount == 0 {
		return // 预检零成本：绝大多数任务无空简介书
	}
	fixed := 0
	for _, nid := range novelIDs {
		if fixed >= 10 {
			break
		}
		var title, author, desc string
		if err := queryOne(`SELECT "title", "author", "description" FROM "Novel" WHERE "id" = ?`,
			[]any{&title, &author, &desc}, nid); err != nil || trimSpaceStr(desc) != "" {
			continue
		}
		generated := firstChapterPreview(nid)
		if trimSpaceStr(generated) == "" {
			generated = trimSpaceStr(llmGenerateDescription(title, author))
		}
		if trimSpaceStr(generated) == "" {
			continue
		}
		res, err := execRetry(`UPDATE "Novel" SET "description" = ?, "updatedAt" = ? WHERE "id" = ? AND "description" = ''`,
			truncateRunes(trimSpaceStr(generated), novelDescriptionMax), nowMillis(), nid)
		if err == nil && rowCountOf(res) > 0 {
			fixed++
		}
	}
}

// smartCompleteStatus 智能完结补强（Task 33，finalize 前批量执行）：
// storex.go 的智能完结注释一直宣称「description+末章标题关键词判定」，但 upsertBook
// 只实现了简介判定（书骨架阶段拿不到目录）——目录已入库后这里补上末章标题路径：
// status=serial 的书若末章标题命中完结词表（大结局/终章/全书完/完本/the end 等，
// novelStatusFinishedRE 同口径），且简介无「连载中/未完」等负向词 → 升级 finished。
// 单向升级（serial→finished，绝不降级）：源站状态「连载中」但末章已是「大结局」的
// 站点状态滞后场景，升级即纠偏。每任务限 20 本防 LLM 外的 DB 写放大。
func smartCompleteStatus(novelIDs []int) {
	if len(novelIDs) == 0 {
		return
	}
	args := make([]any, 0, len(novelIDs))
	for _, id := range novelIDs {
		args = append(args, id)
	}
	var rows []struct {
		id    int
		title string
		desc  string
	}
	q := `SELECT n."id",
                     (SELECT c."title" FROM "Chapter" c WHERE c."novelId" = n."id" ORDER BY c."idx" DESC LIMIT 1) AS lastTitle,
                     n."description"
              FROM "Novel" n
              WHERE n."status" = 'serial' AND n."id" IN (` + sqlPlaceholders(len(novelIDs)) + `)`
	_ = queryList(q, func(rs *sql.Rows) error {
		var r struct {
			id    int
			title string
			desc  string
		}
		if err := rs.Scan(&r.id, &r.title, &r.desc); err != nil {
			return err
		}
		rows = append(rows, r)
		return nil
	}, args...)
	fixed := 0
	for _, r := range rows {
		if fixed >= 20 {
			break
		}
		lastTitle := trimSpaceStr(r.title)
		if lastTitle == "" || !novelStatusFinishedRE.MatchString(lastTitle) {
			continue
		}
		// 简介/末章任一命中进行时负向词（连载中/未完/停更）则不动——防「大结局？不，新的开始」式标题误判
		if novelStatusOngoingRE.MatchString(lastTitle) || novelStatusOngoingRE.MatchString(r.desc) {
			continue
		}
		res, err := execRetry(`UPDATE "Novel" SET "status" = 'finished', "updatedAt" = ? WHERE "id" = ? AND "status" = 'serial'`,
			nowMillis(), r.id)
		if err == nil && rowCountOf(res) > 0 {
			fixed++
		}
	}
	if fixed > 0 {
		log.Printf("[smart-status] 智能完结：%d 本（末章标题命中完结词，serial→finished）", fixed)
	}
}

// firstChapterPreview 首章正文首 200 字（逐行清洗：TrimSpace 去空行后以单空格拼接、截断）。
// 正文读取 COALESCE 分表兼容（chapterId 键）+ readChapterFromTxt 兜底（txt 存储模式）。
func firstChapterPreview(novelID int) string {
	var idx int
	var content string
	err := queryOne(`SELECT c."idx", COALESCE(cc."content", c."content") AS "content"
                FROM "Chapter" c LEFT JOIN "ChapterContent" cc ON cc."chapterId" = c."id"
                WHERE c."novelId" = ? ORDER BY c."idx" ASC LIMIT 1`, []any{&idx, &content}, novelID)
	if err != nil {
		return ""
	}
	if trimSpaceStr(content) == "" {
		if body, terr := readChapterFromTxt(novelID, idx); terr == nil {
			content = body
		}
	}
	var b strings.Builder
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if b.Len() > 0 {
			b.WriteByte(' ')
		}
		b.WriteString(line)
		if len([]rune(b.String())) >= 200 {
			break
		}
	}
	return truncateRunes(b.String(), 200)
}

// ==================== Phase 0：列表页条目收集 ====================

// collectListItems 列表页翻页收集（模板优先、连续失败快速终止、合并去重、任务上限截断）。
// 返回 (条目, 最后命中的列表页 URL 作 referer)。
func collectListItems(run *Run, task TaskRecord, rule LoadedRule) ([]ListItem, string, string) {
	run.Log("抓取列表页第 1 页…")
	first, firstErr := fetchListPage(run, task.TargetURL, rule, "")
	if len(first) == 0 {
		run.Log("列表页未提取到书籍条目")
		return nil, firstErr, task.TargetURL
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
			pageItems, _ := fetchListPage(run, v, rule, "")
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
	return merged, firstErr, currentListURL
}

// ==================== 两种模式 ====================

// runList list 范围模式：Phase 0 列表 → Phase 1 骨架 → Phase 2 填充。
// Task 32-b: storageMode 由 runTask 从任务行读出透传（db|txt|both）
func runList(run *Run, task TaskRecord, rule LoadedRule, storageMode string) {
	// ---- Phase 0：列表页 ----
	collected, firstListErr, currentListURL := collectListItems(run, task, rule)
	if reason := stopState(run.TaskID); reason != "" {
		finalizeStopped(run, reason, "任务已取消", "已暂停（列表阶段中断，进度保留，可恢复继续）")
		return
	}
	if len(collected) == 0 {
		// Task 33: 首页抓取失败若是熔断/软拦截形态（引擎主机冷却中，瞬态非真失效），任务转
		// paused 而非 failed——resume/自动恢复冷却后重新入队即可续传；旧逻辑把带 2.5 万章
		// 进度的任务打成 failed 终态（列表重入撞 60s 熔断窗口），恢复成本全由人工承担
		if isTransientScrapeErr(firstListErr) {
			finalize(run, "paused", "列表页抓取失败（源站限流/空壳软拦截或引擎主机熔断冷却中，非封禁）：任务已自动暂停，自动恢复将在冷却后重新入队（已采进度保留）")
			return
		}
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
		finalizeStopped(run, reason,
			fmt.Sprintf("已取消（书目完成 %d/%d 本）", p1.OKBooks, total),
			fmt.Sprintf("已暂停（书目完成 %d/%d 本，进度保留，可恢复继续）", p1.OKBooks, total))
		// Task 27-c（重新应用 25-a 修复②）：recalcWordCountsFor 大任务秒级耗时，
		// 移到 finalizeStopped 之后——「停止检测→终态落库」窗口从秒级压到毫秒级，
		// 防用户在窗口内 cancel/restart 与 worker 收尾竞态（进度/终态被收尾覆盖）
		recalcWordCountsFor(p1.NovelIDs)
		return
	}
	created, updated, _ := run.Snapshot()
	run.Flush(&TaskFlushFields{Done: &p1.OKBooks, ChaptersTotal: &p1.FillTotal, ChaptersDone: &zero, Created: &created, Updated: &updated})

	if p1.OKBooks == 0 {
		msg := p1.FirstError
		if msg == "" {
			msg = "无书籍采集成功"
		}
		// Task 35-b: 书目全败若是瞬态（引擎熔断冷却/不可达/限流软拦截），转 paused
		// 而非 failed（同 Phase 0 口径；列表成功但 Phase 1 撞熔断窗口同样可自动恢复）
		if isTransientScrapeErr(msg) {
			finalize(run, "paused", "书目抓取失败（源站限流/空壳软拦截或引擎主机熔断冷却中，非封禁）：任务已自动暂停，自动恢复将在冷却后重新入队（已采进度保留）")
			return
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
	// Task 36-a: lastFlush 改 atomic+CAS——Task 35-b 章级 onProgress 调用后，回调从
	// 多车道 goroutine 并发进入，裸 int64 读改写是数据竞争（go test -race 可证）；
	// CAS 保证每个 800ms 窗口恰一次落库（与旧单线程语义一致）
	var lastFlush atomic.Int64
	p2 := phase2Fill(run, rule, p1.FillMap, storageMode, func(doneSoFar int) bool {
		now := nowMillis()
		prev := lastFlush.Load()
		if now-prev < int64(FLUSH_INTERVAL_MS) {
			return true
		}
		if !lastFlush.CompareAndSwap(prev, now) {
			return true // 并发车道已抢占本窗口
		}
		c2, u2, ch := run.Snapshot()
		return run.Flush(&TaskFlushFields{ChaptersDone: &doneSoFar, Chapters: &ch, Created: &c2, Updated: &u2})
	})
	recalcWordCountsFor(p1.NovelIDs)
	created, updated, chapters := run.Snapshot()
	run.Flush(&TaskFlushFields{ChaptersDone: &p2.Filled, Chapters: &chapters, Created: &created, Updated: &updated})

	if p2.FailBreaker && stopState(run.TaskID) == "" {
		// Task 26-d：连败熔断（疑似源站封禁/不可达）→ 转 paused 而非把数万骨架烧成 failed；
		// 恢复=PATCH resume 重入队，Phase 2 依空骨架自动续传（每次重试至多再烧阈值内的失败）
		// Task 29: 限流形态区分处置建议
		if p2.BreakerRateLimit {
			// Task 31-b: 分类覆盖面扩到 200 空壳（限流窗口的主要表现形态之一）
			finalize(run, "paused", fmt.Sprintf("正文连续失败 %d 章（源站限流/空壳软拦截：429/503 或 200 空壳，非封禁），已自动暂停防烧穿（成功 %d 章，进度保留；建议稍后恢复续传，引擎 AIMD+车道降档已自动放缓节奏）", p2.ConsecFails, p2.Filled))
		} else {
			finalize(run, "paused", fmt.Sprintf("正文连续失败 %d 章（疑似源站封禁或站点不可达），已自动暂停防烧穿（成功 %d 章，进度保留，可恢复继续采集）", p2.ConsecFails, p2.Filled))
		}
		return
	}
	if p2.StoppedEarly {
		reason := stopState(run.TaskID)
		if reason == "" {
			reason = "canceled" // 兜底（记录删除等异常路径）
		}
		finalizeStopped(run, reason,
			fmt.Sprintf("已取消（正文填充 %d/%d 章）", p2.Filled, p1.FillTotal),
			fmt.Sprintf("已暂停（正文填充 %d/%d 章，进度保留，可恢复继续）", p2.Filled, p1.FillTotal))
		return
	}
	smartCompleteStatus(p1.NovelIDs)  // Task 33: 智能完结补强（末章标题关键词判定）
	backfillDescriptions(p1.NovelIDs) // Task 32-b: finalize 前空简介批量回填（限 10 本/任务）
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

// runSingle single 单本模式：复用两阶段管线，一个条目 → 骨架 → 填充；done/total 主口径=章节。
// Task 32-b: storageMode 透传同 runList
func runSingle(run *Run, task TaskRecord, rule LoadedRule, storageMode string) {
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
		// Task 35-b: 同 runList——单书重入撞引擎熔断冷却/不可达/限流软拦截（瞬态）转
		// paused 而非 failed；旧逻辑把带数千章进度的单书任务打成 failed 终态
		if isTransientScrapeErr(msg) {
			finalize(run, "paused", "书页抓取失败（源站限流/空壳软拦截或引擎主机熔断冷却中，非封禁）：任务已自动暂停，自动恢复将在冷却后重新入队（已采进度保留）")
			return
		}
		finalize(run, "failed", msg)
		return
	}
	if reason := stopState(run.TaskID); reason != "" {
		finalizeStopped(run, reason, "任务已取消", "已暂停（进度保留，可恢复继续）")
		// Task 27-c（重新应用 25-a 修复②）：同 runList——recalc 移到终态落库之后
		recalcWordCountsFor(p1.NovelIDs)
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
	// Task 36-a: 同 runList——章级 onProgress 并发化后 lastFlush 须 atomic+CAS
	var lastFlush atomic.Int64
	p2 := phase2Fill(run, rule, p1.FillMap, storageMode, func(doneSoFar int) bool {
		now := nowMillis()
		prev := lastFlush.Load()
		if now-prev < int64(FLUSH_INTERVAL_MS) {
			return true
		}
		if !lastFlush.CompareAndSwap(prev, now) {
			return true
		}
		done := p1.SkippedFilled + doneSoFar
		return run.Flush(&TaskFlushFields{Done: &done, ChaptersDone: &done})
	})

	recalcWordCountsFor(p1.NovelIDs)
	done := p1.SkippedFilled + p2.Filled
	_, _, chapters := run.Snapshot()
	run.Flush(&TaskFlushFields{Done: &done, ChaptersDone: &done, Chapters: &chapters})

	if p2.FailBreaker && stopState(run.TaskID) == "" {
		// Task 26-d：连败熔断 → 转 paused（同 runList 注释）
		// Task 29: 限流形态区分处置建议
		if p2.BreakerRateLimit {
			// Task 31-b: 分类覆盖面扩到 200 空壳（同 runList）
			finalize(run, "paused", fmt.Sprintf("正文连续失败 %d 章（源站限流/空壳软拦截：429/503 或 200 空壳，非封禁），已自动暂停防烧穿（成功 %d 章，进度保留；建议稍后恢复续传，引擎 AIMD+车道降档已自动放缓节奏）", p2.ConsecFails, p2.Filled))
		} else {
			finalize(run, "paused", fmt.Sprintf("正文连续失败 %d 章（疑似源站封禁或站点不可达），已自动暂停防烧穿（成功 %d 章，进度保留，可恢复继续采集）", p2.ConsecFails, p2.Filled))
		}
		return
	}
	if p2.StoppedEarly {
		reason := stopState(run.TaskID)
		if reason == "" {
			reason = "canceled" // 兜底（记录删除等异常路径）
		}
		finalizeStopped(run, reason, "任务已取消", "已暂停（进度保留，可恢复继续）")
		return
	}
	smartCompleteStatus(p1.NovelIDs)  // Task 33: 智能完结补强（末章标题关键词判定）
	backfillDescriptions(p1.NovelIDs) // Task 32-b: finalize 前空简介批量回填（限 10 本/任务）
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

// finalize 终态写入：running → 写终态；pending + 实际已跑完（success/partial/failed）→
// 条件领取终态；paused + paused → 暂停确认（保状态刷新 message/log）；
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
	case cur == "pending" && (status == "success" || status == "partial" || status == "failed"):
		// Task 27-c（重新应用 25-a 修复①，合并时丢失）：快速 pause→resume 竞态——
		// 两 API 调用落在 worker 相邻 stopState 检查之间，worker 未感知暂停跑完全程，
		// 此时状态已被 resume 写回 pending；若不领取，任务永久滞留 pending → runner
		// 2s 轮询二次分发全量重跑。条件领取（WHERE status='pending'，gRunning 防重
		// 保证无第二 worker）把实际已跑完的任务落到真终态；canceled 刻意不领取
		// = 兑现「取消收尾中点重启」重跑语义
		_, _ = execRetry("UPDATE ScrapeTask SET status = ?, message = ?, log = ?, updatedAt = ? WHERE id = ? AND status = 'pending'",
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
	// Task 32-b: storageMode（TXT 文件存储模式）随任务参数读出（db.go once 已 ensureColumn，
	// 旧任务行/异常值统一归一 db）
	var mode, targetURL, storageMode string
	var pages int
	var ruleID sql.NullInt64
	if err := queryOne("SELECT mode, targetUrl, pages, ruleId, storageMode FROM ScrapeTask WHERE id = ?",
		[]any{&mode, &targetURL, &pages, &ruleID, &storageMode}, taskID); err != nil {
		// Task 44-b（P2）：参数读取失败（存储瞬时异常/损坏行存储类不匹配，如 pages 列
		// 存在历史工具写入的 TEXT 形态）旧版静默 return——此时 pending→running 条件更新
		// 已完成，无任何 worker 写终态，runner 只轮询 pending、recoverStaleTasks 仅启动
		// 执行一次 → 任务永久悬挂 running（管理端按执行中 409 拒编辑，进程重启前无自愈）。
		// 改为：日志留痕 + finalize paused（与崩溃恢复同语义：进度保留可恢复；文案不含
		// 限流字样，不进 autoResumePausedTasks 词表，恢复路径纯手动）。
		run.Log("任务参数读取失败: " + truncateRunes(err.Error(), 200))
		finalize(run, "paused", "任务参数读取失败（存储瞬时异常或损坏行），任务已自动暂停，排查任务配置后可恢复继续采集")
		return
	}
	switch storageMode {
	case "txt", "both":
	default:
		storageMode = "db"
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
	if storageMode != "db" {
		run.Log(fmt.Sprintf("存储模式: %s（正文%s）", storageMode,
			map[string]string{"txt": "仅落 TXT 分章文件", "both": "入库+TXT 双写"}[storageMode]))
	}
	if task.Mode == "list" {
		runList(run, task, rule, storageMode)
	} else {
		runSingle(run, task, rule, storageMode)
	}
}

// triggerScrapeTask fire-and-forget 入口：runner 轮询专用（任务创建 API 不内联执行，
// runner 2s 轮询领取，见 api_scrape_tasks.go POST 注释），不阻塞调用方
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
