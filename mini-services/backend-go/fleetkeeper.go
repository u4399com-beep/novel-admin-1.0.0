/**
 * fleetkeeper.go —— E26 舰队自持（Task 62-R31）。
 *
 * 用户指令「填充 46.9 万骨架章」+「要求都能够稳定长期进行获取」：list 任务是有限范围
 * 作业（pages 上限+Phase 2 填完即 success/failed 终态），终态后该规则域名空闲——
 * 骨架与填充断流，只能人工重建任务（R26 恢复轮实证 13 任务全靠手工创建）。
 * E18/E21/E23 覆盖「出口池/暂停任务」的自愈，本组件补上最后一环「终态任务」的替代：
 *
 *   周期（5min）：对每条 enabled 规则——
 *     1. 该规则存在 pending/running/paused 任务 → 不动（活跃任务含 paused：E21/E23
 *        的复活通道是它的恢复路径，此处不越权）
 *     2. 无活跃任务且该规则最近一条任务（任意状态）updatedAt 距今 ≥45min → 自动建
 *        一条 list 任务（targetUrl=rule.siteUrl，pages=10，storageMode=db）
 *     3. 45min 冷却防失败任务快速重试风暴（失败站每 45min 至多重试一次）
 *
 * 治理：
 *   - 单飞 goroutine 串行；建任务走与 API 同一条 execRetryReturningID 插入（runner
 *     2s 轮询自动领取）
 *   - FLEETKEEPER_OFF=1 停用（部署机想完全手动控制任务面时）
 *   - best-effort：任何失败仅落日志，绝不影响采集主流程
 */
package main

import (
	"database/sql"
	"log"
	"time"
)

const (
	fleetKeepInterval   = 5 * time.Minute
	fleetKeepPageLimit  = 10
	fleetKeepCooldownMs = 45 * 60 * 1000 // 规则最近任务终态后的冷却窗
)

// fleetKeepOnce 单轮：为无活跃任务且过冷却期的 enabled 规则补建 list 任务
func fleetKeepOnce() {
	type ruleRow struct {
		id      int64
		name    string
		siteURL string
	}
	rules := make([]ruleRow, 0, 16)
	if err := queryList(`SELECT "id","name","siteUrl" FROM "ScrapeRule" WHERE "enabled" = 1 AND "siteUrl" != '' ORDER BY "id" ASC`,
		func(rs *sql.Rows) error {
			var r ruleRow
			if err := rs.Scan(&r.id, &r.name, &r.siteURL); err != nil {
				return err
			}
			rules = append(rules, r)
			return nil
		}); err != nil {
		return
	}
	for _, r := range rules {
		// 活跃任务存在（pending/running/paused 任一）→ 跳过
		var active int
		if err := queryOne(`SELECT COUNT(*) FROM "ScrapeTask" WHERE "ruleId" = ? AND "status" IN ('pending','running','paused')`,
			[]any{&active}, r.id); err != nil || active > 0 {
			continue
		}
		// 冷却：最近一条任务（任意状态）updatedAt 距今不足 45min → 跳过
		//（规则从未有过任务时 COALESCE 取 0 → 视为远过冷却，首轮即建）。
		// Task 51-a: MAX 聚合值可能是 TEXT 存储类（历史工具写入的 DateTime 文本行，
		// 与 recoverStaleTasks Task 26-d 同族实证）——int64 直扫会 Scan 报错 → 该规则
		// 每轮在 err != nil 分支被静默跳过，E26 对该规则永不补建（填充断流无自愈）。
		// 改为 any 读出后经 normalizeMillis 归一：integer/TEXT 多格式均可判定冷却；
		// NULL（无任务）/0/无法解析 → 不可判定 → 不跳过（保留「首轮即建」语义）
		var lastUp any
		if err := queryOne(`SELECT COALESCE(MAX("updatedAt"), 0) FROM "ScrapeTask" WHERE "ruleId" = ?`,
			[]any{&lastUp}, r.id); err != nil {
			continue
		}
		if lastMs, ok := normalizeMillis(lastUp); ok && nowMillis()-lastMs < fleetKeepCooldownMs {
			continue
		}
		newID, err := execRetryReturningID(
			`INSERT INTO "ScrapeTask" ("mode","targetUrl","ruleId","pages","storageMode","status","total","done","chaptersDone","chaptersTotal","created","updated","chapters","message","log","createdAt","updatedAt")
                         VALUES ('list', ?, ?, ?, 'db', 'pending', 0, 0, 0, 0, 0, 0, 0, 'E26 舰队自持：规则无活跃任务，自动重建范围采集', '', ?, ?)`,
			r.siteURL, r.id, fleetKeepPageLimit, nowMillis(), nowMillis())
		if err != nil {
			log.Printf("[fleet-keeper] 规则 #%d《%s》自动建任务失败: %v", r.id, truncateRunes(r.name, 20), err)
			continue
		}
		log.Printf("[fleet-keeper] 规则 #%d《%s》无活跃任务且已过冷却 → 自动建 list 任务 #%d（目标 %s，pages=%d）",
			r.id, truncateRunes(r.name, 20), newID, truncateRunes(r.siteURL, 60), fleetKeepPageLimit)
	}
}

// startFleetKeeper 自愈循环（BACKEND_MODE=all 的 runner 侧 go 调用；FLEETKEEPER_OFF=1 停用）
func startFleetKeeper() {
	if envOff("FLEETKEEPER_OFF") {
		log.Printf("[fleet-keeper] FLEETKEEPER_OFF=1，舰队自持停用")
		return
	}
	go func() {
		// 启动先等 2min（恢复场景下人工重建的任务需时间进入 running，避免重复建）
		time.Sleep(2 * time.Minute)
		for {
			fleetKeepOnce()
			time.Sleep(fleetKeepInterval)
		}
	}()
}
