/**
 * audit_r115_test.go —— R115 章节采集提速三件的回归锁：
 *   ① chapterServiceSample 失败章不采样（R114 遗留②落地——挑战站多策略探索烧穿的
 *      服务耗时不再污染车道回升 EWMA）
 *   ② 挑战站混合流端到端语义：旧采样（成败全收）冻结回升 vs 新采样（仅成功）正常回升
 *
 * 背景：EWMA 采样点原对成败一视同仁。失败链 ElapsedMs 是策略链探索烧穿时长
 * （挑战站每章 8 策略×重试×退避 10-55s），服务耗时部分同样巨大——它度量的是
 * 「本机对抗挑战的成本」而非站点稳态服务速度。挑战站每章探索时 EWMA 被持续顶过
 * 3.5s 阈值 → bumpLaneOnSuccess 恒走冻结分支 → 连捷计数恒清零 → 车道回升永久冻结
 * （与 R112「排队锁死」同构的口径病，只是这次被污染的样本是失败链）。
 */
package main

import "testing"

// ---------- ① chapterServiceSample 采样门 ----------

func TestChapterServiceSample_R115(t *testing.T) {
        cases := []struct {
                name       string
                ok         bool
                total, que int64
                want       int64
        }{
                {"失败章（挑战烧穿 30s）：不采样返回 0（ewmaNext 拒收跳过）", false, 30000, 2000, 0},
                {"失败章（旧引擎 queue=0）：同样不采样", false, 30000, 0, 0},
                {"成功章健康直连：服务=总耗时", true, 1800, 0, 1800},
                {"成功章常规排队：剔除排队取服务", true, 4800, 4000, 800},
                {"成功章旧引擎未埋点：回退旧口径原样返回", true, 5000, 0, 5000},
                {"成功章时钟毛刺（queue>total）：钳 0 跳过", true, 1200, 1500, 0},
        }
        for _, c := range cases {
                if got := chapterServiceSample(c.ok, c.total, c.que); got != c.want {
                        t.Fatalf("%s: chapterServiceSample(%v,%d,%d) = %d, want %d", c.name, c.ok, c.total, c.que, got, c.want)
                }
        }
}

// ---------- ② 挑战站混合流端到端语义 ----------

// TestLaneFreezeSemantic_R115 复现挑战站场景并验证失败不采样解锁：
// 场景=挑战站每 6 章仅 1 章成功（其余多策略探索烧穿：total=30s、queue=2s），
// 成功章 total=1800ms（queue=500ms，服务 1300ms）。
//
//      旧采样（成败全收）：EWMA 被失败样本推高越过 3500 → 恒冻结 → 连捷计数恒清零。
//      新采样（仅成功）：EWMA 稳定在 1300ms 附近 → 永不冻结 → 连捷 24 章正常回升。
//
// 对照锚点：纯成功流在两种口径下都不冻结（站点真慢语义未被误伤——若成功章服务
// 耗时本身超阈，冻结仍会触发，此处用 3s 慢成功验证）。
func TestLaneFreezeSemantic_R115(t *testing.T) {
        // 新口径：混合流仅成功样本进 EWMA
        var ewNew int64
        for i := 0; i < 12; i++ {
                ewNew = ewmaNext(ewNew, chapterServiceSample(false, 30000, 2000)) // 失败：0 → 跳过
                ewNew = ewmaNext(ewNew, chapterServiceSample(false, 28000, 2000))
                ewNew = ewmaNext(ewNew, chapterServiceSample(false, 55000, 3000))
                ewNew = ewmaNext(ewNew, chapterServiceSample(false, 12000, 1000))
                ewNew = ewmaNext(ewNew, chapterServiceSample(false, 30000, 2000))
                ewNew = ewmaNext(ewNew, chapterServiceSample(true, 1800, 500)) // 成功：服务 1300ms
        }
        if ewNew <= 0 {
                t.Fatalf("新口径：成功样本应推进 EWMA，got %d", ewNew)
        }
        if laneBumpFrozen(ewNew) {
                t.Fatalf("新口径：挑战站混合流 EWMA=%d 不应冻结回升（1/6 成功率，成功服务 1300ms）", ewNew)
        }

        // 旧口径对照（成败全收——锁定旧行为防误改回）：同样本流必然冻结
        var ewOld int64
        for i := 0; i < 12; i++ {
                ewOld = ewmaNext(ewOld, ServiceElapsedMs(30000, 2000))
                ewOld = ewmaNext(ewOld, ServiceElapsedMs(28000, 2000))
                ewOld = ewmaNext(ewOld, ServiceElapsedMs(55000, 3000))
                ewOld = ewmaNext(ewOld, ServiceElapsedMs(12000, 1000))
                ewOld = ewmaNext(ewOld, ServiceElapsedMs(30000, 2000))
                ewOld = ewmaNext(ewOld, ServiceElapsedMs(1800, 500))
        }
        if !laneBumpFrozen(ewOld) {
                t.Fatalf("旧口径对照：挑战站混合流 EWMA=%d 应冻结（证明冻结消除来自采样门而非巧合）", ewOld)
        }

        // 站点真慢语义保留：成功章服务耗时本身超阈 → 冻结照旧触发
        var ewSlow int64
        for i := 0; i < 8; i++ {
                ewSlow = ewmaNext(ewSlow, chapterServiceSample(true, 6000, 500))
        }
        if !laneBumpFrozen(ewSlow) {
                t.Fatalf("慢站点保护：成功章服务 5500ms EWMA=%d 应冻结（失败不采样不得误伤真慢语义）", ewSlow)
        }
}
