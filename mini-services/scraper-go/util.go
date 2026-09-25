/**
 * 通用工具：JSON 响应（CORS/无 HTML 转义）/ 请求体限量解析 / 目标 URL 校验 / 规则白名单清洗 /
 * referer/proxy 参数解析 / 超时钳制。（移植自 handlers.ts 通用工具段 + strategies/index.ts clampTimeout）
 */
package main

import (
	"encoding/json"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// ==================== JSON 响应 ====================

func corsHeader(k string) string {
	switch k {
	case "origin":
		return "*"
	case "methods":
		return "GET,POST,OPTIONS"
	case "headers":
		return "content-type"
	}
	return ""
}

func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Access-Control-Allow-Origin", corsHeader("origin"))
	w.Header().Set("Access-Control-Allow-Methods", corsHeader("methods"))
	w.Header().Set("Access-Control-Allow-Headers", corsHeader("headers"))
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false) // 对齐 JSON.stringify：不转义 <>&（正文/html 调试字段可读）
	_ = enc.Encode(data)
}

func failJSON(w http.ResponseWriter, errMsg string, detail any, status int) {
	writeJSON(w, status, map[string]any{"error": errMsg, "detail": detail})
}

// ==================== 请求体解析（上限 1MB，对齐 parseBody 语义） ====================

const maxBodyBytes = 1_048_576

// parseBody 读取并解析 JSON 对象请求体；声明长度超限直接拒绝，无声明长度时流式限量。
// 失败一律返回 nil（调用方回「请求体错误」），与 TS 版返回 null 语义一致。
func parseBody(w http.ResponseWriter, r *http.Request) map[string]any {
	declared := r.Header.Get("Content-Length")
	if declared != "" {
		if n, err := strconv.Atoi(declared); err == nil && n > maxBodyBytes {
			return nil
		}
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	dec := json.NewDecoder(r.Body)
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil
	}
	if obj, ok := v.(map[string]any); ok {
		return obj
	}
	return nil
}

// ==================== 目标 URL 校验（parseTarget） ====================

type targetResult struct {
	ok  bool
	url *url.URL
	msg string
}

func parseTarget(raw any) targetResult {
	s, ok := raw.(string)
	if !ok || strings.TrimSpace(s) == "" {
		return targetResult{msg: "缺少 url 参数"}
	}
	s = strings.TrimSpace(s)
	u, err := url.Parse(s)
	if err != nil {
		return targetResult{msg: "URL 无法解析: " + truncateStr(s, 200)}
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return targetResult{msg: "仅支持 http/https 协议（收到 " + u.Scheme + "）"}
	}
	if u.Host == "" {
		return targetResult{msg: "URL 缺少主机名: " + truncateStr(s, 200)}
	}
	if !privateHostAllowed() && isPrivateHost(u.Hostname()) {
		return targetResult{msg: "拒绝访问内网/本机地址（SSRF 防护）。如确有需要请设置环境变量 SCRAPER_ALLOW_PRIVATE=1"}
	}
	return targetResult{ok: true, url: u}
}

// ==================== 规则白名单清洗（sanitizeRule） ====================

var listKeys = []string{"itemSelector", "titleSelector", "linkSelector", "authorSelector", "categorySelector"}
var bookKeys = []string{
	"titleSelector", "authorSelector", "descriptionSelector", "coverSelector",
	"statusSelector", "categorySelector", "chapterLinkSelector", "chapterTitleSelector",
	"catalogLinkSelector", "excludeSelector", "chapterListApi",
}
var chapterKeys = []string{"titleSelector", "contentSelector", "nextSelector", "excludeSelector"}

func sanitizeRule(keys []string, raw any) map[string]string {
	out := map[string]string{}
	if raw == nil {
		return out
	}
	m, ok := raw.(map[string]any)
	if !ok {
		return out
	}
	for _, k := range keys {
		if v, ok := m[k].(string); ok {
			t := strings.TrimSpace(v)
			if t == "" {
				continue
			}
			// chapterListApi 为 JSON 配置字符串（url/字段名/模板等十几字段），普通选择器 300 字符不够用
			capLen := 300
			if k == "chapterListApi" {
				capLen = 1200
			}
			out[k] = truncateStr(t, capLen)
		}
	}
	return out
}

func ruleMapKeys(m map[string]string) int { return len(m) }

// ==================== 字段解析工具 ====================

func strField(v any, maxLen int) string {
	s, ok := v.(string)
	if !ok || strings.TrimSpace(s) == "" {
		return ""
	}
	return truncateStr(strings.TrimSpace(s), maxLen)
}

func truncateStr(s string, n int) string {
	if len(s) <= n {
		return s
	}
	// 按字符截断（近似 TS 的 String.slice 语义，避免切出半个 UTF-8 序列）
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n])
}

// parseReferer 仅接受合法 http(s) URL（≤2048 字符），非法/缺失返回空串（= TS null）
func parseReferer(raw any) string {
	s, ok := raw.(string)
	if !ok {
		return ""
	}
	s = strings.TrimSpace(s)
	if s == "" || len(s) > 2048 {
		return ""
	}
	u, err := url.Parse(s)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return ""
	}
	return u.String()
}

// parseProxy 站点级出口代理解析：逗号分隔多个代理（故障轮换），
// 仅接受 http/https/socks5/socks5h/socks4 形态 URL（合计 ≤1024 字符）。
// 注意：socks4 在 Go 传输层不支持（见文件头差异说明），校验放行但使用时按普通失败降级直连。
func parseProxy(raw any) string {
	s, ok := raw.(string)
	if !ok {
		return ""
	}
	s = strings.TrimSpace(s)
	if s == "" || len(s) > 1024 {
		return ""
	}
	parts := strings.Split(s, ",")
	var okParts []string
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		u, err := url.Parse(p)
		if err != nil || u.Host == "" {
			return ""
		}
		switch u.Scheme {
		case "http", "https", "socks5", "socks5h", "socks4":
			okParts = append(okParts, p)
		default:
			return ""
		}
	}
	return strings.Join(okParts, ",")
}

// ==================== 超时钳制（clampTimeout） ====================

func clampTimeout(ms any) int {
	var n float64
	switch v := ms.(type) {
	case float64:
		n = v
	case string:
		f, err := strconv.ParseFloat(v, 64)
		if err != nil {
			return 20_000
		}
		n = f
	default:
		return 20_000
	}
	if n != n { // NaN
		return 20_000
	}
	// Task 33-a: ±Inf（字符串 "inf"/"1e999" 可被 ParseFloat 接受）时 int(n) 是实现定义
	// 转换（amd64 得 MinInt64），行为悬在未定义边缘；显式按量级守卫拒绝走默认值。
	if n > 1e15 || n < -1e15 {
		return 20_000
	}
	iv := int(n)
	if iv < 2_000 {
		return 2_000
	}
	if iv > 60_000 {
		return 60_000
	}
	return iv
}

// ==================== 软 404 判定（handleChapter 质量哨兵用） ====================

var (
	soft404TitleRe   = regexp.MustCompile(`(?i)404|not\s*found|不存在|找不到|已删除|无法访问|访问出错|页面出错|加载失败`)
	chapterNumPrefix = regexp.MustCompile(`^第\s*[0-9〇零一二两三四五六七八九十百千万]`)
)

// ==================== URL 工具 ====================

// urlJoin 等价 new URL(ref, base)：相对引用解析；失败返回 nil
func urlJoin(ref, base string) *url.URL {
	b, err := url.Parse(base)
	if err != nil || b.Host == "" && b.Scheme == "" {
		// base 本身无法解析时，尝试直接解析 ref
		u, err2 := url.Parse(ref)
		if err2 != nil {
			return nil
		}
		return u
	}
	u, err := b.Parse(ref)
	if err != nil {
		return nil
	}
	return u
}

// urlParse 包装 net/url.Parse（供各模块统一入口）
func urlParse(raw string) (*url.URL, error) { return url.Parse(raw) }

// hostOf 取 URL 的 host（含端口；解析失败时原样返回，供限速 key 使用）
func hostOf(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil || u.Host == "" {
		return rawURL
	}
	return u.Host
}

// isLoopbackIP 保留给未来 socket 层增强（当前 SSRF 文本层覆盖见 ssrf.go）
var _ = net.ParseIP
