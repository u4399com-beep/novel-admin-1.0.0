/**
 * api_scrape.go —— 业务 API：采集引擎代理。
 *
 * 对应 TS 源：src/app/api/scrape/route.ts（逐行移植）
 *
 * 契约：
 * - GET /api/scrape?proxy=strategies|health（默认 strategies）
 * - POST /api/scrape?proxy=test|chapter（默认 test，body 原样透传）
 * - 白名单外子路由 → 404 {error:'不支持的 proxy 子路由', detail}
 * - 引擎响应：状态码 + Content-Type + body 原样透传（服务端内部直连 127.0.0.1:3030）
 * - 网络/超时失败 → 502 {error, detail, hint}（文案与 TS 一致）
 *
 * 移植语义差异：
 * 1. AbortSignal.timeout(60s) → http.Client.Timeout=60s；超时判定对齐 TS
 *    /timeout|abort/i（Go 侧以 net.Error.Timeout/DeadlineExceeded/Canceled 识别）
 * 2. TS res.text() 无上限；Go 以 32MB 限量读兜底（引擎自身响应 ≤8MB，防异常中间层）
 */
package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strings"
	"time"
)

const scraperProxyOrigin = "http://127.0.0.1:3030"

var (
	scrapeProxyGetSubs  = []string{"strategies", "health"} // TS Set 插入序（错误文案依赖）
	scrapeProxyPostSubs = []string{"test", "chapter"}
	scrapeProxyClient   = &http.Client{Timeout: 60 * time.Second}
)

func init() {
	register("GET", "/api/scrape", handleScrapeProxyGet)
	register("POST", "/api/scrape", handleScrapeProxyPost)
}

func handleScrapeProxyGet(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	sub := parseQueryStr(r, "proxy")
	if sub == "" {
		sub = "strategies"
	}
	if !containsStr(scrapeProxyGetSubs, sub) {
		writeJSON(w, 404, map[string]string{
			"error":  "不支持的 proxy 子路由",
			"detail": "GET 仅允许: " + strings.Join(scrapeProxyGetSubs, ", "),
		})
		return
	}
	scrapeProxyForward(w, "GET", "/api/"+sub, "")
}

func handleScrapeProxyPost(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	sub := parseQueryStr(r, "proxy")
	if sub == "" {
		sub = "test"
	}
	if !containsStr(scrapeProxyPostSubs, sub) {
		writeJSON(w, 404, map[string]string{
			"error":  "不支持的 proxy 子路由",
			"detail": "POST 仅允许: " + strings.Join(scrapeProxyPostSubs, ", "),
		})
		return
	}
	// TS: const body = await req.text()（原样转发，不校验 JSON）
	body, _ := readAllLimited(r.Body, 32<<20)
	scrapeProxyForward(w, "POST", "/api/"+sub, string(body))
}

// scrapeProxyForward 转发请求到引擎并透传响应；网络失败按 TS 结构化 502。
func scrapeProxyForward(w http.ResponseWriter, method, path, body string) {
	var req *http.Request
	var err error
	if method == "GET" {
		req, err = http.NewRequest("GET", scraperProxyOrigin+path, nil)
	} else {
		req, err = http.NewRequest("POST", scraperProxyOrigin+path, strings.NewReader(body))
	}
	if err != nil {
		scrapeProxyFail(w, err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := scrapeProxyClient.Do(req)
	if err != nil {
		scrapeProxyFail(w, err)
		return
	}
	defer res.Body.Close()
	text, _ := readAllLimited(res.Body, 32<<20)
	ct := res.Header.Get("Content-Type")
	if ct == "" {
		ct = "application/json"
	}
	w.Header().Set("Content-Type", ct)
	w.WriteHeader(res.StatusCode)
	_, _ = w.Write(text)
}

// scrapeProxyFail 对齐 TS proxy() 的 catch 分支（超时/不可达文案与 hint）。
func scrapeProxyFail(w http.ResponseWriter, err error) {
	timedOut := false
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
			timedOut = true
		} else {
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				timedOut = true
			}
		}
	}
	detail := "unknown"
	if err != nil {
		detail = truncateRunes(err.Error(), 500)
	}
	out := map[string]any{
		"error":  "采集服务不可用",
		"detail": detail,
		"hint":   "请确认 mini-services/scraper-service 已启动（bun run dev，端口 3030）",
	}
	if timedOut {
		out["error"] = "采集服务响应超时"
		out["hint"] = "策略链整体预算为 55s，可尝试减小 timeoutMs 或指定单一 strategy"
	}
	writeJSON(w, 502, out)
}

func containsStr(list []string, s string) bool {
	for _, it := range list {
		if it == s {
			return true
		}
	}
	return false
}
