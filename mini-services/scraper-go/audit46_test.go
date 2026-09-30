/**
 * audit46_test.go —— Task 46-a 逐行深审修复与增强锁定：
 *
 *   - F1（P2·AIMD 只升不降契约原子化）：noteCrawlDelayFloor / noteAdaptiveRateLimited /
 *     noteAdaptiveSuccess 旧实现 Load→条件→Store 三步非原子，同主机多车道并发互相覆盖——
 *     robots Crawl-delay floor 的低值可吞掉另一车道刚采纳的更高 Retry-After 退避位。
 *     锁定：aimdRaiseTo 纯语义（CAS-max）+ 并发 raise 不变量（终值 = 全部 raise 值最大者）。
 *   - F2（P3·解析层正则提级）：binScore 包级正则语义不变（家族/版本评分）；headerLines
 *     逐行 EqualFold 与旧 ^name:\s*(.*)$ 正则逐用例等价（多头/大小写/CR/伪头/空值）。
 *   - F3（P3·指纹）：chapterListApi AJAX 端点补 User-Agent（旧默认 Go-http-client 自曝爬虫）。
 *   - F4（P3·fail-closed 误拒）：jsonTocSameOrigin 大小写折叠（大写域名书页不再拒绝同源接口），
 *     端口/协议仍严格。
 *   - E3（软拦截识别增强）：challengeFeatureSummary captcha-title / captcha-shell 特征、
 *     极小页滑块/频控词硬判层、pageSoftBlockProfile bodyAnomaly 字段。
 */
package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/PuerkitoBio/goquery"
)

// ---- F1：AIMD 只升不降（CAS-max）----

func TestAimdRaiseToCASMax(t *testing.T) {
	host := "aimd-raise.test"
	slot := getHostSlot(host)
	defer func() {
		hostSlotsMu.Lock()
		delete(hostSlots, host)
		hostSlotsMu.Unlock()
	}()
	slot.aimdMs.Store(0)
	if aimdRaiseTo(slot, 5000) != true || slot.aimdMs.Load() != 5000 {
		t.Fatalf("从 0 抬升到 5000 应成功，got %d", slot.aimdMs.Load())
	}
	if aimdRaiseTo(slot, 3000) != false || slot.aimdMs.Load() != 5000 {
		t.Fatalf("更低值不应回退（只升不降），got %d", slot.aimdMs.Load())
	}
	if aimdRaiseTo(slot, 5000) != false {
		t.Fatalf("等值抬升应视为 no-op")
	}
}

// 并发不变量：多个 goroutine 混合并发抬升不同值（含 crawl-delay 低值与 Retry-After 高值），
// 终值必须等于全部 raise 值的最大者。旧 Load→Store 实现下该不变量可被交错打破。
func TestAimdRaiseConcurrentMaxInvariant(t *testing.T) {
	host := "aimd-raise-race.test"
	defer func() {
		hostSlotsMu.Lock()
		delete(hostSlots, host)
		hostSlotsMu.Unlock()
	}()
	slot := getHostSlot(host)
	slot.aimdMs.Store(0)
	values := []int64{5000, 8000, 12000, 20000, 30000}
	var wg sync.WaitGroup
	for round := 0; round < 200; round++ {
		wg.Add(len(values))
		for _, v := range values {
			go func(v int64) {
				defer wg.Done()
				aimdRaiseTo(slot, v)
			}(v)
		}
		wg.Wait()
		if got := slot.aimdMs.Load(); got != 30000 {
			t.Fatalf("round %d：并发抬升终值应恒为最大者 30000，got %d（只升不降被打破）", round, got)
		}
		slot.aimdMs.Store(0) // 每轮重置重跑
	}
}

// 端到端不变量：crawl-delay floor 与 Retry-After 限流位并发写入，Retry-After 高位不得被吞。
func TestCrawlDelayFloorConcurrentWithRateLimit(t *testing.T) {
	host := "crawl-race.test"
	defer func() {
		hostSlotsMu.Lock()
		delete(hostSlots, host)
		hostSlotsMu.Unlock()
	}()
	ra := int64(20_000)
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			noteCrawlDelayFloor(host, 5000)
		}()
		go func() {
			defer wg.Done()
			noteAdaptiveRateLimited(host, &ra)
		}()
	}
	wg.Wait()
	if got := hostAdaptiveIntervalMs(host); got != 20_000 {
		t.Fatalf("Retry-After=20s 高位被并发 crawl-delay floor 覆盖：got %d（只升不降被打破）", got)
	}
}

// ---- F2：binScore / headerLines ----

func TestBinScoreOrdering(t *testing.T) {
	cases := []struct {
		name  string
		score int
	}{
		{"curl_chrome116", 3*10000 + 116},
		{"curl_chrome99", 3*10000 + 99},
		{"curl_ff135", 2*10000 + 135},
		{"curl-impersonate-firefox120", 2*10000 + 120},
		{"curl_edge131", 10000 + 131},
		{"curl_safari17.0", 10000 + 17}, // 版本段取首个 2-4 位数字串（"17"），与旧实现一致
		{"curl-impersonate", 10000},
		{"curl", 10000},
	}
	for _, c := range cases {
		if got := binScore(c.name); got != c.score {
			t.Errorf("binScore(%q) = %d, want %d", c.name, got, c.score)
		}
	}
	// 排序语义：chrome 新版 > chrome 旧版 > firefox > 其余
	if !(binScore("curl_chrome131") > binScore("curl_ff135") && binScore("curl_ff135") > binScore("curl_edge131")) {
		t.Errorf("binScore 家族优先级错乱")
	}
}

func TestHeaderLinesParity(t *testing.T) {
	hdr := "HTTP/2 200\r\n" +
		"content-type: text/html\r\n" +
		"SET-COOKIE: a=1; Path=/\r\n" +
		"set-cookie: b=2; Secure\r\n" +
		"set-cookiex: not-a-cookie\r\n" +
		"location: /next\r\n" +
		"retry-after:  12\r\n" +
		"empty-value:\r\n" +
		"no-colon-line\r\n" +
		":pseudo-header\r\n"
	if got := headerLines(hdr, "Set-Cookie"); len(got) != 2 || got[0] != "a=1; Path=/" || got[1] != "b=2; Secure" {
		t.Errorf("Set-Cookie 多头/大小写提取错误: %#v", got)
	}
	if got := headerLines(hdr, "Location"); len(got) != 1 || got[0] != "/next" {
		t.Errorf("Location 提取错误: %#v", got)
	}
	if got := headerLines(hdr, "Retry-After"); len(got) != 1 || got[0] != "12" {
		t.Errorf("Retry-After 提取错误: %#v", got)
	}
	if got := headerLines(hdr, "set-cookiex"); len(got) != 1 || got[0] != "not-a-cookie" {
		t.Errorf("精确头名匹配（非前缀）失败: %#v", got)
	}
	if got := headerLines(hdr, "Empty-Value"); len(got) != 1 || got[0] != "" {
		t.Errorf("空值头应提取为空串: %#v", got)
	}
	if got := headerLines(hdr, "Pseudo-Header"); len(got) != 0 {
		t.Errorf("空名伪头不应命中: %#v", got)
	}
	if got := headerLines(hdr, "No-Colon-Line"); len(got) != 0 {
		t.Errorf("无冒号行不应命中: %#v", got)
	}
}

// ---- F3：chapterListApi AJAX 端点 UA 指纹 ----

func TestExtractJsonTocSendsBrowserUA(t *testing.T) {
	var gotUA string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUA = r.Header.Get("User-Agent")
		_, _ = w.Write([]byte(`{"data":[{"title":"第一章 开端","ordernum":1},{"title":"第二章","ordernum":2}]}`))
	}))
	defer srv.Close()
	// 测试站为 127.0.0.1：与 audit32d_test 同模式临时放行私有地址，并替换包级 tocHTTPClient
	//（tocTransport 的 dial Control 在 init 时已按 allowPrivate=false 挂死，回环地址会被拦）
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
		t.Fatalf("JSON 目录应解析出 2 条，got %d，warnings=%v", len(refs), warnings)
	}
	if !strings.HasPrefix(gotUA, "Mozilla/5.0") || !strings.Contains(gotUA, "Chrome/") {
		t.Errorf("AJAX 端点应携带浏览器 UA（旧默认 Go-http-client 自曝爬虫指纹），got %q", gotUA)
	}
	if gotUA != chromeUA {
		t.Errorf("AJAX UA 应与引擎保鲜画像同源一致，got %q want %q", gotUA, chromeUA)
	}
}

// ---- F4：chapterListApi 同源判定大小写折叠 ----

func TestJsonTocSameOriginCaseFold(t *testing.T) {
	cases := []struct {
		api, base string
		want      bool
		note      string
	}{
		{"http://example.com/list", "http://example.com/book/1", true, "完全一致"},
		{"http://example.com/list", "http://EXAMPLE.com/book/1", true, "接口小写/书页大写应视为同源"},
		{"http://EXAMPLE.COM/list", "http://example.com/book/1", true, "接口大写/书页小写应视为同源"},
		{"http://example.com:8080/list", "http://example.com/book/1", false, "端口不同仍拒绝"},
		{"https://example.com/list", "http://example.com/book/1", false, "协议不同拒绝"},
		{"http://evil.com/list", "http://example.com/book/1", false, "跨域拒绝"},
	}
	for _, c := range cases {
		au, err1 := urlParse(c.api)
		bu, err2 := urlParse(c.base)
		if err1 != nil || err2 != nil {
			t.Fatalf("URL 解析失败: %s/%s", c.api, c.base)
		}
		if got := jsonTocSameOrigin(au, bu); got != c.want {
			t.Errorf("%s：jsonTocSameOrigin(%s,%s)=%v want %v", c.note, c.api, c.base, got, c.want)
		}
	}
	if jsonTocSameOrigin(nil, nil) {
		t.Errorf("nil 入参应返回 false")
	}
}

// 端到端：大写域名书页 + 小写接口不再被同源校验误拒（fail-closed 误拒回归）
func TestExtractJsonTocUppercaseHostAccepted(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`[{"title":"第一章","ordernum":1}]`))
	}))
	defer srv.Close()
	savedPrivate, savedClient := allowPrivate, tocHTTPClient
	allowPrivate = true
	tocHTTPClient = &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{}}
	defer func() { allowPrivate, tocHTTPClient = savedPrivate, savedClient }()
	// httptest 的 URL host 形如 127.0.0.1:port；把书页 URL 域名段大写化构造大小写变体
	parts := strings.SplitN(strings.TrimPrefix(srv.URL, "http://"), "/", 2)
	hostUpper := strings.ToUpper(parts[0])
	base := "http://" + hostUpper + "/book/1.html"
	doc, _ := goquery.NewDocumentFromReader(strings.NewReader(`<html><input id="bid" value="7"></html>`))
	cfg, _ := parseChapterListApi(`{"url":"/list","method":"GET","bookIdSelector":"#bid@value","titleField":"title","orderField":"ordernum","urlTemplate":"/read/{bookId}/{order}.html"}`)
	warnings := []string{}
	refs := extractJsonToc(doc.Selection, cfg, base, &warnings)
	if len(refs) != 1 {
		t.Fatalf("大写域名书页的同源接口不应被拒，refs=%d warnings=%v", len(refs), warnings)
	}
}

// ---- E3：软拦截识别增强 ----

// 极小页硬判层：滑块/频控词（keyword 层扩展词表，<3KB + 近空守卫内）
func TestChallengeKeywordSliderTinyPage(t *testing.T) {
	tiny := []byte(`<!DOCTYPE html><html><head><title>安全验证</title></head><body><div>请完成滑块验证后继续访问</div><script>var x=1;</script></body></html>`)
	if !looksLikeChallenge(tiny) {
		t.Errorf("滑块验证极小页应判挑战")
	}
	freq := []byte(`<html><head><title>提示</title></head><body><div>访问过于频繁，请稍后再试</div></body></html>`)
	if !looksLikeChallenge(freq) {
		t.Errorf("频控提示极小页应判挑战（软拦截形态）")
	}
	// 守卫确认：含同词的真实内容长页不误杀（>3KB 体积闸）
	big := []byte("<html><body>" + strings.Repeat("<p>这是一段很长的正常小说正文内容，讲述了主角在山村里的成长故事。</p>", 200) + "他曾怀疑自己遇到了网络访问频率限制的问题。</body></html>")
	if looksLikeChallenge(big) {
		t.Errorf("含关键词的真实内容长页不应被极小页关键词层误杀")
	}
}

// 弱命中层：大页面（不触发硬判）携带 captcha/滑块标题与特征 → softBlock 档案可标注
func TestChallengeFeatureSummaryCaptchaFeatures(t *testing.T) {
	// 大体积正常骨架 + <title>安全验证</title>：looksLikeChallenge 不判死（keyword 层仅极小页），
	// 但 challengeFeatureSummary 应给出 captcha-title
	page := []byte("<html><head><title>安全验证</title></head><body><div class='wrap'>" +
		strings.Repeat("<p>导航 导航 导航</p>", 400) + "</div></body></html>")
	if looksLikeChallenge(page) {
		t.Fatalf("大页不应被硬判挑战（否则本用例前置不成立）")
	}
	hits := challengeFeatureSummary(page)
	joined := strings.Join(hits, ",")
	if !strings.Contains(joined, "captcha-title") {
		t.Errorf("验证码标题应产出 captcha-title 特征，hits=%v", hits)
	}

	// 近空正文 + 频控词 → captcha-shell
	shell := []byte(`<html><head><title>提示</title></head><body><div>访问过于频繁，请稍后再试</div><script>var a=1;var b=2;var c=3;</script></body></html>`)
	hits2 := challengeFeatureSummary(shell)
	joined2 := strings.Join(hits2, ",")
	if !strings.Contains(joined2, "captcha-shell") {
		t.Errorf("近空频控正文应产出 captcha-shell 特征，hits=%v", hits2)
	}

	// 正常章节页（含真实内容、无反爬词）→ 不产出 captcha 特征
	normal := []byte("<html><head><title>第十二章 山雨欲来</title></head><body><div>" +
		strings.Repeat("<p>夜色渐深，山风卷着雨点敲打窗棂，屋内烛火摇曳，他的心思却早已飞到了千里之外的京城。</p>", 30) +
		"</div></body></html>")
	hits3 := challengeFeatureSummary(normal)
	if strings.Contains(strings.Join(hits3, ","), "captcha") {
		t.Errorf("正常章节页不应产出 captcha 特征，hits=%v", hits3)
	}
}

// softBlock 档案：大 HTML + 近空可见正文 → bodyAnomaly 预计算字段
func TestPageSoftBlockProfileBodyAnomaly(t *testing.T) {
	bigEmpty := fetchPageResult{
		ok: true, status: 200, strategy: "fetch-browser",
		html: "<html><head><title>加载中</title></head><body><div id='app'>" +
			strings.Repeat("<script>var a='xxxxxxxxxxxxxxxx';</script>", 500) + "</div></body></html>",
	}
	doc, _ := goquery.NewDocumentFromReader(strings.NewReader(bigEmpty.html))
	prof := pageSoftBlockProfile(bigEmpty, doc)
	if prof["bodyAnomaly"] != "large-html-near-empty-body" {
		t.Errorf("大 HTML 近空正文应标注 bodyAnomaly，prof=%v", prof)
	}

	small := fetchPageResult{ok: true, status: 200, strategy: "fetch-browser", html: "<html><body>短页</body></html>"}
	doc2, _ := goquery.NewDocumentFromReader(strings.NewReader(small.html))
	prof2 := pageSoftBlockProfile(small, doc2)
	if _, exists := prof2["bodyAnomaly"]; exists {
		t.Errorf("小页不应标注 bodyAnomaly，prof=%v", prof2)
	}
}

// 并发冒烟：F1 改动后 note* 家族仍与 hosthealth/槽位观测并发共存（-race 兜底面）
func TestAimdNoteMixedConcurrentSmoke(t *testing.T) {
	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			host := fmt.Sprintf("aimd-mixed-%d.test", g%3)
			ra := int64(6000)
			for i := 0; i < 200; i++ {
				switch i % 4 {
				case 0:
					noteAdaptiveRateLimited(host, &ra)
				case 1:
					noteAdaptiveRateLimited(host, nil)
				case 2:
					noteAdaptiveSuccess(host)
				default:
					noteCrawlDelayFloor(host, 5000)
				}
				_ = hostAdaptiveIntervalMs(host)
				_ = snapshotAdaptiveIntervals()
			}
		}(g)
	}
	wg.Wait()
}

// ---- E5（本轮重试追加）：chapterListApi 同源 XHR 头族一致性（反反爬指纹） ----
// 真实浏览器的同源 AJAX 必然携带 Referer（来源=书页）、Origin（POST）、Accept-Language 与
// Sec-Fetch-*（XHR 固定形态）；旧实现裸缺——同一会话「全套画像拿书页、裸头族打接口」的
// 关联矛盾可被 WAF 画像检测识别。锁定：POST 请求五类头齐备且取值与书页同源口径一致。

func TestExtractJsonTocXhrHeaderConsistency(t *testing.T) {
	var gotReferer, gotOrigin, gotAcceptLang, gotFetchDest, gotFetchMode, gotFetchSite, gotMethod string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotReferer = r.Header.Get("Referer")
		gotOrigin = r.Header.Get("Origin")
		gotAcceptLang = r.Header.Get("Accept-Language")
		gotFetchDest = r.Header.Get("Sec-Fetch-Dest")
		gotFetchMode = r.Header.Get("Sec-Fetch-Mode")
		gotFetchSite = r.Header.Get("Sec-Fetch-Site")
		gotMethod = r.Method
		_, _ = w.Write([]byte(`{"data":[{"title":"第一章 开端","ordernum":1}]}`))
	}))
	defer srv.Close()
	savedPrivate, savedClient := allowPrivate, tocHTTPClient
	allowPrivate = true
	tocHTTPClient = &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{}}
	defer func() { allowPrivate, tocHTTPClient = savedPrivate, savedClient }()

	doc, _ := goquery.NewDocumentFromReader(strings.NewReader(`<html><input id="bid" value="42"></html>`))
	cfg, cfgErr := parseChapterListApi(`{"url":"/list","method":"POST","body":"bid={bookId}","bookIdSelector":"#bid@value","titleField":"title","orderField":"ordernum","listPath":"data","urlTemplate":"/read/{bookId}/{order}.html"}`)
	if cfgErr != "" {
		t.Fatalf("配置解析失败: %s", cfgErr)
	}
	warnings := []string{}
	refs := extractJsonToc(doc.Selection, cfg, srv.URL+"/book/1.html", &warnings)
	if len(refs) != 1 {
		t.Fatalf("JSON 目录应解析出 1 条，got %d，warnings=%v", len(refs), warnings)
	}
	if gotMethod != "POST" {
		t.Fatalf("应按配置以 POST 请求，got %s", gotMethod)
	}
	if gotReferer != srv.URL+"/book/1.html" {
		t.Errorf("同源 XHR 应以书页 URL 为 Referer，got %q want %q", gotReferer, srv.URL+"/book/1.html")
	}
	if gotOrigin != srv.URL {
		t.Errorf("POST XHR 应携带与书页同源的 Origin，got %q want %q", gotOrigin, srv.URL)
	}
	if gotAcceptLang == "" {
		t.Errorf("同源 XHR 应携带 Accept-Language（与页面会话同族头族）")
	}
	if gotFetchDest != "empty" || gotFetchMode != "cors" || gotFetchSite != "same-origin" {
		t.Errorf("Sec-Fetch-* 应呈真实浏览器同源 XHR 形态，got dest=%q mode=%q site=%q", gotFetchDest, gotFetchMode, gotFetchSite)
	}
}
