/**
 * audit51a_test.go —— Task 51-a 第 13 轮收敛深审增强锁定：
 *
 *   - E10（反反爬·头族指纹一致性）：Safari 系画像（safari-desktop/iphone-safari）不再携带
 *     Sec-Fetch-*（dest/mode/site/user）与 Upgrade-Insecure-Requests。威胁模型：真实
 *     Safari/WebKit 从未实现 Fetch Metadata 请求头、同样不发 UIR——旧画像的
 *     sec-fetch-site:none「无来路导航」是 Chrome 语义，「Safari UA + Chrome 导航头族」对
 *     按 UA 分族比对的 WAF 是跨家族矛盾自曝（与 44-a FIX-1「Firefox JA3 配 Chrome 客户端
 *     提示」同族、与 E8 头族版同向）。修复=整族移除；E6/E7「只改写已存在键、绝不注入」
 *     语义与 E8 压缩协商声明（accept-encoding 保留）经本文件三用例锁定。
 */
package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// ---- E10：Safari 画像头族与真实 WebKit 对齐 ----

// 发送 Fetch Metadata 的引擎画像族（Chrome/Edge/Android/Firefox）与
// 不发送的画像族（Safari 系 E10 + spider 系既有语义）的正反两面锁定。
func TestProfileSecFetchFamilyRealBrowserAlignment(t *testing.T) {
	withFetchMetadata := []headerProfile{chromeDesktopProfile, firefoxDesktopProfile, edgeDesktopProfile, androidChromeProfile}
	for _, p := range withFetchMetadata {
		h := p.headers("http://a.com/c/1.html", p.withReferer, "")
		if h["sec-fetch-dest"] != "document" || h["sec-fetch-mode"] != "navigate" {
			t.Errorf("画像 %s 应携带导航形态 sec-fetch-dest/mode, got %q/%q", p.id, h["sec-fetch-dest"], h["sec-fetch-mode"])
		}
		if h["sec-fetch-site"] == "" {
			t.Errorf("画像 %s 应携带 sec-fetch-site（首跳陈述不可缺失）, got 无键", p.id)
		}
		if h["sec-fetch-user"] != "?1" {
			t.Errorf("画像 %s 首跳用户激活导航应携带 sec-fetch-user: ?1, got %q", p.id, h["sec-fetch-user"])
		}
		if h["upgrade-insecure-requests"] != "1" {
			t.Errorf("画像 %s 应携带 upgrade-insecure-requests: 1（真实 Chrome/Firefox 导航行为）, got %q", p.id, h["upgrade-insecure-requests"])
		}
	}
	withoutFetchMetadata := []headerProfile{safariDesktopProfile, iphoneSafariProfile, googlebotProfile, baiduspiderProfile}
	for _, p := range withoutFetchMetadata {
		h := p.headers("http://a.com/c/1.html", p.withReferer, "")
		for _, k := range []string{"sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "sec-fetch-user"} {
			if v, ok := h[k]; ok {
				t.Errorf("画像 %s 不应携带 %s（真实 WebKit/爬虫不发；E10 后回退即跨家族矛盾自曝）, got %q", p.id, k, v)
			}
		}
	}
	// Safari 系专属面：同样不发送 UIR 与客户端提示；E8 压缩协商声明不受 E10 影响
	for _, p := range []headerProfile{safariDesktopProfile, iphoneSafariProfile} {
		h := p.headers("http://a.com/c/1.html", false, "")
		if v, ok := h["upgrade-insecure-requests"]; ok {
			t.Errorf("Safari 画像 %s 不应携带 upgrade-insecure-requests（WebKit 不支持 UIR）, got %q", p.id, v)
		}
		if v, ok := h["sec-ch-ua"]; ok {
			t.Errorf("Safari 画像 %s 不应携带 sec-ch-ua（Safari 无客户端提示）, got %q", p.id, v)
		}
		if h["accept-encoding"] != "gzip, deflate" {
			t.Errorf("E10 不得影响 E8 的压缩协商声明（画像 %s）, got %q", p.id, h["accept-encoding"])
		}
		if !strings.Contains(h["user-agent"], "Safari/") {
			t.Errorf("Safari 画像 UA 不应被 E10 触碰, got %q", h["user-agent"])
		}
	}
}

// 车道 wire 端到端：Safari 画像经真实 fetch 守卫车道上线后，请求头族零 Sec-Fetch-*（E10）；
// Chrome 对照组同拓扑照常携带（防「顺手删错族」回归）。
func TestFetchLaneSafariWireNoSecFetchHeaders(t *testing.T) {
	savedPrivate := allowPrivate
	allowPrivate = true
	defer func() { allowPrivate = savedPrivate }()

	var mu sync.Mutex
	safariWire := map[string]bool{}
	chromeWire := map[string]bool{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		// 按路径分组（Chrome UA 恒以 Safari/537.36 结尾，不能按 UA 子串分族）
		wire := safariWire
		if strings.HasSuffix(r.URL.Path, "/2.html") {
			wire = chromeWire
		}
		for _, k := range []string{"Sec-Fetch-Dest", "Sec-Fetch-Mode", "Sec-Fetch-Site", "Sec-Fetch-User", "Upgrade-Insecure-Requests"} {
			if r.Header.Get(k) != "" {
				wire[k] = true
			}
		}
		_, _ = w.Write([]byte("<html><body>wire-e2e</body></html>"))
	}))
	defer srv.Close()

	safariHeaders := safariDesktopProfile.headers(srv.URL+"/c/1.html", false, "")
	if res := fetchWithRedirectGuard(srv.URL+"/c/1.html", safariHeaders, 8_000, &[]string{}, "", true, nil); !res.ok {
		t.Fatalf("safari 画像请求应成功, got note=%q warning=%q", res.note, res.warning)
	}
	if len(safariWire) != 0 {
		t.Fatalf("Safari 画像上线的请求不得携带 Sec-Fetch-*/UIR（E10）, got %v", safariWire)
	}
	chromeHeaders := chromeDesktopProfile.headers(srv.URL+"/c/2.html", true, "")
	if res := fetchWithRedirectGuard(srv.URL+"/c/2.html", chromeHeaders, 8_000, &[]string{}, "", true, nil); !res.ok {
		t.Fatalf("chrome 对照请求应成功, got note=%q warning=%q", res.note, res.warning)
	}
	for _, k := range []string{"Sec-Fetch-Dest", "Sec-Fetch-Mode", "Sec-Fetch-Site", "Sec-Fetch-User", "Upgrade-Insecure-Requests"} {
		if !chromeWire[k] {
			t.Fatalf("chrome 对照组应携带 %s（E10 不得波及发送 Fetch Metadata 的画像族）", k)
		}
	}
}

// E10×E6/E7 交互锁定：Safari 画像（无 Sec-Fetch 键）经跳间头族精化必须零注入——
// 旧画像即使被回滚，此处也会因「注入缺失键」而非 nil 失败。
func TestRefineHopHeadersNoInjectionForSafari(t *testing.T) {
	hdrs := safariDesktopProfile.headers("http://a.com/c/1.html", false, "")
	before := len(hdrs)
	refineHopHeaders(hdrs, "http://a.com/s", "http://other.example/f") // 跨站跳
	if len(hdrs) != before {
		t.Fatalf("safari 画像跳间头集不得被 E6 精化注入新键, before=%d after=%d (%v)", before, len(hdrs), hdrs)
	}
	for _, k := range []string{"sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "sec-fetch-user"} {
		if _, ok := hdrs[k]; ok {
			t.Fatalf("E6 精化不得向 safari 画像注入 %s（E10：整族零 Sec-Fetch）", k)
		}
	}
	// 对照组：chrome 画像同拓扑跨站跳的 E6 site 改写与 E9 user 删除照常生效
	ch := chromeDesktopProfile.headers("http://a.com/c/1.html", true, "")
	refineHopHeaders(ch, "http://a.com/s", "http://other.example/f")
	if ch["sec-fetch-site"] != "cross-site" {
		t.Fatalf("chrome 对照组 E6 跨站跳应改写 sec-fetch-site=cross-site, got %q", ch["sec-fetch-site"])
	}
	if _, ok := ch["sec-fetch-user"]; ok {
		t.Fatalf("chrome 对照组 E9 应在跳间删除 sec-fetch-user")
	}
	// iPhone Safari 变体同口径（fetch-mobile 车道第二梯）
	ip := iphoneSafariProfile.headers("http://a.com/c/1.html", false, "")
	beforeIP := len(ip)
	refineHopHeaders(ip, "http://a.com/s", "http://other.example/f")
	if len(ip) != beforeIP {
		t.Fatalf("iphone-safari 画像跳间头集不得被注入新键, before=%d after=%d", beforeIP, len(ip))
	}
	if _, ok := ip["sec-fetch-site"]; ok {
		t.Fatalf("iphone-safari 画像不得携带/被注入 sec-fetch-site")
	}
}
