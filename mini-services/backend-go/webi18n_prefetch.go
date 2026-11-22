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
 * 自适应节流（429 配额友好）：
 *   - 本轮有译文产出 → 片间 2s + 轮间 3s（持续推进）；
 *   - 本轮零成功（429 枯竭期，服务端 ok:true 全空段形态）→ 轮间 90s 等待配额窗口；
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
		batches    int64  // 累计上游批次数
		translated int64  // 累计译文产出段数
		misses     int64  // 累计扫描到的未翻段数
		lastRunAt  string // 最近一轮完成时间（UTC）
		lastError  string // 最近一次上游错误（空=无）
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
		res, err := translateUpstream(lang, batch, nil)
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

	// 自适应节流：有产出持续推进；429 枯竭期（零产出+服务端 ok 全空段）长睡等窗口；
	// 网络错误 30s 重试
	if produced > 0 {
		return 3 * time.Second
	}
	if networkErr != "" {
		return 30 * time.Second
	}
	return 90 * time.Second
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
			"batches":    prefetchStats.batches,
			"translated": prefetchStats.translated,
			"misses":     prefetchStats.misses,
			"lastRunAt":  prefetchStats.lastRunAt,
			"lastError":  prefetchStats.lastError,
		},
	})
}
