package main

// jscontent_test.go —— chapterContentApi（R141）回归锁定：
//   1) 配置解析：合法/缺必填/坏正则/contentFields 兼容单字符串/token 桥解析
//   2) cookieValueFromHeader：提取/URL 反解/缺失/空段
//   3) urlJoinPath：相对端点拼接 origin / 绝对端点原样
//   4) extractChapterViaAPI 端到端（httptest）：命中（contentHtml+titleFields+token 桥头）/
//      非同源 SSRF 拒绝 / HTTP 403 / contentFields 全空回退 false
//   5) handleChapter 集成：strategy=json-content-api 直返 + API 失败落回 HTML 路径 warnings 透传
// 与 audit46_test（chapterListApi）同测试环境态：disableImpersonateForTest + 临时放行私有地址
// + 替换 tocHTTPClient（init 时 dial Control 挂死回环地址）。

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func contentApiTestEnv(t *testing.T) {
	t.Helper()
	disableImpersonateForTest(t)
	savedPrivate, savedClient := allowPrivate, tocHTTPClient
	allowPrivate = true
	tocHTTPClient = &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{}}
	t.Cleanup(func() { allowPrivate, tocHTTPClient = savedPrivate, savedClient })
}

const testContentApiCfg = `{
 "url": "/book/queryReadPage?bookId={bookId}&bookIndexId={chapterId}&contentFormat=html",
 "method": "GET",
 "bookIdRE": "/book/(\\d+)/",
 "chapterIdRE": "(\\d+)\\.html",
 "contentFields": ["data.contentHtml", "data.content"],
 "titleFields": ["data.bookIndex.name"],
 "tokenHeaders": [{"header": "X-Browser-Token", "cookie": "novel_browser_token"}]
}`

func TestParseChapterContentApiOK(t *testing.T) {
	cfg, err := parseChapterContentApi(testContentApiCfg)
	if err != "" {
		t.Fatalf("合法配置解析失败: %s", err)
	}
	if cfg.method != "GET" || !strings.Contains(cfg.url, "{bookId}") {
		t.Fatalf("method/url 解析错误: %+v", cfg)
	}
	if len(cfg.contentFields) != 2 || cfg.contentFields[0] != "data.contentHtml" {
		t.Fatalf("contentFields 解析错误: %v", cfg.contentFields)
	}
	if len(cfg.titleFields) != 1 || len(cfg.tokenHeaders) != 1 {
		t.Fatalf("titleFields/tokenHeaders 解析错误: %v / %v", cfg.titleFields, cfg.tokenHeaders)
	}
	if cfg.tokenHeaders[0].header != "X-Browser-Token" || cfg.tokenHeaders[0].cookie != "novel_browser_token" {
		t.Fatalf("token 桥字段错误: %+v", cfg.tokenHeaders[0])
	}
}

func TestParseChapterContentApiErrors(t *testing.T) {
	cases := []struct {
		raw  string
		note string
	}{
		{`{"url":"/a"}`, "缺 bookIdRE/chapterIdRE"},
		{`{"bookIdRE":"/(\\d+)/","chapterIdRE":"(\\d+)","contentFields":["x"]}`, "缺 url"},
		{`{"url":"/a{bookId}","bookIdRE":"(\\d+)","chapterIdRE":"(\\d+)"}`, "缺 contentFields"},
		{`{"url":"/a","bookIdRE":"(\\d+","chapterIdRE":"(\\d+)","contentFields":["x"]}`, "坏正则"},
		{`{badjson`, "JSON 损坏"},
	}
	for _, c := range cases {
		if _, err := parseChapterContentApi(c.raw); err == "" {
			t.Errorf("应拒绝（%s）: %s", c.note, c.raw)
		}
	}
	// URL 缺占位符
	_, err := parseChapterContentApi(`{"url":"/plain","bookIdRE":"(\\d+)","chapterIdRE":"(\\d+)","contentFields":["x"]}`)
	if err == "" || !strings.Contains(err, "占位符") {
		t.Errorf("URL 缺 {bookId}/{chapterId} 占位符应报错，got %q", err)
	}
	// contentFields 单字符串兼容
	cfg, err := parseChapterContentApi(`{"url":"/a{bookId}","bookIdRE":"(\\d+)","chapterIdRE":"(\\d+)","contentFields":"data.content"}`)
	if err != "" || len(cfg.contentFields) != 1 {
		t.Errorf("contentFields 单字符串应兼容，err=%q cfg=%+v", err, cfg)
	}
	// method 默认 GET / POST 白名单
	cfg2, _ := parseChapterContentApi(`{"url":"/a{bookId}","method":"POST","bookIdRE":"(\\d+)","chapterIdRE":"(\\d+)","contentFields":["x"]}`)
	if cfg2.method != "POST" {
		t.Errorf("POST 应保留，got %q", cfg2.method)
	}
	cfg3, _ := parseChapterContentApi(`{"url":"/a{bookId}","method":"PUT","bookIdRE":"(\\d+)","chapterIdRE":"(\\d+)","contentFields":["x"]}`)
	if cfg3.method != "GET" {
		t.Errorf("非法 method 应归一 GET，got %q", cfg3.method)
	}
}

func TestCookieValueFromHeader(t *testing.T) {
	cases := []struct {
		hdr, name, want string
	}{
		{"a=1; novel_browser_token=v1.x%2Fy; c=3", "novel_browser_token", "v1.x/y"},
		{"novel_browser_token=plain", "novel_browser_token", "plain"},
		{"a=1; c=3", "novel_browser_token", ""},
		{"", "novel_browser_token", ""},
		{"novel_browser_token=; a=1", "novel_browser_token", ""},
	}
	for _, c := range cases {
		if got := cookieValueFromHeader(c.hdr, c.name); got != c.want {
			t.Errorf("cookieValueFromHeader(%q,%q)=%q want %q", c.hdr, c.name, got, c.want)
		}
	}
}

func TestUrlJoinPath(t *testing.T) {
	if got := urlJoinPath("/book/query", "https://book.washai.net/book/1/2.html"); got != "https://book.washai.net/book/query" {
		t.Errorf("相对端点拼接错误: %q", got)
	}
	if got := urlJoinPath("https://other.com/api", "https://book.washai.net/book/1/2.html"); got != "https://other.com/api" {
		t.Errorf("绝对端点应原样: %q", got)
	}
}

func TestExtractChapterViaAPIHit(t *testing.T) {
	contentApiTestEnv(t)
	var gotToken, gotReferer string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotToken = r.Header.Get("X-Browser-Token")
		gotReferer = r.Header.Get("Referer")
		if !strings.Contains(r.URL.RawQuery, "bookId=12622") || !strings.Contains(r.URL.RawQuery, "bookIndexId=2039") {
			t.Errorf("请求应携带填槽后的 ID，got %q", r.URL.RawQuery)
		}
		_, _ = w.Write([]byte(`{"code":200,"data":{"contentHtml":"<p>正文甲</p><p>正文乙</p>","bookIndex":{"name":"第1章 开端"},"needBuy":false}}`))
	}))
	defer srv.Close()

	cfg, cfgErr := parseChapterContentApi(testContentApiCfg)
	if cfgErr != "" {
		t.Fatalf("配置解析失败: %s", cfgErr)
	}
	// 会话 jar 预置 token cookie（桥接来源）
	recordSetCookieLines(hostOf(srv.URL), []string{"novel_browser_token=tk123; Path=/"}, strings.HasPrefix(srv.URL, "https"))

	warnings := []string{}
	data, ok := extractChapterViaAPI(srv.URL+"/book/1262260513468569127/2039351400479724039.html", cfg, &warnings)
	if !ok {
		t.Fatalf("API 命中应返回 ok=true，warnings=%v", warnings)
	}
	if data.Content != "<p>正文甲</p><p>正文乙</p>" {
		t.Errorf("正文提取错误: %q", data.Content)
	}
	if data.Title != "第1章 开端" {
		t.Errorf("标题提取错误: %q", data.Title)
	}
	if gotToken != "tk123" {
		t.Errorf("token 桥应把会话 cookie 塞进 X-Browser-Token，got %q", gotToken)
	}
	if !strings.HasSuffix(gotReferer, "/book/1262260513468569127/2039351400479724039.html") {
		t.Errorf("Referer 应为章节页 URL，got %q", gotReferer)
	}
}

func TestExtractChapterViaAPICrossOriginRejected(t *testing.T) {
	contentApiTestEnv(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("非同源请求不应发出")
	}))
	// 不 defer Close——不应有请求到达；测试结束前显式回收。
	cfg, _ := parseChapterContentApi(`{"url":"` + srv.URL + `/evil?bookId={bookId}&chapterId={chapterId}","bookIdRE":"/book/(\\d+)/","chapterIdRE":"(\\d+)\\.html","contentFields":["data.contentHtml"]}`)
	warnings := []string{}
	_, ok := extractChapterViaAPI("https://example-real.com/book/1/2.html", cfg, &warnings)
	if ok {
		t.Fatalf("跨域 API 应拒绝（SSRF）")
	}
	joined := strings.Join(warnings, "")
	if !strings.Contains(joined, "非同源") {
		t.Errorf("警告应说明非同源拒绝，got %v", warnings)
	}
	srv.Close()
}

func TestExtractChapterViaAPIStatus403(t *testing.T) {
	contentApiTestEnv(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()
	cfg, _ := parseChapterContentApi(testContentApiCfg)
	warnings := []string{}
	_, ok := extractChapterViaAPI(srv.URL+"/book/1/2.html", cfg, &warnings)
	if ok {
		t.Fatalf("HTTP 403 应返回 false")
	}
	if !strings.Contains(strings.Join(warnings, ""), "403") {
		t.Errorf("警告应携带状态码，got %v", warnings)
	}
}

func TestExtractChapterViaAPIEmptyContentFields(t *testing.T) {
	contentApiTestEnv(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"code":200,"data":{"contentHtml":""}}`))
	}))
	defer srv.Close()
	cfg, _ := parseChapterContentApi(testContentApiCfg)
	warnings := []string{}
	_, ok := extractChapterViaAPI(srv.URL+"/book/1/2.html", cfg, &warnings)
	if ok {
		t.Fatalf("contentFields 全空应返回 false")
	}
	if !strings.Contains(strings.Join(warnings, ""), "未命中") {
		t.Errorf("警告应说明字段未命中，got %v", warnings)
	}
}

func TestHandleChapterContentApiBranch(t *testing.T) {
	contentApiTestEnv(t)
	var apiHit bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "queryReadPage") {
			apiHit = true
			_, _ = w.Write([]byte(`{"code":200,"data":{"contentHtml":"<p>API 正文</p>","bookIndex":{"name":"第9章 集成"}}}`))
			return
		}
		// HTML 章节页（回退路径不应被触达——API 命中时跳过）
		_, _ = w.Write([]byte(`<html><body><div class="submenu"><h1>书名 > 第9章</h1></div><div class="con"><p>HTML 正文</p></div></body></html>`))
	}))
	defer srv.Close()

	// 沿用 audit46 F3 的 handler 集成形态：直接调 handleChapter + ResponseRecorder
	body := map[string]any{
		"url":  srv.URL + "/book/777/888.html",
		"rule": map[string]any{"chapterContentApi": testContentApiCfg},
	}
	rec := httptest.NewRecorder()
	handleChapter(rec, body)
	if rec.Code != 200 {
		t.Fatalf("应 200，got %d body=%s", rec.Code, rec.Body.String())
	}
	resp := rec.Body.String()
	if !strings.Contains(resp, `"strategy":"json-content-api"`) {
		t.Errorf("应走 json-content-api 策略直返，got %s", resp)
	}
	if !strings.Contains(resp, "API 正文") || !apiHit {
		t.Errorf("正文应来自 API（apiHit=%v），got %s", apiHit, resp)
	}
}

func TestHandleChapterContentApiFallbackToHTML(t *testing.T) {
	contentApiTestEnv(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "queryReadPage") {
			w.WriteHeader(http.StatusForbidden) // API 挂 → 回退 HTML
			return
		}
		_, _ = w.Write([]byte(`<html><body><div class="submenu"><h1>书名 > 第9章</h1></div><div class="con"><p>HTML 正文兜底</p></div></body></html>`))
	}))
	defer srv.Close()

	body := map[string]any{
		"url": srv.URL + "/book/777/888.html",
		"rule": map[string]any{
			"chapterContentApi": testContentApiCfg,
			"titleSelector":     ".submenu h1",
			"contentSelector":   ".con",
		},
	}
	rec := httptest.NewRecorder()
	handleChapter(rec, body)
	if rec.Code != 200 {
		t.Fatalf("回退路径应 200，got %d body=%s", rec.Code, rec.Body.String())
	}
	resp := rec.Body.String()
	if !strings.Contains(resp, "HTML 正文兜底") {
		t.Errorf("API 失败应回退 HTML 正文，got %s", resp)
	}
	if !strings.Contains(resp, "403") {
		t.Errorf("warnings 应透传 API 403 原因，got %s", resp)
	}
}

func TestHandleChapterBadContentApiConfig(t *testing.T) {
	contentApiTestEnv(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`<html><body><div class="con"><p>纯 HTML</p></div></body></html>`))
	}))
	defer srv.Close()

	body := map[string]any{
		"url":  srv.URL + "/book/777/888.html",
		"rule": map[string]any{"chapterContentApi": `{bad`},
	}
	rec := httptest.NewRecorder()
	handleChapter(rec, body)
	if rec.Code != 200 {
		t.Fatalf("坏配置应降级 HTML 路径 200，got %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "配置无效") {
		t.Errorf("坏配置原因应透传，got %s", rec.Body.String())
	}
}
