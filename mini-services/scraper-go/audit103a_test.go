/**
 * audit103a_test.go —— R103 chapterListApi HTML 片段模式回归锁定（引擎侧）：
 *
 * 背景：101kks.com 实测形态——书页 /book/{id}.html 零章节锚，目录页 /book/{id}/index.html
 * 静态 HTML 也零章节（#allchapter 由 $.ajax GET /ajax_novels/chapterlist/{bookId}.html
 * 返回 <ul><li><a> 片段填充）。原 chapterListApi 仅支持 JSON 响应，无法适配。
 *
 * 三项能力：①responseType=html（itemSelector 直接从片段提取锚，URL/标题来自锚本身）
 * ②bookIdRegex（书页 URL 正则提取 {bookId}，书页无 id 元素形态）③cfg.url 支持 {bookId}
 * 占位符（路径参数型 AJAX 端点——原实现仅 body/urlTemplate 支持占位符，url 字面量直传
 * 导致实测 404）。
 *
 * 另锁定 tocFetchImpersonate 的 JA3 伪装传输骨架（Go TLS 指纹被 CF 系 WAF 403 的
 * 根治路径）：fake curl 二进制注入测全链路；无二进制时回退 Go 原生语义不变。
 */
package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/PuerkitoBio/goquery"
)

// disableImpersonateForTest 临时禁用 JA3 伪装传输（沙箱装有真 curl-impersonate 时
// extractJsonTocBudgeted 优先走二进制路径，tocHTTPClient 的替换/断言不生效）——
// 验证 Go 原生传输头族语义的历史测试（audit46/audit50）开头调用本 helper 隔离环境，
// 伪装路径行为由本文件 fake binary 专项测试锁定。
func disableImpersonateForTest(t *testing.T) {
	t.Helper()
	tmp := t.TempDir()
	t.Setenv("PATH", tmp)
	t.Setenv("HOME", tmp)
	curlBinMu.Lock()
	prevBins, prevEmpty := curlBins, curlBinsEmptyAt
	curlBins, curlBinsEmptyAt = nil, 0
	curlBinMu.Unlock()
	t.Cleanup(func() {
		curlBinMu.Lock()
		curlBins, curlBinsEmptyAt = prevBins, prevEmpty
		curlBinMu.Unlock()
	})
}

func TestParseChapterListApiHtmlMode(t *testing.T) {
	// html 模式：itemSelector 必填；bookIdSelector/bookIdRegex 至少其一
	if _, errStr := parseChapterListApi(`{"url":"/a/{bookId}.html","responseType":"html"}`); errStr == "" || !strings.Contains(errStr, "itemSelector") {
		t.Fatalf("html 模式缺 itemSelector 应拒绝，got %q", errStr)
	}
	if _, errStr := parseChapterListApi(`{"url":"/a/{bookId}.html","responseType":"html","itemSelector":"li a"}`); errStr == "" || !strings.Contains(errStr, "bookIdSelector") {
		t.Fatalf("html 模式缺 bookId 来源应拒绝，got %q", errStr)
	}
	cfg, errStr := parseChapterListApi(`{"url":"/a/{bookId}.html","responseType":"html","bookIdRegex":"/book/(\\d+)\\.html","itemSelector":"li a[href]"}`)
	if errStr != "" {
		t.Fatalf("合法 html 配置被拒绝: %q", errStr)
	}
	if cfg.responseType != "html" || cfg.method != "GET" || cfg.itemSelector != "li a[href]" || cfg.bookIdRegex == "" {
		t.Fatalf("html 配置解析不符: %+v", cfg)
	}
	// json 模式向后兼容：无 responseType 时仍按原必填集校验
	if _, errStr := parseChapterListApi(`{"url":"/a","bookIdSelector":"#bid","titleField":"name"}`); errStr == "" || !strings.Contains(errStr, "urlTemplate") {
		t.Fatalf("json 模式缺 urlTemplate 应拒绝，got %q", errStr)
	}
	if cfg2, errStr := parseChapterListApi(`{"url":"/a","bookIdSelector":"#bid","titleField":"name","urlTemplate":"/r/{order}"}`); errStr != "" || cfg2.responseType != "json" {
		t.Fatalf("json 兼容解析不符: %+v %q", cfg2, errStr)
	}
	// 非法 responseType 拒绝
	if _, errStr := parseChapterListApi(`{"url":"/a","responseType":"xml","bookIdSelector":"#b","titleField":"t","urlTemplate":"/u"}`); errStr == "" {
		t.Fatalf("responseType=xml 应拒绝")
	}
}

func TestBookIdFromURLRegex(t *testing.T) {
	cases := []struct{ url, re, want string }{
		{"https://101kks.com/book/6527.html", `/book/(\d+)\.html`, "6527"},
		{"https://101kks.com/book/6527.html", `/nope/(\d+)`, ""},
		{"https://x.com/a/12/b", `/a/(\d+)/`, "12"},
		{"https://x.com/a/12/b", `(?i)[a-z]+/(\d+)/`, "12"},
	}
	for _, c := range cases {
		if got := bookIdFromURL(c.url, c.re); got != c.want {
			t.Fatalf("bookIdFromURL(%q,%q)=%q want %q", c.url, c.re, got, c.want)
		}
	}
	// 非法正则安全返回空（不 panic）
	if got := bookIdFromURL("https://x.com/1", "([unclosed"); got != "" {
		t.Fatalf("非法正则应返回空，got %q", got)
	}
}

func TestExtractHtmlTocFragment(t *testing.T) {
	// 101kks AJAX 片段实测形态：<ul><li data-num="1"><a href="绝对URL">标题 </a>
	frag := `<ul>
<li data-num="1"><a   href="https://101kks.com/txt/6527/3430902.html">第1章 臭魚爛蝦 </a>
<li data-num="2"><a   href="/txt/6527/3430904.html">第2章 突襲</a>
<li data-num="3"><a   href="javascript:;">占位</a>
<li data-num="4"><a></a>
<li data-num="5"><a   href="https://other.example.com/txt/3.html">外站章</a>
</ul>`
	cfg, _ := parseChapterListApi(`{"url":"/a/{bookId}.html","responseType":"html","bookIdRegex":"/book/(\\d+)\\.html","itemSelector":"li a[href]"}`)
	warns := []string{}
	refs := extractHtmlToc([]byte(frag), cfg, "https://101kks.com/book/6527.html", &warns)
	// 3 个有效锚（javascript: 占位 + 空锚剔除；外站 http(s) 锚保留——与 JSON urlTemplate 同姿态，
	// 章节抓取时引擎侧 SSRF 逐跳校验兜底）
	if len(refs) != 3 {
		t.Fatalf("应提取 3 个有效锚，got %d (%+v)", len(refs), refs)
	}
	if got := *refs[0].Url; got != "https://101kks.com/txt/6527/3430902.html" {
		t.Fatalf("绝对 URL 应原样保留，got %q", got)
	}
	if got := *refs[1].Url; got != "https://101kks.com/txt/6527/3430904.html" {
		t.Fatalf("相对 URL 应按书页绝对化，got %q", got)
	}
	if refs[0].Title != "第1章 臭魚爛蝦" {
		t.Fatalf("标题应 TrimSpace，got %q", refs[0].Title)
	}
	// 空片段 → 空结果 + 警告
	warns = []string{}
	refs = extractHtmlToc([]byte("<div>空</div>"), cfg, "https://101kks.com/book/6527.html", &warns)
	if len(refs) != 0 || len(warns) == 0 {
		t.Fatalf("空片段应 0 结果 + 警告，got %d %v", len(refs), warns)
	}
}

func TestChapterListApiBookIdPlaceholderInURL(t *testing.T) {
	// 端到端：httptest 起同源书页+片段端点，走 extractBookBudgeted 全链路验证
	// {bookId} 占位符替换与 html 片段目录增益（书页内嵌 1 条 → 片段 3 条胜出）
	mux := http.NewServeMux()
	mux.HandleFunc("/book/6527.html", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<html><head><title>书页</title></head><body>
<h1>占位符测试书</h1>
<div id="lat"><a href="/txt/6527/999.html">第999章 最新</a></div>
</body></html>`))
	})
	mux.HandleFunc("/ajax_novels/chapterlist/6527.html", func(w http.ResponseWriter, r *http.Request) {
		// 断言引擎请求的是替换后的 URL（6527 而非 {bookId} 字面量）——
		// 若占位符未替换会 404 由 miss 路径承接
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<ul>
<li><a href="/txt/6527/1.html">第1章 甲</a></li>
<li><a href="/txt/6527/2.html">第2章 乙</a></li>
<li><a href="/txt/6527/3.html">第3章 丙</a></li>
</ul>`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(`<html><body><h1>占位符测试书</h1></body></html>`))
	if err != nil {
		t.Fatalf("parse doc: %v", err)
	}
	apiCfg := `{"url":"` + srv.URL + `/ajax_novels/chapterlist/{bookId}.html","responseType":"html","bookIdRegex":"/book/(\\d+)\\.html","itemSelector":"li a[href]"}`
	rule := map[string]string{
		"titleSelector":  "h1",
		"chapterListApi": apiCfg,
	}
	warns := []string{}
	book := extractBookBudgeted(doc, rule, srv.URL+"/book/6527.html", &warns, 60_000)
	if book.Title != "占位符测试书" {
		t.Fatalf("书名提取不符: %q", book.Title)
	}
	if len(book.Chapters) != 3 {
		t.Fatalf("片段目录 3 条应胜出书页内嵌 1 条，got %d (warns=%v)", len(book.Chapters), warns)
	}
	if got := *book.Chapters[0].Url; !strings.HasSuffix(got, "/txt/6527/1.html") {
		t.Fatalf("首章 URL 不符: %q", got)
	}
	// 引擎请求 URL 必须已替换占位符：以 miss 路径反证——若未替换，{bookId} 字面量路径
	// 404 → 无片段目录 → chapters 回退书页 1 条，上方 len==3 断言即失败
}

func TestTocFetchImpersonateFallbackNoBinary(t *testing.T) {
	// 二进制缺失路径：PATH 清空（+ HOME 兜底目录指向空临时目录）→ detectCurlImpersonates 空
	// → tocErrNoTransport，调用方回退 Go 原生
	tmpEmpty := t.TempDir()
	t.Setenv("PATH", tmpEmpty)
	t.Setenv("HOME", tmpEmpty)
	// 重置探测缓存
	curlBinMu.Lock()
	prevBins, prevEmpty := curlBins, curlBinsEmptyAt
	curlBins, curlBinsEmptyAt = nil, 0
	curlBinMu.Unlock()
	defer func() {
		curlBinMu.Lock()
		curlBins, curlBinsEmptyAt = prevBins, prevEmpty
		curlBinMu.Unlock()
	}()
	req, _ := http.NewRequest("GET", "https://example.invalid/a", nil)
	_, _, _, err := tocFetchImpersonate(req, 5000)
	if err != tocErrNoTransport {
		t.Fatalf("无二进制应返回 tocErrNoTransport，got %v", err)
	}
}

func TestTocFetchImpersonateFakeBinary(t *testing.T) {
	// fake curl 脚本注入：校验参数透传（--dump-header/--output/--header/--max-time/-- 与 URL）
	tmpBin := t.TempDir()
	script := `#!/bin/sh
# 记录参数供断言
printf '%s\n' "$@" > "` + filepath.Join(tmpBin, "args.txt") + `"
# 位置参数：--dump-header FILE 与 --output FILE 由参数表解析
prev=""
hdr=""; out=""
for a in "$@"; do
  case "$prev" in
    "--dump-header") hdr="$a" ;;
    "--output") out="$a" ;;
  esac
  prev="$a"
done
printf 'HTTP/2 200\r\nSet-Cookie: k=v; Path=/\r\n\r\n' > "$hdr"
printf '<ul><li><a href="/txt/1.html">第1章</a></li></ul>' > "$out"
printf '200'
`
	binPath := filepath.Join(tmpBin, "curl_fake111")
	if err := os.WriteFile(binPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake curl: %v", err)
	}
	// 名字需命中 reCurlImpersonate：curl_fake111 含 curl_ 前缀 + chrome/ff 等——用 curl_chrome111
	binPath2 := filepath.Join(tmpBin, "curl_chrome111")
	if err := os.WriteFile(binPath2, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake curl2: %v", err)
	}
	_ = binPath
	t.Setenv("PATH", tmpBin)
	t.Setenv("HOME", tmpBin)
	curlBinMu.Lock()
	prevBins, prevEmpty := curlBins, curlBinsEmptyAt
	curlBins, curlBinsEmptyAt = nil, 0
	curlBinMu.Unlock()
	defer func() {
		curlBinMu.Lock()
		curlBins, curlBinsEmptyAt = prevBins, prevEmpty
		curlBinMu.Unlock()
	}()
	req, _ := http.NewRequest("GET", "https://fake.example/ajax_novels/chapterlist/6527.html", nil)
	req.Header.Set("Referer", "https://fake.example/book/6527.html")
	req.Header.Set("User-Agent", "TestUA")
	req.Header.Set("Accept-Encoding", "gzip, deflate")
	body, status, cookies, err := tocFetchImpersonate(req, 8000)
	if err != nil {
		t.Fatalf("fake curl 应成功: %v", err)
	}
	if status != 200 {
		t.Fatalf("status 应 200，got %d", status)
	}
	if !strings.Contains(string(body), "第1章") {
		t.Fatalf("body 应为片段内容，got %q", string(body))
	}
	if len(cookies) != 1 || !strings.HasPrefix(cookies[0], "k=v") {
		t.Fatalf("Set-Cookie 应捕获，got %v", cookies)
	}
	// 参数断言：URL 在 -- 之后、请求头透传、Accept-Encoding 跳过（--compressed 自理）
	argsRaw, _ := os.ReadFile(filepath.Join(tmpBin, "args.txt"))
	args := string(argsRaw)
	if !strings.Contains(args, "https://fake.example/ajax_novels/chapterlist/6527.html") {
		t.Fatalf("URL 应透传给 curl: %s", args)
	}
	if strings.Contains(args, "Accept-Encoding") {
		t.Fatalf("Accept-Encoding 应跳过（--compressed 自理）: %s", args)
	}
	if !strings.Contains(args, "Referer: https://fake.example/book/6527.html") {
		t.Fatalf("Referer 应透传: %s", args)
	}
}
