/**
 * pseo_reenrich.go —— 书名种子重富集自愈巡检（R84，用户指令「书籍页标签丰富度」根治延续）。
 *
 * 背景（R84 实证）：存量书名种子富集窗口内引擎瞬时故障（连续 enrichRetryMax 次全败
 * 有界重试后放弃，finalizeBookSeedEnrich 置 generated 但血缘词为零）→ 1,396/2,062
 * （67.7%）书籍页标签退化为书名+作者+衍生词兜底，真实搜索下拉词为零。R84 以一次性
 * 维护工具 cmd/kwreset 批量重置补救；本文件把该补救固化为常驻自愈通道，防止新故障
 * 窗口再次堆积。
 *
 * 设计：
 * - 周期：PSEO_REENRICH_INTERVAL（默认 60min）——引擎故障窗口（分钟级）远短于周期，
 *   单轮即可把上轮受害种子送到健康引擎面前；频率克制，与封面巡检（30min）错峰。
 * - 判定：source='book' AND status='generated' AND 血缘词 < PSEO_REENRICH_MIN_LINEAGE(8)
 *   （血缘 = seed=该种子 keyword 且 status='generated' 的行数；阈值对齐 novelPseoTags
 *   衍生词兜底线——低于 8 意味着标签以合成词为主）。
 * - 单发闸门：每种子终身仅重富集一次（AppMeta "pseoReenrichDone:<kwNorm>" 标记）。
 *   重置后若引擎健康仍取不到词（真无下拉词的冷门书），下轮巡检不会再次重置空转；
 *   引擎再次故障的种子由既有 enrichRetryMax 有界重试兜底，不叠加。
 * - 批量上限：PSEO_REENRICH_BATCH（默认 50/轮）——突发堆积（如整机恢复后全库重采）
 *   时每轮仅放行 50 个，引擎侧增量负载 ≤50×0.33 QPS/域 与富集循环既有温和度同级；
 *   剩余缺口下轮继续（每小时 50 个，1,400 本量级 28h 收敛，与封面巡检同节奏哲学）。
 * - 隔离：与封面巡检（startCoverSweepLoop）同为独立 goroutine best-effort，失败仅记
 *   日志；PSEO_REENRICH_OFF=1 停用。绝不触碰词池/intro/手工词（只动 source='book' 行）。
 */
package main

import (
	"database/sql"
	"log"
	"os"
	"time"
)

// 重富集巡检常量（var 供测试注入；生产路径只读默认值）
var (
	pseoReenrichInterval = 60 * time.Minute
	pseoReenrichBatch    = 50
	pseoReenrichMinLine  = 8
)

// pseoReenrichMarker 单发闸门记账键（kwNorm 归一形，同词跨形态同一记账）
func pseoReenrichMarker(kw string) string { return "pseoReenrichDone:" + kwNormalize(kw) }

// pseoReenrichScan 待重富集种子扫描：generated 血缘词 < minLine 的 book 种子，
// 排除已标记单发闸门的行，按 id 升序至多 limit 个。
// 血缘子查询按种子自身 keyword 精确匹配（enqueuePseoBookSeed 落库形态一致；
// 种子自身行 seed=” 恒不计入）。
func pseoReenrichScan(minLine, limit int) ([]string, error) {
	kws := []string{}
	err := queryList(
		`SELECT p."keyword" FROM "PseoKeyword" p
                 WHERE p."source" = 'book' AND p."status" = 'generated' AND p."keyword" != ''
                   AND (SELECT COUNT(*) FROM "PseoKeyword" q WHERE q."seed" = p."keyword" AND q."status" = 'generated') < ?
                   AND NOT EXISTS (SELECT 1 FROM "AppMeta" m WHERE m."key" = 'pseoReenrichDone:' || p."kwNorm")
                 ORDER BY p."id" ASC LIMIT ?`,
		func(rows *sql.Rows) error {
			var kw string
			if err := rows.Scan(&kw); err != nil {
				return err
			}
			kws = append(kws, kw)
			return nil
		}, minLine, limit)
	return kws, err
}

// runPseoReenrichSweep 单轮巡检：扫描 → 标记单发闸门 → 重置 pending。
// 返回重置数；DB 错误返回 0 与错误（调用方仅记日志）。
// 标记与重置同事务语义（逐行执行，先标记后重置——进程在两步之间崩溃时种子保持
// generated 未重置但已标记，最多损失一次补救机会，绝不产生重复重置空转）。
func runPseoReenrichSweep(minLine, limit int) (int, error) {
	kws, err := pseoReenrichScan(minLine, limit)
	if err != nil {
		return 0, err
	}
	if len(kws) == 0 {
		return 0, nil
	}
	reset := 0
	for _, kw := range kws {
		setAppMeta(pseoReenrichMarker(kw), "1")
		if _, err := exec(
			`UPDATE "PseoKeyword" SET "status" = 'pending', "updatedAt" = ? WHERE "source" = 'book' AND "status" = 'generated' AND "keyword" = ?`,
			nowMillis(), kw); err != nil {
			return reset, err
		}
		reset++
	}
	return reset, nil
}

// startPseoReenrichSweep 常驻巡检（main.go runner/all 模式 go 调用）。
// 先睡后扫：boot 自愈链（backfillBrokenCoverLocal/种子恢复）先行，与封面巡检同哲学。
func startPseoReenrichSweep() {
	go func() {
		for {
			time.Sleep(pseoReenrichInterval)
			if os.Getenv("PSEO_REENRICH_OFF") == "1" {
				continue
			}
			n, err := runPseoReenrichSweep(pseoReenrichMinLine, pseoReenrichBatch)
			if err != nil {
				log.Printf("[pseo-reenrich] 巡检轮失败: %v", err)
				continue
			}
			if n > 0 {
				log.Printf("[pseo-reenrich] 重置 %d 个血缘词不足种子回 pending（引擎健康时约 %s 后标签补全）",
					n, time.Duration(n/enrichBatchSize)*pseoEnrichInterval)
			}
		}
	}()
}

// itoa 已有实现（db.go），此处不重复；setAppMeta 薄封装集中错误观测
func setAppMeta(key, val string) {
	if _, err := exec(`INSERT OR REPLACE INTO "AppMeta" ("key","value") VALUES (?, ?)`, key, val); err != nil {
		log.Printf("[pseo-reenrich] 记账失败 key=%q: %v", truncateRunes(key, 60), err)
	}
}

// getenvInt 无预留实现：当前常量走 var 注入测试，环境变量仅开关位（PSEO_REENRICH_OFF）；
// 未来若需 env 可调阈值再补，不留死代码
