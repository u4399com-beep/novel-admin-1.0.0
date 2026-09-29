/**
 * audit52a_test.go —— Task 52-a 第 14 轮收敛深审修复与增强锁定：
 *
 *   - E11（反反爬·头族指纹一致性）：Chrome 系画像移除 cache-control: no-cache + pragma:
 *     no-cache。依据（沙箱内实测 Chromium 143 / Playwright chromium-1200 抓包）：真实浏览器
 *     「全新导航」（引擎形态：无缓存基线首次 GET）不发送任何请求侧 cache-control/pragma；
 *     显式 reload（F5）发 cache-control: max-age=0；no-cache+pragma 是硬刷新/DevTools
 *     Disable-cache 专属形态——旧画像对每个 URL 首次请求都声称硬刷新，属可稳定识别的脚本
 *     客户端自曝指纹（与 E8/E9/E10 头族同向）。移除零误杀：建议性缓存元数据头不改变站点
 *     响应决策，副作用仅为响应可经 CDN 缓存正常命中（真实首访浏览器同样如此）。
 *   - jsontoc 空压缩体分类对齐（P3）：声明压缩但 0 字节体按空体处理（与 readBodyCapped
 *     E8 语义同口径），不再虚报「解包失败 EOF」。
 *   - 留档复核落档（零代码变更，测试锁定面）：sec-fetch-storage-access 经 MDN BCD + Storage
 *     Access Headers 规范 + Chromium 143 实测三方证据确认「不该加」——该头仅随「跨站 +
 *     credentials mode=include」请求发送（同站请求省略、credentials omit 省略），Chrome 133+/
 *     Firefox 147+ 才实现、Safari 全系不实现；引擎全部请求为同站导航（same-site → 真实浏览器
 *     省略），注入反而构成伪造头自曝。
 */
package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/PuerkitoBio/goquery"
)

// ---- E11：全新导航对齐——全画像零 cache-control/pragma ----

// 全部 8 个画像的请求头均不得携带 cache-control/pragma：真实浏览器全新导航不发这两个键
// （no-cache+pragma 是硬刷新专属形态；reload 发 max-age=0 而非 no-cache）。
func TestProfileNoCacheControlFreshNavigationAlignment(t *testing.T) {
	profiles := []headerProfile{
		chromeDesktopProfile, firefoxDesktopProfile, safariDesktopProfile, edgeDesktopProfile,
		androidChromeProfile, iphoneSafariProfile, googlebotProfile, baiduspiderProfile,
	}
	for _, p := range profiles {
		h := p.headers("http://a.com/c/1.html", p.withReferer, "")
		if v, ok := h["cache-control"]; ok {
			t.Errorf("画像 %s 不应携带 cache-control（全新导航真实浏览器不发送，硬刷新形态自曝）, got %q", p.id, v)
		}
		if v, ok := h["pragma"]; ok {
			t.Errorf("画像 %s 不应携带 pragma（HTTP/1.0 硬刷新遗留形态）, got %q", p.id, v)
		}
	}
	// E11 不得误伤既有头族：chrome 桌面画像的 UA/Accept/Accept-Encoding(E8)/Sec-Fetch 族/UIR/客户端提示全部在位
	ch := chromeDesktopProfile.headers("http://a.com/c/1.html", true, "")
	for k, want := range map[string]string{
		"accept-language":           acceptLangZH,
		"accept-encoding":           "gzip, deflate",
		"upgrade-insecure-requests": "1",
		"sec-fetch-dest":            "document",
		"sec-fetch-mode":            "navigate",
		"sec-fetch-site":            "same-origin",
		"sec-fetch-user":            "?1",
		"sec-ch-ua-mobile":          "?0",
	} {
		if got := ch[k]; got != want {
			t.Errorf("E11 后 chrome 画像 %s = %q, want %q", k, got, want)
		}
	}
	if !strings.Contains(ch["user-agent"], "Chrome/") || !strings.Contains(ch["sec-ch-ua"], "Google Chrome") {
		t.Errorf("E11 后 chrome 画像 UA/sec-ch-ua 异常: %q / %q", ch["user-agent"], ch["sec-ch-ua"])
	}
}

// 端到端（fetch 车道 wire 侧）：chrome 画像上线请求零 cache-control/pragma——
// 防止未来在 baseHeaders 或车道层重新引入该键（单元层断言被绕过的形态）。
func TestFetchLaneWireNoCacheControl(t *testing.T) {
	savedPrivate := allowPrivate
	allowPrivate = true
	defer func() { allowPrivate = savedPrivate }()

	var mu sync.Mutex
	gotCC, gotPragma, gotAE := "", "", ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		gotCC = r.Header.Get("Cache-Control")
		gotPragma = r.Header.Get("Pragma")
		gotAE = r.Header.Get("Accept-Encoding")
		mu.Unlock()
		_, _ = w.Write([]byte("<html><body>fresh-nav-final</body></html>"))
	}))
	defer srv.Close()

	headers := chromeDesktopProfile.headers(srv.URL+"/c/1.html", true, "")
	res := fetchWithRedirectGuard(srv.URL+"/c/1.html", headers, 8_000, &[]string{}, "", true, nil)
	if !res.ok {
		t.Fatalf("全新导航形态请求应成功, got note=%q warning=%q", res.note, res.warning)
	}
	mu.Lock()
	defer mu.Unlock()
	if gotCC != "" {
		t.Fatalf("wire 请求不应携带 Cache-Control（E11: 全新导航真实浏览器不发送）, got %q", gotCC)
	}
	if gotPragma != "" {
		t.Fatalf("wire 请求不应携带 Pragma, got %q", gotPragma)
	}
	if gotAE != "gzip, deflate" {
		t.Fatalf("E8 accept-encoding 声明不得受 E11 影响, got %q", gotAE)
	}
}

// 端到端（got 车道）：got 系 chrome 随机画像经 headerGeneratorHeaders 消费 chromeDesktopProfile，
// E11 移除后 wire 请求同样零 cache-control（「随机头池 Chrome 变体声称硬刷新」同源自曝面收口）。
func TestGotLaneWireNoCacheControl(t *testing.T) {
	savedPrivate := allowPrivate
	allowPrivate = true
	defer func() { allowPrivate = savedPrivate }()

	// rand.Intn 选中的画像可能是 chrome/edge/firefox——三者本就不发 cache-control，
	// 断言「零 cache-control」对全部三支随机分支恒真
	var mu sync.Mutex
	gotCC := ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		gotCC = r.Header.Get("Cache-Control")
		mu.Unlock()
		_, _ = w.Write([]byte("<html><body>got-final</body></html>"))
	}))
	defer srv.Close()

	res := gotStrategyRun(srv.URL+"/b/1.html", 8_000, &strategyRunCtx{insecureTLS: true})
	if !res.ok {
		t.Fatalf("got 车道应成功, got note=%q warnings=%v", res.note, res.warnings)
	}
	mu.Lock()
	defer mu.Unlock()
	if gotCC != "" {
		t.Fatalf("got 车道 wire 请求不应携带 Cache-Control, got %q", gotCC)
	}
}

// ---- jsontoc：空压缩体分类对齐（P3） ----

// 声明 gzip 但 0 字节体：按空体处理（与 readBodyCapped 的 E8 empty-body 语义同口径），
// 警告为「响应体为空或超限」而非虚报「解包失败 EOF」（旧实现把空响应误读为解包器故障）。
func TestExtractJsonTocGzipEmptyBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Set("Content-Type", "application/json")
		// 0 字节 gzip 体（服务器/代理截断形态）
		_, _ = w.Write([]byte{})
	}))
	defer srv.Close()
	// 与 audit46/50 同模式：临时放行私有地址并替换包级 tocHTTPClient（零外网依赖）
	savedPrivate, savedClient := allowPrivate, tocHTTPClient
	allowPrivate = true
	tocHTTPClient = &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{}}
	defer func() { allowPrivate, tocHTTPClient = savedPrivate, savedClient }()

	doc, _ := goquery.NewDocumentFromReader(strings.NewReader(`<html><input id="bid" value="42"></html>`))
	cfg, cfgErr := parseChapterListApi(`{"url":"/list","method":"GET","bookIdSelector":"#bid@value","titleField":"title","listPath":"data","urlTemplate":"/read/{bookId}/1.html"}`)
	if cfgErr != "" {
		t.Fatalf("配置解析失败: %s", cfgErr)
	}
	warnings := []string{}
	refs := extractJsonToc(doc.Selection, cfg, srv.URL+"/book/1.html", &warnings)
	if len(refs) != 0 {
		t.Fatalf("空体响应应返回空目录, got %d 条", len(refs))
	}
	joined := strings.Join(warnings, "; ")
	if strings.Contains(joined, "解包失败") {
		t.Fatalf("0 字节 gzip 体不得虚报解包失败（E8 空体语义对齐）, warnings=%v", warnings)
	}
	if !strings.Contains(joined, "响应体为空或超限") {
		t.Fatalf("0 字节 gzip 体应按空体处理（响应体为空或超限）, warnings=%v", warnings)
	}
}

// 对照：损坏 gzip 流仍走「解包失败」分支（分类收窄不吞真实故障证据）
func TestExtractJsonTocGzipCorruptStillReported(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Encoding", "gzip")
		_, _ = w.Write([]byte("not-a-gzip-stream-at-all"))
	}))
	defer srv.Close()
	savedPrivate, savedClient := allowPrivate, tocHTTPClient
	allowPrivate = true
	tocHTTPClient = &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{}}
	defer func() { allowPrivate, tocHTTPClient = savedPrivate, savedClient }()

	doc, _ := goquery.NewDocumentFromReader(strings.NewReader(`<html><input id="bid" value="42"></html>`))
	cfg, _ := parseChapterListApi(`{"url":"/list","method":"GET","bookIdSelector":"#bid@value","titleField":"title","listPath":"data","urlTemplate":"/read/{bookId}/1.html"}`)
	warnings := []string{}
	refs := extractJsonToc(doc.Selection, cfg, srv.URL+"/book/1.html", &warnings)
	if len(refs) != 0 {
		t.Fatalf("损坏流应返回空目录, got %d 条", len(refs))
	}
	if !strings.Contains(strings.Join(warnings, "; "), "解包失败") {
		t.Fatalf("损坏 gzip 流必须保留解包失败证据, warnings=%v", warnings)
	}
}
