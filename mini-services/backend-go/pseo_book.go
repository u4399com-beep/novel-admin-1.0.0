/**
 * pseo_book.go —— PSEO 书籍种子自动化（用户指令：「pseo 设置的种子为每本小说的名称，
 * 自动在每本书籍入库的时候去构造 pseo 页面，并在书籍页的简介下面加入相应的标签」）。
 *
 * 链路：
 *   upsertBook 成功（新建或更新）→ enqueuePseoBookSeed（书名 keyword 入库 source=book，
 *   纯 DB 操作，采集热路径零网络调用）→ pseoEnrichLoop（runner 侧独立 goroutine，12s/次
 *   处理 1 个种子）→ fetchSuggestionsMulti（引擎下拉词，失败隔离）→ insertKeywords（长尾词
 *   入库）→ generatePendingPages（书名词 + 长尾词构建聚合页 pageData）
 * 书籍页标签：handleNovelDetail → novelPseoTags（书名词 + 作者词 + 已生成含书名长尾词），
 * 前端主题书籍页在简介下方渲染 chips，点击进入 /api/pseo/{kw} 聚合页视图。
 *
 * 设计要点：
 * - 幂等：INSERT OR IGNORE 唯一约束兜底（并发 upsert 同书/重复采集只登记一次）
 * - 收敛：种子处理一轮后由 generatePendingPages 置 generated/failed，pending 池单调消化；
 *   引擎全挂时书名词仍会生成聚合页（matchNovels 按书名 LIKE 命中本书），功能不因引擎故障失效
 * - 温和：12s/种子 + 引擎自身域名限速，百本书量级 ≈ 20 分钟全量富集，不触发反爬
 * - 隔离：富集循环独立于任务轮询 goroutine，8s 引擎预算绝不阻塞采集调度；所有失败静默
 *   （best-effort），不影响采集主流程与任务状态机
 */
package main

import (
	"database/sql"
	"log"
	"regexp"
	"time"
)

// pseoEnrichInterval 书名种子富集循环周期（每周期处理 1 个种子词）
const pseoEnrichInterval = 12 * time.Second

// enqueuePseoBookSeed 书名种子登记（best-effort：任何失败静默，不影响采集主流程）。
// source=book 标记来源；status=pending 由 generatePendingPages 消化为 generated/failed。
func enqueuePseoBookSeed(title string) {
	kw := sanitizeKeyword(title)
	if kw == "" {
		return
	}
	now := nowMillis()
	_, _ = exec(
		`INSERT OR IGNORE INTO "PseoKeyword" ("keyword","source","status","createdAt","updatedAt") VALUES (?,'book','pending',?,?)`,
		kw, now, now)
}

// startPseoEnrichLoop 启动后台富集循环（main.go 在 runner/all 模式下 go 调用）
func startPseoEnrichLoop() {
	go func() {
		ticker := time.NewTicker(pseoEnrichInterval)
		defer ticker.Stop()
		for range ticker.C {
			enrichOneBookSeed()
		}
	}()
}

// enrichOneBookSeed 处理一个待富集的书名种子：取下拉词长尾 → 入库 → 生成聚合页。
// 无待处理种子/瞬时 DB 错误时本周期静默跳过。
func enrichOneBookSeed() {
	var id int64
	var keyword string
	err := queryOne(
		`SELECT "id","keyword" FROM "PseoKeyword" WHERE "source" = 'book' AND "status" = 'pending' ORDER BY "id" ASC LIMIT 1`,
		[]any{&id, &keyword})
	if err != nil {
		return
	}
	cfg, cerr := getPseoConfig()
	if cerr != nil {
		return
	}
	started := nowMillis()
	// 下拉词扩展（失败隔离：引擎全挂时 agg.Words 为空，书名词本身仍会生成聚合页）
	agg := fetchSuggestionsMulti(keyword, cfg.Sources, 8000)
	words := agg.Words
	if len(words) > cfg.PerSeedLimit {
		words = words[:cfg.PerSeedLimit]
	}
	entries := []kwEntry{{Word: keyword, Engine: "book"}}
	entries = append(entries, words...)
	added, ierr := insertKeywords(entries, cfg.MaxKeywords)
	if ierr != nil {
		log.Printf("[backend-go-pseo] 种子《%s》长尾词入库失败: %v", truncateRunes(keyword, 30), ierr)
	}
	generated, gerr := generatePendingPages(20)
	if gerr != nil {
		log.Printf("[backend-go-pseo] 种子《%s》聚合页生成失败: %v", truncateRunes(keyword, 30), gerr)
		return
	}
	log.Printf("[backend-go-pseo] 种子《%s》下拉词 +%d（耗时 %dms），本轮生成聚合页 %d 个",
		truncateRunes(keyword, 30), added, nowMillis()-started, generated)
}

// Task 25-e: 章节标题形态作者词防御——部分站点列表规则把「最新章节标题」误提取为作者
// （2026-09-22 实测库内 34 本，如 #229《开局签到荒古圣体》author="第2章 惊动十八祖，…"、
// #159《一剑霸天》author="第2章 必斩他"）。该类「作者」此前会渲染成无意义标签并生成
// /pseo/第2章… 实时聚合页（SEO 噪声）。凡以「第N章/节/回/卷/篇」开头的作者词不再作为标签
// （数据源头修复属采集规则辖区，见 Task 25-e 报告；此处仅保证 pseo 标签面不输出噪声）。
var chapterTitleKwRe = regexp.MustCompile(`^第\s*[0-9０-９〇零一二两三四五六七八九十百千万]+\s*[章节回卷篇]`)

// novelPseoTags 书籍页「相关标签」（前端渲染在简介下方，点击进入对应 PSEO 聚合页）：
//  1. 书名种子词（必有——聚合页按书名 LIKE 命中本书；未生成时 [kw] 聚合页实时计算兜底）
//  2. 作者词（聚合页命中该作者全部作品；佚名/章节标题形态不作为标签）
//  3. 搜索引擎下拉词（用户指令「书籍页标签加入搜索引擎下拉词，pseo 词的链接」）：
//     含书名的已生成长尾词（如「XX全文阅读」「XX笔趣阁」），其中本书书名种子的下拉词
//     （source='book'）排最前，其他引擎来源（baidu/bing/duckduckgo…）含书名词按词长升序靠后，
//     最多 12 个
//
// 总上限 14 个；返回 []（JSON 数组）而非 nil（null）。纯 DB 查询（API 热路径），幂等零网络调用。
func novelPseoTags(title, author string) []string {
	out := []string{}
	seen := map[string]bool{}
	add := func(kw string) {
		if kw == "" || seen[kw] || len(out) >= 14 {
			return
		}
		seen[kw] = true
		out = append(out, kw)
	}
	kwTitle := sanitizeKeyword(title)
	kwAuthor := sanitizeKeyword(author)
	add(kwTitle)
	// Task 25-e: 佚名与章节标题形态（规则误提取）作者词均不输出为标签
	if kwAuthor != "" && kwAuthor != "佚名" && !chapterTitleKwRe.MatchString(kwAuthor) {
		add(kwAuthor)
	}
	if kwTitle != "" {
		like := likeWrap(kwTitle)
		// 下拉词优先序：本书书名种子的下拉词（source='book'）最前，其余引擎来源含书名词
		// 按词长升序（短词更贴近书名）、同长按 id 稳定
		_ = queryList(
			`SELECT "keyword" FROM "PseoKeyword" WHERE "status" = 'generated' AND "keyword" LIKE ? AND "keyword" != ? AND "keyword" != ? ORDER BY ("source" = 'book') DESC, LENGTH("keyword") ASC, "id" ASC LIMIT 12`,
			func(rows *sql.Rows) error {
				var kw string
				if err := rows.Scan(&kw); err != nil {
					return err
				}
				add(kw)
				return nil
			}, like, kwTitle, kwAuthor)
	}
	return out
}
