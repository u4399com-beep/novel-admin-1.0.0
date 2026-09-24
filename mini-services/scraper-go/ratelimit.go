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
	"net"
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
	// aimdDecayStepMS 每次成功后的加性回落步长（任务书：每次成功 -0.05s）
	aimdDecayStepMS = 50
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
	aimdMs atomic.Int64
	// Task 31-b: 自适应态下的连续成功计数（加性回落按每次成功逐步进行）
	aimdOKStreak atomic.Int64
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
	slot.lastUsedNano.Store(now.UnixNano())
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

// noteAdaptiveRateLimited Task 31-b AIMD「乘性增大」入口：该主机收到 429/503 时调用。
// 带 Retry-After 时直接采纳其值（仍受 parseRetryAfterMs 的 30s 解析上限约束，且不高于
// 既有值时取较大者——站点给的窗口优先于本地推断）；无 Retry-After 时 ×1.5 逐步放大。
// 同时清零连续成功计数（回落序列重新开始）。
func noteAdaptiveRateLimited(host string, retryAfterMs *int64) {
	if host == "" {
		return
	}
	slot := getHostSlot(host)
	cur := slot.aimdMs.Load()
	floor := getMinIntervalMs()
	var next int64
	if retryAfterMs != nil && *retryAfterMs > 0 {
		next = *retryAfterMs
		if next < floor {
			next = floor // 合规下限：自适应间隔不得低于基础礼貌间隔
		}
		if cur > next {
			next = cur // 已在更高退避位时只升不降（限流窗口叠加）
		}
	} else {
		next = aimdMulStep(cur, floor)
	}
	slot.aimdMs.Store(next)
	slot.aimdOKStreak.Store(0)
}

// noteAdaptiveSuccess Task 31-b AIMD「加性回落」入口：该主机一次成功抓取后调用。
// 处于自适应态（aimdMs>基础间隔）时每次成功回落 aimdDecayStepMS（50ms），到达基础间隔后
// 归零自适应态（aimdMs=0 → 后续直接用基础间隔）。
func noteAdaptiveSuccess(host string) {
	if host == "" {
		return
	}
	slot := getHostSlot(host)
	cur := slot.aimdMs.Load()
	if cur <= 0 {
		return // 未进入自适应态
	}
	floor := getMinIntervalMs()
	next := aimdAddStep(cur, floor)
	if next <= floor {
		next = 0 // 已回到基础间隔：退出自适应态
	}
	slot.aimdMs.Store(next)
	slot.aimdOKStreak.Add(1)
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

// politenessExtraMS 突发抑制的额外间隔：每满 200 次连续请求 +100ms，上界 +1s。
// 抽成纯函数便于单测（Task 26-d）。
func politenessExtraMS(consec int64) int64 {
	if consec <= 0 {
		return 0
	}
	extra := (consec / 200) * 100
	if extra > 1000 {
		extra = 1000
	}
	return extra
}

// acquireDomainSlot 获取指定域名的请求槽位：同域名并发请求串行排队，相邻两次请求
// 之间至少间隔「基础礼貌间隔或 AIMD 自适应间隔的较大者」± 抖动；不同域名互不影响。
// 语义对齐 TS 版（FIFO 排队 + 排队后各自计算等待），锁仅在计算窗口持有，等待发生在锁外。
// Task 26-d 突发抑制：同主机持续请求时在基准间隔上叠加 politenessExtraMS(consec)，
// 长跑 Phase 2（数万章）随请求量自动从 1.2s 放缓至 ≈2.2-2.5s，降低触发源站封禁的概率；
// 只增不减，空闲 5 分钟复位，对短任务无感。
// Task 31-b AIMD 自适应：429/503 限流后该主机间隔乘性增大（×1.5 上界 8s；Retry-After 直接
// 采纳），连续成功后加性缓慢回落（每次成功 -50ms 下限 1.2s）——被限流自动慢下来、恢复后
// 缓慢提速，成为引擎内建行为。空闲 ≥5 分钟时 AIMD 与突发抑制一并复位。
func acquireDomainSlot(host string) {
	slot := getHostSlot(host)
	slot.mu.Lock()
	now := time.Now()
	if now.UnixNano()-slot.lastUsedNano.Load() > int64(5*time.Minute) {
		slot.consec.Store(0) // 空闲复位：突发抑制只针对持续批量
		slot.aimdMs.Store(0) // Task 31-b: AIMD 同口径空闲复位（限流记忆由 hosthealth penalty 继续承担短期退避）
		slot.aimdOKStreak.Store(0)
	}
	n := slot.consec.Add(1)
	// Task 31-b: 有效基础间隔 = max(基础礼貌间隔, AIMD 自适应间隔)
	interval := getMinIntervalMs()
	if ai := slot.aimdMs.Load(); ai > interval {
		interval = ai
	}
	base := now
	if slot.nextAt.After(base) {
		base = slot.nextAt
	}
	wait := base.Sub(now)
	slot.nextAt = base.Add(time.Duration(interval+politenessExtraMS(n))*time.Millisecond + time.Duration(rand.Intn(jitterMS))*time.Millisecond)
	slot.lastUsedNano.Store(now.UnixNano())
	slot.mu.Unlock()
	if wait > 0 {
		time.Sleep(wait)
	}
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
	for _, layout := range []string{http.TimeFormat, "Mon, 02 Jan 2006 15:04:05 GMT", time.RFC850, time.ANSIC} {
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

// robotsTransport robots 检查专用传输：直连不读代理环境变量（与引擎其余路径
// 「未配置代理时严格直连」口径一致，也使 Dialer Control 的直连前提成立）；
// Task 26-d 起挂载 ssrfDialControl 作 DNS rebinding 最后一道闸。
func robotsTransport() *http.Transport {
	dialer := &net.Dialer{
		Timeout:   5 * time.Second,
		KeepAlive: 30 * time.Second,
	}
	if !allowPrivate {
		dialer.Control = ssrfDialControl
	}
	return &http.Transport{
		Proxy:                 nil,
		DialContext:           dialer.DialContext,
		MaxIdleConns:          4,
		IdleConnTimeout:       30 * time.Second,
		TLSHandshakeTimeout:   5 * time.Second,
		ResponseHeaderTimeout: 5 * time.Second,
	}
}

// checkRobots 检查目标 URL 是否被 robots.txt 限制。永不失败、永不阻断 —— 失败时降级为 warning。
func checkRobots(targetURL string) robotsResult {
	agents := []string{"novel-admin-scraper", "*"}
	u, err := url.Parse(targetURL)
	if err != nil || u.Host == "" {
		return robotsResult{warnings: []string{"robots 检查：URL 无法解析，跳过"}}
	}
	origin := u.Scheme + "://" + u.Host
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
			warnings = append(warnings, "robots.txt Crawl-delay="+strconv.Itoa(int(*info.crawlDelayMs/1000))+"s 高于当前限速 "+strconv.FormatInt(getMinIntervalMs(), 10)+"ms，建议降低采集频率")
		}
		return robotsResult{info: info, warnings: warnings}
	}

	warnings := []string{}
	var info *robotsInfo
	// 限速槽位 key 与策略层一致（含端口，见 hostOf），避免同源不同 key 绕过限速
	acquireDomainSlot(u.Host)
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
				warnings = append(warnings, "robots.txt Crawl-delay="+strconv.Itoa(int(*delay/1000))+"s 高于当前限速 "+strconv.FormatInt(getMinIntervalMs(), 10)+"ms，建议降低采集频率")
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
			break
		}
	}
	return buf, false
}
