/**
 * audit55b_test.go —— 第 17 轮采集生命周期深审（Task 55-b）回归锁定：
 *
 * 1) TestSmartCompleteStatusNullLastTitleNoAbort：smartCompleteStatus 的 lastTitle 是
 *    标量子查询——serial 且零章节的书（Phase 1 合法形态：目录提取为空照入库）子查询返回
 *    NULL，string 直扫报错 → queryList 整批中止且错误被 `_ =` 吞掉：同任务任一零章书会把
 *    其余全部书籍的智能完结静默清零（探针实证：202 末章「大结局」因 201 零章书在场保持
 *    serial）。修复后 NullString 扫描，NULL 行按「无末章可判」跳过，批内其余书照常升级。
 * 2) TestLogCapAllowExact / TestLogCapAllowConcurrent：phase2Fill 引擎提示日志闸
 *    （logCap）——旧 warnLogged 的 Load-then-Add 是 check-then-act，多车道并发窗口内可
 *    同时过闸（实际落盘可超预算 10 达 10+lanes）；Add-first 原子闸在任意并发交错下恰好
 *    放行 cap 次（Add 返回唯一序号，确定性成立）。
 * 3) TestFinalizeTerminalClaimBranches：finalize 终态写入六分支契约（Task 25-a/27-c
 *    快速 pause→resume 竞态修复面，此前仅 Phase 1 参数失败路径被 worker_orphan_test
 *    间接覆盖）——running 认领终态/暂停、pending 条件领取 success|partial|failed
 *    （canceled 刻意不领取=兑现重启重跑语义）、paused+paused 暂停确认、已终态绝不改写。
 *
 * 复用 recover_test.go 的 TestMain 临时库（绝不触碰生产 db/custom.db）。
 */
package main

import (
	"sync"
	"testing"
)

// ---------- ① smartCompleteStatus NULL lastTitle 整批中止（P3 修复回归） ----------

func TestSmartCompleteStatusNullLastTitleNoAbort(t *testing.T) {
	mustInitSmartStatusTables(t)
	// 201: serial 且零章节 → lastTitle 子查询 NULL（修复前：整批扫描在此中止）
	insertSmartNovel(t, 201, "零章书55b", "还没有章节。", "serial")
	// 202: 末章完结词 → 应被升级 finished（修复前：被 201 拖累保持 serial）
	insertSmartNovel(t, 202, "完结书55b", "主角赢了。", "serial")
	insertSmartChapter(t, 202, 1, "第1章 开始")
	insertSmartChapter(t, 202, 2, "大结局（全书完）")
	// 203: 末章含进行时负向词 → 不动（判定逻辑本身不受本次修复影响）
	insertSmartNovel(t, 203, "连载书55b", "新书连载中。", "serial")
	insertSmartChapter(t, 203, 1, "大结局暂定卷末")

	smartCompleteStatus([]int{201, 202, 203})

	if got := novelStatusOf(t, 201); got != "serial" {
		t.Errorf("零章书无末章可判应保持 serial，got %s", got)
	}
	if got := novelStatusOf(t, 202); got != "finished" {
		t.Errorf("同批零章书（NULL lastTitle）不得中止整批扫描：书202 末章大结局应升级 finished（修复前探针实证保持 serial），got %s", got)
	}
	if got := novelStatusOf(t, 203); got != "serial" {
		t.Errorf("负向词先行判定不得变化：书203 应保持 serial，got %s", got)
	}
}

// ---------- ② logCap Add-first 日志闸（P3 修复回归） ----------

func TestLogCapAllowExact(t *testing.T) {
	var g logCap
	for i := int64(1); i <= 15; i++ {
		got := g.allow(10)
		want := i <= 10
		if got != want {
			t.Fatalf("第 %d 次申请 allow(10) = %v, want %v（前 10 恰好放行）", i, got, want)
		}
	}
}

func TestLogCapAllowConcurrent(t *testing.T) {
	var g logCap
	const goroutines, perG, capN = 64, 500, int64(10)
	var mu sync.Mutex
	granted := 0
	var wg sync.WaitGroup
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < perG; j++ {
				if g.allow(capN) {
					mu.Lock()
					granted++
					mu.Unlock()
				}
			}
		}()
	}
	wg.Wait()
	// Add 返回唯一递增序号 → 任意并发交错下恰好放行 cap 次（旧 Load-then-Add 可达 10+lanes）
	if granted != int(capN) {
		t.Fatalf("并发 %d×%d 次申请 allow(%d)：放行 %d 次，want 恰好 %d（check-then-act 旧范式会超发）",
			goroutines, perG, capN, granted, capN)
	}
}

// ---------- ③ finalize 终态写入六分支契约 ----------

func TestFinalizeTerminalClaimBranches(t *testing.T) {
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	t.Cleanup(func() { _, _ = db.Exec(`DELETE FROM "ScrapeTask"`) })

	mk := func(status string) int64 {
		id := insertOrphanTask(t, status, "https://finalize-55b.invalid/book/1")
		t.Cleanup(func() { _, _ = db.Exec(`DELETE FROM "ScrapeTask" WHERE "id" = ?`, id) })
		return id
	}
	row := func(id int64) (status, message string) {
		s, m, _ := orphanTaskRow(t, id)
		return s, m
	}

	// ① running + success → 认领终态
	idA := mk("running")
	finalize(NewRun(int(idA)), "success", "范围采集完成")
	if s, m := row(idA); s != "success" || m != "范围采集完成" {
		t.Errorf("running 应被 success 认领，got %s/%q", s, m)
	}

	// ② running + paused → 认领为 paused（worker 安全点感知用户暂停）
	idB := mk("running")
	finalize(NewRun(int(idB)), "paused", "已暂停（进度保留）")
	if s, m := row(idB); s != "paused" || m != "已暂停（进度保留）" {
		t.Errorf("running 应被 paused 认领，got %s/%q", s, m)
	}

	// ③ pending + success → 条件领取（Task 27-c 快速 pause→resume 竞态：实际已跑完不滞留 pending）
	idC := mk("pending")
	finalize(NewRun(int(idC)), "success", "领取终态")
	if s, m := row(idC); s != "success" || m != "领取终态" {
		t.Errorf("pending 应被 success 条件领取（否则 runner 二次分发全量重跑），got %s/%q", s, m)
	}

	// ④ pending + canceled → 刻意不领取（兑现「取消收尾中点重启」重跑语义），仅补日志
	idD := mk("pending")
	finalize(NewRun(int(idD)), "canceled", "任务已取消")
	if s, _ := row(idD); s != "pending" {
		t.Errorf("pending + canceled 不得被领取（保持 pending 交由重启重跑语义），got %s", s)
	}

	// ⑤ paused + paused → 暂停确认：状态/进度字段不动，仅刷新 message/log
	idE := mk("paused")
	finalize(NewRun(int(idE)), "paused", "已暂停（书目完成 3/10 本）")
	if s, m := row(idE); s != "paused" || m != "已暂停（书目完成 3/10 本）" {
		t.Errorf("paused+paused 应确认暂停并刷新 message，got %s/%q", s, m)
	}

	// ⑥ 已终态（canceled，API 写入）→ 绝不改写状态（默认分支仅补日志）
	idF := mk("canceled")
	finalize(NewRun(int(idF)), "failed", "不得覆盖")
	if s, _ := row(idF); s != "canceled" {
		t.Errorf("API 已写入的 canceled 终态不得被 worker 改写（绝不复活/改写），got %s", s)
	}
}
