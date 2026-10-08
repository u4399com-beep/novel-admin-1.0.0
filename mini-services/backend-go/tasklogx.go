/**
 * tasklogx.go —— ScrapeTaskLog 分表读写助手 + 任务历史水平清理（R102-b）。
 *
 * 一、日志垂直拆表（ChapterContent/Task 32-b 同构，schema.go R102-b DDL）：
 *   - 写：writeTaskLog UPSERT 拆表行；主表 ScrapeTask.log 旧列不再增长（存量行由
 *     boot 迁移一次性搬空，列保留仅作回退保险）；
 *   - 读：readTaskLog 先读拆表行，空值回退主表旧列（迁移中断/未迁移行的兜底，迁移
 *     幂等保证正常路径永不触发）；
 *   - 删：FK ON DELETE CASCADE 随任务行自动清理（含 cleanupFinishedTasks 历史清理）。
 *
 * 二、任务历史水平清理（分表思想的运维化——FK 每 5 分钟为启用规则自动建任务，
 * 任务表无清理机制时无限膨胀：19 规则 × 288 任务/天 ≈ 半年 33 万行 + 每行日志）：
 *   - TTL：终态（success/failed/canceled）任务 30 天后删除；partial 保留（缺失
 *     章节可恢复续传，属「进行中」语义）；
 *   - 数量上限：终态任务超上限时按 updatedAt 旧→新清理至上限（防长跑规则高频
 *     重建把 30 天 TTL 冲穿）；
 *   - 调度：boot 一轮 + 每 6h 一轮（cleanupFinishedTasksLoop）；
 *   - 幂等：全部集合 DELETE，重复执行零副作用；失败仅记日志不阻断 boot。
 */
package main

import (
	"database/sql"
	"log"
	"time"
)

// 任务历史清理参数（保守起步：30 天 TTL + 5000 条终态上限；19 规则舰队约 5.8 万条/年
// 终态任务，TTL 先命中；上限仅防极端高频重建场景）
const (
	taskHistoryTTLMs     int64 = 30 * 24 * 3600 * 1000 // 30 天
	taskHistoryCap             = 5000                  // 终态任务保留上限
	taskHistoryLoopHours       = 6                     // 周期清理间隔（小时）
)

// writeTaskLog UPSERT 拆表日志行（新写入唯一入口；失败返回 false 由调用方决定是否告警
// ——日志非关键路径，失败不重试：下一次 Flush 全量重写自动自愈）
func writeTaskLog(taskID int64, text string) bool {
	if taskID <= 0 {
		return false
	}
	_, err := execRetry(
		`INSERT INTO "ScrapeTaskLog" ("taskId","log") VALUES (?,?)
                 ON CONFLICT("taskId") DO UPDATE SET "log" = excluded."log"`,
		taskID, text)
	return err == nil
}

// readTaskLog 读拆表日志行；拆表行为空/缺失时回退主表旧列（存量未迁移行保险）。
// 读路径失败 fail-open 返回空串（日志展示缺失不阻断任务操作）。
func readTaskLog(taskID int64) string {
	if taskID <= 0 {
		return ""
	}
	var v string
	if err := queryOne(`SELECT "log" FROM "ScrapeTaskLog" WHERE "taskId" = ?`, []any{&v}, taskID); err == nil && v != "" {
		return v
	}
	// 回退主表旧列（迁移前的存量行；迁移完成后恒空串，代价为一次可忽略的索引点查）
	_ = queryOne(`SELECT "log" FROM "ScrapeTask" WHERE "id" = ?`, []any{&v}, taskID)
	return v
}

// migrateTaskLogSplitDB 存量日志一次性迁移（getDB once 回调内调用，幂等；⚠ 用传入的
// 局部 *sql.DB 直入，严禁经 exec/query 助手再入 getDB——Task 30 P1 死锁教训）：
// ①主表 log 非空行搬入拆表（ON CONFLICT DO NOTHING：已有拆表行不覆盖——以拆表为准）；
// ②搬空后主表 log 清零（体积释放；幂等——二次启动空串行不再命中）。
// 两个集合语句，任务表万行级毫秒~十毫秒级完成；失败仅记日志不阻断 boot（回退读路径兜底）。
func migrateTaskLogSplitDB(db *sql.DB) {
	ins, err := db.Exec(
		`INSERT INTO "ScrapeTaskLog" ("taskId","log")
                 SELECT "id","log" FROM "ScrapeTask" WHERE "log" != ''
                 ON CONFLICT("taskId") DO NOTHING`)
	if err != nil {
		log.Printf("[db] 任务日志拆表迁移①失败（存量日志暂留主表，readTaskLog 回退兜底，重启重试）: %v", err)
		return
	}
	if _, err := db.Exec(`UPDATE "ScrapeTask" SET "log" = '' WHERE "id" IN (SELECT "taskId" FROM "ScrapeTaskLog")`); err != nil {
		log.Printf("[db] 任务日志拆表迁移②（主表清零）失败（存量日志双存，读路径不受影响，重启重试）: %v", err)
		return
	}
	if n, _ := ins.RowsAffected(); n > 0 {
		log.Printf("[db] 任务日志拆表迁移完成：%d 条存量日志搬入 ScrapeTaskLog，主表体积已释放", n)
	}
}

// cleanupFinishedTasks 任务历史清理（boot + 每 6h；幂等集合 DELETE）。
// 返回本轮删除行数。partial 不删（可恢复续传语义）；running/pending 不删。
func cleanupFinishedTasks() int64 {
	cutoff := nowMillis() - taskHistoryTTLMs
	// ① TTL 清理：终态且 updatedAt 早于切点（updatedAt 由 Flush/终态写入持续触碰，
	// 是任务「最后活动」的准确口径）
	r1, err := execRetry(
		`DELETE FROM "ScrapeTask" WHERE "status" IN ('success','failed','canceled') AND "updatedAt" > 0 AND "updatedAt" < ?`,
		cutoff)
	if err != nil {
		log.Printf("[task-history] TTL 清理失败（本轮跳过）: %v", err)
		return 0
	}
	removed, _ := r1.RowsAffected()
	// ② 数量上限：终态超上限时按 updatedAt 旧→新清理至上限
	var finishedCount int64
	if err := queryOne(`SELECT COUNT(*) FROM "ScrapeTask" WHERE "status" IN ('success','failed','canceled')`,
		[]any{&finishedCount}); err == nil && finishedCount > taskHistoryCap {
		r2, err := execRetry(
			`DELETE FROM "ScrapeTask" WHERE "id" IN (
                                SELECT "id" FROM "ScrapeTask" WHERE "status" IN ('success','failed','canceled')
                                ORDER BY "updatedAt" ASC LIMIT ?)`,
			finishedCount-int64(taskHistoryCap))
		if err == nil {
			if n, _ := r2.RowsAffected(); n > 0 {
				removed += n
				log.Printf("[task-history] 终态任务超上限 %d，已清理最旧 %d 条", taskHistoryCap, n)
			}
		}
	}
	return removed
}

// cleanupFinishedTasksLoop 周期清理循环（阻塞式，main 以 go 调用挂载；首延迟一个周期，
// boot 轮由 main 启动路径直接调用 cleanupFinishedTasks 承担）
func cleanupFinishedTasksLoop() {
	ticker := time.NewTicker(taskHistoryLoopHours * time.Hour)
	defer ticker.Stop()
	for range ticker.C {
		if n := cleanupFinishedTasks(); n > 0 {
			log.Printf("[task-history] 周期清理完成，删除历史任务 %d 条", n)
		}
	}
}
