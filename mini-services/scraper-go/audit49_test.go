/**
 * audit49_test.go —— Task 49-a 逐行深审修复与增强锁定（两轮：上轮超时未返回报告，产物在盘
 * 复核后由重试轮接续；F1/F2/E6 为上轮产物，F3/F4/E7/精简为重试轮新增）：
 *
 *   - F1（P3·错误吞没）：gotStrategyRun 响应体中途断流不再被吞成 "empty-body"——
 *     body.note（network-error）优先于 assess 派生 note，body.warning（底层错误）透传，
 *     与 fetch 系 fetchWithRedirectGuard 的 r.note/r.warning 口径对齐。
 *   - F2（P3·缓存分裂）：checkRobots 的 origin 缓存 key 大小写归一（robotsOriginKey），
 *     大写域名变体不再分裂出第二个 robots 缓存桶（重复抓取、记忆互不可见）。
 *   - F3（P3·移植契约）：runeLen 对齐 JS String.length（UTF-16 code unit）语义——星面
 *     字符（emoji/古汉字 U+10000+）按代理对计 2，近空判定/行长闸/标题闸与 TS 口径一致。
 *   - F4（P3·跨平台截断）：jsonStr 大整数改 strconv.FormatInt(int64(t))——32 位平台
 *     itoa(int(t)) 对 2^53 内雪花 ID 量级值静默回绕，{order} 占位符拼出错误章节 URL。
 *   - E6（反反爬·重定向跳头族保真）：hop>0 按「上一跳→本跳」拓扑改写 sec-fetch-site
 *     （same-origin/same-site/cross-site）与 Referer（同源完整 URL/跨源仅 origin，对齐
 *     Chromium 默认 strict-origin-when-cross-origin）；只改写已存在键，绝不注入缺失键。
 *   - E7（反反爬·首跳 site 陈述与显式 Referer 一致性）：显式 Referer 与目标非同源时
 *     （子域/镜像域变体），首跳 sec-fetch-site 按拓扑派生（deriveSecFetchSite），修复
 *     「site 恒 same-origin vs Referer 他源」的稳定矛盾自曝；只改写已存在且非 none 的键
 *     （spider 无键、safari 系 none 不受影响），Referer 值本身不动（避免破坏需精确来路
 *     的站点）；缺省 Referer（=目标站 origin）派生恒 same-origin，行为不变。
 *   - 精简：rawResponse.finalURL 死字段删除（全仓零读取点）+ helpers.syncMutex 死包装
 *     删除（上轮产物，dnsCacheMu 收敛 sync.Mutex）。
 */
package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
)

// ---- F1：got 车道响应体读取中断证据透出 ----

// hijackServer 启动一个声明 Content-Length=1000 但只写 5 字节就断连的 200 响应站
func hijackServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hj, ok := w.(http.Hijacker)
		if !ok {
			http.Error(w, "no hijack", 500)
			return
		}
		conn, buf, err := hj.Hijack()
		if err != nil {
			return
		}
		defer func() { _ = conn.Close() }()
		_, _ = buf.WriteString("HTTP/1.1 200 OK\r\nContent-Length: 1000\r\nContent-Type: text/html\r\n\r\nshort")
		_ = buf.Flush()
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestGotRunMidBodyDisconnectEvidence(t *testing.T) {
	savedPrivate := allowPrivate
	allowPrivate = true
	defer func() { allowPrivate = savedPrivate }()

	srv := hijackServer(t)
	res := gotStrategyRun(srv.URL+"/x", 8_000, &strategyRunCtx{})
	if res.ok {
		t.Fatalf("中途断流的 200 响应不应判成功")
	}
	if len(res.subAttempts) == 0 {
		t.Fatalf("应至少有一条子尝试记录，got 0")
	}
	last := res.subAttempts[len(res.subAttempts)-1]
	if last.Note != "network-error" {
		t.Fatalf("断流子尝试应记录 network-error（旧实现吞成 empty-body），got %q", last.Note)
	}
	found := false
	for _, w := range res.warnings {
		if strings.Contains(w, "响应体读取中断") {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("warnings 应携带「响应体读取中断」底层错误证据，got %v", res.warnings)
	}
}

// ---- F2：robots origin 缓存 key 归一 ----

func TestRobotsOriginKeyCanonical(t *testing.T) {
	cases := []struct {
		raw  string
		want string
	}{
		{"http://example.com/a", "http://example.com"},
		{"http://EXAMPLE.COM/a", "http://example.com"},
		{"HTTP://EXAMPLE.COM:8080/x", "http://example.com:8080"},
		{"https://Example.COM./x", "https://example.com."},
	}
	for _, c := range cases {
		u, err := url.Parse(c.raw)
		if err != nil {
			t.Fatalf("url.Parse(%q) 失败: %v", c.raw, err)
		}
		if got := robotsOriginKey(u); got != c.want {
			t.Errorf("robotsOriginKey(%q) = %q, want %q（大小写变体不得分裂缓存桶）", c.raw, got, c.want)
		}
	}
}

// ---- E6：重定向跳头族保真 ----

func TestHopSameSiteHosts(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"a.com", "a.com", true},
		{"a.com:80", "a.com:8080", true},   // 端口不参与 same-site
		{"www.a.com", "a.com", true},       // 子域后缀
		{"a.com", "www.a.com", true},       // 反向子域
		{"[::1]:8080", "[::1]:9090", true}, // IPv6 拆端口后相等
	}
	for _, c := range cases {
		if got := hopSameSiteHosts(c.a, c.b); got != c.want {
			t.Errorf("hopSameSiteHosts(%q,%q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
	if hopSameSiteHosts("a.com", "b.com") {
		t.Errorf("无后缀关系的 host 不应判同站")
	}
	if hopSameSiteHosts("", "a.com") {
		t.Errorf("空 host 应判非同站")
	}
}

func TestRefineHopHeadersTopology(t *testing.T) {
	cases := []struct {
		name     string
		prev     string
		hop      string
		wantSite string
		wantRef  string // 期望 referer；空串 = 断言为 prev origin（跨源形态）
	}{
		{"同源跳", "http://a.com/s", "http://a.com/f", "same-origin", "http://a.com/s"},
		{"跨 scheme 同站", "http://a.com/s", "https://a.com/f", "same-site", "http://a.com"},
		{"跨端口同站", "http://a.com:80/s", "http://a.com:8080/f", "same-site", "http://a.com:80"},
		{"子域同站", "http://a.com/s", "http://www.a.com/f", "same-site", "http://a.com"},
		{"跨站", "http://a.com/s", "http://b.com/f", "cross-site", "http://a.com"},
	}
	for _, c := range cases {
		hdrs := map[string]string{"sec-fetch-site": "same-origin", "referer": "http://initial.example/"}
		refineHopHeaders(hdrs, c.prev, c.hop)
		if hdrs["sec-fetch-site"] != c.wantSite {
			t.Errorf("%s: sec-fetch-site = %q, want %q", c.name, hdrs["sec-fetch-site"], c.wantSite)
		}
		wantRef := c.wantRef
		if wantRef == "" {
			u, _ := url.Parse(c.prev)
			wantRef = u.Scheme + "://" + u.Host
		}
		if hdrs["referer"] != wantRef {
			t.Errorf("%s: referer = %q, want %q（默认 strict-origin-when-cross-origin 语义）", c.name, hdrs["referer"], wantRef)
		}
	}
}

// 误杀面：refine 只改写已存在键，绝不注入缺失键（spider 画像无 Sec-Fetch、safari 无 Referer 必须保持原样）
func TestRefineHopHeadersOnlyOverridesExisting(t *testing.T) {
	hdrs := map[string]string{"user-agent": "ua"}
	refineHopHeaders(hdrs, "http://a.com/s", "http://b.com/f")
	if len(hdrs) != 1 || hdrs["user-agent"] != "ua" {
		t.Fatalf("缺失键不得被注入，got %v", hdrs)
	}
	hdrs2 := map[string]string{"referer": "http://initial.example/"}
	refineHopHeaders(hdrs2, "http://a.com/s", "http://a.com/f")
	if hdrs2["referer"] != "http://a.com/s" {
		t.Fatalf("同源跳 referer 应精化为上一跳完整 URL，got %q", hdrs2["referer"])
	}
	// 非法 URL 防御：不改写
	hdrs3 := map[string]string{"sec-fetch-site": "same-origin"}
	refineHopHeaders(hdrs3, "::::", "http://b.com/")
	if hdrs3["sec-fetch-site"] != "same-origin" {
		t.Fatalf("prev URL 非法时应保持原样，got %q", hdrs3["sec-fetch-site"])
	}
}

// 端到端（got 车道）：跨站 302 重定向——首跳保持画像原值，落站跳 sec-fetch-site=cross-site
// 且 Referer 收敛为来源 origin（旧实现恒 same-origin + 首跳完整来路 = 拓扑比对自曝点）。
func TestGotRunCrossHostRedirectHeaderConsistency(t *testing.T) {
	savedPrivate := allowPrivate
	allowPrivate = true
	defer func() { allowPrivate = savedPrivate }()

	var mu sync.Mutex
	startHeaders := map[string]http.Header{}
	finalHeaders := map[string]http.Header{}
	srvB := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		finalHeaders[r.URL.Path] = r.Header.Clone()
		mu.Unlock()
		_, _ = w.Write([]byte("<html><body>final</body></html>"))
	}))
	defer srvB.Close()
	srvA := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		startHeaders[r.URL.Path] = r.Header.Clone()
		mu.Unlock()
		http.Redirect(w, r, srvB.URL+"/final", http.StatusFound)
	}))
	defer srvA.Close()

	res := gotStrategyRun(srvA.URL+"/start", 8_000, &strategyRunCtx{insecureTLS: true})
	if !res.ok {
		t.Fatalf("双跳 302 应成功，got note=%q warnings=%v", res.note, res.warnings)
	}
	start := startHeaders["/start"]
	final := finalHeaders["/final"]
	if start == nil || final == nil {
		t.Fatalf("两跳请求都应到达，start=%v final=%v", start != nil, final != nil)
	}
	if got := start.Get("Sec-Fetch-Site"); got != "same-origin" {
		t.Fatalf("首跳应保持画像原值 same-origin，got %q", got)
	}
	// 两个 httptest 站同为 127.0.0.1（仅端口不同）：same-site 判定与端口无关（site=host 本身），
	// 故期望 same-site 而非 cross-site——但已非旧实现的「跨跳恒 same-origin」；
	// 跨站（无后缀关系 host）形态由 TestRefineHopHeadersTopology 的「跨站」向量锁定。
	if got := final.Get("Sec-Fetch-Site"); got != "same-site" {
		t.Fatalf("跨跳 sec-fetch-site 应按拓扑精化（same-site），旧实现恒 same-origin 自曝，got %q", got)
	}
	if got := final.Get("Referer"); got != srvA.URL {
		t.Fatalf("跨源跳 Referer 应收敛为来源 origin %q（默认 referrer-policy），got %q", srvA.URL, got)
	}
}

// 端到端（fetch 系）：同站 302 重定向——落站跳保持 same-origin 且 Referer=上一跳完整 URL。
func TestFetchGuardSameHostRedirectRefererChain(t *testing.T) {
	savedPrivate := allowPrivate
	allowPrivate = true
	defer func() { allowPrivate = savedPrivate }()

	var mu sync.Mutex
	finalHeaders := http.Header{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/s" {
			http.Redirect(w, r, "/f", http.StatusFound)
			return
		}
		mu.Lock()
		finalHeaders = r.Header.Clone()
		mu.Unlock()
		_, _ = w.Write([]byte("<html><body>final</body></html>"))
	}))
	defer srv.Close()

	headers := map[string]string{
		"user-agent":     chromeUA,
		"sec-fetch-site": "same-origin",
		"referer":        "http://initial.example/page",
		"sec-fetch-dest": "document",
		"sec-fetch-mode": "navigate",
	}
	warnings := []string{}
	res := fetchWithRedirectGuard(srv.URL+"/s", headers, 8_000, &warnings, "", true, nil)
	if !res.ok {
		t.Fatalf("同站 302 跟随应成功，got note=%q warning=%q", res.note, res.warning)
	}
	if got := finalHeaders.Get("Sec-Fetch-Site"); got != "same-origin" {
		t.Fatalf("同站跳应保持 same-origin，got %q", got)
	}
	if got := finalHeaders.Get("Referer"); got != srv.URL+"/s" {
		t.Fatalf("同源跳 Referer 应为上一跳完整 URL %q，got %q", srv.URL+"/s", got)
	}
}

// ---- E7：首跳 sec-fetch-site 与显式 Referer 拓扑一致性 ----

func TestDeriveSecFetchSiteTopology(t *testing.T) {
	cases := []struct {
		name   string
		target string
		ref    string
		want   string
	}{
		{"同源", "http://a.com/c/1.html", "http://a.com/b/9.html", "same-origin"},
		{"跨 scheme 同 host", "https://a.com/c/1", "http://a.com/b/9", "same-site"},
		// 兄弟子域（www↔blog）无后缀关系：按 E6 同款保守方向判 cross-site
		//（无 PSL 依赖，只会把同站跳标成更大跨度、绝不反向放宽，误报方向安全）
		{"兄弟子域保守收敛", "http://www.a.com/c/1", "http://blog.a.com/b/9", "cross-site"},
		{"反向子域", "http://a.com/c/1", "http://www.a.com/b/9", "same-site"},
		{"跨站", "http://a.com/c/1", "http://b.com/b/9", "cross-site"},
		{"目标非法", "::::", "http://a.com/", ""},
		{"Referer 缺 host", "http://a.com/", "/relative/only", ""},
	}
	for _, c := range cases {
		if got := deriveSecFetchSite(c.target, c.ref); got != c.want {
			t.Errorf("%s: deriveSecFetchSite(%q,%q) = %q, want %q", c.name, c.target, c.ref, got, c.want)
		}
	}
}

func TestProfileSecFetchSiteMatchesExplicitReferer(t *testing.T) {
	// 同源显式 Referer（backend 书页→章节主形态）：保持 same-origin，行为不变
	h := chromeDesktopProfile.headers("http://a.com/c/1.html", true, "http://a.com/b/9.html")
	if h["sec-fetch-site"] != "same-origin" {
		t.Fatalf("同源显式 Referer 应保持 same-origin，got %q", h["sec-fetch-site"])
	}
	// 跨站显式 Referer：旧实现恒 same-origin = 稳定矛盾自曝，应精化为 cross-site
	h = chromeDesktopProfile.headers("http://a.com/c/1.html", true, "http://other.example/b/9.html")
	if h["sec-fetch-site"] != "cross-site" {
		t.Fatalf("跨站显式 Referer 应派生 cross-site，got %q", h["sec-fetch-site"])
	}
	if h["referer"] != "http://other.example/b/9.html" {
		t.Fatalf("E7 只改 site 陈述不改 Referer 值（避免破坏需精确来路的站点），got %q", h["referer"])
	}
	// 父子域（host 互为后缀）：same-site
	h = firefoxDesktopProfile.headers("http://www.a.com/c/1", true, "http://a.com/b/9")
	if h["sec-fetch-site"] != "same-site" {
		t.Fatalf("父子域显式 Referer 应派生 same-site，got %q", h["sec-fetch-site"])
	}
	// 缺省 Referer（=目标站自身 origin）：恒 same-origin，行为不变
	h = chromeDesktopProfile.headers("http://a.com/c/1.html", true, "")
	if h["sec-fetch-site"] != "same-origin" {
		t.Fatalf("缺省 Referer 应保持 same-origin，got %q", h["sec-fetch-site"])
	}
	// 误杀面：safari（site=none，无 Referer 直接导航语义）与 spider（无该键）不受影响
	h = safariDesktopProfile.headers("http://a.com/c/1.html", false, "http://other.example/b/9")
	if h["sec-fetch-site"] != "none" {
		t.Fatalf("safari 画像 site=none 语义不得被改写，got %q", h["sec-fetch-site"])
	}
	h = googlebotProfile.headers("http://a.com/c/1.html", false, "http://other.example/b/9")
	if _, ok := h["sec-fetch-site"]; ok {
		t.Fatalf("spider 画像不得被注入 sec-fetch-site，got %q", h["sec-fetch-site"])
	}
	// 非法 Referer：保持画像原值
	h = chromeDesktopProfile.headers("http://a.com/c/1.html", true, "::::")
	if h["sec-fetch-site"] != "same-origin" {
		t.Fatalf("Referer 不可解析时应保持原值，got %q", h["sec-fetch-site"])
	}
}

// 端到端（got 车道·首跳）：跨站显式 Referer 的首跳请求 sec-fetch-site=cross-site
// （旧实现恒 same-origin；hop>0 的落站跳由 E6 精化，见 TestGotRunCrossHostRedirectHeaderConsistency）
func TestGotRunFirstHopSiteMatchesReferer(t *testing.T) {
	savedPrivate := allowPrivate
	allowPrivate = true
	defer func() { allowPrivate = savedPrivate }()

	var mu sync.Mutex
	gotSite := ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		gotSite = r.Header.Get("Sec-Fetch-Site")
		mu.Unlock()
		_, _ = w.Write([]byte("<html><body>ok</body></html>"))
	}))
	defer srv.Close()

	res := gotStrategyRun(srv.URL+"/c/1.html", 8_000, &strategyRunCtx{referer: "http://other.example/b/9.html", insecureTLS: true})
	if !res.ok {
		t.Fatalf("首跳直取应成功，got note=%q warnings=%v", res.note, res.warnings)
	}
	if gotSite != "cross-site" {
		t.Fatalf("首跳 sec-fetch-site 应与显式跨站 Referer 一致（cross-site），got %q", gotSite)
	}
}

// ---- F3：runeLen 对齐 JS String.length（UTF-16 code unit）语义 ----

func TestRuneLenJSSemantics(t *testing.T) {
	cases := []struct {
		in   string
		want int
	}{
		{"", 0},
		{"ab", 2},
		{"中文", 2},         // BMP 内与字符数一致
		{"\U0001D11E", 2}, // U+1D11E 星面字符按代理对计 2（旧实现 1）
		{"😀", 2},          // emoji 同上
		{"a😀b中", 5},       // 混合：1+2+1+1
		{"\u200b", 1},     // 零宽字符 BMP 内计 1
	}
	for _, c := range cases {
		if got := runeLen(c.in); got != c.want {
			t.Errorf("runeLen(%q) = %d, want %d（JS String.length 语义）", c.in, got, c.want)
		}
	}
}

// ---- F4：jsonStr 大整数跨平台不截断 ----

func TestJsonStrIntegerNoPlatformTruncation(t *testing.T) {
	cases := []struct {
		in   any
		want string
	}{
		{float64(3), "3"},
		{float64(4503599627370496), "4503599627370496"}, // 2^52：32 位 int 截断回绕防线
		{float64(2.5), "2.5"},
		{float64(-7), "-7"},
		{nil, ""},
		{"x", "x"},
		{true, "true"},
	}
	for _, c := range cases {
		if got := jsonStr(c.in); got != c.want {
			t.Errorf("jsonStr(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}
