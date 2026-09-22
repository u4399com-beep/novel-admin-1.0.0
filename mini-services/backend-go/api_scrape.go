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
	register("GET", "/api/scrape/covers-backfill", handleCoversBackfillGone)
	register("POST", "/api/scrape/covers-backfill", handleCoversBackfillGone)
}

// handleCoversBackfillGone 封面回填端点（已退役 410 Gone，对齐原 TS 路由契约）。
// 历史：曾凭 Novel.remoteCoverUrl + sourceRuleId 对封面落盘失败的书籍批量重试下载；
// 两字段已随 schema 演进移除，采集入库时改为即时下载封面，无法凭现存字段反推远程
// 封面来源 → 端点退役。GET 仍返回封面本地化统计（backfillable 恒 0，后台按钮禁用）。
func handleCoversBackfillGone(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	if r.Method == http.MethodGet {
		var total, local int64
		_ = queryOne(`SELECT COUNT(*) FROM "Novel"`, []any{&total})
		_ = queryOne(`SELECT COUNT(*) FROM "Novel" WHERE "cover" LIKE '/covers/%'`, []any{&local})
		writeJSON(w, 200, map[string]any{
			"total":        total,
			"local":        local,
			"gradient":     total - local,
			"backfillable": 0, // remoteCoverUrl 字段链已移除，无远程来源可回填
			"available":    false,
		})
		return
	}
	writeJSON(w, 410, map[string]any{
		"error": "封面回填已退役：远程封面来源（remoteCoverUrl/sourceRuleId）字段已随 schema 演进移除，" +
			"采集入库时会即时下载封面落盘（/covers/{id}.webp），失败书籍保留渐变 token；" +
			"如需修复个别封面，请对对应书籍重新采集。",
		"available": false,
	})
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
