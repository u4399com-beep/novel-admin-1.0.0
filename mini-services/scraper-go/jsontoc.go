/**
 * bookRule.chapterListApi：JSON 目录接口支持（逐行移植自 extract/json-toc.ts）。
 *
 * 背景：部分现代 CMS 书页只有最新 N 章 +「查看完整目录」按钮，完整目录由前端 AJAX 端点
 * （POST 表单 → JSON 数组）提供，页面中不存在全量 HTML 目录（实测 ixdzs8.com POST /novel/clist/）。
 *
 * 规则配置（JSON 字符串透传）：
 * {
 *   "url":  "/novel/clist/",                  // 必填：接口路径（相对书页）或绝对 URL，强制同源
 *   "method": "POST",                         // 可选：GET|POST，默认 POST
 *   "body": "bid={bookId}",                   // 可选：表单体，{bookId} 占位符
 *   "bookIdSelector": "#bid@value",           // 必填：书页内书籍 ID 提取（支持 @attr）
 *   "listPath": "data",                       // 可选：JSON 内数组路径（点分），默认顶层为数组
 *   "titleField": "title",                    // 必填：章节标题字段
 *   "orderField": "ordernum",                 // 可选：章节序号字段（用于 urlTemplate 的 {order}）
 *   "skipField": "ctype", "skipValue": "1",   // 可选：条目该字段==skipValue 时跳过（卷标记行）
 *   "urlTemplate": "/read/{bookId}/p{order}.html" // 必填：章节 URL 模板（{bookId}/{order} 占位）
 * }
 *
 * 安全边界：接口与书页必须同源（协议+主机一致，拒绝规则作者把请求导向内网/第三方）；
 * 仅 GET/POST 表单两种形态；不携带除引擎 cookie 会话外的任何凭据；
 * 响应体积走 MAX_TOC_BYTES 上限，条目数走 MAX_TOC_ENTRIES 上限。
 */
package main

import (
	"encoding/json"
	"math"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/PuerkitoBio/goquery"
)

// goquerySelection 类型别名
type goquerySelection = goquery.Selection

const (
	maxTocEntries = 10_000
	maxTocBytes   = 8 * 1024 * 1024
	tocTimeoutMS  = 15_000
)

type chapterListApiConfig struct {
	url            string
	method         string
	body           string
	bookIdSelector string
	listPath       string
	titleField     string
	orderField     string
	skipField      string
	skipValue      string
	urlTemplate    string
}

// parseChapterListApi 解析并校验配置 JSON；非法/缺关键字段时返回原因
func parseChapterListApi(raw string) (chapterListApiConfig, string) {
	var obj map[string]any
	if err := json.Unmarshal([]byte(raw), &obj); err != nil {
		return chapterListApiConfig{}, "chapterListApi 不是合法 JSON"
	}
	s := func(k string) string {
		if v, ok := obj[k].(string); ok {
			return strings.TrimSpace(v)
		}
		return ""
	}
	urlS := s("url")
	bookIdSelector := s("bookIdSelector")
	titleField := s("titleField")
	urlTemplate := s("urlTemplate")
	if urlS == "" || bookIdSelector == "" || titleField == "" || urlTemplate == "" {
		return chapterListApiConfig{}, "chapterListApi 缺少必填字段（url/bookIdSelector/titleField/urlTemplate）"
	}
	method := strings.ToUpper(s("method"))
	if method != "GET" {
		method = "POST"
	}
	return chapterListApiConfig{
		url: urlS, method: method, body: s("body"),
		bookIdSelector: bookIdSelector, listPath: s("listPath"),
		titleField: titleField, orderField: s("orderField"),
		skipField: s("skipField"), skipValue: s("skipValue"), urlTemplate: urlTemplate,
	}, ""
}

// pickPath 按点分路径取 JSON 值（"data" / "result.list"）
func pickPath(obj any, path string) any {
	if path == "" {
		return obj
	}
	cur := obj
	for _, seg := range strings.Split(path, ".") {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur, ok = m[seg]
		if !ok {
			return nil
		}
	}
	return cur
}

// tocTransport JSON 目录接口专用传输（Task 26-d）：与引擎口径一致直连不读代理环境变量，
// 并挂载 ssrfDialControl 作 DNS rebinding 最后一道闸（同源校验只覆盖 URL 层，
// 恶意书页可让同源 AJAX 端点 302/解析切换到内网——Control 在 connect 前再查一次 IP）。
func tocTransport() *http.Transport {
	dialer := &net.Dialer{
		Timeout:   10 * time.Second,
		KeepAlive: 30 * time.Second,
	}
	if !allowPrivate {
		dialer.Control = ssrfDialControl
	}
	return &http.Transport{
		Proxy:                 nil,
		DialContext:           dialer.DialContext,
		MaxIdleConns:          4,
		IdleConnTimeout:       30 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 10 * time.Second,
	}
}

var tocHTTPClient = &http.Client{
	Timeout: time.Duration(tocTimeoutMS) * time.Millisecond,
	CheckRedirect: func(*http.Request, []*http.Request) error {
		// 禁用自动跟随：同源校验只对首个 URL 做过，默认客户端跟随 302 可被
		// 恶意接口导向内网/第三方（SSRF）。3xx 一律拒绝并提示。
		return http.ErrUseLastResponse
	},
	Transport: tocTransport(),
}

// encodeURIComp 等价 JS encodeURIComponent（保留 A-Za-z0-9-_.!~*'()）
func encodeURIComp(s string) string {
	const unreserved = "-_.!~*'()"
	var b strings.Builder
	for _, r := range s {
		c := string(r)
		switch {
		case r >= 'A' && r <= 'Z', r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteString(c)
		case strings.ContainsRune(unreserved, r):
			b.WriteString(c)
		default:
			for _, by := range []byte(c) {
				const hex = "0123456789ABCDEF"
				b.WriteByte('%')
				b.WriteByte(hex[by>>4])
				b.WriteByte(hex[by&0xf])
			}
		}
	}
	return b.String()
}

// extractJsonToc 提取 JSON 目录：返回章节引用数组（解析失败时为空数组，原因写入 warnings）。
// SSRF 安全：接口 URL 解析后必须与 baseUrl 同协议同主机；请求复用引擎 cookie 会话（同源才回放）。
func extractJsonToc(root *goquerySelection, cfg chapterListApiConfig, baseURL string, warnings *[]string) []BookChapterRef {
	// 1) 书页内提取 bookId
	bookId := pickText(root, []string{cfg.bookIdSelector})
	if bookId == "" {
		*warnings = append(*warnings, "chapterListApi：bookIdSelector 未命中（"+cfg.bookIdSelector+"），跳过 JSON 目录提取")
		return []BookChapterRef{}
	}

	// 2) 接口 URL 同源校验
	apiURL := urlJoin(cfg.url, baseURL)
	if apiURL == nil {
		*warnings = append(*warnings, "chapterListApi：接口 URL 无法解析")
		return []BookChapterRef{}
	}
	base, err := urlParse(baseURL)
	if err != nil || base.Host == "" {
		*warnings = append(*warnings, "chapterListApi：书页 URL 无法解析")
		return []BookChapterRef{}
	}
	if apiURL.Scheme != base.Scheme || apiURL.Host != base.Host {
		*warnings = append(*warnings, "chapterListApi：接口 "+apiURL.Host+" 与书页 "+base.Host+" 非同源，已拒绝（SSRF 防护）")
		return []BookChapterRef{}
	}

	// 3) 请求（复用引擎 cookie 会话：书页抓取时种下的会话 cookie 是部分站点的放行条件）
	// 同域请求同样受限速约束（JSON 目录是页面抓取之外的额外请求，不豁免）
	// Task 38-a: 限速槽 key 归一小写（与链层/策略层 hostOf 同口径，防大小写变体稀释限速）
	acquireDomainSlot(strings.ToLower(apiURL.Host))
	https := apiURL.Scheme == "https"
	// Task 38-a: 桶 key 归一 hostOf（小写，与策略层一致，防大小写变体分裂会话）
	cookie := cookieHeaderFor(hostOf(apiURL.String()), https)
	var req *http.Request
	if cfg.method == "POST" {
		// 用 strings.NewReader 让 NewRequest 自动设置 ContentLength：
		// 手动赋值 req.Body 会丢失长度（发 chunked 编码），部分严格后端（PHP/宝塔系）
		// 对无 Content-Length 的表单 POST 解析不出 $_POST
		form := strings.ReplaceAll(cfg.body, "{bookId}", encodeURIComp(bookId))
		req, err = http.NewRequest(cfg.method, apiURL.String(), strings.NewReader(form))
	} else {
		req, err = http.NewRequest(cfg.method, apiURL.String(), nil)
	}
	if err != nil {
		*warnings = append(*warnings, "chapterListApi：接口请求失败 "+err.Error())
		return []BookChapterRef{}
	}
	req.Header.Set("Accept", "application/json, text/plain, */*")
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	if cfg.method == "POST" {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
	}
	res, err := tocHTTPClient.Do(req)
	if err != nil {
		*warnings = append(*warnings, "chapterListApi：接口请求失败 "+err.Error())
		return []BookChapterRef{}
	}
	defer func() { _ = res.Body.Close() }()
	if isRedirectStatus(res.StatusCode) {
		_ = res.Body.Close()
		*warnings = append(*warnings, "chapterListApi：接口返回重定向 HTTP "+itoa(res.StatusCode)+"，已拒绝跟随（SSRF 防护：同源校验仅覆盖首跳）")
		return []BookChapterRef{}
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		*warnings = append(*warnings, "chapterListApi：接口返回 HTTP "+itoa(res.StatusCode))
		return []BookChapterRef{}
	}
	// 会话 cookie 持续回放：接口下发的 Set-Cookie 也入 jar（与策略层行为一致）
	if lines := res.Header.Values("Set-Cookie"); len(lines) > 0 {
		recordSetCookieLines(hostOf(apiURL.String()), lines, https)
	}
	body, tooLarge := readAllCapped(res.Body, maxTocBytes)
	if tooLarge || len(body) == 0 {
		*warnings = append(*warnings, "chapterListApi：响应体为空或超限")
		return []BookChapterRef{}
	}

	// 4) 解析 JSON → 章节引用
	var jsonVal any
	if err := json.Unmarshal(body, &jsonVal); err != nil {
		*warnings = append(*warnings, "chapterListApi：响应不是合法 JSON")
		return []BookChapterRef{}
	}
	list, ok := pickPath(jsonVal, cfg.listPath).([]any)
	if !ok {
		*warnings = append(*warnings, "chapterListApi：listPath \""+cfg.listPath+"\" 未命中数组")
		return []BookChapterRef{}
	}

	refs := []BookChapterRef{}
	for i, entry := range list {
		if i >= maxTocEntries {
			break
		}
		rec, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		if cfg.skipField != "" && cfg.skipValue != "" {
			if sv := jsonStr(rec[cfg.skipField]); sv == cfg.skipValue {
				continue
			}
		}
		title := strings.TrimSpace(jsonStr(rec[cfg.titleField]))
		if title == "" {
			continue
		}
		order := ""
		if cfg.orderField != "" {
			order = strings.TrimSpace(jsonStr(rec[cfg.orderField]))
		}
		urlRaw := strings.ReplaceAll(cfg.urlTemplate, "{bookId}", encodeURIComp(bookId))
		urlRaw = strings.ReplaceAll(urlRaw, "{order}", encodeURIComp(order))
		u := urlJoin(urlRaw, baseURL)
		if u == nil || (u.Scheme != "http" && u.Scheme != "https") {
			continue
		}
		refs = append(refs, BookChapterRef{Title: truncateStr(title, 200), Url: strPtr(u.String())})
	}
	if len(refs) == 0 {
		*warnings = append(*warnings, "chapterListApi：JSON 目录解析结果为空（检查 titleField/skipField/urlTemplate 配置）")
	}
	return refs
}

// jsonStr JSON 任意值 → 字符串（对齐 TS String(v ?? "")：null/undefined 为空串，数字/布尔转文本）
func jsonStr(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case float64:
		// Task 27-c（25-a 遗留 d 收尾）：float→int 转换加值域守卫。旧实现
		// t == float64(int64(t)) 对超出 int64 的极大值（1e300 等）是 Go 规范的
		// 「实现定义行为」（amd64 得哨兵值 -2^63），幸而比较不相等才未出错，但语义
		// 悬在未定义边缘；显式按 2^53（整数精度边界）内才走整数路径，NaN/±Inf
		// 拒绝输出（占位符 {order} 收到空串时 urlJoin 后由 http/https 校验兜底）
		if t == math.Trunc(t) && math.Abs(t) < 9007199254740992 {
			return itoa(int(t))
		}
		if math.IsInf(t, 0) || math.IsNaN(t) {
			return ""
		}
		return trimTrailingZeros(t)
	case bool:
		if t {
			return "true"
		}
		return "false"
	default:
		b, err := json.Marshal(v)
		if err != nil {
			return ""
		}
		return string(b)
	}
}

func trimTrailingZeros(f float64) string {
	return strconv.FormatFloat(f, 'f', -1, 64)
}
