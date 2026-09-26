/**
 * pseo_suggest.go —— 多搜索引擎下拉词获取（服务端专用）。
 *
 * TS 源：src/lib/suggest.ts（逐行移植）
 *   - sanitizeKeyword / normalizeWords / fetchSuggestions / runWithConcurrency /
 *     fetchSuggestionsMulti / SUPPORTED_ENGINES
 *
 * 合规说明（与 TS 版一致）：仅抓取搜索引擎公开的 suggest 接口，用于关键词研究，
 * 遵守低频调用原则（每引擎独立超时 + 失败隔离 + 限并发 3）。
 *
 * 移植语义差异：
 * 1. JS \s 全集与 Go \s 不同 → 统一用 api_novels.go 的 jsSpacePlusRe/jsTrim
 * 2. encodeURIComponent 与 Go url.QueryEscape 编码集不同 → 自实现 jsEncodeURIComp
 *    （未保留字符 A-Za-z0-9-_.!~*'() 与 WHATWG 一致）
 * 3. JS e.message 错误文案 → Go err.Error()（截断 200 字；超时错误文本与 V8 不同，
 *    仅出现在 results[].error 字段，不影响契约结构）
 * 4. 引擎响应解析失败（非法 JSON）在 TS 为 throw→catch→error 字段；Go 等价处理
 * 5. duckduckgo 直连在 Go TLS 栈下会被 Cloudflare JA3 指纹识别并掐死连接导致超时
 *    （worklog Task 18 已知差异①）→ 其下拉词请求改经 scraper-go 引擎
 *    （127.0.0.1:3030，见 suggestFetchViaEngineStrategy）反指纹策略链代理发出；经引擎的
 *    新路径失败时在 results[].error 如实报告（TS 版 duckduckgo 从未真正成功过，
 *    无历史语义可破坏）；其余引擎（baidu/bing/sogou/so360）保持 Go 直连不动
 */
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	suggestUA       = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
	suggestMaxWords = 20 // 单引擎规范化后保留词数
	suggestWordMax  = 60 // 关键词限长（MAX_WORD_LEN）
)

// supportedEngines 引擎白名单（顺序即默认聚合顺序）
var supportedEngines = []string{"baidu", "bing", "duckduckgo", "sogou", "so360"}

var supportedEngineSet = func() map[string]bool {
	m := map[string]bool{}
	for _, e := range supportedEngines {
		m[e] = true
	}
	return m
}()

// sanitizeKeyword 关键词清洗：去控制字符/尖括号/引号等危险字符，折叠空白，限长。
// 供 pseo 相关接口共用（TS sanitizeKeyword 逐行移植；非字符串输入返回空串）。
func sanitizeKeyword(raw any, maxLen ...int) string {
	s, ok := raw.(string)
	if !ok {
		return ""
	}
	ml := suggestWordMax
	if len(maxLen) > 0 && maxLen[0] > 0 {
		ml = maxLen[0]
	}
	s = kwStripRe.ReplaceAllString(s, " ")
	s = jsSpacePlusRe.ReplaceAllString(s, " ")
	s = jsTrim(s)
	return truncateRunes(s, ml)
}

// kwStripRe /[\u0000-\u001f\u007f<>{}[\]$%|\\\/"'`^*#&~;=]/g
var kwStripRe = regexp.MustCompile("[\\x{0000}-\\x{001f}\\x{007f}<>{}\\[\\]$%|\\\\/\"'`^*#&~;=]")

// normalizeWords 引擎原始词规范化：清洗 + 去重 + 截断 20
func normalizeWords(words []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(words))
	for _, w := range words {
		t := sanitizeKeyword(w)
		if t == "" || seen[t] {
			continue
		}
		seen[t] = true
		out = append(out, t)
	}
	if len(out) > suggestMaxWords {
		out = out[:suggestMaxWords]
	}
	return out
}

// jsEncodeURIComp encodeURIComponent 精确等价（未保留字符不转义）
func jsEncodeURIComp(s string) string {
	const unreserved = "-_.!~*'()"
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'A' && r <= 'Z', r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case strings.ContainsRune(unreserved, r):
			b.WriteRune(r)
		default:
			// 与 JS 一致按 UTF-8 字节百分号编码
			for i := 0; i < len(string(r)); i++ {
				b.WriteString("%")
				const hex = "0123456789ABCDEF"
				c := string(r)[i]
				b.WriteByte(hex[c>>4])
				b.WriteByte(hex[c&0x0f])
			}
		}
	}
	return b.String()
}

// suggestResult 单引擎结果（Error 空 = 无错误，序列化时省略该键）
type suggestResult struct {
	Engine string
	OK     bool
	Words  []string
	Error  string
}

// kwEntry 跨引擎去重后的关键词（字段名与 TS {word, engine} 一致）
type kwEntry struct {
	Word   string `json:"word"`
	Engine string `json:"engine"`
}

// suggestionsAggregate 多引擎聚合结果
type suggestionsAggregate struct {
	Results []suggestResult
	Words   []kwEntry
}

var suggestHTTPClient = &http.Client{}

// suggestEngineClient suggest 专用引擎客户端（不复用 engineclient.go 的 engineHTTPClient：
// 那是 60s 超时，对齐引擎 55s 策略链整体预算；suggest 预算是秒级——单发/生成均 8s，
// 硬闸由 ctx 控制，client 不设全局 Timeout 以免双重预算打架）。
var suggestEngineClient = &http.Client{}

// fetchSuggestions 单引擎下拉词（独立超时；失败隔离：仅 error 字段，绝不 panic/抛出）。
// HTTP 非 2xx 时 TS 不抛错（words 留空、无 error 字段）→ Go 同语义。
func fetchSuggestions(engine, keyword string, timeoutMs int) suggestResult {
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()

	words := []string{}
	var fetchErr error
	q := jsEncodeURIComp(keyword)

	switch engine {
	case "baidu":
		words, fetchErr = suggestFetchJSON(ctx, "https://www.baidu.com/sugrec?prod=pc&wd="+q, suggestParseBaidu)
	case "bing":
		words, fetchErr = suggestFetchJSON(ctx, "https://api.bing.com/osjson.aspx?query="+q, func(body []byte) []string {
			var j [2]json.RawMessage
			if json.Unmarshal(body, &j) != nil {
				return nil
			}
			var arr []string
			if len(j) > 1 {
				_ = json.Unmarshal(j[1], &arr)
			}
			return filterNonEmpty(arr)
		})
	case "duckduckgo":
		// 经 scraper-go 引擎代理（Go TLS 被 Cloudflare JA3 指纹掐死 → 直连超时），
		// 见 suggestFetchViaEngineStrategy；响应仍为 ["查询词",[...]]，解析逻辑不变
		words, fetchErr = suggestFetchDuckDuckGo(ctx, "https://duckduckgo.com/ac/?q="+q+"&type=list")
	case "sogou":
		// 容错解析 JSON/JSONP 混合返回
		words, fetchErr = suggestFetchText(ctx, "https://www.sogou.com/sugproxy?p=1&ie=utf8&from=pc&wd="+q, suggestBracketParse)
	case "so360":
		words, fetchErr = suggestFetchText(ctx, "https://sug.so.360.cn/suggest?word="+q+"&ie=utf-8", suggestParseSO360)
	default:
		return suggestResult{Engine: engine, OK: false, Words: []string{}, Error: "不支持的引擎: " + engine}
	}

	if fetchErr != nil {
		return suggestResult{Engine: engine, OK: false, Words: []string{}, Error: truncateRunes(fetchErr.Error(), 200)}
	}
	clean := normalizeWords(words)
	return suggestResult{Engine: engine, OK: len(clean) > 0, Words: clean}
}

// suggestParseBaidu 百度 sugrec 解析：词条字段历史上有 k（旧版）/ q（现行）两种形态，
// 两者兼容（2026-09 实测响应为 g[].q；k 形态保留兼容旧接口变体——19-a 曾误诊为
// TLS 指纹问题，实为解析字段过时致 0 词）。
func suggestParseBaidu(body []byte) []string {
	var j struct {
		G []struct {
			K *string `json:"k"`
			Q *string `json:"q"`
		} `json:"g"`
	}
	if json.Unmarshal(body, &j) != nil {
		return nil
	}
	out := make([]string, 0, len(j.G))
	for _, x := range j.G {
		v := ""
		if x.K != nil {
			v = *x.K
		}
		if v == "" && x.Q != nil {
			v = *x.Q
		}
		if v != "" {
			out = append(out, v)
		}
	}
	return out
}

// suggestParseSO360 360 下拉词解析：现行响应为 {"result":[{"word":...}]}（2026-09 实测），
// 旧版为 {"data":["..."]}，两者兼容；非 JSON/杂形态回落索引首个 [...] 内字符串数组。
func suggestParseSO360(text string) []string {
	var j struct {
		Data   []string `json:"data"`
		Result []struct {
			Word *string `json:"word"`
		} `json:"result"`
	}
	if json.Unmarshal([]byte(text), &j) == nil {
		out := make([]string, 0, len(j.Data)+len(j.Result))
		out = append(out, filterNonEmpty(j.Data)...)
		for _, x := range j.Result {
			if x.Word != nil && *x.Word != "" {
				out = append(out, *x.Word)
			}
		}
		if len(out) > 0 {
			return out
		}
	}
	return suggestBracketParse(text)
}

func filterNonEmpty(in []string) []string {
	out := make([]string, 0, len(in))
	for _, s := range in {
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

// suggestBracketParse 索引出首个 [...] 片段内的 JSON 数组（仅保留字符串元素）
var suggestArrMatchRe = regexp.MustCompile(`\[([\s\S]*)\]`)

func suggestBracketParse(text string) []string {
	m := suggestArrMatchRe.FindStringSubmatch(text)
	if m == nil {
		return nil
	}
	var arr []any
	if json.Unmarshal([]byte(m[1]), &arr) != nil {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, x := range arr {
		if s, ok := x.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func suggestNewRequest(ctx context.Context, url string) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", suggestUA)
	return req, nil
}

func suggestFetchJSON(ctx context.Context, url string, parse func([]byte) []string) ([]string, error) {
	req, err := suggestNewRequest(ctx, url)
	if err != nil {
		return nil, err
	}
	res, err := suggestHTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		// TS res.ok 为 false：不解析、不报错，词留空
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 1<<20))
		return []string{}, nil
	}
	body, err := readAllLimited(res.Body, 4<<20)
	if err != nil {
		return nil, err
	}
	return parse(body), nil
}

func suggestFetchText(ctx context.Context, url string, parse func(string) []string) ([]string, error) {
	req, err := suggestNewRequest(ctx, url)
	if err != nil {
		return nil, err
	}
	res, err := suggestHTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 1<<20))
		return []string{}, nil
	}
	body, err := readAllLimited(res.Body, 4<<20)
	if err != nil {
		return nil, err
	}
	return parse(string(body)), nil
}

// suggestFetchViaEngineStrategy 经 scraper-go 引擎（127.0.0.1:3030 /api/test）代理抓取 targetURL，
// 返回上游原始响应体字节。strategy 非空时作为首选策略传给引擎（链语义：该策略不可用
// → 引擎自动回退全链；可用但请求失败 → 调用方自行无策略重试一次（见 suggestFetchDuckDuckGo）。
//
// 背景（worklog Task 18 已知差异①）：duckduckgo.com 在 Cloudflare 后面，会指纹识别
// Go 标准库 net/http 的 TLS 栈（JA3）并掐死连接导致超时；引擎策略链具备完整反指纹
// 能力（curl-impersonate TLS 伪造 / got-scraping 等价 / browser 兜底），实测可正常
// 取得 duckduckgo 响应。仅 duckduckgo 走此路径，其余引擎直连不受影响。
//
// 引擎契约：POST {"url","includeHtml":true,"timeoutMs"} →
//
//	成功 200 {"ok":true,"html":"<上游原始响应体>","htmlTruncated":bool,...}
//	失败 502 {"ok":false,"error","detail","attempts":[...]}
//
// timeoutMs 按 ctx 剩余预算估算（略小于剩余，给引擎响应回传留余量；引擎侧钳制
// 2s~60s）；请求挂 ctx——外层 suggest 超时预算（单发/生成均 8s）继续作为最终硬闸。
// strategy 空串 = 引擎默认策略链（历史 suggestFetchViaEngine 薄包装已并入本函数）。
func suggestFetchViaEngineStrategy(ctx context.Context, targetURL, strategy string) ([]byte, error) {
	timeoutMs := 3000
	if deadline, ok := ctx.Deadline(); ok {
		if remain := int(time.Until(deadline).Milliseconds()) - 300; remain > 0 {
			timeoutMs = remain
		}
	}
	payload := map[string]any{
		"url":         targetURL,
		"includeHtml": true,
		"timeoutMs":   timeoutMs,
	}
	if strategy != "" {
		payload["strategy"] = strategy
	}
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("采集引擎请求体序列化失败: %s", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, engineBaseURL()+"/api/test", bytes.NewReader(payloadBytes))
	if err != nil {
		return nil, fmt.Errorf("采集引擎请求构造失败: %s", err)
	}
	req.Header.Set("Content-Type", "application/json")
	t0 := time.Now()
	res, err := suggestEngineClient.Do(req)
	log.Printf("[pseo-suggest] 引擎调用 strategy=%q elapsed=%dms err=%v target=%s",
		strategy, time.Since(t0).Milliseconds(), err, truncateRunes(targetURL, 80))
	if err != nil {
		if engineIsTimeout(err) {
			return nil, errors.New("采集引擎请求超时(3030)")
		}
		return nil, fmt.Errorf("采集引擎不可达(3030)（%s）", truncateRunes(err.Error(), 120))
	}
	defer res.Body.Close()
	body, err := readAllLimited(res.Body, 4<<20)
	if err != nil {
		return nil, err
	}
	var env struct {
		OK            *bool   `json:"ok"`
		Error         *string `json:"error"`
		Detail        *string `json:"detail"`
		HTML          *string `json:"html"`
		HTMLTruncated bool    `json:"htmlTruncated"`
		Attempts      []any   `json:"attempts"`
	}
	if json.Unmarshal(body, &env) != nil {
		return nil, fmt.Errorf("引擎响应解析失败(HTTP %d)", res.StatusCode)
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 || env.OK == nil || !*env.OK {
		msg := fmt.Sprintf("HTTP %d", res.StatusCode)
		if env.Error != nil && *env.Error != "" {
			msg = *env.Error
		}
		if env.Detail != nil && *env.Detail != "" {
			msg += "（" + truncateRunes(*env.Detail, 120) + "）"
		}
		return nil, fmt.Errorf("引擎抓取失败: %s（attempts=%d）", msg, len(env.Attempts))
	}
	if env.HTML == nil {
		return nil, fmt.Errorf("引擎响应缺少 html 字段(HTTP %d)", res.StatusCode)
	}
	if env.HTMLTruncated {
		return nil, errors.New("响应被引擎截断(htmlTruncated)")
	}
	return []byte(*env.HTML), nil
}

// suggestFetchDuckDuckGo duckduckgo 下拉词（经引擎代理，见 suggestFetchViaEngineStrategy）。
// ac 接口返回 ["查询词",["词1","词2",...]]，取第二元素字符串数组。
// 两段式策略（实测偶发 curl-impersonate 慢响应会吃光整体预算，必须子死线隔离）：
//  1. 首选 curl-impersonate（Chrome TLS 伪造，实测 /ac/ 206ms；子死线 3.5s 封顶，
//     覆盖引擎 1.5~1.9s 开销+一次 1.2~1.5s 域名限速等待）——该策略不可用时引擎自动回退全链；
//  2. 首选失败/超时且剩余预算充足时，无策略重试一次（全链+亲和，Playwright 兜底 1.5~3s）。
//
// 与直连引擎「HTTP 非 2xx 静默留空」不同：经引擎的新路径失败时如实报错
// （fetchSuggestions 会把 fetchErr 写入 results[].error；TS 版 duckduckgo 从未
// 真正成功过，无历史语义可破坏，以诚实报错优先）。
func suggestFetchDuckDuckGo(ctx context.Context, url string) ([]string, error) {
	body, err := func() ([]byte, error) {
		// 子死线：首选策略最多 3.5s（且给全链兜底留 ≥1.5s），防慢响应吃光整体预算
		sub := ctx
		if remain := suggestCtxRemainMs(ctx); remain >= 4200 {
			capMs := 3500
			if remain-1500 < capMs {
				capMs = remain - 1500
			}
			var cancel context.CancelFunc
			sub, cancel = context.WithTimeout(ctx, time.Duration(capMs)*time.Millisecond)
			defer cancel()
		}
		return suggestFetchViaEngineStrategy(sub, url, "curl-impersonate")
	}()
	if err != nil {
		if suggestCtxRemainMs(ctx) >= 1200 {
			if body2, err2 := suggestFetchViaEngineStrategy(ctx, url, ""); err2 == nil {
				body, err = body2, nil
			}
		}
	}
	if err != nil {
		return nil, err
	}
	var j [2]json.RawMessage
	if json.Unmarshal(body, &j) != nil {
		return nil, errors.New("duckduckgo 响应解析失败（非 [\"查询词\",[...]] 形态）")
	}
	if len(j[1]) == 0 {
		return nil, errors.New("duckduckgo 响应缺少下拉词数组")
	}
	var arr []string
	if json.Unmarshal(j[1], &arr) != nil {
		return nil, errors.New("duckduckgo 下拉词数组解析失败")
	}
	return filterNonEmpty(arr), nil
}

// suggestCtxRemainMs 剩余预算毫秒数（无 deadline 返回极大值）
func suggestCtxRemainMs(ctx context.Context) int {
	deadline, ok := ctx.Deadline()
	if !ok {
		return 1 << 30
	}
	return int(time.Until(deadline).Milliseconds())
}

// runSuggestWithConcurrency 限并发执行器：按索引取件、结果保持输入顺序（TS runWithConcurrency 移植）。
// 任务自身失败隔离（fetchSuggestions 不返回 error），无需 allSettled 语义。
func runSuggestWithConcurrency(tasks []func() suggestResult, concurrency int) []suggestResult {
	results := make([]suggestResult, len(tasks))
	if len(tasks) == 0 {
		return results
	}
	lanes := concurrency
	if lanes > len(tasks) {
		lanes = len(tasks)
	}
	if lanes < 1 {
		lanes = 1
	}
	var mu sync.Mutex
	cursor := 0
	var wg sync.WaitGroup
	for lane := 0; lane < lanes; lane++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				mu.Lock()
				i := cursor
				cursor++
				mu.Unlock()
				if i >= len(tasks) {
					return
				}
				results[i] = tasks[i]()
			}
		}()
	}
	wg.Wait()
	return results
}

// fetchSuggestionsMulti 多引擎聚合：限并发 3 + 跨引擎去重（按引擎优先序）。
// 单引擎超时/解析失败只影响自身 result，绝不抛出。
func fetchSuggestionsMulti(keyword string, engines []string, timeoutMs int) suggestionsAggregate {
	if timeoutMs <= 0 {
		timeoutMs = 4000
	}
	validEngines := make([]string, 0, len(engines))
	for _, e := range engines {
		if supportedEngineSet[e] {
			validEngines = append(validEngines, e)
		}
	}
	tasks := make([]func() suggestResult, 0, len(validEngines))
	for _, e := range validEngines {
		engine := e
		tasks = append(tasks, func() suggestResult {
			return fetchSuggestions(engine, keyword, timeoutMs)
		})
	}
	settled := runSuggestWithConcurrency(tasks, 3)

	results := make([]suggestResult, 0, len(validEngines))
	for i, r := range settled {
		if r.Engine == "" && !r.OK && len(r.Words) == 0 && r.Error == "" {
			results = append(results, suggestResult{Engine: validEngines[i], OK: false, Words: []string{}, Error: "未返回结果"})
			continue
		}
		results = append(results, r)
	}
	seen := map[string]bool{}
	words := make([]kwEntry, 0)
	for _, r := range results {
		for _, w := range r.Words {
			if seen[w] {
				continue
			}
			seen[w] = true
			words = append(words, kwEntry{Word: w, Engine: r.Engine})
		}
	}
	return suggestionsAggregate{Results: results, Words: words}
}
