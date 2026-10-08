/**
 * miniproxypool.go —— R103 全局代理出口池（自动搜代理 + 连通性测试 + 筛选沉淀 + 规则补种）。
 *
 * 用户指令「代理池改造，可自动去网上搜索代理，并进行连通性测试，筛选」。改造前
 * proxywatch.go 只对「enabled 且 proxy 非空」的规则做池内换血，存在三大缺口：
 *   ① proxy 为空的规则永远不会被补种——黑洞站（huangjinwu/23qb）、407 清空站（trxsw）
 *      的规则池空了就永久无人问津；
 *   ② 探测过的优质口直接丢弃——每轮候选探测完即弃，规则间无法共享验证成果；
 *   ③ 无可见性——没有 API/页面能看到池子状态。
 *
 * 本组件补齐（与 proxywatch.go 的规则级换血互补，职责分层）：
 *
 *   收割循环（5min/轮，PROXYPOOL_OFF=1 停用）：
 *     1. 多源拉取候选（复用 fetchProxyCandidates 5 源并行）→ ProxyExit INSERT OR IGNORE
 *     2. 选探测集：未探测新口优先 + 活口最旧优先 + 死口满 24h 的复活候选，上限 160
 *     3. 并发连通性测试（复用 proxyProbeAll，204 探测目标 + 407 判死 + 时延记录）
 *     4. 写回筛选：活口 okN+1/连败清零/时延更新；死口连败 +1，达 3 次判 dead=1
 *     5. 池治理：活口超 300 删最慢；死口超 7 天清理
 *     6. 规则补种 assignNeededRuleProxies：直连不健康（RuleHealth lastOK=0 或连败≥2）
 *        且 proxy='' 的规则——正是黑洞站/407 站——从池内快口做站点级验证（对
 *        rule.siteUrl 实测）后自动填入 proxy（Top-4），完成「直连失败 → 自动获得
 *        代理出口」闭环。直连健康的规则绝不补代理（免费口只会劣化正常站点）。
 *
 *   API：
 *     GET  /api/proxypool        池统计（总数/活口/死口/Top 快口/最近收割）
 *     POST /api/proxypool/harvest 手动触发一轮收割（异步）
 */
package main

import (
        "database/sql"
        "log"
        "net/http"
        "strings"
        "time"
)

const (
        proxyPoolInterval     = 5 * time.Minute
        proxyPoolProbeBatch   = 160 // 每轮探测集上限
        proxyPoolAliveCap     = 300 // 活口容量上限（超出删最慢）
        proxyPoolFailDead     = 3   // 连败 N 次判死
        proxyPoolDeadRevive   = 24 * time.Hour // 死口复活探测间隔
        proxyPoolDeadGC       = 7 * 24 * time.Hour // 死口保留期（超时清理）
        proxyPoolProbeRefresh = 10 * time.Minute   // 活口最短重探间隔
        proxyPoolSeedPerRule  = 4                  // 空池规则补种口数
        proxyPoolRuleBudget   = 20                 // 单规则站点级验证预算（候选尝试上限）
)

// proxy204Target 连通性测试目标（204 generate_204）：经代理完成 TCP+TLS+HTTP 往返即
// 证明出口可用；响应状态不苛求 204（部分免费口会缓存改写状态码），407（代理要求认证）
// 仍由 probeProxyViaProxy 判死。探测目标与抓取链完全隔离。
const proxy204Target = "http://connect.rom.miui.com/generate_204"

// lastHarvestAtMs 最近一次收割完成时间（API 观测）
var lastHarvestAtMs int64

// startProxyPoolHarvest 收割循环（runner/all 模式启动；PROXYPOOL_OFF=1 停用）。
// 启动 90s 后首跑（避开服务启动时采集热路径与引擎预热窗口）。
func startProxyPoolHarvest() {
        if envOff("PROXYPOOL_OFF") {
                log.Printf("[proxy-pool] PROXYPOOL_OFF=1，全局代理池收割停用")
                return
        }
        go func() {
                time.Sleep(90 * time.Second)
                for {
                        func() {
                                defer func() {
                                        if r := recover(); r != nil {
                                                log.Printf("[proxy-pool] harvest panic(已恢复): %v", r)
                                        }
                                }()
                                proxyPoolOnce()
                        }()
                        time.Sleep(proxyPoolInterval)
                }
        }()
}

// proxyPoolOnce 单轮收割：候选入库 → 选探测集 → 并发连通性测试 → 写回筛选 → 池治理 → 规则补种。
func proxyPoolOnce() {
        t0 := time.Now()
        harvested := proxyPoolIngestCandidates()
        probed := proxyPoolProbeRound()
        alive, dead := proxyPoolHousekeeping()
        fed := assignNeededRuleProxies()
        lastHarvestAtMs = nowMillis()
        log.Printf("[proxy-pool] 收割完成：新候选 %d，探测 %d（活 %d/死 %d），池 %d 活 %d 死，补种规则 %d 条，耗时 %s",
                harvested, probed, probedAliveN, probedDeadN, alive, dead, fed, time.Since(t0).Round(time.Second))
}

// proxyPoolIngestCandidates 多源拉取候选入库（INSERT OR IGNORE 幂等；source 标记 harvest）。
// 返回新入库数。
func proxyPoolIngestCandidates() int {
        candidates := fetchProxyCandidates()
        if len(candidates) == 0 {
                return 0
        }
        now := nowMillis()
        inserted := 0
        for _, p := range candidates {
                res, err := execRetry(`INSERT OR IGNORE INTO "ProxyExit" ("proxy","source","createdAt","updatedAt") VALUES (?, 'harvest', ?, ?)`,
                        p, now, now)
                if err != nil {
                        continue
                }
                if n, _ := res.RowsAffected(); n > 0 {
                        inserted++
                }
        }
        return inserted
}

// proxyPoolProbeRound 选择并探测一轮出口，写回结果。返回探测总数与存活数（包级变量记录摘要供日志）。
var probedAliveN, probedDeadN int

func proxyPoolProbeRound() int {
        now := nowMillis()
        // 探测集三分：①从未探测的新口 ②活口到重探期 ③死口到复活期——均按最旧优先
        probes := make([]string, 0, proxyPoolProbeBatch)
        _ = queryList(`SELECT "proxy" FROM "ProxyExit" WHERE "lastProbeAt" = 0 ORDER BY "id" ASC LIMIT ?`,
                func(rs *sql.Rows) error {
                        var p string
                        if err := rs.Scan(&p); err != nil {
                                return err
                        }
                        probes = append(probes, p)
                        return nil
                }, proxyPoolProbeBatch)
        if len(probes) < proxyPoolProbeBatch {
                _ = queryList(`SELECT "proxy" FROM "ProxyExit" WHERE "dead" = 0 AND "lastProbeAt" > 0 AND "lastProbeAt" <= ? ORDER BY "lastProbeAt" ASC LIMIT ?`,
                        func(rs *sql.Rows) error {
                                var p string
                                if err := rs.Scan(&p); err != nil {
                                        return err
                                }
                                probes = append(probes, p)
                                return nil
                        }, now-addMillis(proxyPoolProbeRefresh), proxyPoolProbeBatch-len(probes))
        }
        if len(probes) < proxyPoolProbeBatch {
                _ = queryList(`SELECT "proxy" FROM "ProxyExit" WHERE "dead" = 1 AND "lastFailAt" > 0 AND "lastFailAt" <= ? ORDER BY "lastFailAt" ASC LIMIT ?`,
                        func(rs *sql.Rows) error {
                                var p string
                                if err := rs.Scan(&p); err != nil {
                                        return err
                                }
                                probes = append(probes, p)
                                return nil
                        }, now-addMillis(proxyPoolDeadRevive), proxyPoolProbeBatch-len(probes))
        }
        if len(probes) == 0 {
                return 0
        }
        markArgs := make([]any, 0, len(probes)+1)
        markArgs = append(markArgs, now)
        for _, p := range probes {
        	markArgs = append(markArgs, p)
        }
        _, _ = execRetry(`UPDATE "ProxyExit" SET "lastProbeAt" = ? WHERE "proxy" IN (`+sqlPlaceholders(len(probes))+`)`, markArgs...)
        results := proxyProbeAll(probes, proxy204Target)
        okSet := map[string]int64{}
        for _, pr := range results {
                okSet[pr.proxy] = pr.ms
        }
        aliveN, deadN := 0, 0
        for _, p := range probes {
                if ms, ok := okSet[p]; ok {
                        // 活口：okN+1、连败清零、时延 EWMA 平滑（旧时延 1/2 权重）、dead 复位
                        _, _ = execRetry(`UPDATE "ProxyExit" SET "okN" = "okN" + 1, "failStreak" = 0, "dead" = 0,
                                "ms" = CASE WHEN "ms" <= 0 THEN ? ELSE ("ms" + ?) / 2 END,
                                "lastOkAt" = ?, "lastFailAt" = 0, "updatedAt" = ? WHERE "proxy" = ?`,
                                ms, ms, now, now, p)
                        aliveN++
                } else {
                        _, _ = execRetry(`UPDATE "ProxyExit" SET "failN" = "failN" + 1, "failStreak" = "failStreak" + 1,
                                "dead" = CASE WHEN "failStreak" + 1 >= ? THEN 1 ELSE "dead" END,
                                "lastFailAt" = ?, "updatedAt" = ? WHERE "proxy" = ?`,
                                proxyPoolFailDead, now, now, p)
                        deadN++
                }
        }
        probedAliveN, probedDeadN = aliveN, deadN
        return len(probes)
}

// proxyPoolHousekeeping 池治理：活口超容删最慢、死口过期清理。返回 (活, 死) 计数。
func proxyPoolHousekeeping() (int, int) {
        var alive, dead int
        _ = queryOne(`SELECT COUNT(*) FROM "ProxyExit" WHERE "dead" = 0`, []any{&alive})
        _ = queryOne(`SELECT COUNT(*) FROM "ProxyExit" WHERE "dead" = 1`, []any{&dead})
        if alive > proxyPoolAliveCap {
        // 分层淘汰（R103 修正）：DELETE IN 子查询是「删除排序」——先删已探测慢口（tier DESC），
        // 实测快口（okN>=1）最后删——旧实现 ORDER BY ms DESC 会把 ms=0 的未探测口
        // 排在快口之后，把唯一有实测时延的快口整批误删（首轮实证：60 快口全灭）。
        res, err := execRetry(`DELETE FROM "ProxyExit" WHERE "dead" = 0 AND "id" IN (
                        SELECT "id" FROM "ProxyExit" WHERE "dead" = 0 ORDER BY
                                CASE WHEN "okN" >= 1 THEN 0 WHEN "lastProbeAt" = 0 THEN 1 ELSE 2 END DESC,
                                "ms" DESC, "id" ASC LIMIT ?)`,
                        alive-proxyPoolAliveCap)
                if err == nil {
                        if n, _ := res.RowsAffected(); n > 0 {
                                log.Printf("[proxy-pool] 活口超容，淘汰最慢 %d 口（余 %d）", n, proxyPoolAliveCap)
                                alive = proxyPoolAliveCap
                        }
                }
        }
        gcBefore := nowMillis() - int64(proxyPoolDeadGC/time.Millisecond)
        if res, err := execRetry(`DELETE FROM "ProxyExit" WHERE "dead" = 1 AND "lastFailAt" > 0 AND "lastFailAt" < ?`, gcBefore); err == nil {
                if n, _ := res.RowsAffected(); n > 0 {
                        log.Printf("[proxy-pool] 清理超期死口 %d 条", n)
                        dead -= int(n)
                        if dead < 0 {
                                dead = 0
                        }
                }
        }
        return alive, dead
}

// assignNeededRuleProxies 规则补种：直连不健康且 proxy 为空的规则，从池内快口做站点级
// 验证后自动填入。返回补种成功的规则数。
// 「直连不健康」口径：RuleHealth.lastOK=0 或 failStreak≥2（表无该规则行 = 从未失败 = 健康，不补）。
func assignNeededRuleProxies() int {
        type ruleRow struct {
                id      int64
                name    string
                siteURL string
        }
        rows := make([]ruleRow, 0, 8)
        if err := queryList(`SELECT r."id", r."name", r."siteUrl" FROM "ScrapeRule" r
                LEFT JOIN "RuleHealth" h ON h."ruleId" = r."id"
                WHERE r."enabled" = 1 AND r."proxy" = '' AND r."siteUrl" != ''
                  AND (IFNULL(h."lastOK", 1) = 0 OR IFNULL(h."failStreak", 0) >= 2)
                ORDER BY r."id" ASC`,
                func(rs *sql.Rows) error {
                        var rr ruleRow
                        if err := rs.Scan(&rr.id, &rr.name, &rr.siteURL); err != nil {
                                return err
                        }
                        rows = append(rows, rr)
                        return nil
                }); err != nil || len(rows) == 0 {
                return 0
        }
        // 候选：活口按 ms 升序，批内取用（游标推进避免多规则同质化）
        pool := make([]string, 0, 64)
        _ = queryList(`SELECT "proxy" FROM "ProxyExit" WHERE "dead" = 0 AND "okN" >= 1 ORDER BY "ms" ASC LIMIT 80`,
                func(rs *sql.Rows) error {
                        var p string
                        if err := rs.Scan(&p); err != nil {
                                return err
                        }
                        pool = append(pool, p)
                        return nil
                })
        if len(pool) == 0 {
                return 0
        }
        fed := 0
        used := map[string]bool{} // 本轮已被前序规则取走的口
        for _, rr := range rows {
                // 站点级验证候选（预算内、批内去重）——R103: 复用 proxyProbeAll 并发探测
                //（24 并发 × 8s 超时），旧实现逐口串行最坏 5 规则×20口×8s=13min 拖垮收割节拍
                cands := make([]string, 0, proxyPoolRuleBudget)
                for _, p := range pool {
                        if len(cands) >= proxyPoolRuleBudget {
                                break
                        }
                        if used[p] {
                                continue
                        }
                        cands = append(cands, p)
                }
                if len(cands) == 0 {
                        break // 池内候选耗尽
                }
                okProbes := proxyProbeAll(cands, rr.siteURL)
                proxyProbesSortByMs(okProbes) // 快口优先
                seeded := make([]string, 0, proxyPoolSeedPerRule)
                for _, pr := range okProbes {
                        if len(seeded) >= proxyPoolSeedPerRule {
                                break
                        }
                        seeded = append(seeded, pr.proxy)
                        used[pr.proxy] = true
                }
                for _, c := range cands { // 未通过站测的候选本轮不再给后续规则重复试（预算共享）
                        used[c] = true
                }
                if len(seeded) == 0 {
                        continue
                }
                if _, err := execRetry(`UPDATE "ScrapeRule" SET "proxy" = ?, "updatedAt" = ? WHERE "id" = ? AND "proxy" = ''`,
                        strings.Join(seeded, ","), nowMillis(), rr.id); err != nil {
                        continue
                }
                fed++
                log.Printf("[proxy-pool] 规则 #%d《%s》直连不健康 → 自动补种 %d 个站点实测通过代理口",
                        rr.id, truncateRunes(rr.name, 20), len(seeded))
        }
        return fed
}

// ---------- API ----------

func init() {
        register("GET", "/api/proxypool", handleProxyPoolStats)
        register("POST", "/api/proxypool/harvest", handleProxyPoolHarvest)
}

// handleProxyPoolStats GET /api/proxypool —— 池统计观测面。
func handleProxyPoolStats(w http.ResponseWriter, r *http.Request, _ map[string]string) {
        resp := map[string]any{"ok": true}
        var total, alive, dead int
        _ = queryOne(`SELECT COUNT(*) FROM "ProxyExit"`, []any{&total})
        _ = queryOne(`SELECT COUNT(*) FROM "ProxyExit" WHERE "dead" = 0`, []any{&alive})
        _ = queryOne(`SELECT COUNT(*) FROM "ProxyExit" WHERE "dead" = 1`, []any{&dead})
        resp["total"] = total
        resp["alive"] = alive
        resp["dead"] = dead
        resp["lastHarvestAt"] = lastHarvestAtMs
        top := make([]map[string]any, 0, 10)
        _ = queryList(`SELECT "proxy","ms","okN","failN" FROM "ProxyExit" WHERE "dead" = 0 AND "okN" >= 1 ORDER BY "ms" ASC LIMIT 10`,
                func(rs *sql.Rows) error {
                        var p string
                        var ms, okN, failN int64
                        if err := rs.Scan(&p, &ms, &okN, &failN); err != nil {
                                return err
                        }
                        top = append(top, map[string]any{"proxy": p, "ms": ms, "okN": okN, "failN": failN})
                        return nil
                })
        resp["top"] = top
        // 需要补种但池空/无合格口的规则（观测黑洞站卡点）
        waiting := 0
        _ = queryOne(`SELECT COUNT(*) FROM "ScrapeRule" r LEFT JOIN "RuleHealth" h ON h."ruleId" = r."id"
                WHERE r."enabled" = 1 AND r."proxy" = '' AND r."siteUrl" != ''
                  AND (IFNULL(h."lastOK", 1) = 0 OR IFNULL(h."failStreak", 0) >= 2)`, []any{&waiting})
        resp["rulesWaiting"] = waiting
        writeJSON(w, 200, resp)
}

// handleProxyPoolHarvest POST /api/proxypool/harvest —— 手动触发一轮收割（异步，立即返回）。
func handleProxyPoolHarvest(w http.ResponseWriter, r *http.Request, _ map[string]string) {
        go func() {
                defer func() {
                        if r := recover(); r != nil {
                                log.Printf("[proxy-pool] manual harvest panic(已恢复): %v", r)
                        }
                }()
                proxyPoolOnce()
        }()
        writeJSON(w, 200, map[string]any{"ok": true, "message": "收割已异步启动，稍后 GET /api/proxypool 观察结果"})
}

// ---------- 小工具 ----------

// addMillis 毫秒时长转毫秒数（负数，用于 SQL 比较 lastProbeAt <= now-interval）
func addMillis(d time.Duration) int64 { return int64(d / time.Millisecond) }
