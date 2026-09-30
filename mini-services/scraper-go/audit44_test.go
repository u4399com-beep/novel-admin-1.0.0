// Task 44-a 逐行深审修复锁定（audit44）：
//
//   - FIX-1 P2·反反爬 curl-impersonate 车道 UA/TLS 家族一致性：
//     旧实现把 chromeDesktopProfile 硬编码进该车道（curlimp.go），而二进制按 JA3 家族轮换
//     （curl_chrome* / curl_ff* / curl_safari* / curl_edge*）——轮到 curl_ff* 时是「Firefox TLS/JA3 配
//     Chrome UA + sec-ch-ua 客户端提示」的跨家族指纹矛盾（Firefox/Safari 从不发送客户端提示），
//     服务端可直接识别；多二进制 JA3 轮换反而变成「每轮都自曝矛盾」。修复：按二进制家族选同族
//     画像（UA 版本仍取 39-a E1 保鲜画像——JA3 与 UA 跨版本属弱信号，版本陈旧才是强信号）。
//   - FIX-2 P3 browser cookie 回退注入路径桶 key 归一：38-a 的 hostOf 契约最后漏网点（回退路径
//     旧实现传 tu.Host 原样，URL 大写变体时回退查询必 miss）。抽出 browserCookieEnv 使契约可测。
//   - E2 增强 robots.txt Crawl-delay 采纳为主机 AIMD 礼貌间隔下限（只升不降、上界 30s 与
//     Retry-After 外部指令上限同口径；warn-only 语义不变——不阻断任何请求，只放慢节奏）。
package main

import (
	"strings"
	"testing"
)

// ---- FIX-1：curl-impersonate 二进制家族 ↔ 请求头画像家族一致 ----

func TestCurlImpersonateProfileFamilyAlignment(t *testing.T) {
	cases := []struct {
		bin       string // detectCurlImpersonates 产出的二进制 basename
		wantUATok string // UA 必含的家族标识
		wantCH    bool   // 是否应携带 sec-ch-ua 客户端提示（Firefox/Safari 恒 false）
	}{
		{"curl_chrome131", "Chrome/", true},
		{"curl-impersonate-chrome", "Chrome/", true},
		{"curl_ff135", "Firefox/", false},
		{"curl-impersonate-firefox120", "Firefox/", false},
		{"curl_safari17.0", "Safari/605.1.15", false},
		{"curl-impersonate-safari", "Safari/605.1.15", false},
		{"curl_edge131", "Edg/", true},
		{"curl-impersonate", "Chrome/", true}, // 泛名（无家族后缀）默认 chrome 系
	}
	for _, c := range cases {
		p := curlHeaderProfileFor(c.bin)
		h := p.headers("https://example.com/book/1.html", p.withReferer, "")
		ua := h["user-agent"]
		if !strings.Contains(ua, c.wantUATok) {
			t.Errorf("二进制 %s：UA=%q 不含家族标识 %q（画像 id=%s）", c.bin, ua, c.wantUATok, p.id)
		}
		if _, ok := h["sec-ch-ua"]; ok != c.wantCH {
			t.Errorf("二进制 %s：sec-ch-ua 存在性=%v，期望 %v（画像 id=%s）——Firefox/Safari JA3 配客户端提示属跨家族指纹矛盾", c.bin, ok, c.wantCH, p.id)
		}
	}
}

// 跨家族矛盾的反向锁定：Firefox/Safari 二进制绝不允许拿到 Chrome 客户端提示画像
func TestCurlImpersonateProfileNoCrossFamilyHints(t *testing.T) {
	for _, bin := range []string{"curl_ff135", "curl-impersonate-firefox", "curl_safari", "curl-impersonate-safari"} {
		p := curlHeaderProfileFor(bin)
		h := p.headers("https://example.com/", p.withReferer, "")
		for _, forbidden := range []string{"sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform"} {
			if v, ok := h[forbidden]; ok {
				t.Errorf("二进制 %s（画像 %s）：非 Chromium 家族画像不得携带 %s=%q", bin, p.id, forbidden, v)
			}
		}
	}
}

// ---- FIX-2：browser cookie 注入路径桶 key 归一（hostOf 契约） ----

func TestBrowserCookieEnvKeyNormalization(t *testing.T) {
	recordSetCookieLines("browser-key.test", []string{"sid=abc123; Path=/"}, false)
	lo := browserCookieEnv("http://browser-key.test/book/1")
	up := browserCookieEnv("http://BROWSER-KEY.TEST/book/1")
	if !strings.Contains(lo, "sid=abc123") {
		t.Errorf("正常回放失败：env=%q", lo)
	}
	if lo != up {
		t.Errorf("URL 大小写变体回放不一致（桶 key 未归一）：%q vs %q", lo, up)
	}
}

func TestBrowserCookieEnvSecureFiltered(t *testing.T) {
	recordSetCookieLines("browser-secure.test", []string{"sec=1; Path=/; Secure"}, false)
	if got := browserCookieEnv("http://browser-secure.test/x"); got != "" {
		t.Errorf("Secure cookie 不应在 http 目标回放：%q", got)
	}
	if got := browserCookieEnv("https://browser-secure.test/x"); !strings.Contains(got, "sec=1") {
		t.Errorf("Secure cookie 应在 https 目标回放：%q", got)
	}
}

// ---- E2 增强：robots.txt Crawl-delay 采纳为礼貌间隔下限 ----

func TestNoteCrawlDelayFloor(t *testing.T) {
	host := "crawl-floor.test"
	// 低于基础礼貌间隔：不采纳（默认节奏已更严）
	noteCrawlDelayFloor(host, 500)
	if got := hostAdaptiveIntervalMs(host); got != 0 {
		t.Errorf("500ms 低于基础间隔不应采纳，got %d", got)
	}
	// 高于基础间隔：采纳为下限
	noteCrawlDelayFloor(host, 5000)
	if got := hostAdaptiveIntervalMs(host); got != 5000 {
		t.Errorf("5000ms 应被采纳为间隔下限，got %d", got)
	}
	// 只升不降：更小的 crawl-delay 不回退既有下限
	noteCrawlDelayFloor(host, 3000)
	if got := hostAdaptiveIntervalMs(host); got != 5000 {
		t.Errorf("3000ms 不应降低既有下限 5000，got %d", got)
	}
	// 上界 30s（与 parseRetryAfterMs 外部指令上限同口径）
	noteCrawlDelayFloor("crawl-cap.test", 120_000)
	if got := hostAdaptiveIntervalMs("crawl-cap.test"); got != 30_000 {
		t.Errorf("crawl-delay 采纳应钳上界 30s，got %d", got)
	}
	// 429/Retry-After 已在更高退避位时不覆盖（外部指令取大者）
	ra := int64(20_000)
	noteAdaptiveRateLimited("crawl-mix.test", &ra)
	noteCrawlDelayFloor("crawl-mix.test", 5000)
	if got := hostAdaptiveIntervalMs("crawl-mix.test"); got != 20_000 {
		t.Errorf("更高 Retry-After 退避位不应被 crawl-delay 覆盖，got %d", got)
	}
}

// robots 解析 → 采纳的端到端口径锁定（Crawl-delay 秒 → 毫秒 → 下限）
func TestParseRobotsCrawlDelayAdoption(t *testing.T) {
	groups := parseRobots("User-agent: *\nCrawl-delay: 5\nDisallow: /admin\n")
	g := pickGroup(groups, []string{"novel-admin-scraper", "*"})
	if g == nil || g.crawlDelayMs == nil || *g.crawlDelayMs != 5000 {
		t.Fatalf("robots Crawl-delay 解析失败：%+v", g)
	}
	host := "robots-crawl.test"
	noteCrawlDelayFloor(host, int64(*g.crawlDelayMs))
	if got := hostAdaptiveIntervalMs(host); got != 5000 {
		t.Errorf("robots Crawl-delay=5s 应采纳为 5000ms 间隔下限，got %d", got)
	}
}
