/**
 * translatewarm.go —— 翻译预热工作协程（R139，用户指令：翻译功能放到后台采集期，
 * 前台转换太费事）。
 *
 * 架构（采集期预生成，读者侧零等待）：
 *   入队钩子：persistChapterFill 正文落库成功后 → translateEnqueueChapter（同事务外
 *   best-effort 单条 INSERT OR REPLACE，失败不影响采集状态机）。
 *   消费协程：startTranslateWarmLoop（main.go 注册，TRANSLATEWARM_OFF=1 停用）——
 *   每 2s 取一批 pending（LIMIT 6 章），逐章：
 *     1) 三级回落读正文 → \n split 同渲染层口径切段（<2 字跳过）
 *     2) 全文寻址键批量查 TranslationCache 已覆盖段 → 全覆盖直接 done（零上游）
 *     3) 未命中段 translateUpstream（zh-Hant→OpenCC 词典转换秒级零成本）
 *        → translateCachePut 回写（novelId 归属已由 api_translate 反查链保证此处直传）
 *     4) 成功 done / 失败 attempts++ 重排队（≤3 次，超限 failed 留痕管理面可见）
 *
 * 语种策略（成本闸）：仅 OpenCC 语种自动预热（TRANSLATE_WARM_TARGETS env 可覆盖，
 * 默认 zh-Hant,zh-HK）；LLM 语种（en/ja/ko）绝不自动入队——1.4M 章 × LLM 是成本
 * 爆炸器，保持读者按需翻译+持久缓存复用；admin 翻译缓存页提供按书手动预热入口。
 *
 * 吞吐预算：单章 1 次 upstream 调用（≤300 段上限内）≈ 百毫秒级（OpenCC）；批 6 章/
 * 轮、2s/轮 → 峰值 ~3 章/s，采集入库速率（实测 <1 章/s）不会被队列积压淹没。
 */
package main

import (
	"database/sql"
	"log"
	"os"
	"strings"
	"sync"
	"time"
)

// translateWarmTargets 自动预热语种（env TRANSLATE_WARM_TARGETS 覆盖，逗号分隔；
// 仅接受 OpenCC 语种——LLM 语种在启动时被过滤，防误配成本爆炸）
var translateWarmTargets = sync.OnceValue(func() []string {
	raw := strings.TrimSpace(os.Getenv("TRANSLATE_WARM_TARGETS"))
	if raw == "" {
		raw = "zh-Hant,zh-HK"
	}
	out := []string{}
	for _, t := range strings.Split(raw, ",") {
		t = strings.TrimSpace(t)
		if t == "" || !translateTargets[t] {
			continue
		}
		if t != "zh-Hant" && t != "zh-HK" {
			log.Printf("[translate-warm] 目标 %q 非 OpenCC 语种，拒绝自动预热（成本闸）", t)
			continue
		}
		out = append(out, t)
	}
	return out
})

// translateEnqueueChapter 采集钩子（persistChapterFill 调用）：best-effort 入队，
// 失败静默（翻译缺失可由读者按需兜底，绝不反噬采集状态机）。
func translateEnqueueChapter(novelID, chRowID int64) {
	targets := translateWarmTargets()
	if len(targets) == 0 || chRowID <= 0 {
		return
	}
	now := nowMillis()
	for _, t := range targets {
		_, _ = execRetry(
			`INSERT OR REPLACE INTO "TranslationQueue" ("novelId","chapterId","target","state","attempts","updatedAt")
                         VALUES (?,?,?,'pending',0,?)`,
			novelID, chRowID, t, now)
	}
}

// startTranslateWarmLoop 翻译预热消费协程（main.go 注册；TRANSLATEWARM_OFF=1 停用）
func startTranslateWarmLoop() {
	if os.Getenv("TRANSLATEWARM_OFF") == "1" {
		log.Println("[translate-warm] TRANSLATEWARM_OFF=1，停用")
		return
	}
	targets := translateWarmTargets()
	if len(targets) == 0 {
		log.Println("[translate-warm] 无可用预热语种（TRANSLATE_WARM_TARGETS 配置为空/全被拒），停用")
		return
	}
	log.Printf("[translate-warm] 启动 targets=%v", targets)
	// 启动即先跑一轮（启动积压快速消化），随后 2s 轮询
	for {
		translateWarmOnce(targets)
		time.Sleep(2 * time.Second)
	}
}

// translateWarmOnce 单轮消费：取 pending 批（重试退避：attempts>0 的行 60s 内跳过）
func translateWarmOnce(targets []string) {
	rows := []struct {
		id, novelID, chID int64
		target            string
	}{}
	err := queryList(
		`SELECT "id","novelId","chapterId","target" FROM "TranslationQueue"
                 WHERE "state"='pending' AND "updatedAt" <= ?
                 ORDER BY "id" ASC LIMIT 6`,
		func(rs *sql.Rows) error {
			var r struct {
				id, novelID, chID int64
				target            string
			}
			if err := rs.Scan(&r.id, &r.novelID, &r.chID, &r.target); err == nil {
				rows = append(rows, r)
			}
			return nil
		}, nowMillis())
	if err != nil || len(rows) == 0 {
		return
	}
	for _, r := range rows {
		translateWarmChapter(r.id, r.novelID, r.chID, r.target)
	}
}

// translateWarmChapter 单章预热：读正文 → 切段 → 覆盖检查 → 上游补缺 → 回写 → 状态机
func translateWarmChapter(qid, novelID, chID int64, target string) {
	fail := func(reason string) {
		// 重试退避：updatedAt 推 60s；3 次超限转 failed（管理面可见，不再自动消费）
		var attempts int64
		_ = queryOne(`SELECT "attempts" FROM "TranslationQueue" WHERE "id"=?`, []any{&attempts}, qid)
		attempts++
		state := "pending"
		if attempts >= 3 {
			state = "failed"
		}
		_, _ = execRetry(`UPDATE "TranslationQueue" SET "state"=?, "attempts"=?, "updatedAt"=? WHERE "id"=?`,
			state, attempts, nowMillis()+(60*1000), qid)
		log.Printf("[translate-warm] ch=%d target=%s FAIL(%s) attempts=%d", chID, target, reason, attempts)
	}

	var novelIDDB int64
	var content string
	// 正文三级回落：Chapter.content 存量列（worker 链路正文在分表，legacy 列兜底旧数据）
	if err := queryOne(
		`SELECT c."novelId", COALESCE(cc."content", c."content", '')
                 FROM "Chapter" c LEFT JOIN "ChapterContent" cc ON cc."chapterId" = c."id"
                 WHERE c."id" = ?`,
		[]any{&novelIDDB, &content}, chID); err != nil {
		fail("chapter missing")
		return
	}
	if novelID <= 0 {
		novelID = novelIDDB
	}
	if strings.TrimSpace(content) == "" {
		// 空章（骨架/采集中）：done 直接过（无翻译面；重采改文会重新入队）
		_, _ = execRetry(`UPDATE "TranslationQueue" SET "state"='done', "updatedAt"=? WHERE "id"=?`, nowMillis(), qid)
		return
	}
	paras := []string{}
	for _, p := range strings.Split(content, "\n") {
		p = strings.TrimSpace(p)
		if len([]rune(p)) >= 2 {
			paras = append(paras, p)
		}
	}
	if len(paras) == 0 {
		_, _ = execRetry(`UPDATE "TranslationQueue" SET "state"='done', "updatedAt"=? WHERE "id"=?`, nowMillis(), qid)
		return
	}
	// 上游段数上限防御：>300 段拆批（与 api_translate 上游约束一致）
	const batchSize = 280
	missTotal := 0
	for start := 0; start < len(paras); start += batchSize {
		end := start + batchSize
		if end > len(paras) {
			end = len(paras)
		}
		batch := paras[start:end]
		keys := make([]string, len(batch))
		for i, p := range batch {
			keys[i] = translateCacheKey(p, target)
		}
		hits := translateCacheGet(keys)
		missTexts := []string{}
		for i, p := range batch {
			if _, ok := hits[keys[i]]; !ok {
				missTexts = append(missTexts, p)
			}
		}
		if len(missTexts) > 0 {
			upResults, err := translateUpstream(target, missTexts, nil)
			if err != nil {
				fail("upstream: " + firstLineErr(err))
				return
			}
			// 回写：复用 translateCachePut 持久层（missIdx=全索引——本函数传入的
			// missTexts 全部是待翻段；失败段 results 空串被其内部跳过不落缓存，契约一致）
			keysMiss := make([]string, len(missTexts))
			missIdxAll := make([]int, len(missTexts))
			for i, p := range missTexts {
				keysMiss[i] = translateCacheKey(p, target)
				missIdxAll[i] = i
			}
			translateCachePut(missTexts, keysMiss, upResults, missIdxAll, novelID)
		}
		missTotal += len(missTexts)
	}
	_, _ = execRetry(`UPDATE "TranslationQueue" SET "state"='done', "updatedAt"=? WHERE "id"=?`, nowMillis(), qid)
	if missTotal > 0 {
		log.Printf("[translate-warm] ch=%d target=%s warmed %d paras", chID, target, missTotal)
	}
}
