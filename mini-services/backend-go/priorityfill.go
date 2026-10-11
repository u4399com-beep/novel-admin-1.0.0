/**
 * priorityfill.go —— R111 阅读优先填充（关关「追更优先」思路）。
 *
 * 痛点：fleet 周期按列表页顺序填充，读者正在看的书可能排在数千章队列之后——
 * 「书籍页/目录秒开、正文跟不上」是采集站体验的第一杀手。本组件把「读者正在看」
 * 变成最高优先级信号：书籍页渲染时发现缺章 → 自动建一条 single 任务（目标=该书
 * 源站页，ruleId 按 sourceUrl host 匹配 enabled 规则），runner 2s 内领取，
 * Phase 1 书页+目录（秒级）→ Phase 2 只填该书缺失章节。
 *
 * 治理（防读者浏览引发任务风暴）：
 *   - 每书冷却 30min（进程内 map，重启即清——DB 活跃任务检查兜底重启窗口）
 *   - 同目标 URL 在途任务（pending/running）去重（paused=休眠不占资源，不拦——
 *     降级舰队里 paused 任务可长期堆压，若算入去重/上限会让优先填充永不触发，
 *     R111 首次端到端实测踩坑）
 *   - 全局在途任务上限 15（仅 pending/running；fleet 已饱和时不再加压）
 *   - 每分钟最多触发 2 条（滑动窗口；突发浏览不会瞬间建一堆任务）
 *   - 缺章 ≥1 即触发（冷却与上限已防滥用），无 sourceUrl 的存量书跳过
 *     （fleet 重扫经 upsertBook 空值回填后自愈）
 *
 * 全路径 best-effort：任何失败只落 backend 日志，绝不影响书籍页渲染。
 */
package main

import (
        "database/sql"
        "fmt"
        "log"
        "net/url"
        "strings"
        "sync"
)

const (
        prioFillBookCooldownMs = 30 * 60 * 1000 // 每书触发冷却
        prioFillMaxActiveTasks = 15             // 全局活跃任务上限（含 fleet）
        prioFillPerMinute      = 2              // 每分钟最多触发条数
        prioSourceURLMax       = 500
)

var (
        prioMu       sync.Mutex
        prioLastMs   = map[int]int64{} // novelID → 上次触发时刻 ms
        prioMinuteTs = []int64{}       // 触发时刻滑动窗口（每分钟预算）
)

// hostOfURLSafe URL host 提取（解析失败返回空串）
func hostOfURLSafe(raw string) string {
        u, err := url.Parse(trimSpaceStr(raw))
        if err != nil {
                return ""
        }
        return strings.ToLower(u.Hostname())
}

// triggerPriorityFill 书籍页缺章时的自动优先填充入口（异步安全，可同步调用——
// 内部全路径护栏，最坏情况是一次幂等 DB 查询）。novelID/missingCount 仅用于日志。
func triggerPriorityFill(novelID int, missingCount int) {
        defer func() {
                if r := recover(); r != nil {
                        log.Printf("[priority-fill] panic(已恢复): %v", r)
                }
        }()

        // ---- 护栏①：全局每分钟预算 ----
        now := nowMillis()
        prioMu.Lock()
        recent := prioMinuteTs[:0]
        for _, ts := range prioMinuteTs {
                if now-ts < 60_000 {
                        recent = append(recent, ts)
                }
        }
        prioMinuteTs = recent
        if len(prioMinuteTs) >= prioFillPerMinute {
                prioMu.Unlock()
                return
        }
        // ---- 护栏②：每书冷却 ----
        if last, ok := prioLastMs[novelID]; ok && now-last < prioFillBookCooldownMs {
                prioMu.Unlock()
                return
        }
        // 预占窗口（触发失败也计预算——护栏宁严勿松）
        prioMinuteTs = append(prioMinuteTs, now)
        prioLastMs[novelID] = now
        prioMu.Unlock()

        // ---- 读 sourceUrl（无值跳过：存量书等 fleet 重扫回填）----
        var sourceURL string
        if err := queryOne(`SELECT "sourceUrl" FROM "Novel" WHERE "id" = ?`,
                []any{&sourceURL}, novelID); err != nil || trimSpaceStr(sourceURL) == "" {
                return
        }
        sourceURL = truncateRunes(trimSpaceStr(sourceURL), prioSourceURLMax)

        // ---- 护栏③：同目标在途任务去重（仅 pending/running——paused 休眠不占资源，不拦）----
        var active int
        if err := queryOne(`SELECT COUNT(*) FROM "ScrapeTask" WHERE "targetUrl" = ? AND "status" IN ('pending','running')`,
                []any{&active}, sourceURL); err != nil || active > 0 {
                return
        }

        // ---- 护栏④：全局在途任务上限（仅 pending/running；fleet 饱和时不加压）----
        var totalActive int
        if err := queryOne(`SELECT COUNT(*) FROM "ScrapeTask" WHERE "status" IN ('pending','running')`,
                []any{&totalActive}); err != nil || totalActive >= prioFillMaxActiveTasks {
                return
        }

        // ---- 规则匹配：sourceUrl host ↔ enabled 规则 siteUrl host ----
        bookHost := hostOfURLSafe(sourceURL)
        var ruleID any
        if bookHost != "" {
                type ruleRow struct {
                        id      int64
                        siteURL string
                }
                var rules []ruleRow
                _ = queryList(`SELECT "id","siteUrl" FROM "ScrapeRule" WHERE "enabled" = 1 AND "siteUrl" != ''`,
                        func(rs *sql.Rows) error {
                                var r ruleRow
                                if err := rs.Scan(&r.id, &r.siteURL); err != nil {
                                        return err
                                }
                                rules = append(rules, r)
                                return nil
                        })
                for _, r := range rules {
                        if hostOfURLSafe(r.siteURL) == bookHost {
                                v := r.id
                                ruleID = v
                                break
                        }
                }
        }

        // ---- 建任务（与 POST /api/scrape-tasks 同一条 INSERT 形状；mode=single pages=1）----
        msg := fmt.Sprintf("阅读优先填充：读者访问书籍页自动触发（缺失约 %d 章）", missingCount)
        newID, err := execRetryReturningID(
                `INSERT INTO "ScrapeTask" ("mode","targetUrl","ruleId","pages","storageMode","status","total","done","chaptersDone","chaptersTotal","created","updated","chapters","message","log","createdAt","updatedAt","pageFrom","pageTo")
                 VALUES ('single', ?, ?, 1, 'db', 'pending', 0, 0, 0, 0, 0, 0, 0, ?, '', ?, ?, 0, 0)`,
                sourceURL, ruleID, msg, now, now)
        if err != nil {
                log.Printf("[priority-fill] 书 #%d 建任务失败: %v", novelID, err)
                return
        }
        log.Printf("[priority-fill] 书 #%d 缺 %d 章 → single 任务 #%d（%s）", novelID, missingCount, newID, truncateRunes(sourceURL, 80))
}
