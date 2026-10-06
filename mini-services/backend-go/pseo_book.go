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
	"fmt"
	"log"
	"strconv"
	"sync"
	"time"
)

// pseoEnrichInterval 书名种子富集循环周期（每周期处理一批种子，Task 83 起批量 4）
const pseoEnrichInterval = 12 * time.Second

// enrichBatchSize 每周期并发富集种子数（Task 83 结构性修复：书目灌入速率远大于旧
// 12s/种子富集速率，种子队列单调增长→血缘下拉词永不落地→书籍页标签长期只有
// 书名+作者两个。引擎取词种子级并发 4（引擎聚合内部仍限并发 3，对齐 api_pseo.go
// pseoBatchConcurrency=2 的既有并发先例），对 suggest 端点合計 ~0.33 QPS/域，温和不变；
// DB 收尾串行（单写者不变量：重试记账/词入库/聚合页生成零并发写竞争）
const enrichBatchSize = 4

// Task 59-R2: 种子富集「引擎全败」有界重试。原实现 fetchSuggestionsMulti 失败隔离后
// 静默照常置 generated——引擎瞬时故障窗口内处理的种子，该书下拉词长尾**永久丢失**
// （书本不再更新则种子不再登记）。重试记账存 AppMeta KV（"n|at" 文本形态，无新表）；
// 连续 enrichRetryMax 次全败后放弃（保底书名词页面照常生成），冷却期不空烧引擎。
const (
	enrichRetryMax      = 3             // 连续引擎全败上限
	enrichRetryCooldown = 5 * 60 * 1000 // 重试冷却 5min（毫秒）
)

// enrichRetryKey AppMeta 记账键（kwNorm 归一形，同词跨形态同一记账）
func enrichRetryKey(kw string) string { return "pseoEnrichRetry:" + kwNormalize(kw) }

func getEnrichRetry(kw string) (n int, at int64) {
	var v string
	if err := queryOne(`SELECT "value" FROM "AppMeta" WHERE "key" = ?`, []any{&v}, enrichRetryKey(kw)); err != nil {
		return 0, 0
	}
	_, _ = fmt.Sscanf(v, "%d|%d", &n, &at)
	return
}

func setEnrichRetry(kw string, n int, at int64) {
	_, _ = exec(`INSERT OR REPLACE INTO "AppMeta" ("key","value") VALUES (?, ?)`, enrichRetryKey(kw), itoa(n)+"|"+strconv.FormatInt(at, 10))
}

func clearEnrichRetry(kw string) {
	_, _ = exec(`DELETE FROM "AppMeta" WHERE "key" = ?`, enrichRetryKey(kw))
}

// suggestEnginesAllFailed 引擎侧全败判定：非零结果且每个引擎都带错误（Error != ""）。
// 注意不能以 OK/词数判定——OK=false 且 Error=="" 是「引擎健康但该词无下拉建议」，
// 重试无意义必须区分。零结果（无有效引擎配置/全部未返回）视同全败。
func suggestEnginesAllFailed(agg suggestionsAggregate) bool {
	if len(agg.Results) == 0 {
		return true
	}
	for _, r := range agg.Results {
		if r.Error == "" {
			return false
		}
	}
	return true
}

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
			enrichBookSeedBatch()
		}
	}()
}

// enrichOneBookSeed 单种子便捷入口（保留旧语义名供测试/理解；实际走批量路径）
func enrichOneBookSeed() { enrichBookSeedBatch() }

// enrichSeedClaim 已认领的待富集种子（批内引擎取词并发、DB 收尾串行）
type enrichSeedClaim struct {
	id      int64
	keyword string
}

// enrichBookSeedBatch 每周期处理至多 enrichBatchSize 个待富集书名种子（原 1 个/周期）。
// 三段式：①认领（单查询 LIMIT n）→②引擎取词并发（冷却种子跳过，见重试记账）→
// ③DB 收尾串行（finalizeBookSeedEnrich）。无待处理种子/瞬时 DB 错误时本周期静默跳过。
func enrichBookSeedBatch() {
	claims := make([]enrichSeedClaim, 0, enrichBatchSize)
	err := queryList(
		`SELECT "id","keyword" FROM "PseoKeyword" WHERE "source" = 'book' AND "status" = 'pending' ORDER BY "id" ASC LIMIT ?`,
		func(rows *sql.Rows) error {
			var c enrichSeedClaim
			if err := rows.Scan(&c.id, &c.keyword); err != nil {
				return err
			}
			claims = append(claims, c)
			return nil
		}, enrichBatchSize)
	if err != nil || len(claims) == 0 {
		// Task 41: 无待富集书名种子时，词池仍可能有 pending（intro 提取词/手工添加词）——
		// 照常消化聚合页，否则简介长尾词会滞留 pending（存量书种子均已 generated 实证此路径）。
		// Task 83: SkipBookSeeds——与认领查询之间的窗口期新登记种子不得被扫荡吞掉
		var anyPending int
		if e2 := queryOne(`SELECT COUNT(*) FROM "PseoKeyword" WHERE "status" = 'pending'`, []any{&anyPending}); e2 == nil && anyPending > 0 {
			if g, gerr := generatePendingPagesSkipBookSeeds(20); gerr == nil && g > 0 {
				log.Printf("[backend-go-pseo] 无书名种子待富集，直接消化 pending 词池 +%d 页", g)
			}
		}
		return
	}
	cfg, cerr := getPseoConfig()
	if cerr != nil {
		return
	}
	// ② 引擎取词并发（Task 59-R2 冷却中的重试种子跳过引擎，照常由收尾消化其他 pending 词）
	aggs := make([]suggestionsAggregate, len(claims))
	cooling := make([]bool, len(claims))
	coolingN := make([]int, len(claims))
	var wg sync.WaitGroup
	for i := range claims {
		if rn, rat := getEnrichRetry(claims[i].keyword); rn > 0 && rn <= enrichRetryMax && nowMillis()-rat < enrichRetryCooldown {
			cooling[i], coolingN[i] = true, rn
			continue
		}
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			aggs[i] = fetchSuggestionsMulti(claims[i].keyword, cfg.Sources, 8000)
		}(i)
	}
	wg.Wait()
	// ③ DB 收尾串行（单写者不变量）
	for i := range claims {
		finalizeBookSeedEnrich(claims[i].keyword, aggs[i], cooling[i], coolingN[i], cfg)
	}
}

// finalizeBookSeedEnrich 单种子 DB 收尾：冷却跳过/引擎全败有界重试/长尾入库/聚合页生成。
// 必须在单 goroutine 内串行调用（insertKeywords/generatePendingPages 非并发安全设计）。
func finalizeBookSeedEnrich(keyword string, agg suggestionsAggregate, cooling bool, coolingN int, cfg pseoRunnerConfig) {
	if cooling {
		if g, gerr := generatePendingPagesSkipBookSeeds(20); gerr == nil && g > 0 {
			log.Printf("[backend-go-pseo] 种子《%s》引擎全败冷却中（第%d/%d次），消化 pending 词池 +%d 页",
				truncateRunes(keyword, 30), coolingN, enrichRetryMax, g)
		}
		return
	}
	started := nowMillis()
	// 下拉词扩展（失败隔离：引擎全挂时 agg.Words 为空，书名词本身仍会生成聚合页）
	words := agg.Words
	if len(words) > cfg.PerSeedLimit {
		words = words[:cfg.PerSeedLimit]
	}
	// Task 59-R2: 引擎全败 → 有界重试（保留 pending + 排除本词生成，冷却后自动再富集）；
	// 连续失败达上限或引擎健康应答（含零建议）→ 清记账照常收敛
	if suggestEnginesAllFailed(agg) && len(words) == 0 {
		rn, _ := getEnrichRetry(keyword)
		rn++
		if rn <= enrichRetryMax {
			setEnrichRetry(keyword, rn, nowMillis())
			log.Printf("[backend-go-pseo] 种子《%s》引擎全败（第%d/%d次），保留 pending 冷却重试",
				truncateRunes(keyword, 30), rn, enrichRetryMax)
			// Task 83: SkipBookSeeds——同批/后续未富集种子行不得被扫荡吞掉
			if g, gerr := generatePendingPagesSkipBookSeeds(20); gerr == nil && g > 0 {
				log.Printf("[backend-go-pseo] 引擎全败期间消化其他 pending 词池 +%d 页", g)
			}
			return
		}
		clearEnrichRetry(keyword)
		log.Printf("[backend-go-pseo] 种子《%s》连续%d次引擎全败，放弃长尾重试（书名词页面照常生成）",
			truncateRunes(keyword, 30), enrichRetryMax)
	} else {
		clearEnrichRetry(keyword)
	}
	entries := []kwEntry{{Word: keyword, Engine: "book"}}
	entries = append(entries, words...)
	// Task 40: 血缘入库——seed=书名种子，书籍页按血缘直取本书的 pseo 下拉词
	added, ierr := insertKeywords(entries, cfg.MaxKeywords, keyword)
	if ierr != nil {
		log.Printf("[backend-go-pseo] 种子《%s》长尾词入库失败: %v", truncateRunes(keyword, 30), ierr)
	}
	// Task 83: 种子行必须由富集链路亲自置 generated（词池扫荡会吞掉未富集种子行，
	// 引擎下拉词永久丢失——「标签大多就2个」深层根因）；先种子行后词池（SkipBookSeeds）
	if _, gerr := generatePendingPagesBookSeed(keyword); gerr != nil {
		log.Printf("[backend-go-pseo] 种子《%s》聚合页生成失败: %v", truncateRunes(keyword, 30), gerr)
		return
	}
	generated, gerr := generatePendingPagesSkipBookSeeds(20)
	if gerr != nil {
		log.Printf("[backend-go-pseo] 种子《%s》词池消化失败: %v", truncateRunes(keyword, 30), gerr)
		return
	}
	log.Printf("[backend-go-pseo] 种子《%s》下拉词 +%d（耗时 %dms），本轮生成聚合页 %d 个",
		truncateRunes(keyword, 30), added, nowMillis()-started, generated)
}

// novelPseoTags 书籍页「相关标签」（前端渲染在简介下方，点击进入对应 PSEO 聚合页）：
//  1. 书名种子词（必有——聚合页按书名 LIKE 命中本书；未生成时 SSR 聚合页实时计算兜底）
//  2. 作者词（聚合页命中该作者全部作品；佚名不作为标签）
//  3. 搜索引擎下拉词（用户指令「书籍页标签加入搜索引擎下拉词，pseo 词的链接」；Task 40 强化
//     「加入 pseo 生成的相关下拉词」）双通道取词：
//     ① seed 血缘直取——本书种子富集产出的全部下拉词（enrichOneBookSeed 入库时 seed=书名），
//     不要求词面包含书名（相关推荐词也能上榜），仅取 generated（Task 47：pending/failed 词
//     不再上榜——聚合页对未生成词由 SSR 实时计算兜底渲染，但 chips 内链不得指向潜在 404）
//     ② kwNorm 归一形 LIKE 兜底——覆盖 seed 列引入前的存量词与跨来源含书名词；
//     全半角/空白/大小写形态差异不再漏配（书 293 实证：全角？书名 vs 半角?下拉词全量漏配）；
//     归一包含 ⊇ 严格子串包含，旧语义为严格超集，无需第三查询
//  4. 衍生词兜底（Task 83 用户指令「书籍页标签大多就2个」直修）：真实下拉词依赖书名种子
//     富集（后台队列 12s/批 4 种子），新入库书在血缘词落地前标签长期只有书名+作者两个。
//     以书名/作者为词根合成**空格分隔**搜索长尾（如「书名 小说」）：词面经 matchNovels /
//     pseoRealtimeNovels 的空格分词 LIKE 必然命中本书（Task 47 实时兜底渲染，零 404 契约
//     不破），无需登记词库（读路径零写放大）；血缘下拉词到位后被自然挤占退场（上限 14 不变）
//
// 总上限 14 个，衍生词兜底补齐至 8 个；返回 []（JSON 数组）而非 nil（null）。
// 纯 DB 查询（API 热路径），幂等零网络调用。
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
			`SELECT "keyword" FROM "PseoKeyword" WHERE "seed" = ? AND "status" = 'generated' AND "keyword" != ? AND "keyword" != ?
                          ORDER BY LENGTH("keyword") ASC, "id" ASC LIMIT 12`,
			scanAdd, kwTitle, kwTitle, kwAuthor)
		// ② kwNorm 归一形 LIKE 兜底：存量词 + 跨来源含书名词（归一形抹平标点/空白/大小写差异）
		_ = queryList(
			`SELECT "keyword" FROM "PseoKeyword" WHERE "status" = 'generated' AND "kwNorm" LIKE ? AND "keyword" != ? AND "keyword" != ?
                          ORDER BY ("source" = 'book') DESC, LENGTH("keyword") ASC, "id" ASC LIMIT 12`,
			scanAdd, likeWrap(kwNormalize(kwTitle)), kwTitle, kwAuthor)
	}
	// ③ 衍生词兜底（Task 83）：真实下拉词不足 8 个时以书名/作者词根合成空格分隔搜索长尾。
	// 词面分词后含完整书名/作者 → SSR 聚合页实时渲染（pseoRealtimeNovels LIKE 命中），
	// chips 内链零 404；真实下拉词随后台富集到位，本通道在 len(out)>=8 时自动退场
	if len(out) < 8 {
		if kwTitle != "" {
			for _, suf := range []string{"小说", "全文阅读", "最新章节", "在线阅读", "免费阅读"} {
				add(kwTitle + " " + suf)
				if len(out) >= 8 {
					break
				}
			}
		}
		if len(out) < 8 && kwAuthor != "" && kwAuthor != "佚名" {
			add(kwAuthor + " 小说")
		}
	}
	return out
}
