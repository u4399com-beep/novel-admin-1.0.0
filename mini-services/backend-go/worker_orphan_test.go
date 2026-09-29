/**
 * worker_orphan_test.go —— Task 44-b 采集编排状态机孤儿态回归：
 * 1) runTask 任务参数读取失败（存储瞬时异常/损坏行类型不匹配）必须落 paused 终态，
 *    不得把已 pending→running 的任务悬挂在 running（旧版静默 return，runner 只轮询
 *    pending、recoverStaleTasks 仅启动时执行一次 → 任务永久 running，管理端 409 拒编辑）；
 *    损坏行用 SQLite 宽松类型把 pages 写成 TEXT 复现（与 Task 26-d/33-b TEXT 存储类
 *    防御同族——create API 不会产生该形态，属历史工具/手改库真实可达面）。
 * 2) sweepOrphanRunningTasks 进程内 running 孤儿自查：running 且不在 gRunning 登记表
 *    → 自动暂停；在登记（worker 正在执行）→ 不触碰；pending → 不触碰。
 * 复用 recover_test.go 的 TestMain 临时库（绝不触碰生产 db/custom.db）。
 */
package main

import (
	"testing"
)

// insertOrphanTask 建一条最小任务行，返回 id（extraSQL 可覆写 pages 等列为任意存储类）
func insertOrphanTask(t *testing.T, status, targetURL string) int64 {
	t.Helper()
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	res, err := db.Exec(
		`INSERT INTO "ScrapeTask" ("mode","targetUrl","pages","storageMode","status","createdAt","updatedAt")
		 VALUES ('single', ?, 1, 'db', ?, ?, ?)`,
		targetURL, status, nowMillis(), nowMillis())
	if err != nil {
		t.Fatalf("insert task: %v", err)
	}
	id, _ := res.LastInsertId()
	return id
}

func orphanTaskRow(t *testing.T, id int64) (status, message, logv string) {
	t.Helper()
	if err := queryOne(`SELECT "status","message","log" FROM "ScrapeTask" WHERE "id" = ?`,
		[]any{&status, &message, &logv}, id); err != nil {
		t.Fatalf("query task %d: %v", id, err)
	}
	return
}

// TestRunTaskParamFailurePausesTask 参数读取失败 → paused 终态（非悬挂 running）。
// 修复前行为：runTask 完成 pending→running 条件更新后 SELECT 扫描 pages TEXT 'abc'
// 进 int 失败，静默 return —— 断言 paused 必红（状态滞留 running）。
func TestRunTaskParamFailurePausesTask(t *testing.T) {
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	id := insertOrphanTask(t, "pending", "https://param-scan-failure.invalid/book/1")
	t.Cleanup(func() { _, _ = db.Exec(`DELETE FROM "ScrapeTask" WHERE "id" = ?`, id) })
	// 损坏行：pages 列写入 TEXT（SQLite 非严格列允许）→ queryOne 扫描 *int 必失败
	if _, err := db.Exec(`UPDATE "ScrapeTask" SET "pages" = 'abc' WHERE "id" = ?`, id); err != nil {
		t.Fatalf("corrupt pages column: %v", err)
	}

	runTask(int(id)) // 同步执行；参数扫描失败发生在任何引擎/网络调用之前

	status, message, logv := orphanTaskRow(t, id)
	if status != "paused" {
		t.Fatalf("参数读取失败的任务应转 paused（可恢复终态），got %q（悬挂=旧版缺陷）", status)
	}
	if !containsFoldStr(message, "参数读取失败") || !containsFoldStr(message, "暂停") {
		t.Fatalf("message 应说明参数读取失败并已暂停，got %q", message)
	}
	if !containsFoldStr(logv, "参数读取失败") {
		t.Fatalf("任务日志应留痕参数读取失败，got %q", logv)
	}
	// 状态机契约：不进入限流自动恢复词表（该形态与源站限流无关，纯手动恢复）
	if isRateLimitErrText(message) {
		t.Fatalf("参数失败暂停文案不得命中限流词表（避免进入 autoResume 链），got %q", message)
	}
}

// TestSweepOrphanRunningTasks 进程内 running 孤儿自查三分支
func TestSweepOrphanRunningTasks(t *testing.T) {
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	t.Cleanup(func() { _, _ = db.Exec(`DELETE FROM "ScrapeTask"`) })
	orphan := insertOrphanTask(t, "running", "https://orphan.invalid/book/1")   // 无 worker → 应转 paused
	owned := insertOrphanTask(t, "running", "https://owned.invalid/book/2")     // gRunning 登记 → 不触碰
	pending := insertOrphanTask(t, "pending", "https://pending.invalid/book/3") // pending → 不触碰
	gRunningMu.Lock()
	gRunning[int(owned)] = true
	gRunningMu.Unlock()
	t.Cleanup(func() {
		gRunningMu.Lock()
		delete(gRunning, int(owned))
		gRunningMu.Unlock()
	})

	sweepOrphanRunningTasks()

	if status, _, _ := orphanTaskRow(t, orphan); status != "paused" {
		t.Fatalf("孤儿 running（gRunning 无登记）应被自查转 paused，got %q", status)
	}
	if status, _, _ := orphanTaskRow(t, owned); status != "running" {
		t.Fatalf("gRunning 已登记的 running 任务不得被自查触碰，got %q", status)
	}
	if status, _, _ := orphanTaskRow(t, pending); status != "pending" {
		t.Fatalf("pending 任务不得被自查触碰，got %q", status)
	}
	// 幂等：再扫一轮，已 paused 的孤儿不再变化、owned 仍 running
	sweepOrphanRunningTasks()
	if status, _, _ := orphanTaskRow(t, orphan); status != "paused" {
		t.Fatalf("复查后孤儿应保持 paused，got %q", status)
	}
	if status, _, _ := orphanTaskRow(t, owned); status != "running" {
		t.Fatalf("复查后 owned 应保持 running，got %q", status)
	}
}
