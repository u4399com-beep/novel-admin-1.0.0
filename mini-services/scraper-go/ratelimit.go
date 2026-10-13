/**
 * 网络纪律模块（逐行移植自 rate-limit.ts）：域名级限速 + robots.txt 检查（提示不阻断）+
 * 重试退避工具 + Retry-After 解析。
 *
 * 合规边界（硬编码红线）：
 * - 默认每域名请求间隔 >= 1200ms（±抖动），即 < 1 req/s，任何配置不得低于 1000ms；
 * - robots.txt 仅提示不强制阻断，但必须在响应 warnings 中明确告知调用方；
 * - 不提供任何验证码破解、账号伪装、登录态伪造能力。
 */
package main

import (
        "io"
        "math/rand"
        "net/http"
        "net/url"
        "regexp"
        "sort"
        "strconv"
        "strings"
        "sync"
        "sync/atomic"
        "time"
)

// ==================== 限速 ====================

const (
        defaultMinIntervalMS = 1200
        jitterMS             = 300
        hostSlotGCThreshold  = 64
        hostSlotIdleMS       = 10 * 60 * 1000
)

// Task 31-b: AIMD 自适应限速参数（ixdzs8 实证：12 车道高频下 429/503 + 200 空壳窗口，
// 成功 2/失败 69 后熔断停摆——需要「被限流→自动慢下来→恢复→缓慢提速」的内建行为而非靠熔断停摆）。
// 合规边界：自适应只会拉长间隔（≥ 基础间隔 1.2s，乘性上界 8s；Retry-After 采纳值受
// parseRetryAfterMs 的 30s 上限约束），绝不缩短基础礼貌间隔。
const (
        // aimdMaxIntervalMS 乘性增大的上界（任务书：上限 8s）
        aimdMaxIntervalMS = 8_000
        // aimdDecayStepMS 每次成功后的加性回落步长。R111：50→100ms——50ms 档从 8s 退避
        // 恢复到基础间隔需 136 连胜（限流窗口期吞吐近乎归零），100ms 档 68 连胜恢复；
        // 恢复曲线仍平缓（每成功 100ms），合规下限（≥基础礼貌间隔）不变
        aimdDecayStepMS = 100
)

func getMinIntervalMs() int64 {
        raw := getenv("SCRAPER_MIN_INTERVAL_MS")
        if raw == "" {
                return defaultMinIntervalMS
        }
        n, err := strconv.Atoi(raw)
        if err != nil || n <= 0 {
                return defaultMinIntervalMS
        }
        // 合规下限：不允许配置成高于 1 req/s 的频率
        if n < 1000 {
                return 1000
        }
        // Task 33-a: 上限护栏——配置值无上界时（如误把秒值写成毫秒 1200000），acquireDomainSlot
        // 会把 nextAt 一次前跳数天：该主机所有请求方在锁外睡眠等槽（无法被硬时间闸取消），
        // goroutine 按尝试数堆积且主机吞吐归零。钳到 60s（仍远严于 1 req/s，与 AIMD 上界 8s、
        // Retry-After 解析上限 30s 同量级）。
        if n > 60_000 {
                return 60_000
        }
        return int64(n)
}

type hostSlot struct {
        mu     sync.Mutex
        nextAt time.Time
        // lastUsedNano lastUsedAt 的原子形态（UnixNano）。原实现里 getHostSlot 在 hostSlotsMu
        // 下写、acquireDomainSlot 在 slot.mu 下写同一字段 —— 两把不同的锁保护同一变量，
        // go race detector 实证 DATA RACE（同主机两请求并发即触发）。统一改原子读写。
        lastUsedNano atomic.Int64
        // consec 同主机连续请求计数（Task 26-d 突发抑制）：持续大批量请求时温和拉长间隔，
        // 空闲 ≥5 分钟复位。槽位跨任务共享 → 多任务打同一站点时天然累计（单站限速共享）
        consec atomic.Int64
        // Task 31-b: AIMD 自适应间隔毫秒（0 = 未进入自适应态，用基础间隔）。
        // 429/503/Retry-After → 乘性增大或直接采纳；连续成功 → 加性回落；空闲 ≥5 分钟复位。
        // Task 46-a: 全部写入方改为 CAS 循环（见 aimdRaiseTo）——旧实现 Load→计算→Store 三步
        // 非原子，同主机多车道并发时（list/chapter 车道同打一站）互相覆盖：floor 车道的低值
        // 可吞掉另一车道刚写入的更高 429/Retry-After 退避位，违反「只升不降」契约。
        aimdMs atomic.Int64
        // Task 35-b: 排队/准入观测（/api/host-health?host= 透出）。
        // lastWaitMS 最近一次真实取槽的等待毫秒；sleepers 当前在锁外睡眠等槽的调用方数；
        // sheds 预算感知准入累计拒绝次数（shed 不占槽不计 consec）。
        lastWaitMS atomic.Int64
        sleepers   atomic.Int64
        sheds      atomic.Int64
        // R108: AIMD 对称下探位（毫秒，0..dipMaxMS）。AIMD 原本只升不降（429 后 ×1.5、
        // 成功后 -50ms 回落至基础间隔封底）；本字段给「长期干净的域」一个受控的回落通道：
        // 基础间隔 1.2s 内部下探至 1.2s-dipMax（R115 起默认 1.05s），任何限流信号立即归零弹回。
        // 合规约束：下探后有效间隔仍 ≥1000ms 硬红线（effInterval 钳制不变）。
        dipMs atomic.Int64
        // R115: 限流信号观测（按槽键累计，不清零——与 sheds 同口径的累计观测位）。
        // noteAdaptiveRateLimited 是唯一写点；/api/host-health 透出，为 dip 深度等礼貌
        // 参数的后续调优提供「限流占比」数据依据（R114 遗留③观测前置）。
        rateLimited         atomic.Int64
        lastRateLimitedNano atomic.Int64
}

var (
        hostSlotsMu sync.Mutex
        hostSlots   = map[string]*hostSlot{}
)

func getHostSlot(host string) *hostSlot {
        hostSlotsMu.Lock()
        defer hostSlotsMu.Unlock()
        now := time.Now()
        slot, ok := hostSlots[host]
        if !ok {
                slot = &hostSlot{}
                slot.lastUsedNano.Store(now.UnixNano())
                hostSlots[host] = slot
        }
        // Task 33-a（P1）：此处对既有槽位无条件刷新 lastUsedNano，使 acquireDomainSlot 紧随其后的
        // 「now-lastUsedNano > 5min 空闲复位」恒得 ~0 差值——5 分钟空闲复位（consec/aimdMs；Task 46-a 清理死状态 aimdOKStreak）
        // 是死代码：AIMD 退避位一旦进入便无法经空闲路径退出（仅靠每成功 -50ms 缓慢回落），
        // 突发抑制计数也永不清零。删除刷新：lastUsedNano 语义回归「上次取槽时刻」，由
        // acquireDomainSlot 末尾（slot.mu 内、原子写）负责续期，空闲判定与 GC 时钟均据此成立。
        if len(hostSlots) >= hostSlotGCThreshold {
                for k, s := range hostSlots {
                        if now.UnixNano()-s.lastUsedNano.Load() > hostSlotIdleMS*int64(time.Millisecond) {
                                delete(hostSlots, k)
                        }
                }
        }
        return slot
}

// aimdMulStep 乘性增大一步：cur×1.5，上界 aimdMaxIntervalMS，下界不低于 floor（基础礼貌间隔）。
// 纯函数（表驱动测试见 aimd_test.go，Task 31-b）。
func aimdMulStep(cur, floor int64) int64 {
        if cur < floor {
                cur = floor
        }
        next := cur * 3 / 2
        if next < cur { // 溢出防护（int64 乘法不会溢出在 8s 量级，防御式保留）
                next = cur
        }
        if next > aimdMaxIntervalMS {
                next = aimdMaxIntervalMS
        }
        return next
}

// aimdAddStep 加性回落一步：cur-aimdDecayStepMS，下界 floor（不低于基础礼貌间隔）。
// 纯函数（表驱动测试见 aimd_test.go，Task 31-b）。
func aimdAddStep(cur, floor int64) int64 {
        if cur <= floor {
                return floor
        }
        next := cur - aimdDecayStepMS
        if next < floor {
                next = floor
        }
        return next
}

// aimdRaiseTo Task 46-a：AIMD 间隔「只升不降」抬升原语（CAS-max）。
// 旧实现各写入方先 Load 再条件 Store，两步之间存在窗口：同主机另一车道的更高退避位
// （如 chapter 车道刚采纳的 Retry-After=20s）可被本车道随后 Store 的低值（如 robots
// Crawl-delay floor=5s）覆盖——限流记忆瞬间降档，下一拍请求以过快节奏直打限流中的站点。
// CAS 循环把 max(cur, v) 语义原子化：仅当 cur≥v 时跳过，否则抬到 v；被并发插入的更高值
// 抢先时 CAS 失败重读，永不回退。返回是否发生了抬升。
func aimdRaiseTo(slot *hostSlot, v int64) bool {
        for {
                cur := slot.aimdMs.Load()
                if cur >= v {
                        return false
                }
                if slot.aimdMs.CompareAndSwap(cur, v) {
                        return true
                }
        }
}

// noteAdaptiveRateLimited Task 31-b AIMD「乘性增大」入口：该主机收到 429/503 时调用。
// R108：参数改槽键口径（裸 host 或 slotKeyFor 的 host|eg:… 形态）——分桶主机按出口
// 独立退避（哪个出口被限流只慢哪个出口），未分桶主机键恒为裸 host 行为不变。
// 带 Retry-After 时直接采纳其值（仍受 parseRetryAfterMs 的 30s 解析上限约束，且不高于
// 既有值时取较大者——站点给的窗口优先于本地推断）；无 Retry-After 时 ×1.5 逐步放大。
// Task 46-a：两条路径均改 CAS 原子化（aimdRaiseTo / CAS 循环）——旧 Load→Store 在同主机
// 并发 429/503 下会丢步（A 车道 ×1.5 结果被 B 车道的旧 cur 基底覆盖）。
// 同时清零连续成功计数（回落序列重新开始）；R108：下探位立即归零（先保护后提速）。
func noteAdaptiveRateLimited(slotKey string, retryAfterMs *int64) {
        if slotKey == "" {
                return
        }
        slot := getHostSlot(slotKey)
        resetDip(slot) // R108: 限流即弹回基础间隔，下探奖励清零
        slot.rateLimited.Add(1)                 // R115: 限流信号观测（累计）
        slot.lastRateLimitedNano.Store(time.Now().UnixNano())
        floor := getMinIntervalMs()
        if retryAfterMs != nil && *retryAfterMs > 0 {
                raise := *retryAfterMs
                if raise < floor {
                        raise = floor // 合规下限：自适应间隔不得低于基础礼貌间隔
                }
                aimdRaiseTo(slot, raise) // 只升不降（限流窗口叠加；并发下原子取大者）
        } else {
                for {
                        cur := slot.aimdMs.Load()
                        next := aimdMulStep(cur, floor)
                        if next == cur {
                                break // 已在上界（8s）：值不变，避免无谓写
                        }
                        if slot.aimdMs.CompareAndSwap(cur, next) {
                                break
                        }
                }
        }
}

// noteAdaptiveSuccess Task 31-b AIMD「加性回落」入口：该主机一次成功抓取后调用。
// 处于自适应态（aimdMs>基础间隔）时每次成功回落 aimdDecayStepMS（50ms），到达基础间隔后
// 归零自适应态（aimdMs=0 → 后续直接用基础间隔）。
// R108：参数改槽键口径（同 noteAdaptiveRateLimited）；回到基础间隔后转入下探通道
// noteDipOnSuccess（干净域奖励，深度钳 dipMaxMS）。
func noteAdaptiveSuccess(slotKey string) {
        if slotKey == "" {
                return
        }
        slot := getHostSlot(slotKey)
        floor := getMinIntervalMs()
        // Task 46-a: CAS 循环防丢步——并发成功/限流信号交错时，回落以最新值为基底重算，
        // 不再覆盖另一车道刚写入的更高退避位（429 后紧跟的成功不应把退避位砍掉）。
        for {
                cur := slot.aimdMs.Load()
                if cur <= 0 {
                        // R108: 未处于自适应态 = 干净域 → 成功加深下探（奖励方向）
                        noteDipOnSuccess(slot)
                        return
                }
                next := aimdAddStep(cur, floor)
                if next <= floor {
                        next = 0 // 已回到基础间隔：退出自适应态
                }
                if slot.aimdMs.CompareAndSwap(cur, next) {
                        if next == 0 {
                                noteDipOnSuccess(slot) // R108: 回到基础间隔即开始下探
                        }
                        return
                }
        }
}

// hostAdaptiveIntervalMs Task 31-b: 当前主机的自适应间隔毫秒（0 = 基础间隔态）。
// 供 /api/host-health 可观测端点与 backend 车道感知消费。
func hostAdaptiveIntervalMs(host string) int64 {
        hostSlotsMu.Lock()
        slot, ok := hostSlots[host]
        hostSlotsMu.Unlock()
        if !ok {
                return 0
        }
        return slot.aimdMs.Load()
}

// snapshotAdaptiveIntervals Task 31-b: 当前处于自适应态（aimdMs>0）的全部主机快照。
// 供 /api/host-health 端点返回全量观测面。
func snapshotAdaptiveIntervals() map[string]int64 {
        hostSlotsMu.Lock()
        defer hostSlotsMu.Unlock()
        out := map[string]int64{}
        for h, s := range hostSlots {
                if v := s.aimdMs.Load(); v > 0 {
                        out[h] = v
                }
        }
        return out
}

// politenessExtraCapMS 突发抑制额外间隔上界。R99 调优：默认 1000→300ms——
// 长章节填充任务动辄连续数千请求，consec≥2000 后旧上界把有效间隔推到 2.2s+，
// 吞吐上限被砍 45%。
// R108 再调优：默认 300→150ms——实测舰队重建期各域持续负载下额外间隔恒顶在 +300ms
// （有效间隔均值 1.5s = 2400 章/h 天花板），而突发抑制的「别像机关枪」目的由
// ±300ms 双向抖动继续承担；150ms 上界时持续有效间隔均值 1.35s（+11% 吞吐），
// 且仍严于 1.2s 合规保底 + 150ms 尾差。env SCRAPE_POLITENESS_EXTRA_CAP_MS 可覆盖
//（回 1000 即恢复 Task 26-d 原始口径）；配置非法/负值一律回默认。
var politenessExtraCapMS = int64(150)

func init() {
        raw := getenv("SCRAPER_POLITENESS_EXTRA_CAP_MS")
        if raw == "" {
                return
        }
        n, err := strconv.Atoi(raw)
        if err != nil || n < 0 {
                return
        }
        politenessExtraCapMS = int64(n)
}

// politenessExtraMS 突发抑制的额外间隔：每满 200 次连续请求 +100ms，上界 politenessExtraCapMS。
// 抽成纯函数便于单测（Task 26-d）。
func politenessExtraMS(consec int64) int64 {
        if consec <= 0 {
                return 0
        }
        extra := (consec / 200) * 100
        if extra > politenessExtraCapMS {
                extra = politenessExtraCapMS
        }
        return extra
}

// ==================== R108: AIMD 对称下探通道 ====================

// dipMaxMS AIMD 下探深度上界（毫秒）。R115 默认 100→150：R114 遗留③调优落地——
// 持续有效间隔均值 1.25s→1.20s（干净域吞吐 +4~8%）。安全性依据：下探仅在 aimdMs==0
// 的干净态累加，任何 429/503/Retry-After 立即归零弹回，25ms/成功拍逐步重建（150ms=6 拍）；
// 叠加突发抑制/抖动后仍 ≥1000ms 硬红线（effInterval 钳制不变），对源站的加速不可见
//（单请求间隔分布仍落在 1.0-1.5s 人类区间）。限流占比观测见 rateLimited 槽字段
//（/api/host-health.rateLimitedSlots），数据异常时 SCRAPER_DIP_MAX_MS 可回 100/0。
// 开关：SCRAPER_AIMD_DIP_OFF=1 完全停用（回 R107 只升不降语义）；
// SCRAPER_DIP_MAX_MS 自定义深度（钳 0..400；400 仅在额外间隔被 env 调 0 时安全）。
func dipMaxMS() int64 {
        if getenv("SCRAPER_AIMD_DIP_OFF") != "" {
                return 0
        }
        raw := getenv("SCRAPER_DIP_MAX_MS")
        if raw == "" {
                return 150
        }
        n, err := strconv.Atoi(raw)
        if err != nil || n < 0 {
                return 150
        }
        if n > 400 {
                n = 400
        }
        return int64(n)
}

// dipStepMS 下探步长（每次干净成功 +25ms 加深，达 dipMaxMS 封底）。下探是对称 AIMD 的
// 「奖励方向」：步长取回落步长（R111 起 100ms）的四分之一——下探通道更保守，多成功几拍
// 才到位。
const dipStepMS = int64(25)

// noteDipOnSuccess R108: 干净成功加深下探（仅当该槽未处于 AIMD 退避态时；退避态的回落
// 由 aimdAddStep 承担，两条曲线不叠加）。CAS 循环防并发丢步（对齐 aimdRaiseTo 契约）。
func noteDipOnSuccess(slot *hostSlot) {
        maxDip := dipMaxMS()
        if maxDip <= 0 {
                return
        }
        for {
                cur := slot.dipMs.Load()
                if cur >= maxDip {
                        return
                }
                next := cur + dipStepMS
                if next > maxDip {
                        next = maxDip
                }
                if slot.dipMs.CompareAndSwap(cur, next) {
                        return
                }
        }
}

// resetDip R108: 限流信号/空闲复位时下探位立即归零（弹回基础间隔，先保护后提速）。
func resetDip(slot *hostSlot) {
        if slot.dipMs.Load() != 0 {
                slot.dipMs.Store(0)
        }
}

// ==================== R108: 代理 per-IP 分桶（P2-1，默认关） ====================

// proxyBucketLanes 按主机配置的代理分桶车道数（0=未启用分桶）。
// env SCRAPE_PROXY_BUCKET_HOSTS="host1:4,host2:2"（:N 可省略，默认 4；钳 2..8）。
// 语义：启用分桶的主机，域槽键从 host 扩为 host|eg:<出口>——每个代理出口各自享有
// 完整合规间隔（每 IP 各自 <1 req/s），对「按 IP 限流」型站点（trxsw/biqutu 实证）
// 单域吞吐 ×N。风险（perf-plan P2-1）：源站总 QPS 上升 N 倍，仅对已证实按 IP 限流的
// 站点开启；未列出的主机行为完全不变（键恒为裸 host）。
var proxyBucketHosts = map[string]int{}

func init() {
        raw := getenv("SCRAPE_PROXY_BUCKET_HOSTS")
        if raw == "" {
                return
        }
        for _, part := range strings.Split(raw, ",") {
                part = strings.TrimSpace(part)
                if part == "" {
                        continue
                }
                lanes := 4
                host := part
                if i := strings.LastIndex(part, ":"); i > 0 {
                        host = part[:i]
                        if n, err := strconv.Atoi(part[i+1:]); err == nil && n > 0 {
                                lanes = n
                        }
                }
                host = strings.ToLower(host)
                if host == "" {
                        continue
                }
                if lanes < 2 {
                        lanes = 2
                }
                if lanes > 8 {
                        lanes = 8
                }
                proxyBucketHosts[host] = lanes
        }
}

// bucketLanesFor 主机的分桶车道数（0=未启用）。host 已约定小写（hostOf 归一口径）。
func bucketLanesFor(host string) int {
        return proxyBucketHosts[strings.ToLower(host)]
}

// reEgressKeyCredStrip 出口键兜底脱敏（url.Parse 失败时）：与 chain.go reProxyCred 同口径。
var reEgressKeyCredStrip = regexp.MustCompile(`//[^/@]+@`)

// slotKeyFor R108: 域槽键计算。未启用分桶的主机恒返回裸 host（行为与 R107 完全一致，
// 含代理池轮换场景——池出口轮换但共享 host 槽，单站总节奏不随出口数放大）；
// 启用分桶且出口非直连时返回 host|eg:<出口 host:port>，每出口独立 1.2s 槽。
// 桶身份取出口 URL 的 host:port（净主:端口，天然不含凭据）——代理凭据换血不换桶；
// 解析失败时回退正则脱敏。所有 acquireDomainSlotBudgeted 调用方必须经此函数计算键
//（链层/策略层/跳转层/侧车层）。
func slotKeyFor(host, egress string) string {
        if egress == "" || bucketLanesFor(host) == 0 {
                return host
        }
        if u, err := url.Parse(egress); err == nil && u.Host != "" {
                return host + "|eg:" + u.Host
        }
        return host + "|eg:" + reEgressKeyCredStrip.ReplaceAllString(egress, "//***@")
}

// acquireDomainSlot 获取指定域名的请求槽位：同域名并发请求串行排队，相邻两次请求
// 之间至少间隔「基础礼貌间隔或 AIMD 自适应间隔的较大者」± 抖动；不同域名互不影响。
// 语义对齐 TS 版（FIFO 排队 + 排队后各自计算等待），锁仅在计算窗口持有，等待发生在锁外。
// Task 26-d 突发抑制：同主机持续请求时在基准间隔上叠加 politenessExtraMS(consec)，
// 长跑 Phase 2（数万章）随请求量自动从 1.2s 温和放缓（R99 上界 300ms → ≈1.5s），
// 降低触发源站封禁的概率；只增不减，空闲 5 分钟复位，对短任务无感。
// Task 31-b AIMD 自适应：429/503 限流后该主机间隔乘性增大（×1.5 上界 8s；Retry-After 直接
// 采纳），连续成功后加性缓慢回落（每次成功 -50ms 下限 1.2s）——被限流自动慢下来、恢复后
// 缓慢提速，成为引擎内建行为。空闲 ≥5 分钟时 AIMD 与突发抑制一并复位。
func acquireDomainSlot(host string) {
        acquireDomainSlotBudgeted(host, 0, 0) // deadline=0：旧语义无界等待
}

// acquireDomainSlotBudgeted Task 35-b: 预算感知取槽——ixdzs8 Phase 2 实证根因（task7 复盘：
// 115 章成功后 12 车道全灭 61 失败）：域名槽是「预约制」（nextAt 顺延），N 个并发调用方按
// N×有效间隔错峰拿到槽位；后台 12 车道 × 间隔 1.5-2.5s ⇒ 末位车道纯排队 ≈18-30s，直接吃穿
// 策略级 20s 预算（backend 不传 timeoutMs → 默认 20s）→ timeout-budget 全灭 → 整链失败
// ×N → hosthealth 熔断 → 60 章连败提前停止。旧实现在两个方向上自我放大：①排队不感知预算，
// 必然超时的调用方照样预约槽位（把 nextAt 推得更远、叠 consec 礼貌增量）；②预约后锁外
// sleep 无法被硬时间闸取消，失败反馈滞后一个排队周期。
// 本函数在预约前判断：预计等待 + reserveMS 是否超出 deadlineMs 余量，超出则**不预约、不
// 推 nextAt、不计 consec、不睡眠**，立即返回 granted=false（调用方按结构化快速失败处理，
// backend 车道控制按「预算耗尽」关键词降档，负反馈秒级生效而非超时级生效）。
// deadlineMs=0 保持旧语义（无界等待，robots.txt/chapterListApi 等低频路径沿用）。
// waitedMs 返回实际睡眠毫秒（0 = 未等待/被拒绝），供调用方补偿策略级 deadline（排队时间
// 不吃服务时间窗）。granted=true 时预约已生效（nextAt 已顺延），调用方必须发起真实请求。
func acquireDomainSlotBudgeted(host string, deadlineMs int64, reserveMS int64) (waitedMs int64, granted bool) {
        slot := getHostSlot(host)
        slot.mu.Lock()
        now := time.Now()
        if now.UnixNano()-slot.lastUsedNano.Load() > int64(5*time.Minute) {
                slot.consec.Store(0) // 空闲复位：突发抑制只针对持续批量
                slot.aimdMs.Store(0) // Task 31-b: AIMD 同口径空闲复位（限流记忆由 hosthealth penalty 继续承担短期退避）
                resetDip(slot)       // R108: 下探位同口径空闲复位（新周期重新从基础间隔起步）
        }
        n := slot.consec.Add(1)
        // Task 31-b: 有效基础间隔 = max(基础礼貌间隔, AIMD 自适应间隔)
        // R108: 基础礼貌间隔先减下探位（干净域奖励通道，深度钳 dipMaxMS），再与 AIMD 取大；
        // 下探永不低于 1000ms 硬红线（AIMD 退避态 interval 由 aimdMs 主导时 dip 不生效——
        // dip 仅在 aimdMs==0 的干净态累加，见 noteDipOnSuccess）。
        interval := getMinIntervalMs() - slot.dipMs.Load()
        if interval < 1000 {
                interval = 1000
        }
        if ai := slot.aimdMs.Load(); ai > interval {
                interval = ai
        }
        base := now
        if slot.nextAt.After(base) {
                base = slot.nextAt
        }
        wait := base.Sub(now)
        // Task 35-b: 预算闸——本槽位的预计等待加服务时间预留必须落在调用方 deadline 内，
        // 否则拒绝预约（不消耗槽位资源：consec 回退、nextAt 不动），拒绝路径零副作用
        if deadlineMs > 0 && int64(wait.Milliseconds())+reserveMS > deadlineMs-nowMs() {
                slot.consec.Add(-1)
                slot.sheds.Add(1)
                slot.mu.Unlock()
                return 0, false
        }
        // Task 38-a: 抖动改 ± 双向——旧实现只加 0..+300ms，间隔分布是「固定底噪 + 单向噪声」，
        // 对统计节奏检测器仍是均匀可识别指纹；真实浏览器访问节奏双侧散布。
        // 合规红线：有效间隔钳下限 1000ms（>1 req/s 不允许），负向抖动不得击穿。
        effInterval := interval + politenessExtraMS(n) + int64(rand.Intn(2*jitterMS+1)) - jitterMS
        if effInterval < 1000 {
                effInterval = 1000
        }
        slot.nextAt = base.Add(time.Duration(effInterval) * time.Millisecond)
        slot.lastUsedNano.Store(now.UnixNano())
        slot.mu.Unlock()
        if wait > 0 {
                slot.sleepers.Add(1)
                time.Sleep(wait)
                slot.sleepers.Add(-1)
        }
        ms := wait.Milliseconds()
        if ms < 0 {
                ms = 0
        }
        slot.lastWaitMS.Store(ms)
        return ms, true
}

// hostSlotStats Task 35-b: 单主机限速槽观测快照（/api/host-health?host= 消费）。
// R115 追加：RateLimited/LastRateLimitedAtMs（限流信号观测）+ DipMS（下探位透出）。
type hostSlotStats struct {
        LastWaitMS        int64 `json:"lastSlotWaitMs"`
        Sleepers          int64 `json:"slotSleepers"`
        Sheds             int64 `json:"slotSheds"`
        Consec            int64 `json:"slotConsec"`
        PolitenessExtraMS int64 `json:"politenessExtraMs"`
        RateLimited         int64 `json:"rateLimitedTotal"`
        LastRateLimitedAtMs int64 `json:"lastRateLimitedAtMs"`
        DipMS               int64 `json:"dipMs"`
}

func hostSlotStatsFor(host string) (hostSlotStats, bool) {
        hostSlotsMu.Lock()
        slot, ok := hostSlots[host]
        hostSlotsMu.Unlock()
        if !ok {
                return hostSlotStats{}, false
        }
        consec := slot.consec.Load()
        lastRL := int64(0)
        if nano := slot.lastRateLimitedNano.Load(); nano > 0 {
                lastRL = nano / int64(time.Millisecond)
        }
        return hostSlotStats{
                LastWaitMS:        slot.lastWaitMS.Load(),
                Sleepers:          slot.sleepers.Load(),
                Sheds:             slot.sheds.Load(),
                Consec:            consec,
                PolitenessExtraMS: politenessExtraMS(consec),
                RateLimited:         slot.rateLimited.Load(),
                LastRateLimitedAtMs: lastRL,
                DipMS:               slot.dipMs.Load(),
        }, true
}

// rateLimitedSlotRow R115: 全量限流槽观测行（/api/host-health.rateLimitedSlots 消费）。
// 槽键含分桶形态（host|eg:…）——分桶主机的限流按出口独立记账，观测面同口径。
type rateLimitedSlotRow struct {
        Slot     string `json:"slot"`
        Count    int64  `json:"count"`
        LastAtMs int64  `json:"lastRateLimitedAtMs"`
        AimdMs   int64  `json:"aimdMs"`
        DipMs    int64  `json:"dipMs"`
}

// snapshotRateLimitedSlots R115: 当前累计限流信号非零的槽位快照（按次数降序，
// 恒不超 64 行防观测面膨胀）。空切片返回 nil（JSON null，与 adaptiveHosts 空态一致）。
func snapshotRateLimitedSlots() []rateLimitedSlotRow {
        hostSlotsMu.Lock()
        defer hostSlotsMu.Unlock()
        rows := make([]rateLimitedSlotRow, 0, 8)
        for k, s := range hostSlots {
                c := s.rateLimited.Load()
                if c <= 0 {
                        continue
                }
                lastAt := int64(0)
                if nano := s.lastRateLimitedNano.Load(); nano > 0 {
                        lastAt = nano / int64(time.Millisecond)
                }
                rows = append(rows, rateLimitedSlotRow{Slot: k, Count: c, LastAtMs: lastAt, AimdMs: s.aimdMs.Load(), DipMs: s.dipMs.Load()})
        }
        sort.SliceStable(rows, func(i, j int) bool { return rows[i].Count > rows[j].Count })
        if len(rows) > 64 {
                rows = rows[:64]
        }
        if len(rows) == 0 {
                return nil
        }
        return rows
}

// ==================== 重试 ====================

const maxAttempts = 3

func isRetryableStatus(status int) bool {
        // 仅对网络错误(status=0)、429、5xx 重试；4xx 属于确定性失败不重试
        return status == 0 || status == 429 || status >= 500
}

func backoffDelay(attempt int) int64 {
        base := int64(500) * (1 << (attempt - 1))
        return base + int64(rand.Intn(250))
}

// ==================== Retry-After ====================

var reRetryAfterSecs = regexp.MustCompile(`^\d{1,6}(\.\d+)?$`)
var reHasLetter = regexp.MustCompile(`[a-zA-Z]`)

// parseRetryAfterMs 解析 Retry-After 头（RFC 7231：秒数或 HTTP-date），返回退避毫秒数；
// 无法解析返回 nil。上限 30s：防恶意大值直接吃满策略链预算。
func parseRetryAfterMs(raw string) *int64 {
        if raw == "" {
                return nil
        }
        v := strings.TrimSpace(raw)
        if v == "" {
                return nil
        }
        if reRetryAfterSecs.MatchString(v) {
                f, err := strconv.ParseFloat(v, 64)
                if err != nil || f < 0 {
                        return nil
                }
                ms := int64(f * 1000)
                if ms > 30_000 {
                        ms = 30_000
                }
                return &ms
        }
        // HTTP-date 必然含字母（星期/月份名）；纯数字/负数/科学计数等非秒数形态直接拒绝
        if !reHasLetter.MatchString(v) {
                return nil
        }
        // Task 54 精简：移除与 http.TimeFormat 逐字节恒等的重复字面量（55-a 留档②）
        for _, layout := range []string{http.TimeFormat, time.RFC850, time.ANSIC} {
                if t, err := time.Parse(layout, v); err == nil {
                        ms := time.Until(t).Milliseconds()
                        if ms < 0 {
                                ms = 0
                        }
                        if ms > 30_000 {
                                ms = 30_000
                        }
                        return &ms
                }
        }
        return nil
}

// crawlDelayAdoptMaxMS robots.txt Crawl-delay 采纳上界（与 parseRetryAfterMs 的 30s 外部指令
// 上限同口径；60s 级 crawl-delay 属极端敌意配置，采纳到 30s 已远严于基础礼貌间隔）
const crawlDelayAdoptMaxMS = 30_000

// noteCrawlDelayFloor Task 44-a（E2·反反爬/合规增强）：robots.txt Crawl-delay 采纳为该主机
// AIMD 礼貌间隔下限。根因：parseRobots 已解析 Crawl-delay 但只用于 warnings 提示——源站明示的
// 采集节奏被无视，以 1.2s 高频直打声明了 5s/10s crawl-delay 的站点是自找 429/封禁（合规与
// 反反爬双输）。采纳语义：只升不降（不覆盖更高的 429/Retry-After 退避位）、低于基础礼貌间隔
// 时不采纳（默认节奏已更严）、上界 30s；robots warn-only 契约不变（不阻断任何请求，只放慢节奏）。
// 空闲 5min 复位后由 fetchPage 每次 checkRobots（10min 缓存内）重新施加，活动期自动维持。
// 接线点：chain.go fetchPage 的 checkRobots 之后。锁定测试见 audit44_test.go。
func noteCrawlDelayFloor(host string, delayMs int64) {
        if host == "" || delayMs <= 0 {
                return
        }
        if delayMs > crawlDelayAdoptMaxMS {
                delayMs = crawlDelayAdoptMaxMS
        }
        if delayMs < getMinIntervalMs() {
                return // 低于基础礼貌间隔：无需采纳（默认节奏已更严格）
        }
        slot := getHostSlot(host)
        // Task 46-a: 抬升改 aimdRaiseTo（CAS-max）——旧 Load→条件→Store 与并发的
        // noteAdaptiveRateLimited（429/Retry-After 采纳）互覆，更高退避位可被本函数的低值覆盖。
        aimdRaiseTo(slot, delayMs) // 只升不降（不覆盖 429/Retry-After 的更高退避位）
}

// ==================== robots.txt ====================

const (
        robotsTTLMS    = 10 * 60 * 1000
        robotsCacheMax = 256
        robotsMaxBytes = 1024 * 1024
)

type robotsInfo struct {
        checked      bool
        disallowed   bool
        crawlDelayMs *float64
}

type robotsCacheEntry struct {
        at   time.Time
        info robotsInfo
}

var (
        robotsCacheMu sync.Mutex
        robotsCache   = map[string]robotsCacheEntry{}
)

type robotsGroup struct {
        agents       []string
        disallow     []string
        allow        []string
        crawlDelayMs *float64
}

func parseRobots(text string) []robotsGroup {
        groups := []robotsGroup{}
        var current *robotsGroup
        for _, rawLine := range strings.Split(text, "\n") {
                line := strings.TrimSpace(strings.SplitN(rawLine, "#", 2)[0])
                if line == "" {
                        continue
                }
                idx := strings.Index(line, ":")
                if idx < 0 {
                        continue
                }
                key := strings.ToLower(strings.TrimSpace(line[:idx]))
                value := strings.TrimSpace(line[idx+1:])
                if key == "user-agent" {
                        if current == nil || len(current.disallow) > 0 || len(current.allow) > 0 || current.crawlDelayMs != nil {
                                groups = append(groups, robotsGroup{})
                                current = &groups[len(groups)-1]
                        }
                        current.agents = append(current.agents, strings.ToLower(value))
                } else if current != nil {
                        if key == "disallow" {
                                current.disallow = append(current.disallow, value)
                        } else if key == "allow" {
                                current.allow = append(current.allow, value)
                        } else if key == "crawl-delay" {
                                if sec, err := strconv.ParseFloat(value, 64); err == nil && sec >= 0 {
                                        ms := sec * 1000
                                        current.crawlDelayMs = &ms
                                }
                        }
                }
        }
        return groups
}

func pickGroup(groups []robotsGroup, agents []string) *robotsGroup {
        for _, agent := range agents {
                for i := range groups {
                        for _, a := range groups[i].agents {
                                if a == agent {
                                        return &groups[i]
                                }
                        }
                }
        }
        for i := range groups {
                for _, a := range groups[i].agents {
                        if a == "*" {
                                return &groups[i]
                        }
                }
        }
        return nil
}

// isPathDisallowed 最长匹配规则优先（robots 协议惯例），Allow 优先于等长 Disallow
func isPathDisallowed(group *robotsGroup, pathname string) bool {
        bestLen := -1
        disallowed := false
        check := func(rules []string, isDisallow bool) {
                for _, rule := range rules {
                        if rule == "" { // 空 Disallow = 全部允许
                                continue
                        }
                        if strings.HasPrefix(pathname, rule) && len(rule) > bestLen {
                                bestLen = len(rule)
                                disallowed = isDisallow
                        }
                }
        }
        check(group.allow, false)
        check(group.disallow, true)
        return disallowed
}

type robotsResult struct {
        info     robotsInfo
        warnings []string
}

var robotsClient = &http.Client{
        Timeout: 6 * time.Second,
        CheckRedirect: func(*http.Request, []*http.Request) error {
                // 关键：禁用客户端自动跟随重定向。否则下方手动逐跳 SSRF 校验形同虚设——
                // 恶意站点可用 /robots.txt 302 让默认客户端自动请求任意内网地址（SSRF）。
                return http.ErrUseLastResponse
        },
        Transport: robotsTransport(),
}

// robotsTransport robots 检查专用传输：5s 段口径的 ssrfDirectTransport 薄封装
// （61-R14 起实现体收敛到 httpguard.go；直连/Control 语义见彼处）。
func robotsTransport() *http.Transport {
        return ssrfDirectTransport(5 * time.Second)
}

// robotsOriginKey robots 缓存/robots.txt 请求的 origin key（Task 49-a·F2·P3 归一）：
// scheme://小写 Host。旧实现 origin 直接拼 u.Host 原样大小写——同一站点的 URL 大写变体
// （http://Example.COM/）会分裂出第二个缓存桶：TTL 内各自重新抓取 robots.txt（多耗源站
// 请求配额），且 disallowed/crawlDelayMs 记忆互不可见（fetchPage 的 host 键已归一，
// 只有本缓存 key 漏网）。纯函数（表驱动测试见 audit49_test.go）。
func robotsOriginKey(u *url.URL) string {
        return u.Scheme + "://" + strings.ToLower(u.Host)
}

// checkRobots 检查目标 URL 是否被 robots.txt 限制。永不失败、永不阻断 —— 失败时降级为 warning。
func checkRobots(targetURL string) robotsResult {
        agents := []string{"novel-admin-scraper", "*"}
        u, err := url.Parse(targetURL)
        if err != nil || u.Host == "" {
                return robotsResult{warnings: []string{"robots 检查：URL 无法解析，跳过"}}
        }
        origin := robotsOriginKey(u)
        pathname := u.Path
        if pathname == "" {
                pathname = "/"
        }

        robotsCacheMu.Lock()
        cached, has := robotsCache[origin]
        robotsCacheMu.Unlock()
        if has && time.Since(cached.at) < time.Duration(robotsTTLMS)*time.Millisecond {
                info := cached.info
                warnings := []string{}
                if info.disallowed {
                        warnings = append(warnings, "robots.txt 禁止抓取该路径 ("+pathname+")。本服务仅提示不阻断，请自行确认采集授权与合规性")
                }
                if info.crawlDelayMs != nil && *info.crawlDelayMs > float64(getMinIntervalMs()) {
                        warnings = append(warnings, "robots.txt Crawl-delay="+strconv.Itoa(int(*info.crawlDelayMs/1000))+"s 高于当前限速 "+strconv.FormatInt(getMinIntervalMs(), 10)+"ms，已采纳为该主机请求间隔下限（建议降低采集频率）")
                }
                return robotsResult{info: info, warnings: warnings}
        }

        warnings := []string{}
        var info *robotsInfo
        // 限速槽位 key 与策略层一致（含端口，见 hostOf），避免同源不同 key 绕过限速
        // Task 38-a: 槽 key 归一小写（与链层 hostOf 同口径，防大小写变体绕过限速）
        acquireDomainSlot(strings.ToLower(u.Host))
        // robots.txt 请求走 redirect:'manual' 逐跳 SSRF 校验：
        // 否则恶意站点可用 robots.txt 302 让本服务对内网地址发起 GET（SSRF）
        robotsURL := origin + "/robots.txt"
        var res *http.Response
        for hop := 0; hop <= 3; hop++ {
                hu, err := url.Parse(robotsURL)
                if err != nil {
                        break
                }
                // 协议白名单：重定向到 ftp:/file: 等非 http(s) 形态直接拒绝（重定向变体 SSRF）
                if hu.Scheme != "http" && hu.Scheme != "https" {
                        info = &robotsInfo{}
                        warnings = append(warnings, "robots.txt 重定向到非 http/https 协议已拒绝（"+hu.Scheme+"），未做 robots 校验")
                        break
                }
                hopCheck := assertHostPublic(hu.Hostname())
                if !hopCheck.ok {
                        info = &robotsInfo{}
                        warnings = append(warnings, "robots.txt 获取目标被 SSRF 防护拒绝（"+hopCheck.reason+"），未做 robots 校验")
                        break
                }
                req, _ := http.NewRequest("GET", robotsURL, nil)
                req.Header.Set("User-Agent", "novel-admin-scraper/1.0 (+robots-check)")
                req.Header.Set("Accept", "text/plain,*/*")
                r, err := robotsClient.Do(req)
                if err != nil {
                        info = &robotsInfo{}
                        warnings = append(warnings, "robots.txt 获取异常（"+err.Error()+"），未做 robots 校验，请自行确认目标站允许抓取")
                        break
                }
                if r.StatusCode >= 300 && r.StatusCode <= 308 && r.StatusCode != 304 {
                        loc := r.Header.Get("Location")
                        _ = r.Body.Close()
                        if loc == "" {
                                info = &robotsInfo{}
                                warnings = append(warnings, "robots.txt 返回 "+strconv.Itoa(r.StatusCode)+" 重定向但无 Location，未做 robots 校验")
                                break
                        }
                        next := urlJoin(loc, robotsURL)
                        if next == nil {
                                info = &robotsInfo{}
                                warnings = append(warnings, "robots.txt 重定向 Location 无法解析，未做 robots 校验")
                                break
                        }
                        robotsURL = next.String()
                        continue
                }
                res = r
                break
        }

        if info == nil && res == nil {
                if len(warnings) == 0 {
                        info = &robotsInfo{}
                        warnings = append(warnings, "robots.txt 重定向超过 3 跳，未做 robots 校验，请自行确认目标站允许抓取")
                } else {
                        info = &robotsInfo{}
                }
        } else if info == nil && res != nil && (res.StatusCode < 200 || res.StatusCode >= 300) {
                _ = res.Body.Close()
                info = &robotsInfo{}
                if res.StatusCode != 404 {
                        warnings = append(warnings, "robots.txt 获取失败（HTTP "+strconv.Itoa(res.StatusCode)+"），未做 robots 校验，请自行确认目标站允许抓取")
                }
        } else if info == nil && res != nil {
                // 限量读取：防恶意超大 robots.txt 撑爆内存
                body, tooLarge := readAllCapped(res.Body, robotsMaxBytes)
                _ = res.Body.Close()
                if tooLarge {
                        info = &robotsInfo{}
                        warnings = append(warnings, "robots.txt 超过 "+strconv.Itoa(robotsMaxBytes)+"B 上限，未做 robots 校验，请自行确认目标站允许抓取")
                } else {
                        groups := parseRobots(string(body))
                        group := pickGroup(groups, agents)
                        disallowed := group != nil && isPathDisallowed(group, pathname)
                        var delay *float64
                        if group != nil {
                                delay = group.crawlDelayMs
                        }
                        info = &robotsInfo{checked: true, disallowed: disallowed, crawlDelayMs: delay}
                        if disallowed {
                                warnings = append(warnings, "robots.txt 禁止抓取该路径 ("+pathname+")。本服务仅提示不阻断，请自行确认采集授权与合规性")
                        }
                        if delay != nil && *delay > float64(getMinIntervalMs()) {
                                warnings = append(warnings, "robots.txt Crawl-delay="+strconv.Itoa(int(*delay/1000))+"s 高于当前限速 "+strconv.FormatInt(getMinIntervalMs(), 10)+"ms，已采纳为该主机请求间隔下限（建议降低采集频率）")
                        }
                }
        }
        if info == nil {
                info = &robotsInfo{}
        }

        robotsCacheMu.Lock()
        if len(robotsCache) >= robotsCacheMax {
                // 淘汰最早条目（容量上限防无界增长）
                keys := make([]string, 0, len(robotsCache))
                for k := range robotsCache {
                        keys = append(keys, k)
                }
                sort.Slice(keys, func(i, j int) bool { return robotsCache[keys[i]].at.Before(robotsCache[keys[j]].at) })
                if len(keys) > 0 {
                        delete(robotsCache, keys[0])
                }
        }
        robotsCache[origin] = robotsCacheEntry{at: time.Now(), info: *info}
        robotsCacheMu.Unlock()
        return robotsResult{info: *info, warnings: warnings}
}

// readAllCapped 限量读取：超过 maxBytes 立即中止并标记 tooLarge（响应体永不无界进内存）
func readAllCapped(r io.Reader, maxBytes int) ([]byte, bool) {
        buf := make([]byte, 0, 64*1024)
        chunk := make([]byte, 64*1024)
        total := 0
        for {
                n, err := r.Read(chunk)
                if n > 0 {
                        total += n
                        if total > maxBytes {
                                return nil, true
                        }
                        buf = append(buf, chunk[:n]...)
                }
                if err != nil {
                        if err != io.EOF { // Task 34 (P3-14): 非 EOF 读错误不再吞——残缺数据按失败处理（调用方Unmarshal兜底之外的正道）
                                return nil, true
                        }
                        break
                }
        }
        return buf, false
}
