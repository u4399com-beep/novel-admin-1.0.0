/**
 * webi18n_prefetch.go —— R167 元数据级 LLM 翻译预热工作器（用户指令：翻译缓存的效率
 * 不能做到实时，有没有更快的解决办法能够做到实时程度；实在不行就落库吧）。
 *
 * 定位：R160 起的前台管线是「访问驱动渐进收敛」——首次访问显示原文、后台异步预热、
 * 下次访问命中。R164 sweep 把覆盖面做到「页面可见所有文字」，但 en/ja/ko 动态串
 * （书名/作者/简介/章题）首次仍需原文兜底——用户体感「不实时」。
 *
 * 本工作器把收敛从「访问后」提前到「访问前」：后台无限循环扫库，把页面可见动态串
 * 的有限闭集批量翻译落库（TranslationCache 持久层）——前台渲染时缓存全命中，
 * 毫秒级即实时显示。
 *
 * 预热面（与 R139 成本闸的边界）：
 *   P0 书名 + 作者（Novel.title/author）——首页/列表/书页/区块必显；
 *   P1 简介（Novel.description 全文）——书页/列表卡；
 *   P2 每书最新 1 章章题（Chapter 最新行）——列表页 LatestChapters/书页 meta。
 * 全库正文（1.4M 章 × LLM）仍维持 R139 判断绝不自动预热（成本爆炸器）——正文
 * 继续走章级访问驱动预热（i18nChapterParas/i18nAsyncWarm 既有管线）+ 目录页
 * sweep 渲染 miss 异步预热。元数据闭集（~1300 书 × 4 字段 × 3 语种）量级可控。
 *
 * 语种轮转：en → ja → ko（每轮单语种，配额三语种均分）。zh-Hant 走 OpenCC 本地
 * 词典转换，渲染路径即秒级实时，无需预热。
 *
 * 成本闸联动：
 *   - env I18N_PREFETCH_OFF=1 整体停用（应急杀开关，与 GEO_LANG_OFF 同域哲学）；
 *   - GEO_LANG_OFF=1 或默认站点 langMode=off（恒 zh-CN）→ 长睡巡检（外语渲染关停
 *     = 无预热需求，省配额；admin 改回 auto/force 后下一轮巡检自动恢复）。
 *
 * 自适应节流（429 配额友好；R168 libre 兜底升级）：
 *   - 本轮有译文产出 → 片间 2s + 轮间 3s（持续推进）；
 *   - 本轮零成功（429 枯竭期，服务端 ok:true 全空段形态）→ 不再干睡 90s——改走
 *     LibreTranslate 兜底引擎垫底落库（libre 前缀键，LLM 恢复后自动升级），
 *     libre 也不可用时维持 90s 等待配额窗口；
 *   - 上游网络错误 → 轮间 30s。
 * 游标到尾即回零循环巡检——采集新入库书（fleet runner 扩池）与 admin 改动的简介
 * 自然进入下一轮队列，无需事件通知。
 *
 * 观测：GET /api/translate/prefetch/status——运行态/游标/语种/累计段数/最近错误，
 * admin 与运维探针可直读。
 */
package main

import (
	"log"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

// 预热工作器运行态（status API 只读；worker 单 goroutine 写，原子性由互斥保证）
var (
	prefetchMu      sync.Mutex
	prefetchRunning bool
	prefetchCursor  int64  // Novel.id 游标（分页推进，尾部回零）
	prefetchLang    string // 当前轮语种
	prefetchStats   struct {
		batches         int64  // 累计上游批次数
		translated      int64  // 累计译文产出段数
		misses          int64  // 累计扫描到的未翻段数
		lastRunAt       string // 最近一轮完成时间（UTC）
		lastError       string // 最近一次上游错误（空=无）
		libreTranslated int64  // R168：libre 垘底产出段数（LLM 枯竭期兜底）
	}
)

// i18nPrefetchTargets 预热语种轮转序列（LLM 语种固定序；zh-Hant 不在列——OpenCC 实时）
var i18nPrefetchTargets = []string{"en", "ja", "ko"}

// i18nPrefetchClient 独立上游 client（120s——长简介串比章级 90s 更宽容；与渲染路径
// 150s 代理 client、章级 90s client 三方隔离，互不拖累）
var i18nPrefetchClient = &http.Client{Timeout: 120 * time.Second}

// startI18nPrefetchLoop 启动工作器（main.go 注册；I18N_PREFETCH_OFF=1 停用）
func startI18nPrefetchLoop() {
	if os.Getenv("I18N_PREFETCH_OFF") == "1" {
		log.Println("[prefetch] I18N_PREFETCH_OFF=1，元数据预热工作器停用")
		return
	}
	prefetchMu.Lock()
	prefetchRunning = true
	prefetchMu.Unlock()
	go func() {
		log.Println("[prefetch] 元数据级翻译预热工作器启动（P0 书名/作者 → P1 简介 → P2 最新章题；en/ja/ko 轮转）")
		langIdx := 0
		for {
			sleep := i18nPrefetchRound(&langIdx)
			time.Sleep(sleep)
		}
	}()
}

// i18nPrefetchRound 单轮预热：闸检查 → 游标分页扫书 → 收集含汉字动态串 → 缓存批查
// miss → 分片上游翻译 → 落库+LRU 回填。返回下一轮前休眠时长（自适应节流）。
func i18nPrefetchRound(langIdx *int) time.Duration {
	// 成本闸巡检：GEO_LANG_OFF 或 langMode=off（恒 zh-CN）→ 外语渲染关停，长睡等恢复
	if webLangGeoDisabled {
		return 10 * time.Minute
	}
	if st := loadWebSettings(); st != nil && webLangModeOf(st) == "off" {
		return 10 * time.Minute
	}
	lang := i18nPrefetchTargets[*langIdx%len(i18nPrefetchTargets)]
	*langIdx++
	prefetchMu.Lock()
	prefetchLang = lang
	cur := prefetchCursor
	prefetchMu.Unlock()

	// 游标分页扫书（24 本/轮）+ 每书最新 1 章题——WHERE id > 游标推进（游标无效化会
	// 恒扫同批书，预热永远不越出头部）
	novels, _ := queryNovelList(` WHERE n."id" > ?`, ` ORDER BY n."id" ASC`, []any{cur}, 24, 0)
	var bookIDs []int64
	type scanRow struct {
		id                            int64
		title, author, desc, latestCh string
	}
	rows := make([]scanRow, 0, len(novels))
	var maxID int64
	for _, m := range novels {
		id, _ := m["id"].(int64)
		if id == 0 {
			if v, ok := m["id"].(int); ok {
				id = int64(v)
			}
		}
		if id <= 0 {
			continue
		}
		bookIDs = append(bookIDs, id)
		if id > maxID {
			maxID = id
		}
		t, _ := m["title"].(string)
		a, _ := m["author"].(string)
		d, _ := m["description"].(string)
		var lc string
		_ = queryOne(`SELECT "title" FROM "Chapter" WHERE "novelId" = ? ORDER BY "idx" DESC LIMIT 1`, []any{&lc}, id)
		rows = append(rows, scanRow{id: id, title: t, author: a, desc: d, latestCh: lc})
	}

	// 收集含汉字动态串（去重；空串/非汉字跳过——纯数字/英文串无需翻译）
	seen := map[string]bool{}
	texts := make([]string, 0, len(rows)*4)
	addText := func(s string) {
		s = strings.TrimSpace(s)
		if s == "" || len([]rune(s)) < 2 || seen[s] || !sweepHasHan(s) {
			return
		}
		seen[s] = true
		texts = append(texts, s)
	}
	for _, r := range rows {
		addText(r.title)
		addText(r.author)
		addText(r.desc)
		addText(r.latestCh)
	}

	// 游标推进（本轮无书=游标回零循环巡检）
	prefetchMu.Lock()
	if maxID > 0 && len(rows) == 24 {
		prefetchCursor = maxID
	} else {
		prefetchCursor = 0
	}
	prefetchMu.Unlock()

	if len(texts) == 0 {
		return 3 * time.Second
	}

	// 缓存批查 miss（全文寻址键；worker 产出直接落持久层，访问时数据面/sweep 双消费面命中）
	keys := make([]string, len(texts))
	for i, t := range texts {
		keys[i] = translateCacheKey(t, lang)
	}
	cached := translateCacheGet(keys)
	miss := make([]string, 0, len(texts))
	for i, t := range texts {
		if c, ok := cached[keys[i]]; !ok || c == "" {
			miss = append(miss, t)
		}
	}
	// R167: 短串优先——书名/作者/章题（≤60 rune）是首页/列表每页必显的最高频可见面，
	// 配额窗口内优先吃下（全库短串覆盖后，列表页即全译文实时）；简介全文长串尾置
	// 跟进（书页可见面，第二优先级）。稳定排序保证同类内保持扫描序。
	sort.SliceStable(miss, func(i, j int) bool {
		return len([]rune(miss[i])) < len([]rune(miss[j]))
	})
	prefetchMu.Lock()
	prefetchStats.misses += int64(len(miss))
	prefetchMu.Unlock()
	if len(miss) == 0 {
		return 3 * time.Second // 本批全命中——推进游标继续扫
	}

	// 分片上游翻译（32 段/片复用 i18nWarmChunk 参数；片间 2s 节流）
	produced := int64(0)
	batches := 0
	networkErr := ""
	for start := 0; start < len(miss); start += i18nWarmChunk {
		end := start + i18nWarmChunk
		if end > len(miss) {
			end = len(miss)
		}
		batch := miss[start:end]
		orig := translateUpstreamClient
		translateUpstreamClient = i18nPrefetchClient
		// R169：engine=llm 显式专属 + deadlineMs=60000 钳制——修复枯竭期死锁
		//（原 auto 形态服务端 LLM 死线 130s>客户端 120s：请求必超时阵亡，ok 全空段
		// 形态永不可达，libre 垫底分支饿死）。llm 专属同时杜绝服务端 auto 混流把
		// libre 译文混入普通键固化；60s 内 429 退避梯（2s/6s/15s/30s）仍公平尝试。
		res, err := translateUpstreamEngine(lang, batch, nil, "llm", 60000)
		translateUpstreamClient = orig
		batches++
		if err != nil {
			networkErr = err.Error()
			break // 止损：已成功片已落缓存，下轮游标继续
		}
		pkeys := make([]string, len(batch))
		missIdx := make([]int, 0, len(batch))
		short := map[string]string{}
		for i, t := range batch {
			pkeys[i] = translateCacheKey(t, lang)
			if i < len(res) && res[i] != "" {
				missIdx = append(missIdx, i)
				produced++
				if len([]rune(t)) <= 120 {
					short[t] = res[i]
				}
			}
		}
		if len(missIdx) > 0 {
			translateCachePut(batch, pkeys, res, missIdx, 0)
			if len(short) > 0 {
				i18nShortOverwrite(lang, short)
			}
		}
		if end < len(miss) {
			time.Sleep(2 * time.Second)
		}
	}

	prefetchMu.Lock()
	prefetchStats.batches += int64(batches)
	prefetchStats.translated += produced
	prefetchStats.lastRunAt = time.Now().UTC().Format("2006-01-02T15:04:05Z")
	prefetchStats.lastError = networkErr
	prefetchMu.Unlock()

	// 自适应节流：有产出持续推进；429 枯竭期（零产出+服务端 ok 全空段）不再干睡——
	// R168：改走 libre 兜底垫底落库（0.6s/段无限量），libre 也不可用时维持 90s 长睡；
	// 网络错误 30s 重试
	if produced > 0 {
		return 3 * time.Second
	}
	// R169：libre 垡底零门槛前置——零产出三形态（服务端 ok 全空段/客户端超时
	// networkErr/上游网络错）一律先试 libre（:5000 本地独立引擎，LLM 通道异常不代表
	// libre 不可用）。修复 networkErr 提前 return 饿死垫底的 R168 缺陷（枯竭期
	// 超时即常态形态，垫底分支永不可达=libreTranslated 恒 0）。
	libreProduced := i18nPrefetchLibreFallback(lang, miss)
	prefetchMu.Lock()
	prefetchStats.libreTranslated += libreProduced
	prefetchMu.Unlock()
	if libreProduced > 0 {
		return 3 * time.Second // libre 无配额限制，继续推进
	}
	if networkErr != "" {
		return 30 * time.Second // LLM+libre 双通道皆败：30s 后重试（网络抖动）
	}
	return 90 * time.Second
}

// i18nPrefetchLibreFallback R168：LLM 枯竭期（429 窗口）libre 兜底——miss 段经
// translate-service engine=libre 批量翻译（Argos/ctranslate2 CPU 推理，0.6s/段无限量），
// 成功段落 libre 前缀键落库（不落普通键不覆盖 short LRU——LLM 恢复后预热器照常
// 翻译落库自动升级）。已垫底段先过滤（防 LLM 枯竭期每轮重复翻译空转 CPU）。
func i18nPrefetchLibreFallback(lang string, miss []string) int64 {
	if len(miss) == 0 {
		return 0
	}
	// 过滤已 libre 垫底段（libre 键命中=已垫底，跳过）
	lkeys := make([]string, len(miss))
	for i, t := range miss {
		lkeys[i] = translateCacheKeyLibre(t, lang)
	}
	lmap := translateCacheGet(lkeys)
	todo := make([]string, 0, len(miss))
	for i, t := range miss {
		if c, ok := lmap[lkeys[i]]; !ok || c == "" {
			todo = append(todo, t)
		}
	}
	if len(todo) == 0 {
		return 0
	}

	produced := int64(0)
	for start := 0; start < len(todo); start += i18nWarmChunk {
		end := start + i18nWarmChunk
		if end > len(todo) {
			end = len(todo)
		}
		batch := todo[start:end]
		orig := translateUpstreamClient
		translateUpstreamClient = i18nPrefetchClient
		res, err := translateUpstreamEngine(lang, batch, nil, "libre", 0)
		translateUpstreamClient = orig
		if err != nil {
			log.Printf("[prefetch] libre fallback FAIL: %v", err)
			break // libre 也不可用（未部署/熔断）：止损等下轮
		}
		keys := make([]string, len(batch))
		idx := make([]int, 0, len(batch))
		for i, t := range batch {
			keys[i] = translateCacheKeyLibre(t, lang)
			if i < len(res) && res[i] != "" {
				idx = append(idx, i)
				produced++
			}
		}
		if len(idx) > 0 {
			translateCachePut(batch, keys, res, idx, 0)
		}
		if end < len(todo) {
			time.Sleep(2 * time.Second)
		}
	}
	return produced
}

// handleTranslatePrefetchStatus GET /api/translate/prefetch/status——工作器观测面
// （admin/运维探针直读；无写面，匿名可读同 /api/health 语义）
func handleTranslatePrefetchStatus(w http.ResponseWriter, r *http.Request, ps map[string]string) {
	prefetchMu.Lock()
	defer prefetchMu.Unlock()
	writeJSON(w, 200, map[string]any{
		"running": prefetchRunning,
		"cursor":  prefetchCursor,
		"lang":    prefetchLang,
		"targets": i18nPrefetchTargets,
		"stats": map[string]any{
			"batches":         prefetchStats.batches,
			"translated":      prefetchStats.translated,
			"misses":          prefetchStats.misses,
			"lastRunAt":       prefetchStats.lastRunAt,
			"lastError":       prefetchStats.lastError,
			"libreTranslated": prefetchStats.libreTranslated, // R168
		},
	})
}
