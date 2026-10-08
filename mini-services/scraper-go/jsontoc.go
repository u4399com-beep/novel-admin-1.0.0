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
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"sort"
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

// tocTransport JSON 目录接口专用传输（Task 26-d）：10s 段口径的 ssrfDirectTransport 薄封装
// （61-R14 起实现体收敛到 httpguard.go），同源校验只覆盖 URL 层，恶意书页可让同源
// AJAX 端点 302/解析切换到内网——Dialer Control 在 connect 前再查一次 IP。
func tocTransport() *http.Transport {
	return ssrfDirectTransport(10 * time.Second)
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

// jsonTocSameOrigin chapterListApi 同源判定（Task 46-a F4 抽出）：协议一致 + Host 大小写折叠
// 后一致（Host 含端口，端口不折叠——不同端口仍拒绝）。纯函数，锁定测试见 audit46_test.go。
func jsonTocSameOrigin(apiURL, base *url.URL) bool {
	if apiURL == nil || base == nil {
		return false
	}
	return apiURL.Scheme == base.Scheme && strings.EqualFold(apiURL.Host, base.Host)
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
	return extractJsonTocBudgeted(root, cfg, baseURL, warnings, 0)
}

// tocSlot 预算常量（R86 目录截断修复）：
//   - tocSlotDefaultMS：旧固定档（unknown 剩余预算时沿用）
//   - tocSlotMaxMS：上界 20s——BOOK_CONCURRENCY=4 时书页+JSON 目录请求在域槽 FIFO 上
//     的排队深度实测可达 8-10s+，旧 5s 档在舰队负载下必 shed → 书目录被截断为书页内嵌
//     的「最新几章」（ixdzs8 实测 86 本书全被截成 8 章）；
//   - tocSlotSafetyMS：响应序列化/传输边距。
const (
	tocSlotDefaultMS = 5_000
	tocSlotMaxMS     = 20_000
	tocSlotSafetyMS  = 3_000
)

// tocSlotBudget 由剩余消费预算计算取槽等待上界：
//   - remainingMs<=0（未知/旧调用路径）：旧 5s 固定档，行为不变；
//   - 剩余充裕：clamp(remaining-safety, …, 20s)，排队预算自适应放大，
//     舰队满载时 JSON 目录不再被无谓 shed；
//   - 剩余不足 5s+边距：返回 0（shed）——旧实现此时仍会等 5s 再发真实请求，
//     叠加接口耗时可能突破消费方 60s 超时导致整本书页失败（比丢 JSON 目录更糟）。
func tocSlotBudget(remainingMs int64) int64 {
	if remainingMs <= 0 {
		return tocSlotDefaultMS
	}
	b := remainingMs - tocSlotSafetyMS
	if b < tocSlotDefaultMS {
		return 0
	}
	if b > tocSlotMaxMS {
		b = tocSlotMaxMS
	}
	return b
}

// extractJsonTocBudgeted 带剩余预算版 extractJsonToc（remainingMs<=0 = 未知，旧 5s 档）。
// R86：队列等待预算由固定 5s 改为剩余预算自适应（上界 20s）——固定小预算在多书并发
// 采集时几乎必 shed（目录被静默截断为书页内嵌几章），自适应预算在保证不突破消费
// 超时的前提下把排队容忍度放到 20s，实测大幅降低 shed 率。
func extractJsonTocBudgeted(root *goquerySelection, cfg chapterListApiConfig, baseURL string, warnings *[]string, remainingMs int64) []BookChapterRef {
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
	// Task 46-a（F4）：同源判定归一为小写比较（旧实现 apiURL.Host != base.Host 区分大小写，
	// 书页 URL 带大写域名变体 http://Example.COM/x 时同源接口被 fail-closed 误拒）。
	// 归一只折叠大小写；协议/主机/端口仍逐项一致，SSRF 姿态不变（纯函数抽出便于锁定测试）。
	if !jsonTocSameOrigin(apiURL, base) {
		*warnings = append(*warnings, "chapterListApi：接口 "+apiURL.Host+" 与书页 "+base.Host+" 非同源，已拒绝（SSRF 防护）")
		return []BookChapterRef{}
	}

	// 3) 请求（复用引擎 cookie 会话：书页抓取时种下的会话 cookie 是部分站点的放行条件）
	// 同域请求同样受限速约束（JSON 目录是页面抓取之外的额外请求，不豁免）
	// Task 38-a: 限速槽 key 归一小写（与链层/策略层 hostOf 同口径，防大小写变体稀释限速）
	// Task 46-a（F9）：取槽改预算感知——本函数运行在策略链预算之外（链已返回成功页后才
	// 开始提取），旧无界排队在 AIMD 高退避位/多车道饱和时可在 handler 内额外睡 8-30s+，
	// 叠在 55s 链预算之上突破主站 60s 消费超时；shed 时结构化警告并放弃 JSON 目录
	//（HTML 目录照常返回，仅影响「接口优于内嵌」的增益路径）。
	// R86：固定 5s 档改剩余预算自适应（tocSlotBudget：unknown→5s、充裕→≤20s、
	// 不足→立即 shed）——多书并发采集时 5s 排队预算实测必 shed，目录被静默截断。
	slotBudget := tocSlotBudget(remainingMs)
	if slotBudget == 0 {
		*warnings = append(*warnings, "chapterListApi：消费剩余预算不足，已跳过 JSON 目录提取（防御性 shed，不影响书页内嵌目录）")
		return []BookChapterRef{}
	}
	slotDeadline := nowMs() + slotBudget
	if _, granted := acquireDomainSlotBudgeted(strings.ToLower(apiURL.Host), slotDeadline, 0); !granted {
		*warnings = append(*warnings, "chapterListApi：域限速排队超预算，已跳过 JSON 目录提取（引擎准入拒绝，不影响书页内嵌目录）")
		return []BookChapterRef{}
	}
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
	// Task 50-a（E8·反反爬指纹一致性）：AJAX 请求显式声明 Accept-Encoding——旧实现不发
	// 该键时 Go 传输层自动补「Accept-Encoding: gzip」（单 gzip = 稳定 Go 客户端指纹），
	// 与 46-a F3 已补的 chromeUA 矛盾；只声明引擎能解的 gzip/deflate，解包在响应侧
	// contentDecodedReader 承接。
	req.Header.Set("Accept-Encoding", "gzip, deflate")
	// Task 46-a（F3·反反爬指纹）：AJAX 端点此前不发 User-Agent —— Go 客户端默认落
	// "Go-http-client/1.1"，同一会话先以浏览器画像拿书页、紧接的目录接口却自曝爬虫 UA，
	// 既是指纹矛盾也是 UA 白名单类 WAF 的直接拒绝信号（会话 cookie 白种了）。补引擎
	// 保鲜桌面 Chrome UA，与被回放的 cookie 会话同族。
	req.Header.Set("User-Agent", chromeUA)
	// Task 46-a（E5·反反爬指纹一致性）：真实浏览器的同源 XHR 在书页会话内必然携带
	// Referer（来源=书页）、Origin（POST 必带）与 Accept-Language、Sec-Fetch-*（XHR 形态
	// 固定值 dest=empty/mode=cors/site=same-origin）。旧实现裸缺这些头——同一会话先以
	// 全套浏览器画像拿书页、紧接的目录接口却是「无来路、无语言偏好」的头族，服务端
	// 画像关联检测（WAF 比对页面视图与 AJAX 请求的头族一致性）可直接识别。全部按真实
	// 浏览器同源 XHR 形态补齐（同源校验已保证 site=same-origin 陈述为真；Origin 仅 POST
	// 携带——Chrome 对同源 GET XHR 不发 Origin）。
	req.Header.Set("Accept-Language", acceptLangZH)
	req.Header.Set("Referer", baseURL)
	req.Header.Set("Sec-Fetch-Dest", "empty")
	req.Header.Set("Sec-Fetch-Mode", "cors")
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	if cfg.method == "POST" {
		req.Header.Set("Origin", base.Scheme+"://"+base.Host)
	}
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
	// Task 50-a（E8）：显式声明 Accept-Encoding 后 tocHTTPClient 不再透明解压，
	// 响应体统一经 contentDecodedReader 解包（与 readBodyCapped 同一实现）
	src, decodeClose, derr := contentDecodedReader(res)
	if derr != nil {
		// Task 52-a（P3·分类对齐）：声明压缩但 0 字节体（gzip.NewReader 对空流返回 io.EOF）
		// 按空体处理，与 readBodyCapped 的 E8 语义同口径——旧实现虚报「解包失败 EOF」，
		// 排障时把「空响应」误读为「解包器故障」。
		if derr == io.EOF {
			*warnings = append(*warnings, "chapterListApi：响应体为空或超限")
			return []BookChapterRef{}
		}
		*warnings = append(*warnings, "chapterListApi：响应体解包失败 "+derr.Error())
		return []BookChapterRef{}
	}
	body, tooLarge := readAllCapped(src, maxTocBytes)
	decodeClose() // identity 路径与 defer res.Body.Close 双关幂等，解压路径先关解压器
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
			// Task 49-a（F4·P3 跨平台截断）：旧实现 itoa(int(t))——32 位平台 int 为
			// 32 位，2^53 内大整数（order 字段常见雪花 ID 量级）静默截断回绕，
			// {order} 占位符拼出错误章节 URL。改按 int64 格式化，64 位语义不变。
			return strconv.FormatInt(int64(t), 10)
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

// trimTrailingZeros 格式化浮点（JSON 数字 → URL 片段，去科学计数法尾巴）
func trimTrailingZeros(f float64) string {
	return strconv.FormatFloat(f, 'f', -1, 64)
}

// ---------------------------------------------------------------------------
// chapterListHtmlApiTemplate（R103）：HTML 片段目录接口模板展开
// ---------------------------------------------------------------------------

// reNumSeg URL path 中的连续数字段（bookId 提取用）
var reNumSeg = regexp.MustCompile(`\d+`)

// bookIdFromURL 从书页 URL 提取书籍 id：path 最后一段连续数字
// （/book/184.html → "184"；/novel/123/ → "123"；无数字返回空串）。
// 只看 path 不看 query——query 里的数字（分页/追踪参数）不可靠。
func bookIdFromURL(rawURL string) string {
	u, err := urlParse(rawURL)
	if err != nil || u == nil {
		return ""
	}
	// 用未转义的 u.Path 而非 EscapedPath：%20 等转义序列里的数字会被误当 bookId
	// （"not a url" → "http://not%20a%20url" → EscapedPath 含 "20"）
	nums := reNumSeg.FindAllString(u.Path, -1)
	if len(nums) == 0 {
		return ""
	}
	return nums[len(nums)-1]
}

// expandTocHtmlApi 展开 HTML 片段目录接口模板：{bookId} 替换 + 绝对化 +
// 同源校验（复用 jsonTocSameOrigin，与 JSON 目录接口同款 SSRF 防护）+ 去锚。
// 任一步失败返回 ok=false（调用方落结构化警告，不影响书页内嵌目录）。
func expandTocHtmlApi(tpl, baseURL string) (string, bool) {
	id := bookIdFromURL(baseURL)
	if id == "" {
		return "", false
	}
	expanded := strings.ReplaceAll(tpl, "{bookId}", id)
	u := toAbs(expanded, baseURL)
	if u == "" {
		return "", false
	}
	au, err := urlParse(u)
	if err != nil || au == nil {
		return "", false
	}
	bu, err := urlParse(baseURL)
	if err != nil || bu == nil {
		return "", false
	}
	if !jsonTocSameOrigin(au, bu) {
		return "", false
	}
	if idx := strings.Index(u, "#"); idx >= 0 {
		u = u[:idx]
	}
	return u, true
}

// ---------------------------------------------------------------------------
// sortChapterRefsByNo（R103）：页面乱序源站的抓取时排序
// ---------------------------------------------------------------------------

// reArabicChapterNo 标题「第N章/节/回/话」阿拉伯编号（含全角数字；允许少量装饰前缀）
var reArabicChapterNo = regexp.MustCompile(`^[\[【(（「『]{0,2}第\s*([0-9０-９]{1,7})\s*[章节回话]`)

// foldFullwidthDigits 全角数字 ０-９ → 0-9（chapterListApi 与阿拉伯编号解析共用语义）
func foldFullwidthDigits(s string) string {
	if !strings.ContainsFunc(s, func(r rune) bool { return r >= '０' && r <= '９' }) {
		return s
	}
	var b strings.Builder
	for _, r := range s {
		if r >= '０' && r <= '９' {
			b.WriteRune(r - '０' + '0')
		} else {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// parseArabicChapterNo 引擎侧编号解析：仅「第N章」阿拉伯形态（中文数字形态不在抓取
// 层处理——排序守卫按解析率判定，低解析率自动跳过，后端 resort 有完整中文数字支持）
func parseArabicChapterNo(title string) (int64, bool) {
	m := reArabicChapterNo.FindStringSubmatch(strings.TrimSpace(title))
	if m == nil {
		return 0, false
	}
	v, err := strconv.ParseInt(foldFullwidthDigits(m[1]), 10, 64)
	if err != nil || v < 0 || v > 99_999_999 {
		return 0, false
	}
	return v, true
}

// sortChapterRefsByNo 按标题阿拉伯编号稳定排序（解析率 ≥80% 且无重复编号才启用；
// 未编号行锚定前一编号行之后 +0.5）。不满足守卫时原样返回。详见 extract.go 调用点注释。
func sortChapterRefsByNo(refs []BookChapterRef) []BookChapterRef {
	n := len(refs)
	if n < 8 {
		return refs
	}
	nums := make([]int64, n)
	okFlags := make([]bool, n)
	okc := 0
	seen := map[int64]bool{}
	for i := range refs {
		if v, ok := parseArabicChapterNo(refs[i].Title); ok {
			nums[i] = v
			okFlags[i] = true
			okc++
			if seen[v] {
				return refs // 重复编号：分卷各自编号/站源卷章撞名，交后端分卷重排
			}
			seen[v] = true
		}
	}
	if okc*5 < n*4 { // 编号解析率 < 80%：倒序/中文数字/无编号形态，不动
		return refs
	}
	type pair struct {
		r BookChapterRef
		k float64
	}
	ps := make([]pair, n)
	var last int64
	for i := range refs {
		k := float64(last) + 0.5
		if okFlags[i] {
			last = nums[i]
			k = float64(nums[i])
		}
		ps[i] = pair{refs[i], k}
	}
	// 同键保持原序（稳定）：正常升序站零实害
	sort.SliceStable(ps, func(a, b int) bool { return ps[a].k < ps[b].k })
	out := make([]BookChapterRef, n)
	for i, p := range ps {
		out[i] = p.r
	}
	return out
}
