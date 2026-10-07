/**
 * audit50_test.go —— Task 50-a 第 12 轮收敛深审修复与增强锁定：
 *
 *   - E8（反反爬·头族指纹一致性）：Go 原生车道（fetch 系/got 系）画像显式声明
 *     accept-encoding: gzip, deflate——旧实现不发该键时 Go 传输层自动补单
 *     「Accept-Encoding: gzip」（稳定的 Go 客户端指纹，真实浏览器恒含 deflate/br），
 *     与画像 UA 构成头族矛盾；响应侧由 contentDecodedReader 透明解包（gzip/zlib/
 *     裸 deflate 三形态），maxBytes 上限计数作用在解包后字节上（解压炸弹防护不回退）。
 *     jsontoc AJAX 车道同口径接线（46-a F3 已补 UA，本项补齐压缩协商头族）。
 *   - E9（反反爬·重定向跳 sec-fetch-user 保真）：sec-fetch-user 仅随「用户激活发起的
 *     导航」发送，重定向跳（3xx/JS 跳转）非用户激活、真实浏览器跳间不携带——refineHopHeaders
 *     在 hop>0 删除已存在的 sec-fetch-user 键（误杀面控制：无该键画像本就不发，绝不注入）。
 *   - 精简：selectors.go isSafe 死函数删除（grep 全仓零调用点）。
 */
package main

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/PuerkitoBio/goquery"
)

// ---- E8：画像压缩能力声明与响应侧透明解包 ----

// 全部画像必须显式声明 accept-encoding（与真实解压能力一致的 gzip, deflate）——
// 漏声明即回退 Go 传输层单 gzip 指纹。
func TestProfileAcceptEncodingAdvertised(t *testing.T) {
	profiles := []headerProfile{
		chromeDesktopProfile, firefoxDesktopProfile, safariDesktopProfile, edgeDesktopProfile,
		androidChromeProfile, iphoneSafariProfile, googlebotProfile, baiduspiderProfile,
	}
	for _, p := range profiles {
		h := p.headers("http://a.com/c/1.html", p.withReferer, "")
		if h["accept-encoding"] != "gzip, deflate" {
			t.Errorf("画像 %s 的 accept-encoding = %q, want \"gzip, deflate\"（缺声明即回落 Go 单 gzip 指纹）", p.id, h["accept-encoding"])
		}
	}
}

// gzipReader 构造一段 gzip 流
func gzipReader(t *testing.T, payload []byte) io.Reader {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write(payload); err != nil {
		t.Fatalf("gzip 写入失败: %v", err)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("gzip 收尾失败: %v", err)
	}
	return bytes.NewReader(buf.Bytes())
}

// zlib / 裸 deflate 两种流形态构造
func deflateReader(t *testing.T, payload []byte, zlibWrapped bool) io.Reader {
	t.Helper()
	var buf bytes.Buffer
	var w io.WriteCloser
	if zlibWrapped {
		w = zlib.NewWriter(&buf)
	} else {
		w, _ = flate.NewWriter(&buf, flate.DefaultCompression)
	}
	if _, err := w.Write(payload); err != nil {
		t.Fatalf("deflate 写入失败: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("deflate 收尾失败: %v", err)
	}
	return bytes.NewReader(buf.Bytes())
}

func decodedResponse(enc string, body io.Reader) *http.Response {
	hdr := http.Header{}
	hdr.Set("Content-Type", "text/html")
	if enc != "" {
		hdr.Set("Content-Encoding", enc)
	}
	return &http.Response{StatusCode: 200, Header: hdr, Body: io.NopCloser(body)}
}

func TestContentDecodedReaderThreeForms(t *testing.T) {
	marker := "<html><body>压-缩-解-包-marker</body></html>"
	cases := []struct {
		name string
		enc  string
		body io.Reader
	}{
		{"gzip", "gzip", gzipReader(t, []byte(marker))},
		{"zlib 封装 deflate", "deflate", deflateReader(t, []byte(marker), true)},
		{"裸 deflate 误标流", "deflate", deflateReader(t, []byte(marker), false)},
		{"identity 透传", "identity", strings.NewReader(marker)},
		{"未声明编码透传", "", strings.NewReader(marker)},
	}
	for _, c := range cases {
		res := decodedResponse(c.enc, c.body)
		src, cleanup, err := contentDecodedReader(res)
		if err != nil {
			t.Errorf("%s: contentDecodedReader 失败: %v", c.name, err)
			continue
		}
		got, rerr := io.ReadAll(src)
		cleanup()
		if rerr != nil {
			t.Errorf("%s: 读取失败: %v", c.name, rerr)
			continue
		}
		if string(got) != marker {
			t.Errorf("%s: 解包结果不匹配, got %q", c.name, truncateStr(string(got), 80))
		}
	}
}

// 声明 gzip 但 0 字节体：按空体处理（对齐旧透明解压路径 empty-body 语义），不虚报 network-error
func TestReadBodyCappedGzipEmptyBody(t *testing.T) {
	res := decodedResponse("gzip", strings.NewReader(""))
	br := readBodyCapped(res)
	if br.note != "" || len(br.bytes) != 0 || br.warning != "" {
		t.Fatalf("0 字节 gzip 体应按空体处理, got note=%q warning=%q", br.note, br.warning)
	}
}

// 声明 gzip 但流损坏：network-error + 警告留痕（错误证据不再吞没）
func TestReadBodyCappedGzipCorrupt(t *testing.T) {
	res := decodedResponse("gzip", strings.NewReader("not-a-gzip-stream-at-all"))
	br := readBodyCapped(res)
	if br.note != "network-error" || !strings.Contains(br.warning, "解包失败") {
		t.Fatalf("损坏 gzip 流应记 network-error+解包失败警告, got note=%q warning=%q", br.note, br.warning)
	}
}

// maxBytes 上限计数作用在解包后字节上：小体积 gzip 展开超限必须 too-large（解压炸弹防护）
func TestReadBodyCappedCapCountsDecompressed(t *testing.T) {
	huge := bytes.Repeat([]byte("A"), maxBytes+1024) // 明文超限、压缩后极小
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write(huge); err != nil {
		t.Fatalf("gzip 写入失败: %v", err)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("gzip 收尾失败: %v", err)
	}
	res := decodedResponse("gzip", bytes.NewReader(buf.Bytes()))
	if buf.Len() >= maxBytes {
		t.Fatalf("测试前置失效：压缩流应远小于上限")
	}
	br := readBodyCapped(res)
	if br.note != "too-large" {
		t.Fatalf("解包后超限应记 too-large（旧语义按压缩字节计数会漏放解压炸弹）, got note=%q size=%d", br.note, br.size)
	}
	if br.size <= maxBytes {
		t.Fatalf("too-large 的 size 应为已读解包字节总量, got %d", br.size)
	}
}

// 端到端（fetch 车道）：请求侧携带显式 accept-encoding（不再回落 Go 单 gzip 指纹）、
// 响应侧 gzip 明文正确解出（策略链把解压后 HTML 当成功页返回）。
func TestFetchLaneAcceptEncodingAndGzipEndToEnd(t *testing.T) {
	savedPrivate := allowPrivate
	allowPrivate = true
	defer func() { allowPrivate = savedPrivate }()

	var mu sync.Mutex
	gotAE := ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		gotAE = r.Header.Get("Accept-Encoding")
		mu.Unlock()
		var buf bytes.Buffer
		zw := gzip.NewWriter(&buf)
		_, _ = zw.Write([]byte("<html><body>gzip-e2e-final</body></html>"))
		_ = zw.Close()
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write(buf.Bytes())
	}))
	defer srv.Close()

	headers := chromeDesktopProfile.headers(srv.URL+"/c/1.html", true, "")
	res := fetchWithRedirectGuard(srv.URL+"/c/1.html", headers, 8_000, &[]string{}, "", true, nil)
	if !res.ok {
		t.Fatalf("gzip 响应应解包成功, got note=%q warning=%q", res.note, res.warning)
	}
	if !strings.Contains(string(res.bytes), "gzip-e2e-final") {
		t.Fatalf("响应体应为解包后明文, got %q", truncateStr(string(res.bytes), 120))
	}
	if gotAE != "gzip, deflate" {
		t.Fatalf("请求应携带画像声明的 accept-encoding, got %q（旧实现为 Go 默认单 gzip）", gotAE)
	}
}

// 端到端（jsontoc 车道）：AJAX 显式 accept-encoding + gzip JSON 响应正确解包解析
func TestExtractJsonTocGzipEndToEnd(t *testing.T) {
	disableImpersonateForTest(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if ae := r.Header.Get("Accept-Encoding"); ae != "gzip, deflate" {
			t.Errorf("AJAX 应显式声明 accept-encoding, got %q", ae)
		}
		var buf bytes.Buffer
		zw := gzip.NewWriter(&buf)
		_, _ = zw.Write([]byte(`{"data":[{"title":"第一章 开端","ordernum":1},{"title":"第二章","ordernum":2}]}`))
		_ = zw.Close()
		w.Header().Set("Content-Encoding", "gzip")
		_, _ = w.Write(buf.Bytes())
	}))
	defer srv.Close()
	// 测试站为 127.0.0.1：与 audit46_test 同模式临时放行私有地址并替换包级 tocHTTPClient
	savedPrivate, savedClient := allowPrivate, tocHTTPClient
	allowPrivate = true
	tocHTTPClient = &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{}}
	defer func() { allowPrivate, tocHTTPClient = savedPrivate, savedClient }()

	doc, _ := goquery.NewDocumentFromReader(strings.NewReader(`<html><input id="bid" value="42"></html>`))
	cfg, cfgErr := parseChapterListApi(`{"url":"/list","method":"GET","bookIdSelector":"#bid@value","titleField":"title","orderField":"ordernum","listPath":"data","urlTemplate":"/read/{bookId}/{order}.html"}`)
	if cfgErr != "" {
		t.Fatalf("配置解析失败: %s", cfgErr)
	}
	warnings := []string{}
	refs := extractJsonToc(doc.Selection, cfg, srv.URL+"/book/1.html", &warnings)
	if len(refs) != 2 {
		t.Fatalf("gzip JSON 目录应解包并解析出 2 条, got %d, warnings=%v", len(refs), warnings)
	}
}

// ---- E9：重定向跳 sec-fetch-user 保真 ----

// 单元：hop>0 删除已存在的 sec-fetch-user；无该键不注入；非法 URL 防御路径零改动
func TestRefineHopHeadersDropsSecFetchUserOnRedirect(t *testing.T) {
	hdrs := map[string]string{
		"sec-fetch-site":  "same-origin",
		"sec-fetch-user":  "?1",
		"referer":         "http://initial.example/",
		"accept-encoding": "gzip, deflate",
	}
	refineHopHeaders(hdrs, "http://a.com/s", "http://a.com/f")
	if _, ok := hdrs["sec-fetch-user"]; ok {
		t.Fatalf("重定向跳应删除 sec-fetch-user（非用户激活导航真实浏览器不发送）, got %q", hdrs["sec-fetch-user"])
	}
	if hdrs["sec-fetch-site"] != "same-origin" || hdrs["referer"] != "http://a.com/s" {
		t.Fatalf("E9 不得影响 E6 的 site/referer 改写, got %v", hdrs)
	}
	if hdrs["accept-encoding"] != "gzip, deflate" {
		t.Fatalf("E9 不得误删无关头, got %v", hdrs)
	}
	// 误杀面：无该键的画像（safari/spider）保持零注入
	hdrs2 := map[string]string{"user-agent": "ua"}
	refineHopHeaders(hdrs2, "http://a.com/s", "http://b.com/f")
	if _, ok := hdrs2["sec-fetch-user"]; ok {
		t.Fatalf("缺失键不得被注入, got %v", hdrs2)
	}
	if len(hdrs2) != 1 {
		t.Fatalf("无该键画像跳间头集不得被改动, got %v", hdrs2)
	}
}

// 端到端（got 车道）：302 跳后的落站跳不携带 sec-fetch-user（旧实现残留首跳 ?1 自曝）
func TestGotRunRedirectDropsSecFetchUser(t *testing.T) {
	savedPrivate := allowPrivate
	allowPrivate = true
	defer func() { allowPrivate = savedPrivate }()

	var mu sync.Mutex
	startUser, finalUser := "", ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		if r.URL.Path == "/s" {
			startUser = r.Header.Get("Sec-Fetch-User")
			http.Redirect(w, r, "/f", http.StatusFound)
		} else {
			finalUser = r.Header.Get("Sec-Fetch-User")
			_, _ = w.Write([]byte("<html><body>final</body></html>"))
		}
		mu.Unlock()
	}))
	defer srv.Close()

	res := gotStrategyRun(srv.URL+"/s", 8_000, &strategyRunCtx{insecureTLS: true})
	if !res.ok {
		t.Fatalf("302 跟随应成功, got note=%q warnings=%v", res.note, res.warnings)
	}
	if startUser != "?1" {
		t.Fatalf("首跳为用户激活导航应保留 sec-fetch-user: ?1, got %q", startUser)
	}
	if finalUser != "" {
		t.Fatalf("重定向跳非用户激活，sec-fetch-user 应被 E9 删除（旧实现残留 ?1 与浏览器行为矛盾）, got %q", finalUser)
	}
}
