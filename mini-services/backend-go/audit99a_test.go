/**
 * audit99a_test.go —— R99 章节采集效率三层改造的回归锁：
 *  ① isQueueShedErr 排队饱和快速失败判定（救援重试的触发面）
 *  ② ewmaNext / laneBumpFrozen 饱和感知车道回升冻结（boom-bust 震荡根治）
 *  ③ fetchChapterRescued 排队饱和救援重试（shed=未发网络请求，歇压后重试一次）
 *
 * 背景：实测 8 任务并发时聚合填充仅 4254 章/时，域槽授权 ~1600-1800/时/站而
 * 填充仅占授权 27%——根因是 12 车道对 0.5 req/s 的域槽供给过订阅：车道排队 8-17s →
 * 引擎预算闸快速失败（budget-exhausted）→ 车道控制误判限流骤降 → 连捷回升再打满。
 * 另有突发抑制上界 +1s 把有效间隔推到 2.2s（引擎侧 concurrency_test 锁定新曲线）。
 */
package main

import (
        "strings"
        "sync/atomic"
        "testing"
        "time"
)

// ---------- ① isQueueShedErr ----------

func TestIsQueueShedErr_R99(t *testing.T) {
        cases := []struct {
                name string
                err  string
                want bool
        }{
                {
                        "引擎预算闸 shed（链层未预约槽位）",
                        "全部可用策略均抓取失败（fetch-browser: budget-exhausted（限速排队饱和，未预约槽位快速失败，backend 请降并发）; fetch-ua-rotate: budget-exhausted（限速排队饱和，未预约槽位快速失败，backend 请降并发））",
                        true,
                },
                {
                        "预算耗尽但非排队饱和（槽位已授予后预算耗尽，可能已发请求）——不得救援",
                        "全部可用策略均抓取失败（fetch-browser: budget-exhausted（整体时间预算耗尽，停止尝试后续策略））",
                        false,
                },
                {"排队后预算耗尽（已排队已可能发请求）——不得救援", "budget-exhausted（限速排队后预算耗尽）", false},
                {"真实限流 429——不归救援（走 shrinkLanes）", "全部可用策略均抓取失败（fetch-browser: HTTP 429）", false},
                {"引擎请求超时", "引擎请求超时(60s)", false},
                {"软拦截空壳", "正文提取为空：所有选择器均未命中或内容为空", false},
                {"空串", "", false},
        }
        for _, c := range cases {
                if got := isQueueShedErr(c.err); got != c.want {
                        t.Fatalf("%s: isQueueShedErr = %v, want %v", c.name, got, c.want)
                }
        }
}

// ---------- ② ewmaNext / laneBumpFrozen ----------

func TestEwmaNext_R99(t *testing.T) {
        cases := []struct{ cur, ms, want int64 }{
                {0, 2000, 2000},   // 无历史直接采纳
                {0, 8000, 8000},   // 无历史高值也采纳（首章即深队列信号）
                {2000, 4000, 2500}, // α=1/4: 2000 + 2000/4
                {2000, 0, 2000},   // ms<=0 不可信（失败章节）不拖低
                {2000, -5, 2000},  // 负值同上
                {4000, 1200, 3300}, // 回落同样 α=1/4: 4000 + (1200-4000)/4
        }
        for _, c := range cases {
                if got := ewmaNext(c.cur, c.ms); got != c.want {
                        t.Fatalf("ewmaNext(%d,%d) = %d, want %d", c.cur, c.ms, got, c.want)
                }
        }
}

func TestLaneBumpFrozen_R99(t *testing.T) {
        for _, ew := range []int64{0, 1, 1200, 2000, 3500} {
                if laneBumpFrozen(ew) {
                        t.Fatalf("laneBumpFrozen(%d) = true, want false（≤阈值不冻结）", ew)
                }
        }
        for _, ew := range []int64{3501, 4000, 8000, 17000} {
                if !laneBumpFrozen(ew) {
                        t.Fatalf("laneBumpFrozen(%d) = false, want true（>阈值冻结回升）", ew)
                }
        }
}

// ---------- ③ fetchChapterRescued ----------

// fakeChapterFetch 顺序假引擎：按序返回预设结果并记录调用次数（单测串行，无需加锁）
type fakeChapterFetch struct {
        n       int
        results []engineResult[ChapterData]
}

func (f *fakeChapterFetch) impl(u string, rule LoadedRule, referer string) engineResult[ChapterData] {
        i := f.n
        f.n++
        if i < len(f.results) {
                return f.results[i]
        }
        return f.results[len(f.results)-1]
}

func TestFetchChapterRescued_R99(t *testing.T) {
        oldImpl := chapterFetchImpl
        oldBackoff := queueShedBackoff
        defer func() {
                chapterFetchImpl = oldImpl
                queueShedBackoff = oldBackoff
        }()
        queueShedBackoff = 5 * time.Millisecond // 测试零等待

        t.Run("shed失败→救援重试成功", func(t *testing.T) {
                fake := &fakeChapterFetch{results: []engineResult[ChapterData]{
                        {OK: false, Error: "全部可用策略均抓取失败（fetch-browser: budget-exhausted（限速排队饱和，未预约槽位快速失败，backend 请降并发））"},
                        {OK: true, Data: ChapterData{Title: "第1章", Content: "正文", WordCount: 2}, ElapsedMs: 1800},
                }}
                chapterFetchImpl = fake.impl
                var rescued atomic.Int64
                res := fetchChapterRescued("http://x/1.html", LoadedRule{}, "", &rescued)
                if !res.OK || res.Data.Content != "正文" {
                        t.Fatalf("救援后应成功, got OK=%v err=%s", res.OK, res.Error)
                }
                if rescued.Load() != 1 {
                        t.Fatalf("rescued = %d, want 1", rescued.Load())
                }
                if fake.n != 2 {
                        t.Fatalf("应恰重试一次（2 次调用）, got %d", fake.n)
                }
        })

        t.Run("非shed失败不重试", func(t *testing.T) {
                fake := &fakeChapterFetch{results: []engineResult[ChapterData]{
                        {OK: false, Error: "全部可用策略均抓取失败（fetch-browser: HTTP 404）"},
                        {OK: true, Data: ChapterData{Content: "不该到达"}},
                }}
                chapterFetchImpl = fake.impl
                var rescued atomic.Int64
                res := fetchChapterRescued("http://x/2.html", LoadedRule{}, "", &rescued)
                if res.OK {
                        t.Fatal("404 不应被救援成功")
                }
                if fake.n != 1 || rescued.Load() != 0 {
                        t.Fatalf("不重试: calls=%d rescued=%d", fake.n, rescued.Load())
                }
        })

        t.Run("shed但重试仍失败", func(t *testing.T) {
                shedErr := "全部可用策略均抓取失败（fetch-browser: budget-exhausted（限速排队饱和，未预约槽位快速失败，backend 请降并发））"
                fake := &fakeChapterFetch{results: []engineResult[ChapterData]{
                        {OK: false, Error: shedErr},
                        {OK: false, Error: shedErr},
                }}
                chapterFetchImpl = fake.impl
                var rescued atomic.Int64
                res := fetchChapterRescued("http://x/3.html", LoadedRule{}, "", &rescued)
                if res.OK || rescued.Load() != 0 {
                        t.Fatalf("重试仍失败应原样透传: OK=%v rescued=%d", res.OK, rescued.Load())
                }
                if fake.n != 2 || !strings.Contains(res.Error, "budget-exhausted") {
                        t.Fatalf("应恰一次重试并保留原错误: calls=%d err=%s", fake.n, res.Error)
                }
        })

        t.Run("成功路径零开销直通", func(t *testing.T) {
                fake := &fakeChapterFetch{results: []engineResult[ChapterData]{
                        {OK: true, Data: ChapterData{Content: "正文"}, ElapsedMs: 1500},
                }}
                chapterFetchImpl = fake.impl
                var rescued atomic.Int64
                res := fetchChapterRescued("http://x/4.html", LoadedRule{}, "", &rescued)
                if !res.OK || fake.n != 1 || rescued.Load() != 0 || res.ElapsedMs != 1500 {
                        t.Fatalf("成功不应触发重试: OK=%v calls=%d rescued=%d elapsed=%d", res.OK, fake.n, rescued.Load(), res.ElapsedMs)
                }
        })
}

// ---------- ④ 引擎耗时信号解析 ----------

func TestParseElapsedMs_R99(t *testing.T) {
        for _, c := range []struct {
                b   string
                val int64
        }{{"18437", 18437}, {" 1234 ", 1234}, {"", 0}, {"abc", 0}, {"-3", 0}, {"0", 0}, {"1.5", 0}} {
                if got := parseElapsedMs(c.b); got != c.val {
                        t.Fatalf("parseElapsedMs(%q) = %d, want %d", c.b, got, c.val)
                }
        }
}
