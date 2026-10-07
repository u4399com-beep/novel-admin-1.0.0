/**
 * backend-go —— E19 规则健康巡检（61-R4 新增能力）。
 *
 * 动机（用户指令「在库采集规则全部突破、稳定长期获取」）：E18 出口池自愈只覆盖
 * 「代理出口死口」这一种病灶；站点结构漂移（选择器失效）、入口页下线、站点死亡、
 * 挑战升级等病灶只能在真实采集任务失败时被动发现。本巡检以最低成本（每规则每轮
 * 恰一次引擎 /api/test 列表提取，走与真实采集完全相同的 loadRule→engineRuleBody
 * 契约路径）主动探测每条启用规则的健康度，落 RuleHealth 表并在规则面板透出，
 * 使「规则还能不能用」从被动踩坑变为面板一瞥可知。
 *
 * 设计要点：
 * - 判定三态归一为二值+备注：传输失败/软拦截/0 条目=不健康（0 条目备注区分
 *   「选择器或入口漂移」），条目>0=健康。与 fetchListPage 的软拦截文案口径一致。
 * - 串行巡检（不并发轰炸引擎/站点，引擎内部另有域名限速≥1.2s 与 55s 预算）。
 * - 单轮总时长上界：规则数 × 60s（引擎客户端超时），17 规则最坏 ~17min，
 *   默认轮间隔 45min，重叠防护由 gPatrolRunning CAS 兜底（手动触发与循环互斥）。
 * - 幂等：RuleHealth upsert（INSERT ON CONFLICT DO UPDATE），连续计数在 SQL 内
 *   维护，巡检崩溃重启零状态损失。
 * - 停用开关 RULEHEALTH_OFF=1；轮间隔 RULEHEALTH_INTERVAL_MIN（分钟，[5,720] 夹取）。
 */
package main

import (
	"database/sql"
	"log"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// ruleHealthInitialDelay 启动后首轮巡检延迟（避开 boot 迁移/播种/任务拉起高峰）
const ruleHealthInitialDelay = 90 * time.Second

// ruleHealthDefaultIntervalMin 默认巡检轮间隔（分钟）
const ruleHealthDefaultIntervalMin = 45

// gPatrolRunning 巡检单飞闸（1=running）：循环轮与手动触发互斥，防重叠双写连击计数
var gPatrolRunning atomic.Int32

// ruleHealthIntervalMin 解析巡检轮间隔（分钟）；非法/越界回落默认并夹取 [5,720]
func ruleHealthIntervalMin() int {
	v := strings.TrimSpace(os.Getenv("RULEHEALTH_INTERVAL_MIN"))
	if v == "" {
		return ruleHealthDefaultIntervalMin
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return ruleHealthDefaultIntervalMin
	}
	if n < 5 {
		return 5
	}
	if n > 720 {
		return 720
	}
	return n
}

// startRuleHealthLoop 巡检循环入口（main.go 在 runner/all 模式 go 起）。
// 首轮延迟 90s；此后按 RULEHEALTH_INTERVAL_MIN 周期巡检；单轮 panic 不致命（下轮重来）。
func startRuleHealthLoop() {
	// 61-R9 口径统一：改用 envOff（E18 proxywatch 同款 kill-switch 助手，1/true/yes 均
	// 认停用）——旧版手写 TrimSpace=="1" 仅认 "1"，与兄弟组件 E18 语义漂移
	if envOff("RULEHEALTH_OFF") {
		log.Println("[rulehealth] RULEHEALTH_OFF=1，规则健康巡检停用")
		return
	}
	interval := time.Duration(ruleHealthIntervalMin()) * time.Minute
	log.Printf("[rulehealth] 规则健康巡检启动（首轮 %v 后，间隔 %v）", ruleHealthInitialDelay, interval)
	time.Sleep(ruleHealthInitialDelay)
	for {
		func() {
			defer func() { _ = recover() }() // 单轮异常不致命（对齐 proxywatch 防御口径）
			ruleHealthPass("循环")
		}()
		time.Sleep(interval)
	}
}

// triggerRuleHealthCheckAsync 手动触发一次巡检（admin「立即巡检」按钮）。返回 false=已有
// 一轮在跑（循环轮或前次手动），本次忽略——单飞闸保证任意时刻至多一轮在途。
func triggerRuleHealthCheckAsync() bool {
	if !gPatrolRunning.CompareAndSwap(0, 1) {
		return false
	}
	go func() {
		defer gPatrolRunning.Store(0)
		defer func() { _ = recover() }()
		ruleHealthRun("手动")
	}()
	return true
}

// ruleHealthPass 单轮巡检：遍历全部启用规则，逐条探活并落 RuleHealth。
// mode 仅用于日志区分来源（循环/手动）。
func ruleHealthPass(mode string) {
	// 单飞闸：循环轮与手动触发统一经此 CAS（61-R8 修复：旧版 trigger 预占 CAS +
	// pass 内二次 CAS 自锁 → 手动触发永远静默空转仍返回 202；现 gate 仅此一处，
	// trigger 直接执行 ruleHealthRun 不再预占）
	if !gPatrolRunning.CompareAndSwap(0, 1) {
		log.Printf("[rulehealth] %s巡检跳过：已有巡检在途", mode)
		return
	}
	defer gPatrolRunning.Store(0)
	ruleHealthRun(mode)
}

// ruleHealthRun 巡检执行体（调用方必须已持单飞闸）。
func ruleHealthRun(mode string) {
	type ruleRef struct {
		id      int64
		siteURL string
	}
	rules := []ruleRef{}
	err := queryList(`SELECT "id","siteUrl" FROM "ScrapeRule" WHERE "enabled" = 1 ORDER BY "id" ASC`, func(rs *sql.Rows) error {
		var id int64
		var siteURL string
		if err := rs.Scan(&id, &siteURL); err != nil {
			return err
		}
		rules = append(rules, ruleRef{id: id, siteURL: siteURL})
		return nil
	})
	if err != nil {
		log.Printf("[rulehealth] %s巡检规则清单读取失败: %v", mode, err)
		return
	}
	if len(rules) == 0 {
		log.Printf("[rulehealth] %s巡检：无启用规则，跳过", mode)
		return
	}
	okN, failN := 0, 0
	started := time.Now()
	for _, rr := range rules {
		ok, latencyMs, note := ruleHealthCheckOne(rr.id, rr.siteURL)
		if err := ruleHealthUpsert(rr.id, ok, latencyMs, note); err != nil {
			log.Printf("[rulehealth] 规则#%d 结果落库失败: %v", rr.id, err)
			continue
		}
		if ok {
			okN++
		} else {
			failN++
			log.Printf("[rulehealth] 规则#%d 不健康: %s", rr.id, note)
		}
	}
	log.Printf("[rulehealth] %s巡检完成：%d 规则，健康 %d / 不健康 %d，耗时 %s", mode, len(rules), okN, failN, time.Since(started).Round(time.Second))

	// E23（61-R11）: 巡检联动复活——闭环「限流熔断暂停 × runner 自动恢复 4 次上限」
	// 的无人值守断流点：巡检实测健康的规则，其限流类暂停任务（静默 ≥30min）自动
	// 重新入队。人工运维等价动作（看面板确认站点活着 → 点恢复），频率受巡检轮间隔
	// 约束（默认 45min 至多一轮），引擎侧 1.2s 域限速兜住礼貌性。
	patrolReviveTasks()
}

// patrolReviveTasks 巡检联动复活（E23）：仅复活「巡检本轮实测健康规则」名下的限流类
// 暂停任务。61-R21 扩展：纳入「疑似源站封禁或站点不可达」类暂停——引擎短时下线时
// runner 会把在跑任务按此口径批量暂停（引擎离线≠站点死亡），巡检 lastOK=1 即
// 「站点经引擎真实可达」的强反证，复活安全。条件更新防与手动操作/worker 终态竞态。
func patrolReviveTasks() {
	type revival struct {
		id   int64
		rule int64
	}
	revs := []revival{}
	// R102-b（日志拆表）：巡检查询不再拖主表 log 列，日志按需 readTaskLog（拆表行 + 旧列回退）
	err := queryList(
		`SELECT t."id", COALESCE(t."ruleId",0) FROM "ScrapeTask" t
                 JOIN "RuleHealth" h ON h."ruleId" = t."ruleId"
                 WHERE t."status" = 'paused' AND h."lastOK" = 1
                   AND (t."message" LIKE '%限流%软拦截%' OR t."message" LIKE '%封禁或站点不可达%')
                   AND t."updatedAt" <= ?`,
		func(rs *sql.Rows) error {
			var id, ruleID int64
			if err := rs.Scan(&id, &ruleID); err != nil {
				return nil // 单行脏数据跳过
			}
			revs = append(revs, revival{id: id, rule: ruleID})
			return nil
		}, nowMillis()-patrolReviveSilentMs)
	if err != nil || len(revs) == 0 {
		return
	}
	revived := 0
	for _, rv := range revs {
		line := "[" + runTs() + "] 巡检联动恢复（E23：规则健康实测通过，限流熔断自动出坑）"
		logv := readTaskLog(rv.id) // R102-b: 日志拆表读（含主表旧列回退）
		if logv != "" {
			logv += "\n"
		}
		logv = lastLines(logv+line, MAX_LOG_LINES)
		res, err := execRetry(
			`UPDATE "ScrapeTask" SET "status" = 'pending', "message" = '巡检联动恢复（规则健康实测通过），等待 runner 领取继续采集', "updatedAt" = ? WHERE "id" = ? AND "status" = 'paused'`,
			nowMillis(), rv.id)
		if err == nil {
			if cnt, _ := res.RowsAffected(); cnt > 0 {
				_ = writeTaskLog(rv.id, logv) // R102-b: 日志落拆表
				revived++
				log.Printf("[rulehealth] 任务 #%d（规则 #%d）巡检联动恢复（E23）", rv.id, rv.rule)
			}
		}
	}
	if revived > 0 {
		log.Printf("[rulehealth] E23 联动复活 %d 条限流暂停任务", revived)
	}
}

// patrolReviveSilentMs 巡检联动复活的暂停静默窗（与 runner autoResumeSilentMs 3min 错开，
// 让 runner 自身恢复路径先跑；30min 视为「runner 恢复也未能站稳」的深冷却，由实测健康放行）
const patrolReviveSilentMs = 30 * 60 * 1000

// ruleHealthCheckOne 单规则探活：走与真实采集完全一致的 loadRule→engineRuleBody→
// /api/test(listRule) 契约路径。返回 (健康, 延迟ms, 备注)。
func ruleHealthCheckOne(ruleID int64, siteURL string) (bool, int64, string) {
	if strings.TrimSpace(siteURL) == "" {
		return false, 0, "入口 URL 为空"
	}
	id := int(ruleID)
	lr := loadRule(&id)
	s0 := time.Now()
	res := callEngine[struct {
		List *struct {
			Items []ListItem `json:"items"`
		} `json:"list"`
	}]("/api/test", engineRuleBody(siteURL, map[string]any{"listRule": lr.ListRule}, lr, ""))
	latencyMs := time.Since(s0).Milliseconds()
	if !res.OK {
		return false, latencyMs, truncateRunes(res.Error, 200)
	}
	n := 0
	if res.Data.List != nil {
		for _, it := range res.Data.List.Items {
			if it.URL != "" {
				n++
			}
		}
	}
	if n > 0 {
		return true, latencyMs, ""
	}
	if res.SoftBlock {
		return false, latencyMs, "HTTP 200 空壳（软拦截/挑战竞态）"
	}
	return false, latencyMs, "入口可访问但 0 条目（选择器或入口页漂移）"
}

// ruleHealthUpsert 巡检结果落库（幂等 upsert，连击计数在 SQL 内维护）。
// 首插分支（无既有行）：okStreak/failStreak 按 ok 结果二选一置 1（旧实现硬编码
// okStreak=1/failStreak=0，首轮失败的规则被虚标 okStreak=1 连败恒 0——61-R4 自测实证）。
func ruleHealthUpsert(ruleID int64, ok bool, latencyMs int64, note string) error {
	now := time.Now().UnixMilli()
	okInt := 0
	if ok {
		okInt = 1
	}
	_, err := exec(
		`INSERT INTO "RuleHealth" ("ruleId","lastCheckAt","lastOK","lastLatencyMs","okStreak","failStreak","lastNote","updatedAt")
                 VALUES (?,?,?,?,?,?,?,?)
                 ON CONFLICT("ruleId") DO UPDATE SET
                   "lastCheckAt" = "excluded"."lastCheckAt",
                   "lastOK" = "excluded"."lastOK",
                   "lastLatencyMs" = "excluded"."lastLatencyMs",
                   "okStreak" = CASE WHEN "excluded"."lastOK" THEN "RuleHealth"."okStreak" + 1 ELSE 0 END,
                   "failStreak" = CASE WHEN "excluded"."lastOK" THEN 0 ELSE "RuleHealth"."failStreak" + 1 END,
                   "lastNote" = "excluded"."lastNote",
                   "updatedAt" = "excluded"."updatedAt"`,
		ruleID, now, ok, latencyMs, okInt, 1-okInt, truncateRunes(note, 200), now)
	return err
}

// ruleHealthByRule 一次性读全部巡检结果（API/admin 装配用），ruleId → 行 map。
// 缺列/缺表安全：调用方（GET /api/scrape-rules、admin 首屏）在表尚未建出时降级为
// 无健康字段（bool false 短路），不影响规则面板主功能。
func ruleHealthByRule() map[int64]map[string]any {
	out := map[int64]map[string]any{}
	err := queryList(
		`SELECT "ruleId","lastCheckAt","lastOK","lastLatencyMs","okStreak","failStreak","lastNote" FROM "RuleHealth"`,
		func(rs *sql.Rows) error {
			var ruleID, lastCheckAt, latencyMs, okStreak, failStreak int64
			var lastOK bool
			var lastNote string
			if err := rs.Scan(&ruleID, &lastCheckAt, &lastOK, &latencyMs, &okStreak, &failStreak, &lastNote); err != nil {
				return nil // 单行脏数据跳过，不拖垮整体装配
			}
			out[ruleID] = map[string]any{
				"lastCheckAt":   lastCheckAt,
				"lastOK":        lastOK,
				"lastLatencyMs": latencyMs,
				"okStreak":      okStreak,
				"failStreak":    failStreak,
				"lastNote":      lastNote,
			}
			return nil
		})
	if err != nil {
		return map[int64]map[string]any{}
	}
	return out
}
