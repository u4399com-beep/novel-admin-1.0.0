/**
 * backend-go —— scraper-go（127.0.0.1:3030）HTTP 客户端封装。
 *
 * TS 源：src/lib/scrape/engine-client.ts（逐行移植）
 * 只依赖引擎的 HTTP 契约（/api/test、/api/chapter 的请求/响应结构），不依赖其内部实现：
 * - 响应 { ok, data, warnings, strategy, attempts[] } 或 { error, detail }（含 502 结构化失败）
 * - ok=false 或 HTTP 非 2xx → 失败；成功但缺 data 对象 → 失败（防 2xx 空 JSON 透传）
 * - 60s 超时（≥ 引擎策略链 55s 预算，与 /api/scrape 代理 60s 对齐）
 *
 * 移植差异：
 * - TS EngineResult 可辨识联合 → Go 泛型 struct{ OK bool; ... }（错误经 Error 字段）
 * - AbortSignal.timeout 超时 → http.Client.Timeout；超时错误识别为「引擎请求超时(60s)」，
 *   其余网络错误为「采集引擎不可达(3030)」（与 TS timedOut 分支文案一致）
 * - fetchChapterPaged 同章分页拼接（MAX_CHAPTER_PAGES=4）与 isSameChapterPagination
 *   的路径前缀续写判断逐行移植——这是长章节缺半 bug 的修复点：
 *   仅接受 base_2.html / base/2.html 形态（前缀后首字符必须是 _ / / 之一，? # 分支保留但
 *   实际不可达——JS pathname 亦不含 ?/#，忠实保留原样）；前缀允许省略 .html 后缀的差异
 *   （xinjianpan vl7.html → vl7_2.html、ggd66 y.html → y_2.html）
 */
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// SCRAPER_BASE 引擎地址（Task 26-d 起可经环境变量覆盖，修复旧版三处硬编码：
// 测试实例/多引擎部署下必然打到生产 3030，且测试 runner 的互监护会误杀生产引擎）。
//   - BACKEND_ENGINE_URL：完整 base（如 http://127.0.0.1:3131），优先级最高
//   - BACKEND_ENGINE_PORT：仅端口（如 3131）
//   - 缺省 http://127.0.0.1:3030（生产默认，与历史行为一致）
func engineBaseURL() string {
	if u := strings.TrimSpace(os.Getenv("BACKEND_ENGINE_URL")); u != "" {
		if p, err := url.Parse(u); err == nil && (p.Scheme == "http" || p.Scheme == "https") && p.Host != "" {
			return strings.TrimRight(u, "/")
		}
	}
	if p := strings.TrimSpace(os.Getenv("BACKEND_ENGINE_PORT")); p != "" {
		if n, err := strconv.Atoi(p); err == nil && n > 0 && n < 65536 {
			return fmt.Sprintf("http://127.0.0.1:%d", n)
		}
	}
	return "http://127.0.0.1:3030"
}

// isDefaultEngineURL 引擎地址是否为生产默认（runner 互监护仅对默认地址执行
// pkill+拉起——自定义引擎进程的拉起方式未知，杀掉后无法正确重拉）
func isDefaultEngineURL() bool { return engineBaseURL() == "http://127.0.0.1:3030" }

// ENGINE_TIMEOUT_MS 引擎策略链整体预算 55s，超时须 ≥ 预算否则慢站点会被提前切断
const ENGINE_TIMEOUT_MS = 60_000

// MAX_CHAPTER_PAGES 同章分页拼接上限（同一章最多翻 4 次内页，即 5 个分页）
const MAX_CHAPTER_PAGES = 4

var engineHTTPClient = &http.Client{Timeout: ENGINE_TIMEOUT_MS * time.Millisecond}

// engineResult 引擎调用结果（TS EngineResult<T> 联合类型 → struct + OK 标志）
type engineResult[T any] struct {
	OK       bool
	Data     T
	Error    string
	Warnings []string
	Strategy string
	Attempts *int // 引擎响应缺 attempts 时为 nil
}

// engineIsTimeout 判定是否客户端超时（对齐 TS /timeout|abort/i || name==='TimeoutError'）
func engineIsTimeout(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}

// rawJSONString JSON 字段 → 字符串（字符串原样；其他类型转文本；缺失/空 → ""）
func rawJSONString(r json.RawMessage) string {
	if len(r) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(r, &s); err == nil {
		return s
	}
	return string(r)
}

// callEngine 调用引擎；网络异常/超时/非 2xx 一律返回结构化失败，绝不 panic。
// 成功时带回响应顶层 strategy（命中策略名）与 attempts（策略链尝试次数）供可观测性记录。
// return 路径可达性（对齐 TS 12-g2 核对）：①响应非合法 JSON → 失败；②!HTTP 2xx 或引擎
// ok:false → 失败；③成功但缺 data 对象 → 失败；④正常成功。
func callEngine[T any](path string, body map[string]any) engineResult[T] {
	jb, err := json.Marshal(body)
	if err != nil {
		return engineResult[T]{OK: false, Error: "引擎请求体序列化失败", Warnings: []string{}}
	}
	req, err := http.NewRequest("POST", engineBaseURL()+path, bytes.NewReader(jb))
	if err != nil {
		return engineResult[T]{OK: false, Error: "采集引擎不可达(3030)", Warnings: []string{}}
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := engineHTTPClient.Do(req)
	if err != nil {
		if engineIsTimeout(err) {
			return engineResult[T]{OK: false, Error: fmt.Sprintf("引擎请求超时(%ds)", ENGINE_TIMEOUT_MS/1000), Warnings: []string{}}
		}
		return engineResult[T]{OK: false, Error: "采集引擎不可达(3030)", Warnings: []string{}}
	}
	defer res.Body.Close()
	rb, _ := readAllLimited(res.Body, 8<<20)

	var env struct {
		OK       *bool           `json:"ok"`
		Error    json.RawMessage `json:"error"`
		Detail   json.RawMessage `json:"detail"`
		Warnings []any           `json:"warnings"`
		Strategy json.RawMessage `json:"strategy"`
		Attempts []any           `json:"attempts"`
		Data     json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(rb, &env); err != nil {
		return engineResult[T]{OK: false, Error: fmt.Sprintf("引擎响应解析失败(HTTP %d)", res.StatusCode), Warnings: []string{}}
	}
	warnings := []string{}
	for _, w := range env.Warnings {
		warnings = append(warnings, fmt.Sprintf("%v", w))
	}

	if res.StatusCode < 200 || res.StatusCode >= 300 || (env.OK != nil && !*env.OK) {
		base := rawJSONString(env.Error)
		if base == "" {
			base = fmt.Sprintf("HTTP %d", res.StatusCode)
		}
		detail := rawJSONString(env.Detail)
		if detail != "" {
			detail = truncateRunes(detail, 200)
		}
		if detail != "" {
			base = base + "（" + detail + "）"
		}
		return engineResult[T]{OK: false, Error: base, Warnings: warnings}
	}

	// 成功响应必须携带 data 对象（引擎 handlers 成功路径恒有）
	trimmed := strings.TrimSpace(string(env.Data))
	if trimmed == "" || trimmed == "null" || trimmed[0] != '{' {
		return engineResult[T]{OK: false, Error: fmt.Sprintf("引擎响应缺少 data 字段(HTTP %d)", res.StatusCode), Warnings: warnings}
	}
	var data T
	if err := json.Unmarshal(env.Data, &data); err != nil {
		return engineResult[T]{OK: false, Error: fmt.Sprintf("引擎响应 data 解析失败(HTTP %d)", res.StatusCode), Warnings: warnings}
	}
	out := engineResult[T]{OK: true, Data: data, Warnings: warnings, Strategy: rawJSONString(env.Strategy)}
	if env.Attempts != nil {
		n := len(env.Attempts)
		out.Attempts = &n
	}
	return out
}

// engineRuleBody 组装引擎请求体（charset/proxy/insecureTLS/referer 可选字段按存在性展开）
func engineRuleBody(u string, ruleVal any, rule LoadedRule, referer string) map[string]any {
	body := map[string]any{"url": u, "rule": ruleVal}
	if rule.Charset != "" {
		body["charset"] = rule.Charset
	}
	if rule.Proxy != "" {
		body["proxy"] = rule.Proxy
	}
	if rule.InsecureTLS {
		body["insecureTLS"] = true
	}
	if referer != "" {
		body["referer"] = referer
	}
	return body
}

// bookPageResult fetchBookPage 结果
type bookPageResult struct {
	OK   bool
	Book BookData
	Err  string
}

// fetchBookPage 抓取并提取一个书页（每次调用成功命中后记一行策略日志；quiet 抑制日志）。
// referer 可选（""=不传）：列表页场景把站点首页/上一页作为来路传入。
func fetchBookPage(run *Run, u string, rule LoadedRule, referer string, quiet bool) bookPageResult {
	res := callEngine[struct {
		Book *BookData `json:"book"`
	}]("/api/test", engineRuleBody(u, map[string]any{"bookRule": rule.BookRule}, rule, referer))
	if !res.OK {
		return bookPageResult{OK: false, Err: res.Error}
	}
	if len(res.Warnings) > 0 && !quiet {
		run.LogWarnings(res.Warnings)
	}
	if res.Strategy != "" && !quiet {
		n := "?"
		if res.Attempts != nil {
			n = itoa(*res.Attempts)
		}
		run.Log(fmt.Sprintf("书页命中策略 %s（尝试 %s 次）", res.Strategy, n))
	}
	if res.Data.Book == nil || res.Data.Book.Title == "" {
		return bookPageResult{OK: false, Err: "未提取到书籍标题（规则与内置回退均未命中）"}
	}
	return bookPageResult{OK: true, Book: *res.Data.Book}
}

// fetchListPage 抓取并提取一个列表页；失败时记录日志并返回空数组（翻页场景失败可跳过）
func fetchListPage(run *Run, u string, rule LoadedRule, referer string) []ListItem {
	res := callEngine[struct {
		List *struct {
			Items []ListItem `json:"items"`
		} `json:"list"`
	}]("/api/test", engineRuleBody(u, map[string]any{"listRule": rule.ListRule}, rule, referer))
	if !res.OK {
		run.Log(fmt.Sprintf("列表页抓取失败(%s): %s", truncateRunes(u, 100), res.Error))
		return nil
	}
	if len(res.Warnings) > 0 {
		run.LogWarnings(res.Warnings)
	}
	items := []ListItem{}
	if res.Data.List != nil {
		for _, it := range res.Data.List.Items {
			if it.URL != "" { // TS filter(!!it.url)
				items = append(items, it)
			}
		}
	}
	return items
}

// fetchCatalogChapters 抓取完整目录页并提取章节链接（配合 bookRule.catalogLinkSelector）。
// 目录页只需 chapterLinkSelector/excludeSelector；失败记录日志返回空数组（调用方回退书页章节链接）。
func fetchCatalogChapters(run *Run, u string, rule LoadedRule, referer string, quiet bool) []ChapterRef {
	bookRule := RuleMap{}
	for _, key := range []string{"chapterLinkSelector", "excludeSelector"} {
		if v := rule.BookRule[key]; v != "" {
			bookRule[key] = v
		}
	}
	res := callEngine[struct {
		Book *BookData `json:"book"`
	}]("/api/test", engineRuleBody(u, map[string]any{"bookRule": bookRule}, rule, referer))
	if !res.OK {
		if !quiet {
			run.Log(fmt.Sprintf("目录页抓取失败(%s): %s", truncateRunes(u, 100), res.Error))
		}
		return nil
	}
	if len(res.Warnings) > 0 && !quiet {
		run.LogWarnings(res.Warnings)
	}
	if res.Data.Book == nil {
		return nil
	}
	return res.Data.Book.Chapters
}

// fetchChapter 抓取并提取一个章节（warnings 由调用方按存储成败决定是否记录）
func fetchChapter(u string, rule LoadedRule, referer string) engineResult[ChapterData] {
	return callEngine[ChapterData]("/api/chapter", engineRuleBody(u, rule.ChapterRule, rule, referer))
}

var (
	// htmlSuffixRE \.[sx]?html?$（.html/.htm/.shtml/.xhtml 等，忽略大小写）
	htmlSuffixRE = regexp.MustCompile(`(?i)\.[sx]?html?$`)
	// pageParamRE (?:^|[&?])page=\d+（?page=2 形态的 page 参数递增语义）
	pageParamRE = regexp.MustCompile(`(?:^|[&?])page=\d+`)
)

// isSameChapterPagination 判断 nextUrl 是否是「当前章节的下一分页」而非下一章：
// 仅接受路径前缀续写形态（base_2.html / base/2.html / base?page=2），前缀后第一个字符
// 必须是 _ / / ? # 之一，防止 /book/1/ 误匹配 /book/12/ 这类数字续写。
// 逐行移植自 engine-client.ts（Task 3 第二轮：huangjinwu/ggd66 长章节缺半修复点）。
func isSameChapterPagination(base, next string) bool {
	// JS new URL() 对非法/相对 URL 抛异常 → catch 返回 false；Go 以 IsAbs 等价判定
	b, err := url.Parse(base)
	if err != nil || !b.IsAbs() {
		return false
	}
	n, err := url.Parse(next)
	if err != nil || !n.IsAbs() {
		return false
	}
	// 同章分页必在同主机同路径空间（跨域/换路径视为另一页）
	if b.Host != n.Host {
		return false
	}
	np := n.EscapedPath()
	// 前缀匹配（允许 base 省略 .html 后缀的差异；前缀后第一个字符必须是 _ / ? #，
	// 防 /book/1/ 误匹配 /book/12/）
	prefixes := []string{strings.TrimRight(b.EscapedPath(), "/")}
	if htmlSuffixRE.MatchString(prefixes[0]) {
		prefixes = append(prefixes, htmlSuffixRE.ReplaceAllString(prefixes[0], ""))
	}
	for _, bp := range prefixes {
		if !strings.HasPrefix(np, bp) || len(np) == len(bp) {
			continue
		}
		sep := np[len(bp)]
		if sep != '_' && sep != '/' && sep != '?' && sep != '#' {
			continue
		}
		if sep == '?' {
			// ?page=2 形态：要求 page 参数递增语义存在（JS 检测 n.search；Go 用 RawQuery 等价）
			return pageParamRE.MatchString(n.RawQuery)
		}
		return true
	}
	return false
}

// fetchChapterPaged 抓取整章（含同章分页拼接）：首版 fetchChapter 后，若引擎返回的
// nextUrl 是当前章节的下一分页，继续抓取并把正文按段落合并，直至无分页/达上限。
// 任何一页失败都保留已抓到的部分（partial 内容优于整体失败）。
func fetchChapterPaged(u string, rule LoadedRule, referer string) engineResult[ChapterData] {
	first := fetchChapter(u, rule, referer)
	if !first.OK {
		return first
	}
	data := first.Data
	warnings := append([]string(nil), first.Warnings...)
	strategy := first.Strategy
	attempts := first.Attempts
	visited := map[string]bool{u: true}
	next := data.NextURL
	for page := 2; next != "" && page <= MAX_CHAPTER_PAGES+1; page++ {
		if !isSameChapterPagination(u, next) {
			break
		}
		if visited[next] { // 引擎 nextUrl 环路防御
			break
		}
		visited[next] = true
		sub := fetchChapter(next, rule, referer)
		if !sub.OK || strings.TrimSpace(sub.Data.Content) == "" {
			break
		}
		// 合并正文：分页边界按段落直接续接（各页正文已由引擎清洗过）
		data.Content = data.Content + "\n" + sub.Data.Content
		data.Paragraphs = append(append([]string(nil), data.Paragraphs...), sub.Data.Paragraphs...)
		data.WordCount += sub.Data.WordCount
		data.NextURL = sub.Data.NextURL
		warnings = append(warnings, sub.Warnings...)
		strategy = sub.Strategy
		attempts = sub.Attempts
		next = sub.Data.NextURL
	}
	// warnings 去重保序（[...new Set(warnings)] 语义）
	seen := map[string]bool{}
	uniq := make([]string, 0, len(warnings))
	for _, w := range warnings {
		if !seen[w] {
			seen[w] = true
			uniq = append(uniq, w)
		}
	}
	return engineResult[ChapterData]{OK: true, Data: data, Warnings: uniq, Strategy: strategy, Attempts: attempts}
}
