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
 */
package main

import (
	"context"
	"encoding/json"
	"io"
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
		words, fetchErr = suggestFetchJSON(ctx, "https://www.baidu.com/sugrec?prod=pc&wd="+q, func(body []byte) []string {
			var j struct {
				G []struct {
					K *string `json:"k"`
				} `json:"g"`
			}
			if json.Unmarshal(body, &j) != nil {
				return nil
			}
			out := make([]string, 0, len(j.G))
			for _, x := range j.G {
				if x.K != nil && *x.K != "" {
					out = append(out, *x.K)
				}
			}
			return out
		})
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
		words, fetchErr = suggestFetchJSON(ctx, "https://duckduckgo.com/ac/?q="+q+"&type=list", func(body []byte) []string {
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
	case "sogou":
		// 容错解析 JSON/JSONP 混合返回
		words, fetchErr = suggestFetchText(ctx, "https://www.sogou.com/sugproxy?p=1&ie=utf8&from=pc&wd="+q, suggestBracketParse)
	case "so360":
		words, fetchErr = suggestFetchText(ctx, "https://sug.so.360.cn/suggest?word="+q+"&ie=utf-8", func(text string) []string {
			var j struct {
				Data []string `json:"data"`
			}
			if err := json.Unmarshal([]byte(text), &j); err == nil {
				return filterNonEmpty(j.Data)
			}
			return suggestBracketParse(text)
		})
	default:
		return suggestResult{Engine: engine, OK: false, Words: []string{}, Error: "不支持的引擎: " + engine}
	}

	if fetchErr != nil {
		return suggestResult{Engine: engine, OK: false, Words: []string{}, Error: truncateRunes(fetchErr.Error(), 200)}
	}
	clean := normalizeWords(words)
	return suggestResult{Engine: engine, OK: len(clean) > 0, Words: clean}
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
