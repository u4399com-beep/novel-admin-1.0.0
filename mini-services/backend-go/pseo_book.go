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
	"time"
)

// pseoEnrichInterval 书名种子富集循环周期（每周期处理 1 个种子词）
const pseoEnrichInterval = 12 * time.Second

// enqueuePseoBookSeed 书名种子登记（best-effort：失败仅记日志，不影响采集主流程；
// Task 44-b 起非唯一冲突错误落日志可观测）。source=book 标记来源；status=pending 由
// generatePendingPages 消化为 generated/failed。
func enqueuePseoBookSeed(title string) {
	kw := sanitizeKeyword(title)
	if kw == "" {
		return
	}
	now := nowMillis()
	// Task 44-b: INSERT OR IGNORE 的 error 恒为非唯一冲突类（唯一冲突已被 IGNORE 吞为成功）
	// ——此前 `_, _ = exec` 全静默，种子链断裂（列缺失/模式漂移/锁超时）零痕迹可排查，
	// 与 Task 40 占位符错配静默丢整批的教训同族：静默吞错必须可观测
	if _, err := exec(
		`INSERT OR IGNORE INTO "PseoKeyword" ("keyword","source","status","createdAt","updatedAt","kwNorm") VALUES (?,'book','pending',?,?,?)`,
		kw, now, now, kwNormalize(kw)); err != nil {
		log.Printf("[backend-go-pseo] 书名种子登记失败 keyword=%q: %v", truncateRunes(kw, 40), err)
	}
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
		// Task 41: 无待富集书名种子时，词池仍可能有 pending（intro 提取词/手工添加词）——
		// 照常消化聚合页，否则简介长尾词会滞留 pending（存量书种子均已 generated 实证此路径）
		var anyPending int
		if e2 := queryOne(`SELECT COUNT(*) FROM "PseoKeyword" WHERE "status" = 'pending'`, []any{&anyPending}); e2 == nil && anyPending > 0 {
			if g, gerr := generatePendingPages(20); gerr == nil && g > 0 {
				log.Printf("[backend-go-pseo] 无书名种子待富集，直接消化 pending 词池 +%d 页", g)
			}
		}
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
	// Task 40: 血缘入库——seed=书名种子，书籍页按血缘直取本书的 pseo 下拉词
	added, ierr := insertKeywords(entries, cfg.MaxKeywords, keyword)
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

// novelPseoTags 书籍页「相关标签」（前端渲染在简介下方，点击进入对应 PSEO 聚合页）：
//  1. 书名种子词（必有——聚合页按书名 LIKE 命中本书；未生成时 [kw] 聚合页实时计算兜底）
//  2. 作者词（聚合页命中该作者全部作品；佚名不作为标签）
//  3. 搜索引擎下拉词（用户指令「书籍页标签加入搜索引擎下拉词，pseo 词的链接」；Task 40 强化
//     「加入 pseo 生成的相关下拉词」）双通道取词：
//     ① seed 血缘直取——本书种子富集产出的全部下拉词（enrichOneBookSeed 入库时 seed=书名），
//     不要求词面包含书名（相关推荐词也能上榜），generated 优先（聚合页 TDK 已生成）
//     ② kwNorm 归一形 LIKE 兜底——覆盖 seed 列引入前的存量词与跨来源含书名词；
//     全半角/空白/大小写形态差异不再漏配（书 293 实证：全角？书名 vs 半角?下拉词全量漏配）；
//     归一包含 ⊇ 严格子串包含，旧语义为严格超集，无需第三查询
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
	if kwAuthor != "" && kwAuthor != "佚名" {
		add(kwAuthor)
	}
	if kwTitle != "" {
		scanAdd := func(rows *sql.Rows) error {
			var kw string
			if err := rows.Scan(&kw); err != nil {
				return err
			}
			add(kw)
			return nil
		}
		// ① seed 血缘直取：本书种子的下拉词按词长升序（短词更贴近书名）、同长按 id 稳定
		_ = queryList(
			`SELECT "keyword" FROM "PseoKeyword" WHERE "seed" = ? AND "keyword" != ? AND "keyword" != ?
                          ORDER BY ("status" = 'generated') DESC, LENGTH("keyword") ASC, "id" ASC LIMIT 12`,
			scanAdd, kwTitle, kwTitle, kwAuthor)
		// ② kwNorm 归一形 LIKE 兜底：存量词 + 跨来源含书名词（归一形抹平标点/空白/大小写差异）
		_ = queryList(
			`SELECT "keyword" FROM "PseoKeyword" WHERE "status" = 'generated' AND "kwNorm" LIKE ? AND "keyword" != ? AND "keyword" != ?
                          ORDER BY ("source" = 'book') DESC, LENGTH("keyword") ASC, "id" ASC LIMIT 12`,
			scanAdd, likeWrap(kwNormalize(kwTitle)), kwTitle, kwAuthor)
	}
	return out
}
