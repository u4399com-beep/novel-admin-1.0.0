/**
 * audit39_test.go —— Task 39-a 未扫文件深审修复回归锁定（风格对齐 audit38_test.go）：
 * ①F1 cachedPublicIP 尾点归一：URL 带尾点域名（http://example.com./）时 --resolve 钉死不再 miss
 * ②F2 Set-Cookie Max-Age/Expires 优先级（RFC 6265 §5.3）：有效 Max-Age 存在时过期 Expires 不再
 *    误删 WAF 通关 cookie（双向属性顺序覆盖）+ jar 端到端
 * ③F3 newServer 超时参数：ReadHeaderTimeout/IdleTimeout 在位（空闲 keep-alive 连接回收）
 * ④E1 指纹保鲜：chromeMajor ∈ 133-140 且 UA/Sec-CH-UA/Edg 同源派生一致；Firefox 142/Safari 18.5
 * ⑤E2 got 系随机头池：Chrome/Edge/Firefox 三画像均可达，accept-language 恒在白名单内
 * 运行：cd mini-services/scraper-go && go test -race ./... -count=1
 */
package main

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

// TestCachedPublicIPTrailingDot F1: assertHostPublic 以剥尾点后的主机名为 key 落 DNS 缓存
// （Task 34 P3-6 口径），cachedPublicIP 必须同口径查询——否则 curlResolvePin 对
// 「http://example.com./」类尾点变体返回空，curl 系策略的 DNS rebinding 钉死静默失效。
func TestCachedPublicIPTrailingDot(t *testing.T) {
	const host = "pin39.example.com"
	const pinIP = "93.184.216.34"
	dnsCacheMu.Lock()
	dnsCache[host] = dnsEntry{at: time.Now(), publicIP: pinIP}
	dnsCacheMu.Unlock()
	defer func() {
		dnsCacheMu.Lock()
		delete(dnsCache, host)
		dnsCacheMu.Unlock()
	}()

	cases := []struct {
		name     string
		hostname string
		want     string
	}{
		{"裸主机名命中", host, pinIP},
		{"单尾点命中（修复点）", host + ".", pinIP},
		{"双尾点命中（Task 34 P3-6 同款循环）", host + "..", pinIP},
		{"大写变体命中", "PIN39.Example.COM.", pinIP},
		{"未知主机 miss", "other39.example.com", ""},
		{"仅点号归一为空串", ".", ""},
	}
	for _, c := range cases {
		if got := cachedPublicIP(c.hostname); got != c.want {
			t.Fatalf("%s: cachedPublicIP(%q) = %q, want %q", c.name, c.hostname, got, c.want)
		}
	}
	// 端到端：curlResolvePin 对尾点域名应产出 host:port:ip 钉死参数
	u, err := urlParse("http://" + host + ".:8080/x")
	if err != nil {
		t.Fatalf("urlParse 失败: %v", err)
	}
	pin := curlResolvePin(u)
	if pin != host+":8080:"+pinIP {
		t.Fatalf("curlResolvePin 尾点域名钉死失效: got %q, want %q", pin, host+":8080:"+pinIP)
	}
}

// TestParseSetCookieLineMaxAgeExpiresPrecedence F2: RFC 6265 §5.3 —— 有效 Max-Age 存在时
// Expires（含过期删除语义）完全被忽略；两种属性顺序均不得破坏 Max-Age TTL。
func TestParseSetCookieLineMaxAgeExpiresPrecedence(t *testing.T) {
	now := int64(1_700_000_000_000)
	past := "Sun, 01 Jan 2023 00:00:00 GMT" // 恒早于 now 的过期日期
	future := "Tue, 01 Jan 2030 00:00:00 GMT"

	cases := []struct {
		name       string
		line       string
		wantRemove bool
		wantExpiry int64 // 0 = 不断言具体值
	}{
		{"过期 Expires 后置不覆盖有效 Max-Age", "a=1; Max-Age=3600; Expires=" + past, false, now + 3_600_000},
		{"过期 Expires 前置不被 Max-Age 覆删（修复点）", "a=1; Expires=" + past + "; Max-Age=3600", false, now + 3_600_000},
		{"未来 Expires 后置不延长 Max-Age TTL", "a=1; Max-Age=3600; Expires=" + future, false, now + 3_600_000},
		{"未来 Expires 前置被 Max-Age 覆盖", "a=1; Expires=" + future + "; Max-Age=3600", false, now + 3_600_000},
		{"Max-Age=0 删除不受未来 Expires 干扰", "a=1; Expires=" + future + "; Max-Age=0", true, 0},
		{"无效 Max-Age 时过期 Expires 照旧删除", "a=1; Max-Age=inf; Expires=" + past, true, 0},
		{"仅过期 Expires 照旧删除（既有语义）", "a=1; Expires=" + past, true, 0},
		{"仅有效 Max-Age 照旧（既有语义）", "a=1; Max-Age=3600", false, now + 3_600_000},
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
			t.Fatalf("%s: 不应删除（WAF 通关 cookie 被误删=反复过挑战根因），got %+v", c.name, p)
		}
		if c.wantExpiry != 0 && p.expiresAt != c.wantExpiry {
			t.Fatalf("%s: expiresAt = %d, want %d", c.name, p.expiresAt, c.wantExpiry)
		}
	}
}

// TestCookieJarMaxAgeSurvivesExpiredExpires F2 端到端：recordSetCookieLines 入库 →
// cookieHeaderFor 可回放（过期 Expires 不再在 jar 层吞掉长效 Max-Age 通关 cookie）。
func TestCookieJarMaxAgeSurvivesExpiredExpires(t *testing.T) {
	host := "jar39.example.com"
	defer func() {
		jar.mu.Lock()
		delete(jar.hosts, host)
		jar.mu.Unlock()
	}()
	stored := recordSetCookieLines(host, []string{"__jsl_clearance=pass; Expires=Sun, 01 Jan 2023 00:00:00 GMT; Max-Age=7200; Path=/"}, true)
	if stored != 1 {
		t.Fatalf("Max-Age 与过期 Expires 并存的 cookie 应入库，stored = %d", stored)
	}
	if hdr := cookieHeaderFor(host, false); !strings.Contains(hdr, "__jsl_clearance=pass") {
		t.Fatalf("WAF 通关 cookie 被过期 Expires 误删（回放头 = %q）", hdr)
	}
}

// TestNewServerTimeouts F3: 引擎 HTTP Server 超时参数在位——IdleTimeout 补齐后
// backend-go 重启遗留的空闲 keep-alive 连接 120s 内回收；WriteTimeout 维持不设
// （策略链 55s 预算 + 主站 60s 消费超时兑底，服务端再设会切断长抓取）。
func TestNewServerTimeouts(t *testing.T) {
	s := newServer("127.0.0.1:0", http.NewServeMux())
	if s.ReadHeaderTimeout != 10*time.Second {
		t.Fatalf("ReadHeaderTimeout = %v, want 10s", s.ReadHeaderTimeout)
	}
	if s.IdleTimeout != 120*time.Second {
		t.Fatalf("IdleTimeout = %v, want 120s（空闲连接回收缺失=长跑 FD 泄漏面）", s.IdleTimeout)
	}
	if s.WriteTimeout != 0 {
		t.Fatalf("WriteTimeout = %v, want 0（不设：防切断 55s 长抓取）", s.WriteTimeout)
	}
}

// TestProfilesFingerprintFreshness E1: UA 指纹保鲜——chromeMajor 落在近期活跃带内且
// UA/Sec-CH-UA/Edge 同源派生一致（版本错位是可检测的指纹矛盾）；Firefox/Safari 恒 ≥ 保鲜下限。
func TestProfilesFingerprintFreshness(t *testing.T) {
	if chromeMajor < 147 || chromeMajor > 154 {
		t.Fatalf("chromeMajor = %d, want [147,154]（候选集过期=UA 白名单外被拒概率上升）", chromeMajor)
	}
	if !strings.Contains(chromeUA, "Chrome/"+itoa(chromeMajor)+".0.0.0") {
		t.Fatalf("chromeUA 与 chromeMajor 派生不一致: %q", chromeUA)
	}
	if strings.Count(chromeSecCHUA, itoa(chromeMajor)) != 2 {
		t.Fatalf("chromeSecCHUA 与 chromeMajor 派生不一致: %q", chromeSecCHUA)
	}
	if !strings.Contains(edgeUA, "Edg/"+itoa(chromeMajor)+".0.0.0") {
		t.Fatalf("edgeUA Edg 版本与 chromeMajor 派生不一致: %q", edgeUA)
	}
	// 保鲜下限：Firefox=154、Safari=27.x、iOS=27.x（2026-09 现势 stable；未来刷新常量时同步上调）
	if !strings.Contains(firefoxDesktopProfile.headers("https://x.test/", false, "")["user-agent"], "Firefox/154.0") {
		t.Fatalf("Firefox UA 未刷新到保鲜带: %q", firefoxDesktopProfile.headers("https://x.test/", false, "")["user-agent"])
	}
	safariUA := safariDesktopProfile.headers("https://x.test/", false, "")["user-agent"]
	if !strings.Contains(safariUA, "Version/27.") {
		t.Fatalf("桌面 Safari UA 未刷新到 27.x: %q", safariUA)
	}
	iphoneUA := iphoneSafariProfile.headers("https://x.test/", false, "")["user-agent"]
	if !strings.Contains(iphoneUA, "iPhone OS 27_") || !strings.Contains(iphoneUA, "Version/27.") {
		t.Fatalf("iPhone Safari UA 未刷新到 iOS 27.x: %q", iphoneUA)
	}
}

// TestHeaderGeneratorHeadersDesktopPool E2: got 系随机头池三画像（Chrome/Edge/Firefox）
// 均可达（熵距拉开），且每个画像的 accept-language 恒在白名单内、UA 恒非空。
func TestHeaderGeneratorHeadersDesktopPool(t *testing.T) {
	langs := map[string]bool{
		"zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7": true,
		"zh-CN,zh;q=0.9":                      true,
		"zh-CN,zh;q=0.9,en;q=0.8":             true,
	}
	saw := map[string]bool{}
	for i := 0; i < 240; i++ {
		h := headerGeneratorHeaders("https://pool39.example.com/book/1")
		ua := h["user-agent"]
		if ua == "" {
			t.Fatalf("第 %d 轮: user-agent 缺失", i)
		}
		if !langs[h["accept-language"]] {
			t.Fatalf("第 %d 轮: accept-language 越白名单: %q", i, h["accept-language"])
		}
		switch {
		case strings.Contains(ua, "Firefox/"):
			saw["firefox"] = true
			if _, has := h["sec-ch-ua"]; has {
				t.Fatalf("Firefox 画像不应携带客户端提示: %q", h["sec-ch-ua"])
			}
		case strings.Contains(ua, "Edg/"):
			saw["edge"] = true
			if _, has := h["sec-ch-ua"]; !has {
				t.Fatalf("Edge 画像应携带客户端提示")
			}
		case strings.Contains(ua, "Chrome/"):
			saw["chrome"] = true
			if _, has := h["sec-ch-ua"]; !has {
				t.Fatalf("Chrome 画像应携带客户端提示")
			}
		default:
			t.Fatalf("未知画像 UA: %q", ua)
		}
	}
	for _, family := range []string{"chrome", "edge", "firefox"} {
		if !saw[family] {
			t.Fatalf("240 轮内未抽到 %s 画像（池覆盖缺失）: %v", family, saw)
		}
	}
}
