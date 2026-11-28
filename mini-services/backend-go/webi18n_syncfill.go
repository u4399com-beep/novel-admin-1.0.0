/**
 * webi18n_syncfill.go —— R190 渲染出口翻译完整性闸（用户指令：在展示之前检查一下
 * 是否已完成翻译，没完成翻译的话就再翻译一遍然后再展示到前台）。
 *
 * 定位：R160 起 en/ja/ko 渲染策略是「未命中原文兜底 + 后台异步预热」——首次访问
 * 显示原文（缓存空库/预热滞后/配额枯竭期体感即「大量文字没翻译」）。本闸把补译
 * 前移到展示前：i18nTexts / i18nChapterParas / i18nSweepHTML 三消费面的未命中段
 * 统一先经 i18nSyncFillMisses 同步补译（:3032 libre 引擎快通道，译文落库即展示），
 * 预算内未完成的残余段维持异步预热渐进收敛——渲染路径永不被翻译栈拖死。
 *
 * 预算模型（libre CPU 推理吞吐 ~0.3-1.5 段/s 实测量级，大页全量同步物理不可行）：
 *   - 分片并行：chunk 段/片 × par 并发片，单片独立短超时（translateUpstreamVia
 *     按剩余预算钳制 client.Timeout）；
 *   - 总预算 deadline：en 20s（单跳）/ ja ko 32s（双跳）——片派发前查剩余预算，
 *     剩余 < 40% 预算的片不再派发（残量转异步），在途片按剩余超时自然收敛；
 *   - 单飞闸：全进程 ≤2 个补译 flight（TryAcquire 非阻塞，忙→本次直接转异步），
 *     防并发渲染叠放打满 :5000 与渲染线程排队。
 *
 * 防回炉闸 i18nLooksTargetLang：ja 含假名/ko 含谚文的段视为已属目标语种（数据面
 * 译文含汉字假名会被 sweep 二次收集——zh→ja 管线回炉日文段产出垃圾译文且 v!=t
 * 会替换显示；跳过即幂等）。en 段无汉字本就被 sweepHasHan 挡住。
 *
 * 观测：syncfillStats 计数并入 GET /api/translate/prefetch/status。
 * 杀开关：I18N_SYNCFILL_OFF=1 整体停用（回退 R164 异步收敛形态）。
 */
package main

import (
        "net/http"
        "os"
        "strings"
        "sync"
        "sync/atomic"
        "time"
)

// ---------- 预算参数 ----------

const (
        syncFillMaxSegs  = 240              // 单次补译段数上限（余量转异步，扫描序优先=页面头部优先）
        syncFillPar      = 2                // 片间并发（:5000 单模型锁串行，并发仅去排队延迟）
        syncFillChunkEn  = 10               // en 单跳片大小
        syncFillChunk2H  = 8                // ja/ko 双跳片大小
        syncFillBudgetEn = 24 * time.Second // en 总预算（等待后台长调用让路后仍有推理窗）
        syncFillBudget2H = 32 * time.Second // ja/ko 总预算（双跳 ×2 时长）
        syncFillDedupMs  = 20_000           // 同段补译尝试去重窗（同请求数据面+sweep 双飞/渲染风暴防抖）
        syncFillChunkTO  = 90 * time.Second // 片超时定值：容忍一个在途后台调用（≤36s）让路后完成推理
        syncFillGraceEn  = 30 * time.Second // flight 硬墙钟宽限（预算耗尽后等在途片收尾：en 一片推理窗）
        syncFillGrace2H  = 45 * time.Second // ja/ko 双跳一片推理窗
)

// syncFillSema 全进程补译单飞闸（≤2 flight；TryAcquire 忙→转异步）
var syncFillSema = make(chan struct{}, 2)

// syncFillParSema 片间并发闸（par 片同时在飞）
var syncFillParSema = make(chan struct{}, syncFillPar)

// syncfillStats 观测计数（atomic；prefetch status API 读）
var syncfillStats struct {
        calls      atomic.Int64 // 补译调用次数（含忙拒/空段）
        flights    atomic.Int64 // 实际执行的 flight 数
        segs       atomic.Int64 // 补译成功落库段数
        busySkip   atomic.Int64 // 单飞闸忙拒次数（转异步）
        deadlineAB atomic.Int64 // 预算中止次数
        fails      atomic.Int64 // 上游失败片数
}

// syncFillActive 渲染优先级反转信号（R190）：flight 执行期 >0，后台预热 worker
// （transbulk 整章长调用/title-warm/prefetch/异步预热）检到即暂停本轮上游调用——
// :5000 是 CPU 串行推理瓶颈，整章 280 段单调用可占数分钟，不避让时补译片在队列
// 中超时空手而归（渲染等了预算却拿不到译文）。交互面优先，让路窗口 = flight 时长。
var syncFillActive atomic.Int32

// ---------- 语种判定 ----------

// i18nLangIsOpenCC OpenCC 词典语种族（渲染路径同步秒级补译既有语义；zh-HK R190 补齐
// ——此前仅 zh-Hant 走同步面，zh-HK 首访原文兜底为既存缺口）
func i18nLangIsOpenCC(lang string) bool {
        return lang == "zh-Hant" || lang == "zh-HK"
}

// i18nLooksTargetLang 段是否已属目标语种（防已译文回炉）：ja 含假名（平/片假名/
// 半角片假名）、ko 含谚文（音节/字母/兼容字母）即视为目标语种文本。
func i18nLooksTargetLang(lang, s string) bool {
        switch lang {
        case "ja":
                for _, r := range s {
                        if (r >= 0x3040 && r <= 0x30FF) || (r >= 0x31F0 && r <= 0x31FF) || (r >= 0xFF66 && r <= 0xFF9D) {
                                return true
                        }
                }
        case "ko":
                for _, r := range s {
                        if (r >= 0xAC00 && r <= 0xD7AF) || (r >= 0x1100 && r <= 0x11FF) || (r >= 0x3130 && r <= 0x318F) {
                                return true
                        }
                }
        }
        return false
}

// ---------- 补译主入口 ----------

// syncFillRecent 同段补译尝试去重（key lang|sha256(text) → 过期毫秒）：同一请求
// 数据面+sweep 双消费面各自触发补译会对同一批失败段双倍打点且双倍拉长渲染
//（实测章节页 2 flight × 20s = 40s 零增量）；TTL 内已尝试段不再入补译面（残余由
// 异步预热/后台产线收敛，TTL 过期后自然重试）。
var syncFillRecent sync.Map

// syncFillDedupFilter 过滤 TTL 内已尝试段，并对入面段登记尝试时间
func syncFillDedupFilter(lang string, texts []string) []string {
        now := nowMillis()
        out := make([]string, 0, len(texts))
        for _, t := range texts {
                key := lang + "|" + translateCacheKey(t, lang)
                if v, ok := syncFillRecent.Load(key); ok {
                        if until, ok2 := v.(int64); ok2 && now < until {
                                continue
                        }
                }
                syncFillRecent.Store(key, now+syncFillDedupMs)
                syncFillRecentCount.Add(1)
                out = append(out, t)
        }
        // 惰性清理：>5000 键全表扫过期剔除（防长驻内存爬升；TTL 20s 下增速有限）
        if syncFillRecentSize() > 5000 {
                n := int64(0)
                syncFillRecent.Range(func(k, v any) bool {
                        if until, ok2 := v.(int64); !ok2 || now >= until {
                                syncFillRecent.Delete(k)
                        } else {
                                n++
                        }
                        return true
                })
                syncFillRecentCount.Store(n)
        }
        return out
}

var syncFillRecentCount atomic.Int64

func syncFillRecentSize() int64 { return syncFillRecentCount.Load() }

// i18nSyncFillMisses 渲染出口同步补译（libre 语种 en/ja/ko 未命中段）：
// 预算内分片并行补译 → 译文落 TranslationCache 普通键 + 短文本 LRU 回填（展示即时
// 生效，本次渲染与其他消费面复用）。返回实际翻好的 {原文→译文} 子集；预算外/失败/
// 忙拒残余由调用方转异步预热（渐进收敛语义不变）。
func i18nSyncFillMisses(lang string, novelID int64, miss []string) map[string]string {
        if len(miss) == 0 || lang == "" || lang == "zh-CN" || i18nLangIsOpenCC(lang) {
                return nil
        }
        if os.Getenv("I18N_SYNCFILL_OFF") == "1" {
                return nil
        }
        syncfillStats.calls.Add(1)
        // 入料过滤：含汉字（纯拉丁/数字无翻译面）+ 非目标语种（防已译文回炉）+ 上限截断
        todo := make([]string, 0, len(miss))
        for _, t := range miss {
                if len([]rune(strings.TrimSpace(t))) < 2 || !sweepHasHan(t) || i18nLooksTargetLang(lang, t) {
                        continue
                }
                todo = append(todo, t)
                if len(todo) >= syncFillMaxSegs {
                        break
                }
        }
        if len(todo) == 0 {
                return nil
        }
        // 同段尝试去重（同请求数据面+sweep 双飞/渲染风暴防抖；TTL 20s）
        todo = syncFillDedupFilter(lang, todo)
        if len(todo) == 0 {
                return nil
        }
        // 单飞闸（非阻塞；忙→转异步不排队——渲染线程绝不为补译排队）
        select {
        case syncFillSema <- struct{}{}:
                defer func() { <-syncFillSema }()
        default:
                syncfillStats.busySkip.Add(1)
                return nil
        }
        syncfillStats.flights.Add(1)
        syncFillActive.Add(1)
        defer syncFillActive.Add(-1)

        chunk := syncFillChunkEn
        budget := syncFillBudgetEn
        if lang != "en" {
                chunk = syncFillChunk2H
                budget = syncFillBudget2H
        }
        deadline := time.Now().Add(budget)
        out := make(map[string]string, len(todo))
        var outMu sync.Mutex
        var wg sync.WaitGroup

        for start := 0; start < len(todo); start += chunk {
                remain := time.Until(deadline)
                if remain <= 0 {
                        syncfillStats.deadlineAB.Add(1)
                        break
                }
                end := start + chunk
                if end > len(todo) {
                        end = len(todo)
                }
                batch := todo[start:end]
                // 片并发闸：占位阻塞受总预算约束（time.After 与 deadline 同源）——
                // 预算耗尽即停止派发，在途片按自身超时收敛
                timedOut := false
                select {
                case syncFillParSema <- struct{}{}:
                case <-time.After(remain):
                        timedOut = true
                }
                if timedOut {
                        syncfillStats.deadlineAB.Add(1)
                        break
                }
                wg.Add(1)
                go func(batch []string) {
                        defer wg.Done()
                        defer func() { <-syncFillParSema }()
                        // 片超时定值 90s：片可等待在途后台调用（≤36s）让路后再推理完成；
                        // 渲染墙钟上界 = 派发窗（budget）+ 片完成窗，收敛于单飞闸保护
                        c := http.Client{Timeout: syncFillChunkTO}
                        res, err := translateUpstreamVia(&c, lang, batch, nil, "", 0)
                        if err != nil {
                                syncfillStats.fails.Add(1)
                                return
                        }
                        keys := make([]string, len(batch))
                        missIdx := make([]int, 0, len(batch))
                        short := map[string]string{}
                        for i, t := range batch {
                                keys[i] = translateCacheKey(t, lang)
                                if i < len(res) && res[i] != "" {
                                        missIdx = append(missIdx, i)
                                        if len([]rune(t)) <= sweepShortRunes {
                                                short[t] = res[i]
                                        }
                                }
                        }
                        if len(missIdx) > 0 {
                                translateCachePut(batch, keys, res, missIdx, novelID)
                                if len(short) > 0 {
                                        i18nShortOverwrite(lang, short)
                                }
                                outMu.Lock()
                                for i, t := range batch {
                                        if i < len(res) && res[i] != "" {
                                                out[t] = res[i]
                                        }
                                }
                                outMu.Unlock()
                                syncfillStats.segs.Add(int64(len(missIdx)))
                        }
                }(batch)
        }
        // flight 硬墙钟：预算=派发窗，宽限=在途片收尾推理窗——渲染墙钟有界；
        // 宽限后仍完成的片照常后台落库（90s 片超时兜底），成果由后续渲染命中
        done := make(chan struct{})
        go func() { wg.Wait(); close(done) }()
        select {
        case <-done:
        case <-time.After(time.Until(deadline.Add(syncFillGraceForLang(lang)))):
        }
        return out
}

// syncFillGraceForLang flight 硬墙钟宽限（预算耗尽后在途片收尾窗：一片推理时长量级）
func syncFillGraceForLang(lang string) time.Duration {
        if lang == "en" {
                return syncFillGraceEn
        }
        return syncFillGrace2H
}
