/**
 * 采集引擎业务 handler 层（逐行移植自 handlers.ts）：
 * 请求体解析/参数校验 + /api/strategies、/api/test、/api/chapter 的业务处理。
 *
 * 对外 API 契约（字段名/错误结构 {error,detail}/CORS）与 TS 版完全一致，主站 worker 与 UI 依赖之：
 * - 成功与失败响应都携带 attempts 明细（每次网络尝试的状态/耗时/画像/挑战页标记）便于调试；
 * - 策略链全败返回结构化 502 而非 5xx panic；
 * - 内部异常只返回消息不返回堆栈（堆栈仅打印到服务端日志）。
 */
package main

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/PuerkitoBio/goquery"
)

// pageFetchOutcome fetchAndPrepare 结果
type pageFetchOutcome struct {
	response bool // true = 已写出错误响应（调用方直接 return）
	page     fetchPageResult
	target   string
}

func fetchAndPrepare(w http.ResponseWriter, body map[string]any) pageFetchOutcome {
	t := parseTarget(body["url"])
	if !t.ok {
		failJSON(w, "参数错误", t.msg, 400)
		return pageFetchOutcome{response: true}
	}
	timeoutMs := clampTimeout(body["timeoutMs"])
	strategy := strField(body["strategy"], 64)
	charset := strField(body["charset"], 64)
	if strategy != "" && !containsStr(strategyNames, strategy) {
		failJSON(w, "参数错误", "未知策略 \""+strategy+"\"（可选: "+strings.Join(strategyNames, ", ")+"）", 400)
		return pageFetchOutcome{response: true}
	}
	// 可选 referer 链（向后兼容：不传时为空，策略层维持原行为）
	referer := parseReferer(body["referer"])
	// 站点级出口代理（规则配置，向后兼容：不传/非法时为空 → 直连）
	proxy := parseProxy(body["proxy"])
	// 自签/裸 IP 站点 TLS 旁路（规则配置，向后兼容：不传时 false）
	insecureTLS, _ := body["insecureTLS"].(bool)
	page := fetchPage(t.url.String(), fetchPageOptions{
		requestedStrategy: strategy,
		forcedCharset:     charset,
		timeoutMs:         timeoutMs,
		referer:           referer,
		proxy:             proxy,
		insecureTLS:       insecureTLS,
	})
	return pageFetchOutcome{page: page, target: t.url.String()}
}

// pageFailureResponse 策略链全败时的结构化 502 响应（含 attempts 明细与挑战页标记）
func pageFailureResponse(w http.ResponseWriter, page fetchPageResult, baseURL string) {
	challengeSuspected := false
	for _, a := range page.attempts {
		if a.Blocked {
			challengeSuspected = true
			break
		}
	}
	if !challengeSuspected && strings.Contains(page.detail, "挑战页") {
		challengeSuspected = true
	}
	writeJSON(w, 502, map[string]any{
		"ok": false, "url": baseURL, "error": page.err, "detail": page.detail,
		"challengeSuspected": challengeSuspected, "attempts": page.attempts,
		"robots": page.robots, "warnings": page.warnings, "elapsedMs": page.elapsedMs,
	})
}

// robotsSummaryJSON robots 摘要（crawlDelayMs 恒带，可能为 null）
func robotsSummaryJSON(r RobotsSummary) RobotsSummary { return r }

// handleStrategies GET /api/strategies
func handleStrategies(w http.ResponseWriter, _ *http.Request) {
	strategies := listStrategies()
	affHosts, affMax := affinityStats()
	ckHosts, ckMax, ckPerHost, ckTTL := cookieStats()
	resp := map[string]any{
		"ok":         true,
		"service":    "scraper-service",
		"strategies": strategies,
		// 按主机策略亲和缓存说明（向后兼容的追加字段）
		"affinity": map[string]any{
			"description":  "按主机策略亲和：某主机最近一次成功的策略会在后续对该主机的请求中被提到策略链首优先尝试（显式指定 strategy 时不生效；亲和命中失败照旧回退全链，attempts 顺序照实记录）",
			"maxEntries":   affMax,
			"trackedHosts": affHosts,
		},
		// 按主机 Cookie 会话持久化说明
		"cookieSession": func() map[string]any {
			return map[string]any{
				"description":       "按主机 Cookie 会话持久化：捕获各策略响应的 Set-Cookie 按主机存储（含重定向中间跳），该主机后续请求自动回放，覆盖「首访种 cookie、二访才放行」的站点；仅进程内存不落盘，LRU 上限与 TTL 见下；Secure 属性 cookie 仅在 https 请求回放",
				"trackedHosts":      ckHosts,
				"maxHosts":          ckMax,
				"maxCookiesPerHost": ckPerHost,
				"ttlMs":             ckTTL,
			}
		}(),
		// 按主机健康度记忆说明
		"hostHealth": func() map[string]any {
			s := getHostHealthStats()
			return map[string]any{
				"description":    "按主机健康度记忆：429/503 后下一次抓取先主动退避（Retry-After 优先，指数增长上界 15s，成功即清零）；连续整链失败达阈值的主机熔断快速失败（冷却 60s 起指数增长上界 10min，半开自动恢复；显式指定 strategy 时跳过熔断）",
				"trackedHosts":   s.TrackedHosts,
				"maxEntries":     s.MaxEntries,
				"breakerStrikes": s.BreakerStrikes,
				"baseCooldownMs": s.BaseCooldownMs,
				"maxCooldownMs":  s.MaxCooldownMs,
				"maxPenaltyMs":   s.MaxPenaltyMs,
			}
		}(),
		// browser 策略说明（Go 版：Python Playwright 桥接，独立子进程渲染）
		"browserSession": map[string]any{
			"description":  "browser 策略经 Python Playwright 桥接（scripts/render.py）渲染：每请求独立子进程浏览器（cookie/会话隔离），自带 SIGALRM 看门狗与渲染期 SSRF 拦截；子进程模式天然无长跑内存膨胀",
			"reuseEnabled": false,
			"bridge":       "python-playwright",
		},
		"compliance": map[string]any{
			"rateLimit":          "默认每域名 1200ms±300ms（< 1 req/s），环境变量 SCRAPER_MIN_INTERVAL_MS 可调但不允许低于 1000ms；跨域重定向跳同样逐跳限速",
			"robotsCheck":        "warn-only：解析 robots.txt，命中 Disallow 时在 warnings 中提示，不强制阻断",
			"ssrfGuard":          "文本层（IPv4 全形态/IPv6 内网段）+ DNS 尽力校验 + redirect manual 逐跳校验",
			"maxResponseBytes":   maxBytes,
			"challengeDetection": "四层检测：反爬平台强特征（任意体积，扫描前 32KB，含国产 WAF JS 挑战壳 token acw_sc__v2/__jsl_clearance/__jsluid/yunsuo/wzws）→ 近空可见正文（<80 字符）JS 跳板/「JS 计算 cookie + 原地 reload」壳/需启用 JS 壳（任意体积，覆盖 HTTP 200 伪装）→ 极小页(<3KB)挑战关键词（latin1/UTF-8/GB18030 三解码匹配，含中文关键词）→ 极小页 0 秒 meta-refresh 跳板；命中即标记 blocked 并按失败处理",
			"captchaSolving":     "禁止提供",
			"loginContent":       "禁止采集",
			"accountSpoofing":    "禁止提供",
		},
	}
	writeJSON(w, 200, resp)
}

// htmlDebugLimit includeHtml 调试模式下单次返回的 HTML 上限（约 300K 字符）
const htmlDebugLimit = 300_000

// handleTest POST /api/test
func handleTest(w http.ResponseWriter, body map[string]any) {
	t0 := nowMs()
	outcome := fetchAndPrepare(w, body)
	if outcome.response {
		return
	}
	page := outcome.page
	baseURL := outcome.target

	if !page.ok {
		pageFailureResponse(w, page, baseURL)
		return
	}

	rawRule, _ := body["rule"].(map[string]any)
	listRule := sanitizeRule(listKeys, rawRule["listRule"])
	bookRule := sanitizeRule(bookKeys, rawRule["bookRule"])
	chapterRule := sanitizeRule(chapterKeys, rawRule["chapterRule"])
	hasRule := len(listRule)+len(bookRule)+len(chapterRule) > 0
	// 调试开关（可选，向后兼容）：includeHtml=true 时响应附带原始 HTML（截断到上限）
	includeHtml, _ := body["includeHtml"].(bool)
	htmlDebug := ""
	if includeHtml {
		htmlDebug = truncateStr(page.html, htmlDebugLimit)
	}

	warnings := append([]string{}, page.warnings...)
	doc, docErr := goquery.NewDocumentFromReader(strings.NewReader(page.html))
	if docErr != nil {
		failJSON(w, "服务器内部错误", "HTML 解析失败", 500)
		return
	}
	data := map[string]any{}

	if len(listRule) > 0 {
		data["list"] = extractList(doc, listRule, baseURL, &warnings)
	}
	if len(bookRule) > 0 {
		data["book"] = extractBook(doc, bookRule, baseURL, &warnings)
	}
	if len(chapterRule) > 0 {
		data["chapter"] = extractChapter(doc, chapterRule, baseURL, &warnings)
	}
	if !hasRule {
		title := collapse(doc.Find("title").First().Text())
		data["page"] = map[string]any{
			"url": baseURL, "title": title, "htmlLength": runeLen(page.html),
		}
		warnings = append(warnings, "未提供任何提取规则（rule.listRule / bookRule / chapterRule），仅返回页面基础信息")
	}

	resp := map[string]any{
		"ok": true, "url": baseURL, "strategy": page.strategy, "status": page.status,
		"elapsedMs": nowMs() - t0, "fetchElapsedMs": page.elapsedMs, "encoding": page.encoding,
		"htmlLength": runeLen(page.html), "robots": page.robots, "attempts": page.attempts,
		"data": data, "warnings": warnings,
	}
	if includeHtml {
		resp["html"] = htmlDebug
		resp["htmlTruncated"] = runeLen(page.html) > runeLen(htmlDebug)
	}
	writeJSON(w, 200, resp)
}

// handleChapter POST /api/chapter
func handleChapter(w http.ResponseWriter, body map[string]any) {
	t0 := nowMs()
	rule := sanitizeRule(chapterKeys, body["rule"])
	outcome := fetchAndPrepare(w, body)
	if outcome.response {
		return
	}
	page := outcome.page
	baseURL := outcome.target

	if !page.ok {
		pageFailureResponse(w, page, baseURL)
		return
	}

	warnings := append([]string{}, page.warnings...)
	doc, docErr := goquery.NewDocumentFromReader(strings.NewReader(page.html))
	if docErr != nil {
		failJSON(w, "服务器内部错误", "HTML 解析失败", 500)
		return
	}
	data := extractChapter(doc, rule, baseURL, &warnings)

	// 软 404/空壳质量哨兵：HTTP 200 但正文为空的伪装页。
	// 纯提示（ok 仍为 true，不改变既有成功语义），把「200 伪装」暴露给调用方可观测。
	if page.status == 200 && data.Content == "" {
		// 标题呈 404/空壳特征时更明确；排除「第404章」这类标题里的数字巧合
		soft404Title := soft404TitleRe.MatchString(data.Title) && !chapterNumPrefix.MatchString(data.Title)
		if soft404Title {
			warnings = append(warnings, "HTTP 200 但正文为空且标题呈 404/空壳特征，疑似软 404（目标站用 200 状态码伪装错误页）")
		} else {
			warnings = append(warnings, "HTTP 200 但正文提取为空：疑似 JS 渲染空壳或软 404，建议用 browser 策略复核该 URL")
		}
	}

	writeJSON(w, 200, map[string]any{
		"ok": true, "url": baseURL, "strategy": page.strategy, "status": page.status,
		"elapsedMs": nowMs() - t0, "fetchElapsedMs": page.elapsedMs, "encoding": page.encoding,
		"robots": page.robots, "attempts": page.attempts, "data": data, "warnings": warnings,
	})
}

// jsonNumbersAttempsCount 保留（未用则编译器剔除）
var _ = json.Marshal
var _ = regexp.MustCompile
var _ = strconv.Itoa
