/**
 * audit_r115_test.go —— R115 引擎侧改动的回归锁：
 *   ① dip 默认深度 100→150ms（R114 遗留③落地；限流即归零 + 25ms/拍回升的自动保护不变）
 *   ② 限流信号观测面：noteAdaptiveRateLimited 计数（槽级累计 + 最后时刻）+
 *      hostSlotStatsFor/snapshotRateLimitedSlots 透出（R114 遗留③观测前置）
 *   ③ dip 重建拍数语义：150ms 上限 = 6 个干净成功拍重建（观测口径说明性断言）
 */
package main

import (
        "fmt"
        "testing"
        "time"
)

// TestDipMaxDefault_R115 锁定新默认深度（无 env 时 150；限流归零语义已有 r108_test 覆盖）
func TestDipMaxDefault_R115(t *testing.T) {
        if getenv("SCRAPER_DIP_MAX_MS") != "" || getenv("SCRAPER_AIMD_DIP_OFF") != "" {
                t.Skip("环境已配置 dip 参数，跳过默认值断言")
        }
        if got := dipMaxMS(); got != 150 {
                t.Fatalf("dipMaxMS 默认应为 150（R115 调优），got %d", got)
        }
}

// TestRateLimitedObservability_R115 限流信号观测：计数/最后时刻/归零联动/全量快照
func TestRateLimitedObservability_R115(t *testing.T) {
        slotKey := fmt.Sprintf("r115-rl-test-%d.example.com", time.Now().UnixNano())
        // 前置：干净成功若干拍 → 下探位建立（验证限流信号同时归零下探）
        slot := getHostSlot(slotKey)
        for i := 0; i < 10; i++ {
                noteAdaptiveSuccess(slotKey)
        }
        if slot.dipMs.Load() <= 0 {
                t.Fatalf("前置：干净成功应建立下探位，got %d", slot.dipMs.Load())
        }

        // 两次限流信号 → 计数=2、最后时刻>0、下探归零
        noteAdaptiveRateLimited(slotKey, nil)
        noteAdaptiveRateLimited(slotKey, nil)
        if got := slot.rateLimited.Load(); got != 2 {
                t.Fatalf("rateLimited 计数应为 2，got %d", got)
        }
        if slot.dipMs.Load() != 0 {
                t.Fatalf("限流信号应归零下探位，got %d", slot.dipMs.Load())
        }
        if slot.lastRateLimitedNano.Load() <= 0 {
                t.Fatalf("lastRateLimitedNano 应被记录")
        }

        stats, ok := hostSlotStatsFor(slotKey)
        if !ok {
                t.Fatalf("hostSlotStatsFor 应命中已建槽")
        }
        if stats.RateLimited != 2 {
                t.Fatalf("stats.RateLimited 应为 2，got %d", stats.RateLimited)
        }
        if stats.LastRateLimitedAtMs <= 0 {
                t.Fatalf("stats.LastRateLimitedAtMs 应为正（Unix 毫秒），got %d", stats.LastRateLimitedAtMs)
        }
        if stats.DipMS != 0 {
                t.Fatalf("stats.DipMS 应为 0（限流归零），got %d", stats.DipMS)
        }

        // 全量快照：命中本槽且计数一致；限流后 dip 从零重建（25ms/拍）
        rows := snapshotRateLimitedSlots()
        found := false
        for _, r := range rows {
                if r.Slot == slotKey {
                        found = true
                        if r.Count != 2 {
                                t.Fatalf("快照 Count 应为 2，got %d", r.Count)
                        }
                        if r.LastAtMs != stats.LastRateLimitedAtMs {
                                t.Fatalf("快照 LastAtMs 与单槽口径不一致： %d vs %d", r.LastAtMs, stats.LastRateLimitedAtMs)
                        }
                }
        }
        if !found {
                t.Fatalf("snapshotRateLimitedSlots 应包含 %s", slotKey)
        }

        // 限流后 dip 从零重建：先衰减 AIMD 退避位（-100ms/拍）至基础间隔，随后干净成功
        // 拍开始下探（+25ms/拍）——两条曲线互斥语义（R108 既有行为）的观测面联动验证。
        // 两次无限流头的 429 → aimd 1200×1.5²=2700ms，衰减至基础间隔需 15 拍（第 16 拍 dip+25）
        for i := 0; i < 20; i++ {
                noteAdaptiveSuccess(slotKey)
                if slot.dipMs.Load() > 0 {
                        break
                }
        }
        if got := slot.dipMs.Load(); got != 25 {
                t.Fatalf("限流后 AIMD 衰减至基础间隔的首个成功拍应重建下探 25ms，got %d (aimd=%d)", got, slot.aimdMs.Load())
        }
}

// TestRateLimitedSnapshotOrder_R115 快照按次数降序 + 上限 64 行
func TestRateLimitedSnapshotOrder_R115(t *testing.T) {
        base := time.Now().UnixNano()
        hi := fmt.Sprintf("r115-ord-hi-%d.example.com", base)
        lo := fmt.Sprintf("r115-ord-lo-%d.example.com", base)
        noteAdaptiveRateLimited(hi, nil)
        noteAdaptiveRateLimited(hi, nil)
        noteAdaptiveRateLimited(hi, nil)
        noteAdaptiveRateLimited(lo, nil)
        rows := snapshotRateLimitedSlots()
        idxHi, idxLo := -1, -1
        for i, r := range rows {
                switch r.Slot {
                case hi:
                        idxHi = i
                case lo:
                        idxLo = i
                }
        }
        if idxHi < 0 || idxLo < 0 {
                t.Fatalf("快照应同时包含 hi/lo 槽")
        }
        if idxHi > idxLo {
                t.Fatalf("快照应按次数降序：hi(3)@%d 应先于 lo(1)@%d", idxHi, idxLo)
        }
}
