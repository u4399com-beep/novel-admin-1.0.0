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
	"os"
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

// acquireDomainSlot 获取指定域名的请求槽位：同域名并发请求串行排队，相邻两次请求
// 之间至少间隔 getMinIntervalMs() ± 抖动；不同域名互不影响。
// 语义对齐 TS 版（FIFO 排队 + 排队后各自计算等待），锁仅在计算窗口持有，等待发生在锁外。
func acquireDomainSlot(host string) {
	slot := getHostSlot(host)
	slot.mu.Lock()
	now := time.Now()
	base := now
	if slot.nextAt.After(base) {
		base = slot.nextAt
	}
	wait := base.Sub(now)
	slot.nextAt = base.Add(time.Duration(getMinIntervalMs())*time.Millisecond + time.Duration(rand.Intn(jitterMS))*time.Millisecond)
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

// robotsTransport robots 检查专用传输层（无代理语义与 TS 版 fetch 一致）。
// Task 25-a: 加连接层 SSRF 兑底（DNS rebinding TOCTOU 封堵）；环境已配置代理时
// 拨号对象是代理自身，不套用目标站内网拦截（robots 仅 warn-only，失败也只降级为提示）。
func robotsTransport() *http.Transport {
	tr := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		MaxIdleConns:          4,
		IdleConnTimeout:       30 * time.Second,
		TLSHandshakeTimeout:   5 * time.Second,
		ResponseHeaderTimeout: 5 * time.Second,
	}
	if !proxyEnvPresent() {
		tr.DialContext = ssrfGuardDialer().DialContext
	}
	return tr
}

// proxyEnvPresent 环境是否配置了 HTTP(S)_PROXY（Go http.ProxyFromEnvironment 读取的键全集）
func proxyEnvPresent() bool {
	for _, k := range []string{"HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"} {
		if os.Getenv(k) != "" {
			return true
		}
	}
	return false
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
