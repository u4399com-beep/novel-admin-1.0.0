/**
 * HTTP 基础设施（逐行移植自 strategies/http.ts）：流式限量读体 / 统一响应评估（含挑战页标记）/
 * 逐跳 SSRF 守卫 fetch / JS token 重定向挑战解析。
 *
 * ⚠ fetchWithRedirectGuard 是安全代码：手动逐跳重定向（CheckRedirect: ErrUseLastResponse），
 *   每一跳的协议白名单、SSRF 拒绝逻辑一行语义都不能变。
 *   Go 传输层原生支持 manual 重定向（无 TS 运行时 opaqueredirect 降级路径，行为更严格）。
 * - 每一跳按目标 host 回放引擎 cookie 会话，并把响应的 Set-Cookie 写回 jar
 *   （含 3xx 中间跳——「首访种 cookie、二访放行」的种子正是种在这些跳上）。
 * - 跨域重定向跳同样逐跳限速。
 * - 站点级出口代理：http/https/socks5(h) 支持；socks4 不支持（Go 传输层限制，见 types.go 差异说明）。
 */
package main

import (
	"crypto/tls"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const maxBytes = 8 * 1024 * 1024
const maxRedirectHops = 5

// ==================== JS token 重定向挑战解析 ====================

// JS_REDIRECT_ASSIGN_RE：location.href / location.replace( / location = 赋值表达式
var reJSRedirectAssign = regexp.MustCompile(`(?i)(?:window\.)?location(?:\.href|\.replace\s*\(|\s*=)\s*=?\s*([^;\n]{5,300})[;\n]?`)

// var/const/let 字面量赋值表
var reJSVarAssign = regexp.MustCompile(`(?:var|const|let)\s+([\w$]+)\s*=\s*["']([^"']*)["']`)

// resolveJsRedirect 从近空 HTML 中解析 JS 重定向目标：支持字面量、简单变量（let/const/var 赋值）、
// encodeURIComponent() 包装与 + 拼接（含 location.pathname/origin/search/hash 自引用）。
// 解析失败/目标与当前 URL 相同/非 http(s) 时返回 ""。
func resolveJsRedirect(html, currentURL string) string {
	if html == "" || runeLen(html) > 100_000 {
		return "" // 仅小挑战页；大页面不做正则扫描
	}
	assigns := map[string]string{}
	for _, m := range reJSVarAssign.FindAllStringSubmatch(html, -1) {
		assigns[m[1]] = m[2]
	}
	for _, m := range reJSRedirectAssign.FindAllStringSubmatch(html, -1) {
		expr := strings.TrimSpace(m[1])
		if expr == "" {
			continue
		}
		resolved := evalConcat(expr, assigns, currentURL)
		if resolved == "" || resolved == currentURL {
			continue
		}
		u := urlJoin(resolved, currentURL)
		if u == nil {
			continue
		}
		if u.Scheme == "http" || u.Scheme == "https" {
			return u.String()
		}
	}
	return ""
}

var (
	reEncodeURICI = regexp.MustCompile(`(?i)^encodeURIComponent\s*\(\s*([\w$.]+)?\s*\)$`)
	reStringLit   = regexp.MustCompile(`^["']([^"']*)["']$`)
	reLocProp     = regexp.MustCompile(`(?i)^location\.(pathname|search|hash|origin|host|href)$`)
)

// evalConcat 常量折叠拼接表达式：字符串字面量 + 已知变量 + encodeURIComponent(x) + location.*
func evalConcat(expr string, assigns map[string]string, currentURL string) string {
	parts := splitTopLevelPlus(expr)
	out := strings.Builder{}
	for _, raw := range parts {
		p := strings.TrimSpace(raw)
		if p == "" {
			continue
		}
		if enc := reEncodeURICI.FindStringSubmatch(p); enc != nil && enc[1] != "" {
			p = enc[1]
		}
		if lit := reStringLit.FindStringSubmatch(p); lit != nil {
			out.WriteString(lit[1])
			continue
		}
		if loc := reLocProp.FindStringSubmatch(p); loc != nil {
			u, err := url.Parse(currentURL)
			if err != nil {
				return ""
			}
			switch strings.ToLower(loc[1]) {
			case "pathname":
				out.WriteString(u.Path)
			case "search":
				if u.RawQuery != "" {
					out.WriteString("?" + u.RawQuery)
				}
			case "hash":
				if u.Fragment != "" {
					out.WriteString("#" + u.Fragment)
				}
			case "origin":
				out.WriteString(u.Scheme + "://" + u.Host)
			case "host":
				out.WriteString(u.Host)
			default:
				out.WriteString(u.String())
			}
			continue
		}
		if v, ok := assigns[p]; ok {
			out.WriteString(v)
			continue
		}
		return "" // 未知标识符（函数调用/计算表达式）：放弃（不硬编码任何站点专用逻辑）
	}
	if out.Len() == 0 {
		return ""
	}
	return out.String()
}

// splitTopLevelPlus 按顶层 + 拆分（字符串字面量内的 + 不拆）
func splitTopLevelPlus(expr string) []string {
	out := []string{}
	var cur strings.Builder
	quote := byte(0)
	for i := 0; i < len(expr); i++ {
		ch := expr[i]
		if quote != 0 {
			cur.WriteByte(ch)
			if ch == quote {
				quote = 0
			}
			continue
		}
		if ch == '"' || ch == '\'' {
			quote = ch
			cur.WriteByte(ch)
			continue
		}
		if ch == '+' {
			out = append(out, cur.String())
			cur.Reset()
			continue
		}
		cur.WriteByte(ch)
	}
	out = append(out, cur.String())
	return out
}

// ==================== 统一响应评估 ====================

type assessResult struct {
	ok      bool
	blocked bool
	size    int
	note    string
	warning string
}

// assess 统一的响应评估：ok 判定 + 挑战页标记 + 结构化 note，各执行器共用保证一致
func assess(status int, b []byte, contentType string) assessResult {
	size := len(b)
	if looksLikeChallenge(b) {
		return assessResult{
			ok: false, blocked: true, size: size, note: "challenge-page",
			warning: "疑似挑战/拦截页（命中反爬平台特征/小页挑战关键词/0秒跳板之一，响应 " + strconv.Itoa(size) + "B），已按失败处理",
		}
	}
	if status >= 400 {
		return assessResult{ok: false, blocked: false, size: size, note: "http-" + strconv.Itoa(status)}
	}
	if status == 0 {
		return assessResult{ok: false, blocked: false, size: size, note: "network-error"}
	}
	if size == 0 {
		return assessResult{ok: false, blocked: false, size: size, note: "empty-body"}
	}
	return assessResult{ok: true, blocked: false, size: size}
}

// ==================== 流式限量读体 ====================

type bodyResult struct {
	bytes       []byte
	contentType string
	note        string
	warning     string
	size        int // 实际读取字节数（too-large 时为已读总量，供 attempts 明细展示）
}

// readBodyCapped 流式限量读取响应体：超过 maxBytes 立即中止并按 too-large 失败。
// Content-Length 超限的响应在读取前就放弃；无 Content-Length 的流式响应靠实际字节计数兜底。
func readBodyCapped(res *http.Response) bodyResult {
	contentType := res.Header.Get("Content-Type")
	declaredLen, _ := strconv.Atoi(res.Header.Get("Content-Length"))
	if declaredLen > maxBytes {
		_ = res.Body.Close() // 主动释放连接
		return bodyResult{contentType: contentType, note: "too-large", size: declaredLen,
			warning: "响应过大（Content-Length " + strconv.Itoa(declaredLen) + "B > 上限 " + strconv.Itoa(maxBytes) + "B），已放弃"}
	}
	chunks := make([]byte, 0, 64*1024)
	total := 0
	chunk := make([]byte, 64*1024)
	tooLarge := false
	for {
		n, err := res.Body.Read(chunk)
		if n > 0 {
			total += n
			if total > maxBytes {
				tooLarge = true
				break
			}
			chunks = append(chunks, chunk[:n]...)
		}
		if err != nil {
			if err != io.EOF {
				_ = res.Body.Close()
				return bodyResult{contentType: contentType, note: "network-error", warning: "响应体读取中断: " + err.Error()}
			}
			break
		}
	}
	_ = res.Body.Close()
	if tooLarge {
		return bodyResult{contentType: contentType, note: "too-large", size: total,
			warning: "响应实际大小超过上限 " + strconv.Itoa(maxBytes) + "B，已中途放弃并断开连接"}
	}
	return bodyResult{bytes: chunks, contentType: contentType, size: total}
}

// ==================== 传输层（按 代理|insecureTLS|h2 组合缓存 Transport） ====================

type transportKey struct {
	proxy    string
	insecure bool
	noH2     bool
}

var (
	transportMu   sync.Mutex
	transportPool = map[transportKey]*http.Transport{}
)

func transportFor(proxy string, insecure, noH2 bool) (*http.Transport, string) {
	key := transportKey{proxy: proxy, insecure: insecure, noH2: noH2}
	transportMu.Lock()
	defer transportMu.Unlock()
	if tr, ok := transportPool[key]; ok {
		return tr, ""
	}
	tr := &http.Transport{
		// TS 版 fetch 不读代理环境变量：未配置代理时严格直连
		Proxy:                 nil,
		MaxIdleConns:          64,
		MaxIdleConnsPerHost:   8,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   15 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		ForceAttemptHTTP2:     !noH2,
		DisableCompression:    false,
	}
	if tr.ForceAttemptHTTP2 == false && noH2 {
		// 显式禁用 HTTP/2（got-scraping http1.1 降级画像）
		tr.TLSNextProto = map[string]func(string, *tls.Conn) http.RoundTripper{}
	}
	if insecure {
		if tr.TLSClientConfig == nil {
			tr.TLSClientConfig = &tls.Config{}
		}
		// 自签/裸 IP 站点（规则 insecureTLS=true）：跳过证书校验，仅传输层生效
		tr.TLSClientConfig.InsecureSkipVerify = true
	}
	warn := ""
	if proxy != "" {
		pu, err := url.Parse(proxy)
		if err == nil && pu.Host != "" {
			switch pu.Scheme {
			case "http", "https":
				tr.Proxy = http.ProxyURL(pu)
			case "socks5", "socks5h":
				// Go 传输层原生支持 socks5；socks5h（远端 DNS）按 socks5 处理
				pu2 := *pu
				pu2.Scheme = "socks5"
				tr.Proxy = http.ProxyURL(&pu2)
			case "socks4":
				// Go 传输层不支持 socks4：本策略降级直连并提示（链内后续策略仍按配置尝试）
				warn = "socks4 代理在 Go 引擎不支持，本策略降级直连"
			}
		}
	}
	transportPool[key] = tr
	return tr, warn
}

// manualClient 手动重定向客户端：3xx 原样返回给调用方逐跳处理
func manualClient(tr *http.Transport, timeout time.Duration) *http.Client {
	return &http.Client{
		Transport:     tr,
		Timeout:       timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// ==================== RawResponse（与 TS 同构） ====================

type rawResponse struct {
	ok          bool
	status      int
	bytes       []byte
	contentType string
	finalURL    string
	note        string
	warning     string
	retryAfter  *int64
}

// fetchWithRedirectGuard 带逐跳 SSRF 校验的 fetch：手动跟随重定向，每一跳都做
// 文本层 + DNS 尽力校验；重定向跳按目标 host 回放/捕获 cookie 会话，跨域跳逐跳限速。
func fetchWithRedirectGuard(target string, headers map[string]string, timeoutMs int64, warnings *[]string, proxy string, insecureTLS bool) rawResponse {
	deadline := nowMs() + timeoutMs
	current := target
	hops := 0
	if proxy != "" {
		// 站点级出口代理：仅首次请求时提示一次（凭证掩码不回显）
		masked := reProxyCred.ReplaceAllString(proxy, "//***@")
		*warnings = append(*warnings, "[proxy] 经配置代理出口访问（"+masked+"）")
	}

	for {
		remaining := deadline - nowMs()
		if remaining < 500 {
			return rawResponse{ok: false, status: 0, note: "timeout"}
		}

		target2, err := url.Parse(current)
		if err != nil || target2.Host == "" {
			return rawResponse{ok: false, status: 0, note: "bad-url"}
		}
		if target2.Scheme != "http" && target2.Scheme != "https" {
			return rawResponse{ok: false, status: 0, note: "bad-scheme",
				warning: "重定向到非 http/https 协议已拒绝: " + target2.Scheme}
		}
		check := assertHostPublic(target2.Hostname())
		if !check.ok {
			return rawResponse{ok: false, status: 0, note: "ssrf-blocked", warning: "SSRF 防护: " + check.reason}
		}
		if check.warning != "" {
			*warnings = append(*warnings, "[ssrf] "+check.warning)
		}

		// 跨域重定向跳也必须受限速约束（首跳由策略层已排队，跳过避免同一 host 双重等待）
		if current != target {
			acquireDomainSlot(hostOf(current))
		}

		// Cookie 会话回放：合并该 host 的 cookie（覆盖式设置，调用方不自带 cookie 头）
		https := target2.Scheme == "https"
		hopHeaders := headers
		if hopCookie := cookieHeaderFor(target2.Host, https); hopCookie != "" {
			hopHeaders = map[string]string{}
			for k, v := range headers {
				hopHeaders[k] = v
			}
			hopHeaders["cookie"] = hopCookie
		}

		tr, trWarn := transportFor(proxy, insecureTLS, false)
		if trWarn != "" {
			*warnings = append(*warnings, trWarn)
		}
		req, err := http.NewRequest("GET", current, nil)
		if err != nil {
			return rawResponse{ok: false, status: 0, note: "bad-url", warning: "网络错误: " + err.Error()}
		}
		for k, v := range hopHeaders {
			req.Header.Set(k, v)
		}
		res, err := manualClient(tr, time.Duration(remaining)*time.Millisecond).Do(req)
		if err != nil {
			note := "network-error"
			if strings.Contains(strings.ToLower(err.Error()), "timeout") || strings.Contains(strings.ToLower(err.Error()), "deadline") {
				note = "timeout"
			}
			return rawResponse{ok: false, status: 0, note: note, warning: "网络错误: " + err.Error()}
		}
		recordResponseCookies(target2.Host, res, https)

		if isRedirectStatus(res.StatusCode) {
			loc := res.Header.Get("Location")
			_ = res.Body.Close()
			if loc == "" {
				return rawResponse{ok: false, status: res.StatusCode, note: "redirect-no-location"}
			}
			next := urlJoin(loc, current)
			if next == nil {
				return rawResponse{ok: false, status: res.StatusCode, note: "redirect-bad-location",
					warning: "非法 Location 头: " + truncateStr(loc, 200)}
			}
			hops++
			if hops > maxRedirectHops {
				return rawResponse{ok: false, status: res.StatusCode, note: "too-many-redirects",
					warning: "重定向超过 " + strconv.Itoa(maxRedirectHops) + " 跳，已停止"}
			}
			current = next.String()
			continue
		}

		// Retry-After 尊重：429/503 时解析站点给出的退避指引
		var retryAfter *int64
		if res.StatusCode == 429 || res.StatusCode == 503 {
			retryAfter = parseRetryAfterMs(res.Header.Get("Retry-After"))
		}
		body := readBodyCapped(res)

		// JS token 重定向挑战：200 + 近空 JS 页（window.location.href 拼接跳转）——
		// 还原目标 URL 后按重定向跳处理（共享跳数预算与 cookie 会话；跳回可能升级会话 cookie）。
		// 仅在非 3xx 路径上检查，且只信任字面量常量折叠结果。
		if len(body.bytes) > 0 && len(body.bytes) < 8192 {
			jsNext := resolveJsRedirect(latinView(body.bytes), current)
			if jsNext != "" {
				next, err := url.Parse(jsNext)
				if err != nil || next.Host == "" {
					return rawResponse{ok: false, status: res.StatusCode, note: "bad-js-redirect"}
				}
				if next.Scheme != "http" && next.Scheme != "https" {
					return rawResponse{ok: false, status: res.StatusCode, note: "bad-scheme",
						warning: "JS 重定向到非 http/https 协议已拒绝: " + next.Scheme}
				}
				jsCheck := assertHostPublic(next.Hostname())
				if !jsCheck.ok {
					return rawResponse{ok: false, status: 0, note: "ssrf-blocked",
						warning: "SSRF 防护: JS 重定向终点 " + jsCheck.reason}
				}
				hops++
				if hops > maxRedirectHops {
					return rawResponse{ok: false, status: res.StatusCode, note: "too-many-redirects",
						warning: "重定向（含 JS token 跳转）超过 " + strconv.Itoa(maxRedirectHops) + " 跳，已停止"}
				}
				*warnings = append(*warnings, "JS token 重定向挑战页：已解析 location 拼接目标并跟随（会话 cookie 持续回放）")
				current = next.String()
				continue
			}
		}

		return rawResponse{ok: res.StatusCode >= 200 && res.StatusCode < 300, status: res.StatusCode,
			bytes: body.bytes, contentType: body.contentType, finalURL: current, note: body.note, warning: body.warning, retryAfter: retryAfter}
	}
}

var reProxyCred = regexp.MustCompile(`//[^@]*@`)

// latinView JS 侧用 utf-8 无损解码小挑战页；此处直接按 UTF-8（无效字节按替换符）——
// 与 TS `new TextDecoder('utf-8', { fatal: false }).decode` 一致
func latinView(b []byte) string { return string(b) }

func isRedirectStatus(s int) bool {
	return s == 301 || s == 302 || s == 303 || s == 307 || s == 308
}
