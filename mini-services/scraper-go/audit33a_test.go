/**
 * audit33a_test.go —— Task 33-a 深度抓 bug 回归锁定（表驱动，风格对齐 aimd_test.go/concurrency_test.go）：
 * ①assess 严格 2xx 门（旧实现 300/304-with-body 误判 ok=true，httpguard.go）
 * ②Set-Cookie Max-Age 非有限值/超大值守卫（旧实现 int64(sec*1000) 溢出毒化过期时间，cookies.go）
 * ③SCRAPER_MIN_INTERVAL_MS 上限护栏（旧实现无上界 → nextAt 前跳数天 + goroutine 等槽堆积，ratelimit.go）
 * ④clampTimeout ±Inf 量级守卫（旧实现 int(n) 实现定义转换，util.go）
 * ⑤parseSetCookieLine 常规属性回归（Max-Age=0 删除指令/Expires 过期）
 * 运行：cd mini-services/scraper-go && go test -race ./... -count=1
 */
package main

import (
	"testing"
	"time"
)

// TestAssessStrict2xx 非阻塞响应评估的状态码门（Task 33-a 修复回归，表驱动）
func TestAssessStrict2xx(t *testing.T) {
	body := []byte("<html><body>正文内容，不是挑战页，长度足够通过挑战检测。</body></html>")
	cases := []struct {
		name   string
		status int
		body   []byte
		wantOK bool
		note   string
	}{
		{"200 有体 → 成功", 200, body, true, ""},
		{"204 等其它 2xx 有体 → 成功", 206, body, true, ""},
		{"304 有体 → 失败（旧实现误判成功）", 304, body, false, "http-304"},
		{"300 Multiple Choices 有体 → 失败", 300, body, false, "http-300"},
		{"403 → 失败", 403, body, false, "http-403"},
		{"500 → 失败", 500, body, false, "http-500"},
		{"0 → 网络错误", 0, body, false, "network-error"},
		{"200 空体 → empty-body", 200, nil, false, "empty-body"},
		{"304 空体 → 状态门优先于 empty-body", 304, nil, false, "http-304"},
	}
	for _, c := range cases {
		a := assess(c.status, c.body, "text/html; charset=utf-8")
		if a.ok != c.wantOK {
			t.Fatalf("%s: assess(%d).ok = %v, want %v（note=%q）", c.name, c.status, a.ok, c.wantOK, a.note)
		}
		if c.note != "" && a.note != c.note {
			t.Fatalf("%s: assess(%d).note = %q, want %q", c.name, c.status, a.note, c.note)
		}
	}
	// 挑战检测门优先于状态码门（挑战页无论状态码都 blocked）
	chal := []byte("<html><head><title>Just a moment...</title></head><body>x</body></html>")
	a := assess(200, chal, "text/html")
	if a.ok || !a.blocked || a.note != "challenge-page" {
		t.Fatalf("挑战页应 blocked/challenge-page，got %+v", a)
	}
}

// TestParseSetCookieLineMaxAgeBounds Max-Age 属性数值边界（Task 33-a 修复回归，表驱动）
func TestParseSetCookieLineMaxAgeBounds(t *testing.T) {
	now := int64(1_700_000_000_000)
	cases := []struct {
		name       string
		line       string
		wantRemove bool
		wantExpiry int64 // 0 = 不断言（按其它断言判定）
	}{
		// inf/NaN：ParseFloat 接受但 int64 转换溢出 → 忽略属性，按会话默认 TTL 入库
		{"Max-Age=inf 忽略属性按默认 TTL", "a=1; Max-Age=inf", false, now + cookieSessionTTLMS},
		{"Max-Age=NaN 忽略属性按默认 TTL", "a=1; Max-Age=NaN", false, now + cookieSessionTTLMS},
		{"Max-Age=1e999 ParseFloat 报错忽略", "a=1; Max-Age=1e999", false, now + cookieSessionTTLMS},
		// 超大有限值：float 域钳制后不溢出；实现语义为 min(默认会话 TTL, Max-Age)，
		// 故 30min 会话 TTL 生效（既有语义回归锁定）
		{"Max-Age 超大取 min(会话TTL,Max-Age)", "a=1; Max-Age=999999999999", false, now + cookieSessionTTLMS},
		{"Max-Age=0 删除指令", "a=1; Max-Age=0", true, 0},
		{"Max-Age=-5 删除指令", "a=1; Max-Age=-5", true, 0},
		{"Max-Age=3600 取 min(会话TTL,Max-Age)", "a=1; Max-Age=3600", false, now + cookieSessionTTLMS},
	}
	for _, c := range cases {
		p := parseSetCookieLine(c.line, now)
		if c.wantRemove {
			if p == nil || !p.remove {
				t.Fatalf("%s: 应解析为删除指令，got %+v", c.name, p)
			}
			continue
		}
		if p == nil || p.remove {
			t.Fatalf("%s: 不应解析为删除指令，got %+v", c.name, p)
		}
		if c.wantExpiry != 0 && p.expiresAt != c.wantExpiry {
			t.Fatalf("%s: expiresAt = %d, want %d（负/溢出过期时间即回归）", c.name, p.expiresAt, c.wantExpiry)
		}
		if p.expiresAt <= now {
			t.Fatalf("%s: 过期时间必须晚于 now，got %d", c.name, p.expiresAt)
		}
	}
	// Expires 过期 → 删除指令（既有语义回归）
	if p := parseSetCookieLine("a=1; Expires=Mon, 02 Jan 2006 15:04:05 GMT", now); p == nil || !p.remove {
		t.Fatalf("过期 Expires 应解析为删除指令，got %+v", p)
	}
}

// TestGetMinIntervalMsClamp SCRAPER_MIN_INTERVAL_MS 边界钳制（Task 33-a 修复回归，表驱动）
func TestGetMinIntervalMsClamp(t *testing.T) {
	cases := []struct {
		raw  string
		want int64
	}{
		{"", defaultMinIntervalMS},    // 未配置 → 默认
		{"abc", defaultMinIntervalMS}, // 非数字 → 默认
		{"0", defaultMinIntervalMS},   // 非正数 → 默认
		{"500", 1000},                 // 低于合规下限 → 抬到 1000
		{"2000", 2000},                // 正常自定义值
		{"60000", 60000},              // 恰在上界
		{"60001", 60000},              // 超上界 → 钳制
		{"1200000", 60000},            // 误把秒写成毫秒的典型场景 → 钳制
	}
	for _, c := range cases {
		t.Setenv("SCRAPER_MIN_INTERVAL_MS", c.raw)
		if got := getMinIntervalMs(); got != c.want {
			t.Fatalf("SCRAPER_MIN_INTERVAL_MS=%q: getMinIntervalMs() = %d, want %d", c.raw, got, c.want)
		}
	}
}

// TestClampTimeoutBounds timeoutMs 参数钳制边界（Task 33-a 修复回归，表驱动）
func TestClampTimeoutBounds(t *testing.T) {
	cases := []struct {
		name string
		in   any
		want int
	}{
		{"字符串 inf → 默认", "inf", 20_000},
		{"字符串 1e999（ParseFloat 得 +Inf）→ 默认", "1e999", 20_000},
		{"字符串 -1e999 → 默认", "-1e999", 20_000},
		{"字符串 NaN → 默认", "NaN", 20_000},
		{"字符串非数字 → 默认", "abc", 20_000},
		{"字符串 30000 → 原样", "30000", 30_000},
		{"数值 1000 → 抬到下限", float64(1000), 2_000},
		{"数值 900000 → 压到上限", float64(900_000), 60_000},
		{"数值 20000 → 原样", float64(20_000), 20_000},
		{"不支持的类型 → 默认", true, 20_000},
	}
	for _, c := range cases {
		if got := clampTimeout(c.in); got != c.want {
			t.Fatalf("%s: clampTimeout(%v) = %d, want %d", c.name, c.in, got, c.want)
		}
	}
}

// TestHostSlotIntervalBoundedWithEnv 上限护栏与限速槽位联动：把间隔配置成超大值后，
// 槽位 nextAt 的前跳量必须被钳在钳制间隔 + 突发抑制 + 抖动量级内（防「一次前跳数天」）。
func TestHostSlotIntervalBoundedWithEnv(t *testing.T) {
	t.Setenv("SCRAPER_MIN_INTERVAL_MS", "1200000") // 误配置：20 分钟
	slot := getHostSlot("clamp33a.test")
	slot.mu.Lock()
	slot.nextAt = time.Time{} // 归零起点
	slot.consec.Store(0)
	slot.mu.Unlock()
	acquireDomainSlot("clamp33a.test")
	slot.mu.Lock()
	gap := slot.nextAt.Sub(time.Now())
	slot.mu.Unlock()
	if gap <= 0 {
		t.Fatalf("nextAt 应前跳，got %v", gap)
	}
	// 钳制间隔 60s + 突发抑制 ≤1s + 抖动 ≤300ms + 排队耗时余量
	if gap > 65*time.Second {
		t.Fatalf("nextAt 前跳 %v 超过钳制上界（护栏未生效，goroutine 将按天等槽）", gap)
	}
	if gap < 58*time.Second {
		t.Fatalf("nextAt 前跳 %v 低于钳制间隔（限速语义被破坏）", gap)
	}
}
