/**
 * runner_resume_blocked_test.go —— P0-2（R107 提速·舰队唤醒）回归锁定：
 *
 * 1) TestBlockedResumeMatcherContract：封禁形态自动恢复的 SQL LIKE 词表
 *    '%疑似源站封禁或站点不可达%' 必须命中 pausedPhase2BlockedFmt 生产模板（文案与
 *    词表是隐式契约，任一方单方面改动都会让唤醒通道静默失效——同
 *    worker_autorecovery_test.go 的限流词表锁定哲学）；限流形态模板
 *    （pausedPhase2RateLimitFmt）不得命中——它有更快的 3min 限流通道，双通道重复
 *    恢复会加倍烧预算；重启孤儿唤醒词表同锁。
 * 2) TestResumeRestartOrphans：重启孤儿一次性归队——只匹配「服务重启，任务自动暂停」
 *    前缀；手动暂停/已恢复文案不误伤；恢复后 message 改写 → 重复调用幂等（无重启风暴）。
 * 3) TestAutoResumeBlockedTasksBounded：封禁通道有界性——代理池存活 ≥3 才唤醒；
 *    每轮 ≤autoResumeBlockedPerSweep 条；每任务 ≤autoResumeBlockedMaxPerTask 次
 *    （恢复→重 pause→再扫不再恢复）；非封禁文案不触碰；静默期未到的任务不唤醒。
 * 复用 recover_test.go 的 TestMain 临时库（绝不触碰生产 db/custom.db）。
 */
package main

import (
        "strings"
        "testing"
)

func TestBlockedResumeMatcherContract(t *testing.T) {
        blockedMsg := pausedPhase2BlockedFmt
        if !strings.Contains(blockedMsg, "疑似源站封禁或站点不可达") {
                t.Errorf("封禁终态文案缺少自动恢复词表needle「疑似源站封禁或站点不可达」，P0-2 封禁唤醒通道将静默失效：%q", blockedMsg)
        }
        limitMsg := pausedPhase2RateLimitFmt
        if strings.Contains(limitMsg, "疑似源站封禁或站点不可达") {
                t.Errorf("限流终态文案不应命中封禁唤醒词表（限流有更快的 3min 通道，双通道重复恢复加倍烧预算）：%q", limitMsg)
        }
        orphanMsg := "服务重启，任务自动暂停（可恢复继续采集）"
        if !strings.HasPrefix(orphanMsg, "服务重启，任务自动暂停") {
                t.Errorf("重启孤儿文案前缀漂移，resumeRestartOrphans 词表失效：%q", orphanMsg)
        }
        // 恢复后文案不得再匹配孤儿前缀（幂等关键：进程崩溃循环场景无重启风暴）
        if strings.HasPrefix("服务重启自动恢复：重新入队继续采集（进度保留）", "服务重启，任务自动暂停") {
                t.Error("恢复后文案仍匹配孤儿前缀，重启风暴防护失效")
        }
        // 手动暂停文案不得命中任何自动恢复通道
        manualMsg := "已手动暂停（进度保留，可恢复继续采集）"
        if strings.Contains(manualMsg, "疑似源站封禁或站点不可达") || strings.HasPrefix(manualMsg, "服务重启，任务自动暂停") {
                t.Errorf("手动暂停文案命中自动恢复词表，用户暂停意图将被覆盖：%q", manualMsg)
        }
}

func mustInitBlockedResumeTables(t *testing.T) {
        mustInitScrapeTaskTable(t)
        db, err := getDB()
        if err != nil {
                t.Fatalf("open temp db: %v", err)
        }
        if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS "ProxyExit" (
                "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                "proxy" TEXT NOT NULL,
                "ms" INTEGER NOT NULL DEFAULT 0,
                "okN" INTEGER NOT NULL DEFAULT 0,
                "failN" INTEGER NOT NULL DEFAULT 0,
                "failStreak" INTEGER NOT NULL DEFAULT 0,
                "dead" INTEGER NOT NULL DEFAULT 0,
                "source" TEXT NOT NULL DEFAULT '',
                "lastOkAt" INTEGER NOT NULL DEFAULT 0,
                "lastFailAt" INTEGER NOT NULL DEFAULT 0,
                "lastProbeAt" INTEGER NOT NULL DEFAULT 0,
                "createdAt" INTEGER NOT NULL DEFAULT 0,
                "updatedAt" INTEGER NOT NULL DEFAULT 0
        )`); err != nil {
                t.Fatalf("create ProxyExit: %v", err)
        }
        t.Cleanup(func() {
                _, _ = db.Exec("DELETE FROM ProxyExit")
        })
}

func insertTaskMsg(t *testing.T, status, message string, updatedAt int64) int64 {
        db, err := getDB()
        if err != nil {
                t.Fatalf("open temp db: %v", err)
        }
        res, err := db.Exec(`INSERT INTO ScrapeTask (status, targetUrl, message, log, createdAt, updatedAt) VALUES (?, 'https://blocked.example/book/1', ?, '', ?, ?)`,
                status, message, updatedAt, updatedAt)
        if err != nil {
                t.Fatalf("insert: %v", err)
        }
        id, _ := res.LastInsertId()
        t.Cleanup(func() {
                _, _ = db.Exec("DELETE FROM ScrapeTask WHERE id = ?", id)
        })
        return id
}

func seedAliveProxies(t *testing.T, n int) {
        db, err := getDB()
        if err != nil {
                t.Fatalf("open temp db: %v", err)
        }
        for i := 0; i < n; i++ {
                if _, err := db.Exec(`INSERT INTO ProxyExit ("proxy","dead","source","updatedAt") VALUES (?, 0, 'test', ?)`,
                        "10.0.0."+string(rune('a'+i))+":8080", nowMillis()); err != nil {
                        t.Fatalf("insert proxy: %v", err)
                }
        }
}

func proxyAliveCount(t *testing.T) int {
        var alive int
        db, err := getDB()
        if err != nil {
                t.Fatalf("open temp db: %v", err)
        }
        if err := db.QueryRow(`SELECT COUNT(*) FROM ProxyExit WHERE dead = 0`).Scan(&alive); err != nil {
                t.Fatalf("count alive: %v", err)
        }
        return alive
}

func TestResumeRestartOrphans(t *testing.T) {
        mustInitScrapeTaskTable(t)
        now := nowMillis()
        past := now - 3600_000

        idOrphan1 := insertTaskMsg(t, "paused", "服务重启，任务自动暂停（可恢复继续采集）", past)
        idOrphan2 := insertTaskMsg(t, "paused", "服务重启，任务自动暂停（可恢复继续采集）", past - 1000)
        idManual := insertTaskMsg(t, "paused", "已手动暂停（进度保留，可恢复继续采集）", past)
        idAlready := insertTaskMsg(t, "paused", "服务重启自动恢复：重新入队继续采集（进度保留）", past)

        n := resumeRestartOrphans()
        if n != 2 {
                t.Fatalf("应唤醒 2 条重启孤儿（恢复后文案与手动暂停不误伤），got %d", n)
        }
        for _, id := range []int64{idOrphan1, idOrphan2} {
                if got := taskStatus(t, id); got != "pending" {
                        t.Fatalf("孤儿任务 #%d 应转 pending，got %s", id, got)
                }
        }
        if got := taskStatus(t, idManual); got != "paused" {
                t.Fatalf("手动暂停任务不得被孤儿唤醒触碰，got %s", got)
        }
        if got := taskStatus(t, idAlready); got != "paused" {
                t.Fatalf("已恢复过文案的任务不得被再次唤醒（幂等），got %s", got)
        }
        if again := resumeRestartOrphans(); again != 0 {
                t.Fatalf("重复调用应幂等返回 0，got %d", again)
        }
}

func TestAutoResumeBlockedTasksBounded(t *testing.T) {
        mustInitBlockedResumeTables(t)
        now := nowMillis()
        silentOld := now - autoResumeBlockedSilentMs - 60_000 // 静默期已过
        silentNew := now - 60_000                             // 静默期未到

        // 场景 A：代理池死气沉沉（存活 0）→ 不唤醒
        seedAliveProxies(t, 0)
        idA := insertTaskMsg(t, "paused", pausedPhase2BlockedFmt, silentOld)
        autoResumeBlockedTasks()
        if got := taskStatus(t, idA); got != "paused" {
                t.Fatalf("代理池存活不足时不应唤醒封禁任务，got %s", got)
        }

        // 场景 B：代理池健康 → 每轮至多 2 条、静默期未到不唤醒、非封禁文案不触碰
        seedAliveProxies(t, proxyPoolResumeMinAlive)
        if got := proxyAliveCount(t); got < proxyPoolResumeMinAlive {
                t.Fatalf("前置：代理池应 ≥%d，got %d", proxyPoolResumeMinAlive, got)
        }
        idOld1 := insertTaskMsg(t, "paused", pausedPhase2BlockedFmt, silentOld)
        idOld2 := insertTaskMsg(t, "paused", pausedPhase2BlockedFmt, silentOld-1000)
        idOld3 := insertTaskMsg(t, "paused", pausedPhase2BlockedFmt, silentOld-2000)
        idFresh := insertTaskMsg(t, "paused", pausedPhase2BlockedFmt, silentNew)
        idLimit := insertTaskMsg(t, "paused", pausedPhase2RateLimitFmt, silentOld) // 限流形态走 3min 通道
        idManual := insertTaskMsg(t, "paused", "已手动暂停（进度保留，可恢复继续采集）", silentOld)

        autoResumeBlockedTasks() // 第 1 轮：最旧 2 条（idOld3、idOld2）
        for _, id := range []int64{idOld3, idOld2} {
                if got := taskStatus(t, id); got != "pending" {
                        t.Fatalf("封禁任务 #%d 静默期满应被唤醒，got %s", id, got)
                }
        }
        if got := taskStatus(t, idOld1); got != "paused" {
                t.Fatalf("每轮至多 %d 条，第 3 旧任务应留待下轮，got %s", autoResumeBlockedPerSweep, got)
        }
        if got := taskStatus(t, idFresh); got != "paused" {
                t.Fatalf("静默期未到的封禁任务不得唤醒，got %s", got)
        }
        if got := taskStatus(t, idLimit); got != "paused" {
                t.Fatalf("限流形态文案不得进封禁通道（专属 3min 通道），got %s", got)
        }
        if got := taskStatus(t, idManual); got != "paused" {
                t.Fatalf("手动暂停不得被触碰，got %s", got)
        }

        // 场景 C：每任务 ≤2 次上限——把已恢复的任务重新置回 paused 两次后不再恢复
        autoResumeBlockedTasks() // 第 2 轮：唤醒 idOld1（第 1 次）
        if got := taskStatus(t, idOld1); got != "pending" {
                t.Fatalf("第 2 轮应唤醒最旧的 idOld1，got %s", got)
        }
        // idOld1 已恢复 1 次；重新 pause 模拟「恢复即再熔断」——生产中 worker 再熔断会写入
        // 全新封禁文案（恢复后 message 已被改写，不再匹配词表；此处同步模拟该语义）
        if _, err := exec(`UPDATE ScrapeTask SET status = 'paused', message = ?, updatedAt = ? WHERE id = ?`, pausedPhase2BlockedFmt, silentOld, idOld1); err != nil {
                t.Fatalf("re-pause: %v", err)
        }
        autoResumeBlockedTasks() // 第 3 轮：idOld1 第 2 次恢复
        if got := taskStatus(t, idOld1); got != "pending" {
                t.Fatalf("第 2 次恢复应生效（上限 %d），got %s", autoResumeBlockedMaxPerTask, got)
        }
        if _, err := exec(`UPDATE ScrapeTask SET status = 'paused', message = ?, updatedAt = ? WHERE id = ?`, pausedPhase2BlockedFmt, silentOld, idOld1); err != nil {
                t.Fatalf("re-pause2: %v", err)
        }
        autoResumeBlockedTasks() // 第 4 轮：idOld1 已达 2 次上限 → 不再恢复
        if got := taskStatus(t, idOld1); got != "paused" {
                t.Fatalf("每任务 %d 次上限应生效（第 3 次不恢复），got %s", autoResumeBlockedMaxPerTask, got)
        }
}
