/**
 * SSRF 防护（逐行移植自 rate-limit.ts SSRF 段，语义一行不差）：
 * - IPv4 全部文本形态：点分十进制、短格式(127.1)、八进制(0177.0.0.1)、十六进制(0x7f.0x0.0.1)、
 *   纯十进制整数(2130706433)、纯十六进制(0x7f000001)、纯八进制(017700000001)；
 * - IPv6：::1 / ::、fc00::/7（ULA）、fe80::/10（链路本地）、::ffff:0:0/96（IPv4-mapped 递归检查）、
 *   ::/96（IPv4-compatible 递归检查）、64:ff9b::/96（NAT64 递归检查）；无法解析的 IPv6 文本 fail-closed；
 * - 主机名：文本层（localhost/.localhost/.local/.internal）+ DNS 尽力解析（fail-open，3s 超时）。
 * Task 25-a：已加连接层兑底 ssrfGuardControl（net.Dialer.Control 检查实际拨号对端 IP，
 * 覆盖无代理直连的 fetch/got-scraping/robots/JSON 目录路径），封堵 DNS rebinding TOCTOU；
 * curl-impersonate / browser 桥接为外部进程，仍维持「逐跳 assertHostPublic + 文档声明局限」。
 */
package main

import (
	"context"
	"fmt"
	"net"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

var allowPrivate = envBool("SCRAPER_ALLOW_PRIVATE")

func privateHostAllowed() bool { return allowPrivate }

func envBool(name string) bool {
	return getenv(name) == "1"
}

// ==================== IPv4 文本解析 ====================

var (
	reAllDec  = regexp.MustCompile(`^\d+$`)
	reHex     = regexp.MustCompile(`^0x[0-9a-f]+$`)
	reOct     = regexp.MustCompile(`^0[0-7]+$`)
	rePartDec = regexp.MustCompile(`^\d+$`)
)

// parseIpv4TextOk 解析 IPv4 文本的各种形态，返回 32 位无符号整数；无法识别返回 false。
// 支持：1.2.3.4 / 127.1 / 0177.0.0.1 / 0x7f.0x0.0.1 / 2130706433 / 0x7f000001 / 017700000001
func parseIpv4TextOk(host string) (uint32, bool) {
	h := strings.ToLower(strings.TrimSpace(host))
	if h == "" {
		return 0, false
	}
	// 逐形态判定与 parseIpv4Text 相同，但以第二返回值区分失败
	if reAllDec.MatchString(h) || reHex.MatchString(h) || reOct.MatchString(h) {
		var n uint64
		var err error
		if strings.HasPrefix(h, "0x") {
			n, err = strconv.ParseUint(h[2:], 16, 64)
		} else if reOct.MatchString(h) && len(h) > 1 {
			n, err = strconv.ParseUint(h[1:], 8, 64)
		} else {
			n, err = strconv.ParseUint(h, 10, 64)
		}
		if err != nil || n > 0xffffffff {
			return 0, false
		}
		return uint32(n), true
	}
	parts := strings.Split(h, ".")
	if len(parts) < 1 || len(parts) > 4 {
		return 0, false
	}
	nums := make([]uint32, 0, 4)
	for _, p := range parts {
		if p == "" {
			return 0, false
		}
		var n uint64
		var err error
		if reHex.MatchString(p) {
			n, err = strconv.ParseUint(p[2:], 16, 64)
		} else if reOct.MatchString(p) && len(p) > 1 {
			n, err = strconv.ParseUint(p[1:], 8, 64)
		} else if rePartDec.MatchString(p) {
			n, err = strconv.ParseUint(p, 10, 64)
		} else {
			return 0, false
		}
		if err != nil || n > 255 {
			return 0, false
		}
		nums = append(nums, uint32(n))
	}
	if len(nums) < 4 {
		last := nums[len(nums)-1]
		nums = nums[:len(nums)-1]
		missing := 4 - len(nums) - 1
		if missing > 0 {
			var limit uint64 = 1
			for i := 0; i <= missing; i++ {
				limit *= 256
			}
			if uint64(last) >= limit {
				return 0, false
			}
		}
		for i := missing; i >= 1; i-- {
			div := uint32(1)
			for j := 0; j < i; j++ {
				div *= 256
			}
			nums = append(nums, (last/div)%256)
		}
		nums = append(nums, last%256)
	}
	return (nums[0]<<24 | nums[1]<<16 | nums[2]<<8 | nums[3]) & 0xffffffff, true
}

func ipv4IsPrivate(n uint32) bool {
	top8 := n >> 24
	top16 := n >> 16
	// 0.0.0.0/8 "本网络"、10/8、127/8、169.254/16、172.16/12、192.168/16、100.64/10（CGNAT）、198.18/15（基准测试保留）
	if top8 == 0 || top8 == 10 || top8 == 127 {
		return true
	}
	if top16 == 0xa9fe { // 169.254.x.x
		return true
	}
	if top16 == 0xc0a8 { // 192.168.x.x
		return true
	}
	if top16 >= 0xac10 && top16 <= 0xac1f { // 172.16.0.0/12
		return true
	}
	if top8 == 100 {
		second := (n >> 16) & 0xff
		if second >= 64 && second <= 127 {
			return true
		}
	}
	if top16 == 0xc612 || top16 == 0xc613 { // 198.18.0.0/15
		return true
	}
	// 224.0.0.0/4（组播）与 240.0.0.0/4（保留/广播）
	top := n & 0xf0000000
	if top == 0xe0000000 || top == 0xf0000000 {
		return true
	}
	return false
}

// ==================== IPv6 文本解析 ====================

// parseIpv6Text 把 IPv6 文本展开为 8 组 16 位数值；无法解析返回 nil。
func parseIpv6Text(host string) []uint16 {
	h := strings.ToLower(strings.TrimSpace(host))
	if !strings.Contains(h, ":") {
		return nil
	}
	// 内嵌 IPv4 尾部（::ffff:192.168.1.1）→ 转成两组十六进制
	tailIdx := strings.LastIndex(h, ":")
	tailStr := h[tailIdx+1:]
	if strings.Contains(tailStr, ".") {
		n, ok := parseIpv4TextOk(tailStr)
		if !ok {
			return nil
		}
		h = h[:tailIdx+1] + strconv.FormatUint(uint64(n>>16), 16) + ":" + strconv.FormatUint(uint64(n&0xffff), 16)
	}
	if !reIpv6Chars.MatchString(h) {
		return nil
	}
	halves := strings.Split(h, "::")
	if len(halves) > 2 {
		return nil
	}
	var left, right []string
	if halves[0] != "" {
		for _, g := range strings.Split(halves[0], ":") {
			if g != "" {
				left = append(left, g)
			}
		}
	}
	if len(halves) == 2 && halves[1] != "" {
		for _, g := range strings.Split(halves[1], ":") {
			if g != "" {
				right = append(right, g)
			}
		}
	}
	for _, g := range append(append([]string{}, left...), right...) {
		if len(g) > 4 {
			return nil
		}
		if _, err := strconv.ParseUint(g, 16, 32); err != nil {
			return nil
		}
	}
	fill := 8 - len(left) - len(right)
	if fill < 0 {
		return nil
	}
	groups := make([]uint16, 0, 8)
	for _, g := range left {
		v, _ := strconv.ParseUint(g, 16, 32)
		groups = append(groups, uint16(v))
	}
	for i := 0; i < fill; i++ {
		groups = append(groups, 0)
	}
	for _, g := range right {
		v, _ := strconv.ParseUint(g, 16, 32)
		groups = append(groups, uint16(v))
	}
	if len(groups) != 8 {
		return nil
	}
	return groups
}

var reIpv6Chars = regexp.MustCompile(`^[0-9a-f:]+$`)

func ipv6IsPrivate(groups []uint16) bool {
	allZero := true
	for _, g := range groups {
		if g != 0 {
			allZero = false
			break
		}
	}
	if allZero { // ::（未指定地址）
		return true
	}
	// ::1
	first7Zero := true
	for _, g := range groups[:7] {
		if g != 0 {
			first7Zero = false
			break
		}
	}
	if first7Zero && groups[7] == 1 {
		return true
	}
	// fc00::/7（ULA：fc/fd 开头）
	if groups[0]&0xfe00 == 0xfc00 {
		return true
	}
	// fe80::/10（链路本地）
	if groups[0]&0xffc0 == 0xfe80 {
		return true
	}
	v4 := func() uint32 { return uint32(groups[6])<<16 | uint32(groups[7]) }
	// ::ffff:0:0/96 IPv4-mapped → 递归检查内嵌 IPv4
	m1 := true
	for _, g := range groups[:5] {
		if g != 0 {
			m1 = false
			break
		}
	}
	if m1 && groups[5] == 0xffff {
		return ipv4IsPrivate(v4())
	}
	// ::/96（IPv4-compatible，已废弃）：非全零内嵌 IPv4 时递归检查
	m2 := true
	for _, g := range groups[:6] {
		if g != 0 {
			m2 = false
			break
		}
	}
	if m2 && (groups[6] != 0 || groups[7] != 0) {
		return ipv4IsPrivate(v4())
	}
	// 64:ff9b::/96 NAT64
	if groups[0] == 0x64 && groups[1] == 0xff9b {
		mid := true
		for _, g := range groups[2:6] {
			if g != 0 {
				mid = false
				break
			}
		}
		if mid {
			return ipv4IsPrivate(v4())
		}
	}
	return false
}

// ==================== 文本层检查 ====================

// isPrivateHost 文本层内网地址检查（覆盖 IPv4 全部文本形态 + IPv6 主流内网形态），不做 DNS。
func isPrivateHost(hostname string) bool {
	h := strings.ToLower(strings.TrimSpace(hostname))
	h = strings.TrimPrefix(h, "[")
	h = strings.TrimSuffix(h, "]")
	h = strings.TrimSuffix(h, ".")
	if h == "" {
		return true
	}
	if h == "localhost" || strings.HasSuffix(h, ".localhost") || strings.HasSuffix(h, ".local") || strings.HasSuffix(h, ".internal") {
		return true
	}
	if strings.Contains(h, ":") {
		groups := parseIpv6Text(h)
		// 解析失败的 IPv6 文本（zone id 等）一律 fail-closed
		if groups == nil {
			return true
		}
		return ipv6IsPrivate(groups)
	}
	if v4, ok := parseIpv4TextOk(h); ok {
		return ipv4IsPrivate(v4)
	}
	return false
}

// ==================== DNS 尽力校验 ====================

const (
	dnsCacheTTLMS     = 5 * 60 * 1000
	dnsCacheMax       = 512
	dnsLookupTimeout  = 3 * time.Second
	dnsNegativeExpiry = 60 * 1000 // 解析失败（NXDOMAIN 等）的缓存时长，防每请求都打 DNS
)

type dnsEntry struct {
	at         time.Time
	privateHit bool
	warning    string
	negative   bool // 解析失败（fail-open）
}

var (
	dnsCacheMu syncMutex
	dnsCache   = map[string]dnsEntry{}
)

type hostCheckResult struct {
	ok      bool
	reason  string
	warning string
}

// assertHostPublic 主机名/IPC 位置的 SSRF 校验入口：
// IP 字面量 → 纯文本检查；主机名 → 文本层 + DNS 尽力解析（fail-open）。
// SCRAPER_ALLOW_PRIVATE=1 时全部放行（本地调试用）。
func assertHostPublic(hostname string) hostCheckResult {
	if allowPrivate {
		return hostCheckResult{ok: true}
	}
	h := strings.ToLower(strings.TrimSpace(hostname))
	h = strings.TrimPrefix(h, "[")
	h = strings.TrimSuffix(h, "]")
	if h == "" {
		return hostCheckResult{ok: false, reason: "空主机名"}
	}

	// IP 字面量（含 IPv6）：文本检查即可，无需 DNS
	if v4, ok := parseIpv4TextOk(h); ok {
		if ipv4IsPrivate(v4) {
			return hostCheckResult{ok: false, reason: "内网 IPv4 地址被拒绝: " + h}
		}
		return hostCheckResult{ok: true}
	}
	if strings.Contains(h, ":") {
		groups := parseIpv6Text(h)
		// fail-closed：无法解析的 IPv6（zone id 等）直接拒绝，不落入 DNS fail-open 分支
		if groups == nil {
			return hostCheckResult{ok: false, reason: "无法解析的 IPv6 地址被拒绝（fail-closed）: " + h}
		}
		if ipv6IsPrivate(groups) {
			return hostCheckResult{ok: false, reason: "内网 IPv6 地址被拒绝: " + h}
		}
		return hostCheckResult{ok: true}
	}

	// 主机名文本层检查（必须在 DNS 之前）：systemd-resolved 会把 *.localhost 解析到 127.0.0.1、
	// mDNS 会把 *.local 解析到局域网设备 —— 纯靠 DNS fail-open 是可被绕过的 SSRF 口
	if isPrivateHost(h) {
		return hostCheckResult{ok: false, reason: "主机名命中内网文本层规则（SSRF 防护）: " + h}
	}

	// 主机名：DNS 尽力解析（带缓存）
	dnsCacheMu.Lock()
	cached, has := dnsCache[h]
	dnsCacheMu.Unlock()
	if has {
		ttl := time.Duration(dnsCacheTTLMS) * time.Millisecond
		if cached.negative {
			ttl = time.Duration(dnsNegativeExpiry) * time.Millisecond
		}
		if time.Since(cached.at) < ttl {
			if cached.privateHit {
				return hostCheckResult{ok: false, reason: "域名 " + h + " 解析到内网地址（DNS 层 SSRF 防护）"}
			}
			return hostCheckResult{ok: true, warning: cached.warning}
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), dnsLookupTimeout)
	defer cancel()
	var lastErr error
	privateHit := false
	hitLabel := ""
	resolver := net.DefaultResolver
	addrs4, err4 := resolver.LookupIPAddr(ctx, h)
	if err4 != nil {
		lastErr = err4
	} else {
		for _, a := range addrs4 {
			ip := a.IP
			if v4 := ip.To4(); v4 != nil {
				n := uint32(v4[0])<<24 | uint32(v4[1])<<16 | uint32(v4[2])<<8 | uint32(v4[3])
				if ipv4IsPrivate(n) {
					privateHit = true
					hitLabel = ip.String()
					break
				}
			} else {
				groups := ipv6ToGroups(ip)
				if groups != nil && ipv6IsPrivate(groups) {
					privateHit = true
					hitLabel = ip.String()
					break
				}
			}
		}
	}

	entry := dnsEntry{at: time.Now(), privateHit: privateHit}
	var res hostCheckResult
	if privateHit {
		res = hostCheckResult{ok: false, reason: "域名 " + h + " 解析到内网地址 " + hitLabel + "（DNS 层 SSRF 防护）"}
	} else if lastErr != nil {
		// fail-open：DNS 查询失败时放行，后续 fetch 会自然暴露连接错误
		entry.negative = true
		entry.warning = "DNS 校验失败（" + lastErr.Error() + "），已放行由请求层兜底"
		res = hostCheckResult{ok: true, warning: entry.warning}
	} else if len(addrs4) == 0 {
		entry.warning = "域名 " + h + " DNS 解析结果为空"
		res = hostCheckResult{ok: true, warning: entry.warning}
	} else {
		res = hostCheckResult{ok: true}
	}
	dnsCacheMu.Lock()
	if len(dnsCache) >= dnsCacheMax {
		// 淘汰最早条目（简化 LRU：随机淘汰最早写入者即可，容量上限防无界增长）
		for k := range dnsCache {
			delete(dnsCache, k)
			break
		}
	}
	dnsCache[h] = entry
	dnsCacheMu.Unlock()
	return res
}

// ipv6ToGroups 把 16 字节 IP 转成 8 组 16 位（供 DNS 结果复用 ipv6IsPrivate）
func ipv6ToGroups(ip net.IP) []uint16 {
	b := ip.To16()
	if b == nil {
		return nil
	}
	groups := make([]uint16, 8)
	for i := 0; i < 8; i++ {
		groups[i] = uint16(b[i*2])<<8 | uint16(b[i*2+1])
	}
	return groups
}

// ==================== 连接层 SSRF 兑底（Task 25-a：封堵 DNS rebinding TOCTOU） ====================

// assertHostPublic 的 DNS 校验只覆盖「解析时」的 IP；「校验通过 → 实际连接」之间攻击者
// 可借低 TTL DNS rebinding 把同一域名二次解析到内网地址（文本层 + DNS 层都拦不住）。
// ssrfGuardControl 返回 net.Dialer.Control 钩子：在 TCP 连接建立前检查内核实际选中的
// 对端 IP，命中内网段（复用 ipv4IsPrivate/ipv6IsPrivate 同一套语义）直接拒绝拨号。
// SCRAPER_ALLOW_PRIVATE=1（本地调试）时返回 nil（不加钩子）。
// 仅用于无代理直连传输层：配置了出口代理时拨号对象是代理自身（是否内网由部署方决定），
// 不应套用目标站 SSRF 规则。
func ssrfGuardControl() func(network, address string, c syscall.RawConn) error {
	if allowPrivate {
		return nil
	}
	return func(_ string, address string, _ syscall.RawConn) error {
		host, _, err := net.SplitHostPort(address)
		if err != nil {
			return fmt.Errorf("ssrf-guard: 无法解析拨号地址 %q", address)
		}
		ip := net.ParseIP(host)
		if ip == nil {
			return fmt.Errorf("ssrf-guard: 非法对端地址 %q", host)
		}
		blocked := ""
		if v4 := ip.To4(); v4 != nil {
			n := uint32(v4[0])<<24 | uint32(v4[1])<<16 | uint32(v4[2])<<8 | uint32(v4[3])
			if ipv4IsPrivate(n) {
				blocked = host
			}
		} else if groups := ipv6ToGroups(ip); groups != nil && ipv6IsPrivate(groups) {
			blocked = host
		}
		if blocked != "" {
			return fmt.Errorf("ssrf-guard: 连接目标解析到内网地址 %s（连接层 SSRF 防护）", blocked)
		}
		return nil
	}
}

// ssrfGuardDialer 构建带连接层 SSRF 钩子的拨号器（不做额外超时约束——既有路径由
// 各 client.Timeout / 硬时间闸兜底，保持拨号行为不变）
func ssrfGuardDialer() *net.Dialer {
	d := &net.Dialer{KeepAlive: 30 * time.Second}
	if c := ssrfGuardControl(); c != nil {
		d.Control = c
	}
	return d
}
