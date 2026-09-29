/**
 * worker_smart_test.go —— Task 33 回归锁定：
 * 1) isRateLimitErrText/isSoftBlockErrText 失败形态判定表（六站实采真实文案样本，
 *    防关键词缺口复发——23qb 熔断时活跃车道 12 的事故根因）；
 * 2) laneFloorStore/laneFloorLoad 跨 resume 车道降档记忆（只降不升 + 并发安全）；
 * 3) smartCompleteStatus 智能完结补强（末章标题命中完结词 serial→finished；
 *    负向词先行：连载中/未完 不动）；
 * 4) TestEngineErrorFormTransientMatrix（Task 57-b）：引擎现行错误形态全量清单
 *    → isTransientScrapeErr 覆盖矩阵（逐形态对照 ../scraper-go 生产构造点，
 *    只读跨辖区核对；瞬态必须 paused、结构性失败必须 failed）。
 * 复用 recover_test.go 的 TestMain 临时库（绝不触碰生产库）。
 */
package main

import (
	"sync"
	"testing"
)

func TestIsRateLimitErrText(t *testing.T) {
	cases := []struct {
		name string
		err  string
		want bool
	}{
		{"空串", "", false},
		{"显式429", "HTTP 429 Too Many Requests", true},
		{"显式503", "503 Service Unavailable", true},
		{"中文限流", "主机最近被限流（429/503）", true},
		{"英文rate", "rate limited by upstream", true},
		// Task 33 六站实采新增形态（旧词表全部漏判 → 车道降档永不触发）
		{"限速排队", "fetch-ua-rotate: budget-exhausted（限速排队后预算耗尽）", true},
		{"预算耗尽", "限速排队后预算耗尽", true},
		{"budget-exhausted", "fetch-ua-rotate: budget-exhausted", true},
		{"引擎熔断中", "目标主机熔断中（近期连续整链失败，暂停请求以防刺激反爬/空耗预算）", true},
		{"整链失败", "主机 www.23qb.net 连续整链失败已达熔断阈值", true},
		// Task 35-b: 引擎整链失败的另一顶层文案（huangjinwu/xinjianpan 实测，
		// 旧词表永不命中 → 列表阶段误判 failed 终态而非可自动恢复的 paused）
		{"全部可用策略", "列表页抓取失败(https://www.huangjinwu.org/): 全部可用策略均抓取失败（fetch-browser/chrome-desktop: timeout; fetch-ua-rotate/firefox-desktop: timeout）", true},
		// 不误伤：timeout-budget 可能是慢站；普通网络错误；无关文案
		{"timeout-budget不算", "fetch-browser/chrome-desktop: timeout-budget", false},
		{"普通超时", "context deadline exceeded", false},
		{"普通404", "HTTP 404 Not Found", false},
		{"选择器失效", "正文提取为空", false},
		// Task 36-a: 误伤面收窄回归锁定——rate 裸子串会命中无关英文词，
		// 429/503 裸子串会命中内嵌数字；硬化后全部不命中，真实限流文案不受影响
		{"generate不误伤", "failed to generate chapter list", false},
		{"operate不误伤", "failed to operate on closed file", false},
		{"moderate不误伤", "moderate rate of requests", true}, // 含独立 rate 词元仍命中
		{"separate不误伤", "separate profiles", false},
		{"accurate不误伤", "timestamp not accurate", false},
		{"内嵌数字429不误伤", "第1429章抓取失败", false},
		{"内嵌数字503不误伤", "HTTP 1503 moved", false},
		{"显式429仍命中", "HTTP 429", true},
		{"retry-after仍命中", "HTTP 429 已按站点 Retry-After=5s 退避", true},
		// Task 57-b: 引擎现行 502 合并形态（error（detail）拼接后逐词核对）
		{"整链失败·挑战页形态", "全部可用策略均抓取失败（fetch-browser/chrome-desktop: challenge-page，最后备注: challenge-page；检测到疑似挑战页，目标站可能有反爬防护）", true},
		{"整链失败·排队饱和形态", "全部可用策略均抓取失败（got-scraping: budget-exhausted（限速排队饱和，未预约槽位快速失败，backend 请降并发））", true},
		{"整链失败·网络错误形态", "全部可用策略均抓取失败（fetch-browser: network-error，最后备注: network-error）", true},
		// Task 57-b: 结构性失败负例（failed 终态为正确语义，不得误判瞬态转 paused）
		{"SSRF拦截负例", "SSRF 防护拦截（域名 internal.example 解析到内网地址（DNS 层 SSRF 防护））", false},
		{"URL无法解析负例", "URL 无法解析（https://bad host/book.html）", false},
		{"参数错误负例", "参数错误（未知策略 \"nope\"（可选: fetch-browser, got-scraping, curl-impersonate, fetch-curl, browser））", false},
		{"服务器内部错误负例", "服务器内部错误（HTML 解析失败）", false},
	}
	for _, c := range cases {
		if got := isRateLimitErrText(c.err); got != c.want {
			t.Errorf("%s: isRateLimitErrText(%q) = %v, want %v", c.name, c.err, got, c.want)
		}
	}
}

func TestIsSoftBlockErrText(t *testing.T) {
	cases := []struct {
		name string
		err  string
		want bool
	}{
		{"空串", "", false},
		{"挑战页", "challenge loop detected", true},
		{"中文挑战", "JS token 重定向挑战页已跟随", true},
		{"200空壳", "章节正文为空（HTTP 200 空壳响应，疑似限流软拦截/挑战竞态）", true},
		{"正文为空", "正文为空", true},
		{"正文提取为空", "正文提取为空", true},
		// Task 57-b: 引擎现行挑战形态逐词锁定（attempts note 进 detail 的实际字符串）
		{"challenge-page备注", "fetch-browser/chrome-desktop: challenge-page", true},
		{"challenge-loop备注", "challenge-loop：JS token 跳转跟随后仍为挑战页，判定挑战循环终止", true},
		{"疑似挑战页后缀", "；检测到疑似挑战页，目标站可能有反爬防护", true},
		{"502合并形态", "全部可用策略均抓取失败（fetch-browser: challenge-page；检测到疑似挑战页，目标站可能有反爬防护）", true},
		// Task 57-b: 非软拦截负例（网络层/预算类备注不得误入软拦截桶）
		{"network-error备注不误判", "fetch-ua-rotate: network-error，最后备注: network-error", false},
		{"too-large备注不误判", "curl-impersonate/chrome131: too-large", false},
		{"HTTP403不误判", "got-scraping: HTTP 403", false},
		{"引擎不可达不算软拦截", "采集引擎不可达(3030)", false},
		{"显式429不算软拦截", "HTTP 429", false},
		{"普通错误", "connection reset", false},
	}
	for _, c := range cases {
		if got := isSoftBlockErrText(c.err); got != c.want {
			t.Errorf("%s: isSoftBlockErrText(%q) = %v, want %v", c.name, c.err, got, c.want)
		}
	}
}

func TestLaneFloorMonotonic(t *testing.T) {
	id := 990_001
	t.Cleanup(func() { gLaneFloor.Delete(id) })
	if got := laneFloorLoad(id); got != 0 {
		t.Fatalf("无记忆应得 0，got %d", got)
	}
	laneFloorStore(id, 4)
	if got := laneFloorLoad(id); got != 4 {
		t.Fatalf("首次记录应得 4，got %d", got)
	}
	laneFloorStore(id, 8) // 更宽 → 拒绝（只降不升）
	if got := laneFloorLoad(id); got != 4 {
		t.Fatalf("只降不升应保持 4，got %d", got)
	}
	laneFloorStore(id, 2) // 更窄 → 采纳
	if got := laneFloorLoad(id); got != 2 {
		t.Fatalf("更窄应采纳 2，got %d", got)
	}
	laneFloorStore(id, 0) // 非法值忽略
	if got := laneFloorLoad(id); got != 2 {
		t.Fatalf("非法值应忽略保持 2，got %d", got)
	}
}

func TestLaneFloorConcurrent(t *testing.T) {
	id := 990_002
	t.Cleanup(func() { gLaneFloor.Delete(id) })
	var wg sync.WaitGroup
	for i := 1; i <= 8; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			laneFloorStore(id, n)
			_ = laneFloorLoad(id)
		}(i)
	}
	wg.Wait()
	got := laneFloorLoad(id)
	if got != 1 { // 全部并发写的历史最小值
		t.Fatalf("并发写后应得最小值 1，got %d", got)
	}
}

func mustInitSmartStatusTables(t *testing.T) {
	t.Helper()
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS "Novel" (
                "id" INTEGER PRIMARY KEY AUTOINCREMENT,
                "title" TEXT NOT NULL,
                "description" TEXT NOT NULL DEFAULT '',
                "status" TEXT NOT NULL DEFAULT 'serial',
                "updatedAt" INTEGER NOT NULL DEFAULT 0
        )`); err != nil {
		t.Fatalf("create Novel: %v", err)
	}
	// 兼容先跑的窄表测试（api_chapters_audit_test 建的 Novel 无 description/status 列）：
	// CREATE IF NOT EXISTS 是 no-op，INSERT 会因缺列失败——防御性 ALTER 补列（重复加列报错忽略）
	for _, col := range []string{`ALTER TABLE "Novel" ADD COLUMN "description" TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE "Novel" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'serial'`} {
		_, _ = db.Exec(col)
	}
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS "Chapter" (
                "id" INTEGER PRIMARY KEY AUTOINCREMENT,
                "novelId" INTEGER NOT NULL REFERENCES "Novel"("id") ON DELETE CASCADE,
                "idx" INTEGER NOT NULL,
                "title" TEXT NOT NULL DEFAULT '',
                "content" TEXT NOT NULL DEFAULT '',
                "wordCount" INTEGER NOT NULL DEFAULT 0,
                "createdAt" INTEGER NOT NULL DEFAULT 0,
                UNIQUE("novelId","idx")
        )`); err != nil {
		t.Fatalf("create Chapter: %v", err)
	}
	t.Cleanup(func() {
		_, _ = db.Exec(`DELETE FROM "Chapter"`)
		_, _ = db.Exec(`DELETE FROM "Novel"`)
	})
}

func insertSmartNovel(t *testing.T, id int, title, desc, status string) {
	t.Helper()
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	// 基础 schema 下 Novel.categoryId NOT NULL+FK：幂等建分类行
	if _, err := db.Exec(`INSERT OR IGNORE INTO "Category" ("id","name") VALUES (9010,'智能补全测试分类')`); err != nil {
		t.Fatalf("insert category: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO "Novel" ("id","title","author","categoryId","description","status","updatedAt") VALUES (?,?,?,?,?,?,?)`,
		id, title, "测试作者", 9010, desc, status, nowMillis()); err != nil {
		t.Fatalf("insert novel %d: %v", id, err)
	}
}

func insertSmartChapter(t *testing.T, novelID int, idx int, title string) {
	t.Helper()
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO "Chapter" ("novelId","idx","title","wordCount","createdAt") VALUES (?,?,?,?,?)`,
		novelID, idx, title, 10, nowMillis()); err != nil {
		t.Fatalf("insert chapter: %v", err)
	}
}

func novelStatusOf(t *testing.T, id int) string {
	t.Helper()
	var status string
	if err := queryOne(`SELECT "status" FROM "Novel" WHERE "id" = ?`, []any{&status}, id); err != nil {
		t.Fatalf("query status: %v", err)
	}
	return status
}

func TestSmartCompleteStatus(t *testing.T) {
	mustInitSmartStatusTables(t)
	// 1. 末章「大结局」且简介无负向词 → finished
	insertSmartNovel(t, 101, "升级书A", "主角一路升级最终无敌。", "serial")
	insertSmartChapter(t, 101, 1, "第1章 起点")
	insertSmartChapter(t, 101, 2, "第2章 决战")
	insertSmartChapter(t, 101, 3, "大结局（全书完）")
	// 2. 末章「大结局」但简介含「连载中」→ 不动（负向词先行）
	insertSmartNovel(t, 102, "连载书B", "新书连载中，日更六千。", "serial")
	insertSmartChapter(t, 102, 1, "第1章 开局")
	insertSmartChapter(t, 102, 2, "大结局暂定卷末")
	// 3. 末章「第199章 大结局？不，新的开始」标题本身含完结词但无负向词 → 按设计升级
	//    （novelStatusOngoingRE 不含问号语境；可接受 trade-off，宁纠偏勿漏标）
	// 4. 末章普通标题 → 不动
	insertSmartNovel(t, 104, "普通书D", "一个普通的故事。", "serial")
	insertSmartChapter(t, 104, 1, "第1章 开始")
	// 5. 已是 finished → 不动（单向升级）
	insertSmartNovel(t, 105, "完结书E", "已完结老书。", "finished")
	insertSmartChapter(t, 105, 1, "完本感言")

	smartCompleteStatus([]int{101, 102, 104, 105})

	if got := novelStatusOf(t, 101); got != "finished" {
		t.Errorf("书101 末章大结局应升级 finished，got %s", got)
	}
	if got := novelStatusOf(t, 102); got != "serial" {
		t.Errorf("书102 简介含连载中应保持 serial，got %s", got)
	}
	if got := novelStatusOf(t, 104); got != "serial" {
		t.Errorf("书104 普通末章应保持 serial，got %s", got)
	}
	if got := novelStatusOf(t, 105); got != "finished" {
		t.Errorf("书105 本就 finished 不应变化，got %s", got)
	}
}

// TestEngineErrorFormTransientMatrix（Task 57-b 引擎消费面专项）——引擎现行错误
// 形态全量清单 → isTransientScrapeErr 覆盖矩阵。逐形态对照 ../scraper-go 生产
// 构造点（只读跨辖区核对，构造点以行内注释标注）：
//
//	顶层 502：chain.go pageFailureResponse（error=「全部可用策略均抓取失败」/
//	          「目标主机熔断中」/「URL 无法解析」/「SSRF 防护拦截」，detail=
//	          attempts note 串，backend callEngine 拼接为 error（detail））
//	4xx/5xx：handlers.go failJSON（参数错误/服务器内部错误）+ main.go（Not Found）
//	本地：   engineclient.go callEngine 四出口（不可达/超时/解析失败/缺 data）
//
// 契约：瞬态形态（限流/软拦截/熔断/引擎自状态）必须命中（paused 自动恢复资格），
// 结构性失败（参数/SSRF/规则失效/引擎 bug）必须不命中（failed 终态，自动恢复不空转）。
// 已核对的引擎现行形态之外无遗漏：network-error/too-large/timeout-budget 等仅作为
// attempts note 出现在 detail 中，顶层「全部可用策略均抓取失败」恒在场（chain.go:527
// 唯一 errMsg 构造点），瞬态判定不依赖 detail 词；callEngine 对 detail 200 rune 截断
// 只影响失败形态统计分桶（failSoftBlock vs failOther），不影响状态机判定。
// 已知设计内误伤面（概率判定语义，Task 33 注释载明）：「URL 无法解析」的 detail 若
// 恰含 429/503 词元会被误判瞬态——backend parseHttpURL 先行校验（http/https+host+
// 端口）使该形态对任务 URL 实际不可达，四字样均不在本矩阵锁定范围。
func TestEngineErrorFormTransientMatrix(t *testing.T) {
	cases := []struct {
		name string
		err  string
		want bool // true=瞬态（paused 自动恢复）；false=结构性（failed 终态）
	}{
		// ---- 瞬态（必须命中）----
		{"502整链失败·挑战备注", "全部可用策略均抓取失败（fetch-browser/chrome-desktop: challenge-page; got-scraping: challenge-loop，最后备注: challenge-loop；检测到疑似挑战页，目标站可能有反爬防护）", true},
		{"502整链失败·预算耗尽备注", "全部可用策略均抓取失败（fetch-ua-rotate/firefox-desktop: budget-exhausted（限速排队后预算耗尽））", true},
		{"502整链失败·网络错误备注", "全部可用策略均抓取失败（fetch-browser: network-error，最后备注: network-error）", true},
		{"502整链失败·限流记忆 memo", "全部可用策略均抓取失败 (host 近期限流记忆: 429 2次/503 1次)（fetch-browser: HTTP 429）", true},
		{"502目标主机熔断中", "目标主机熔断中（近期连续整链失败，暂停请求以防刺激反爬/空耗预算）（主机 www.example.net 连续整链失败已达熔断阈值，剩余冷却 58s 后自动恢复尝试（一次成功即复位））", true},
		{"callEngine不可达", "采集引擎不可达(3030)", true},
		{"callEngine超时", "引擎请求超时(60s)", true},
		{"softBlock200空壳", softBlockEmptyErrText, true},
		{"章节200空壳本地文案", "章节正文为空（HTTP 200 空壳响应，疑似限流软拦截/挑战竞态）", true},
		// ---- 结构性（必须不命中）----
		{"502 URL无法解析", "URL 无法解析（https://bad host/book.html）", false},
		{"502 SSRF防护拦截", "SSRF 防护拦截（域名 internal.example 解析到内网地址（DNS 层 SSRF 防护））", false},
		{"400参数错误", "参数错误（未知策略 \"nope\"（可选: fetch-browser, got-scraping, curl-impersonate, fetch-curl, browser））", false},
		{"400请求体错误", "请求体错误（请求体必须是 JSON 对象，形如 { url, rule: { listRule?, bookRule?, chapterRule? }, strategy?, charset?, timeoutMs? }）", false},
		{"500服务器内部错误", "服务器内部错误（HTML 解析失败）", false},
		{"404未知路由", "Not Found（未知路由 POST /api/unknown。可用: GET /api/strategies, GET /api/health, GET /api/host-health, POST /api/test, POST /api/chapter）", false},
		{"规则失效书页", "未提取到书籍标题（规则与内置回退均未命中）", false},
		{"引擎响应解析失败（留档：现行为 failed；引擎重启主形态=连接拒绝，命中不可达瞬态）", "引擎响应解析失败(HTTP 502)", false},
		{"引擎响应缺少 data 字段（留档同上）", "引擎响应缺少 data 字段(HTTP 200)", false},
	}
	for _, c := range cases {
		if got := isTransientScrapeErr(c.err); got != c.want {
			t.Errorf("%s: isTransientScrapeErr(%q) = %v, want %v", c.name, c.err, got, c.want)
		}
	}
}
