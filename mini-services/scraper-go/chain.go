/**
 * 策略链编排（逐行移植自 strategies/index.ts 的 fetchPage）：
 * SSRF 校验 → 熔断检查 → robots 检查 → 主机限流退避 → 按序尝试策略链
 * （域名限速 + 指数退避重试 + 整体时间预算 + 按主机策略亲和提位 + 硬时间闸）→ 字符集解码。
 * 永不 panic，全部失败时返回结构化错误。
 */
package main

import (
	"fmt"
	"math/rand"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
)

const chainBudgetMS = 55_000

// proxyCursor 站点级代理池轮换游标（跨请求轮换出口）。fetchPage 会被多请求并发调用，
// 游标必须原子递增（Go race detector 实证竞态点）；原子递增取模语义与 TS 版一致。
var proxyCursor atomic.Int64

var allStrategies = []strategyDef{
	fetchBrowserStrategy,
	fetchUaRotateStrategy,
	fetchMobileStrategy,
	fetchSpiderStrategy,
	curlImpersonateStrategy,
	curlPlainStrategy, // Task 25: 普通 curl 诚实客户端策略（针对拦截已知爬虫指纹但放行 curl 的 WAF，5165.org 实证）
	gotScrapingStrategy,
	browserStrategy,
}

// STRATEGY_NAMES 策略名列表（顺序与 TS 版一致）
var strategyNames = func() []string {
	names := make([]string, 0, len(allStrategies))
	for _, s := range allStrategies {
		names = append(names, s.name)
	}
	return names
}()

// fetchPageOptions 对齐 TS FetchPageOptions
type fetchPageOptions struct {
	requestedStrategy string
	forcedCharset     string
	timeoutMs         int
	referer           string
	proxy             string
	insecureTLS       bool
}

// fetchPageResult 对齐 TS FetchPageResult
type fetchPageResult struct {
	ok        bool
	html      string
	encoding  string
	strategy  string
	status    int
	warnings  []string
	attempts  []AttemptSummary
	robots    RobotsSummary
	elapsedMs int64
	err       string
	detail    string
}

// listStrategies 可用抓取策略及状态
func listStrategies() []StrategyInfo {
	out := make([]StrategyInfo, 0, len(allStrategies))
	for i := range allStrategies {
		s := &allStrategies[i]
		avail := false
		func() {
			defer func() { _ = recover() }()
			avail = s.probe()
		}()
		out = append(out, StrategyInfo{Name: s.name, Description: s.description, Available: avail})
	}
	return out
}

// pickOrder 显式指定策略时单策略链（探测失败回退全链并提示），否则默认全链
func pickOrder(requested string, warnings *[]string) []strategyDef {
	if requested != "" {
		for i := range allStrategies {
			s := &allStrategies[i]
			if s.name == requested {
				avail := false
				func() {
					defer func() { _ = recover() }()
					avail = s.probe()
				}()
				if avail {
					return []strategyDef{*s}
				}
				*warnings = append(*warnings, "指定策略 \""+requested+"\" 当前不可用，回退默认顺序")
				return allStrategies
			}
		}
		*warnings = append(*warnings, "指定策略 \""+requested+"\" 不存在（可选: "+strings.Join(strategyNames, ", ")+"），回退默认顺序")
	}
	return allStrategies
}

// fetchPage 抓取主入口
func fetchPage(rawURL string, opts fetchPageOptions) fetchPageResult {
	t0 := nowMs()
	warnings := []string{}
	attempts := []AttemptSummary{}
	timeoutMs := clampTimeout(opts.timeoutMs)
	// 整体预算：单策略超时再多给余量，硬上限 55s（主站代理 60s 超时之内）
	budget := int64(chainBudgetMS)
	minBudget := int64(timeoutMs+8_000) * 1
	if minBudget < int64(timeoutMs)*5/2 {
		minBudget = int64(timeoutMs) * 5 / 2
	}
	if minBudget < budget {
		budget = minBudget
	}
	deadline := t0 + budget

	var host string
	if u, err := url.Parse(rawURL); err == nil && u.Host != "" {
		host = u.Host
	} else {
		return fetchPageResult{
			ok: false, html: "", encoding: "", strategy: "", status: 0, warnings: []string{"URL 无法解析"},
			attempts: attempts, robots: RobotsSummary{CrawlDelayMs: nil},
			elapsedMs: nowMs() - t0, err: "URL 无法解析", detail: rawURL,
		}
	}

	// 入口 SSRF 校验（文本层 + DNS 尽力）——重定向逐跳校验在各策略的 fetchWithRedirectGuard 中
	entryCheck := assertHostPublic(hostOf(rawURL))
	if !entryCheck.ok {
		reason := entryCheck.reason
		if reason == "" {
			reason = "目标主机被拒绝"
		}
		return fetchPageResult{
			ok: false, html: "", encoding: "", strategy: "", status: 0, warnings: warnings,
			attempts: attempts, robots: RobotsSummary{CrawlDelayMs: nil},
			elapsedMs: nowMs() - t0, err: "SSRF 防护拦截", detail: reason,
		}
	}
	if entryCheck.warning != "" {
		warnings = append(warnings, "[ssrf] "+entryCheck.warning)
	}

	// 主机熔断：连败达阈值的主机快速结构化失败，不空烧 55s 预算；
	// 冷却结束自动半开恢复，成功一次即复位。显式指定策略时视为人工调试，跳过熔断。
	if opts.requestedStrategy == "" {
		if circuitMs := hostCircuitOpenMs(host); circuitMs > 0 {
			return fetchPageResult{
				ok: false, html: "", encoding: "", strategy: opts.requestedStrategy, status: 0, warnings: warnings,
				attempts: attempts, robots: RobotsSummary{CrawlDelayMs: nil},
				elapsedMs: nowMs() - t0,
				err:       "目标主机熔断中（近期连续整链失败，暂停请求以防刺激反爬/空耗预算）",
				detail: "主机 " + host + " 连续整链失败已达熔断阈值，剩余冷却 " +
					strconv.Itoa(int((circuitMs+999)/1000)) + "s 后自动恢复尝试（一次成功即复位）",
			}
		}
	}

	robots := checkRobots(rawURL)
	warnings = append(warnings, robots.warnings...)

	// 主机限流记忆：最近被 429/503 的主机先主动退避一拍再进链（Retry-After 优先），
	// 退避时长受剩余预算约束（至少留 3s 给真实尝试），预算不够时跳过退避。
	if penalty := hostPenaltyMs(host); penalty > 0 {
		waitCap := deadline - nowMs() - 3000
		wait := penalty
		if waitCap < wait {
			wait = waitCap
		}
		if wait < 0 {
			wait = 0
		}
		if wait > 500 {
			warnings = append(warnings, "[host-health] 主机 "+host+" 最近被限流（429/503），先主动退避 "+
				strconv.FormatFloat(float64(wait)/1000, 'f', 1, 64)+"s 再尝试（健康度记忆，成功后清零）")
			sleepMs(wait)
		}
	}

	order := pickOrder(opts.requestedStrategy, &warnings)

	// 按主机策略亲和：未显式指定策略时，把该主机最近一次成功的策略提到链首
	//（亲和命中失败时后续照旧全链回退，attempts 顺序照实记录）
	if opts.requestedStrategy == "" && len(order) > 1 {
		preferred := getPreferredStrategy(host)
		if preferred != "" {
			preferredIdx := -1
			for i := range order {
				if order[i].name == preferred {
					preferredIdx = i
					break
				}
			}
			if preferredIdx > 0 {
				preferredDef := order[preferredIdx]
				newOrder := []strategyDef{preferredDef}
				newOrder = append(newOrder, order[:preferredIdx]...)
				newOrder = append(newOrder, order[preferredIdx+1:]...)
				order = newOrder
				warnings = append(warnings, "[affinity] 主机 "+host+" 上次由策略 "+preferred+" 成功抓取，本次已将其提至链首优先尝试")
			}
		}
	}

	lastStatus := 0
	lastNote := ""
	var lastRetryAfterMs *int64
	sawChallenge := false

	// 站点级代理池（规则可配多个逗号分隔）：每次 fetchPage 调用轮换一个出口，
	// 失效代理由后续请求自然绕过（免费公共代理单点易失效的多出口容错）
	proxyPool := []string{}
	if opts.proxy != "" {
		for _, p := range strings.Split(opts.proxy, ",") {
			p = strings.TrimSpace(p)
			if p != "" {
				proxyPool = append(proxyPool, p)
			}
		}
	}
	pickProxy := func() string {
		if len(proxyPool) == 0 {
			return ""
		}
		idx := int(proxyCursor.Add(1))
		return proxyPool[(idx+len(proxyPool)-1)%len(proxyPool)]
	}

	for si := 0; si < len(order); si++ {
		strat := &order[si]
		if nowMs() > deadline-1500 {
			attempts = append(attempts, AttemptSummary{Strategy: strat.name, OK: false, Status: 0, Ms: 0, Note: "budget-exhausted（整体时间预算耗尽，停止尝试后续策略）"})
			break
		}
		available := false
		func() {
			defer func() { _ = recover() }()
			available = strat.probe()
		}()
		if !available {
			attempts = append(attempts, AttemptSummary{Strategy: strat.name, OK: false, Status: 0, Ms: 0, Note: "unavailable（探测失败，跳过）"})
			continue
		}
		for attempt := 1; attempt <= maxAttempts; attempt++ {
			if deadline-nowMs() < 1500 {
				attempts = append(attempts, AttemptSummary{Strategy: strat.name, OK: false, Status: 0, Ms: 0, Note: "budget-exhausted（整体时间预算耗尽）"})
				break
			}
			// 限速排队可能耗时较长（同主机并发任务时可达数秒）：剩余预算必须在排队之后重新计算
			acquireDomainSlot(host)
			remaining := deadline - nowMs()
			if remaining < 1500 {
				attempts = append(attempts, AttemptSummary{Strategy: strat.name, OK: false, Status: 0, Ms: 0, Note: "budget-exhausted（限速排队后预算耗尽）"})
				break
			}
			effTimeout := int64(timeoutMs)
			if remaining-500 < effTimeout {
				effTimeout = remaining - 500
			}
			if effTimeout < 1000 {
				effTimeout = 1000
			}
			s0 := nowMs()
			// 硬时间闸：任何策略都不得挂死整条链（链剩余预算 + 2.5s 余量）
			ctx := &strategyRunCtx{referer: opts.referer, proxy: pickProxy(), insecureTLS: opts.insecureTLS}
			res, _ := runWithHardGate(func() attemptResult {
				return safeStrategyRun(strat, rawURL, effTimeout, ctx)
			}, remaining+2500, remaining+2500)
			ms := nowMs() - s0

			// 子尝试摊平进 attempts（每次真实网络请求一条记录），无子尝试时记录策略级条目
			if len(res.subAttempts) > 0 {
				for _, sub := range res.subAttempts {
					attempts = append(attempts, AttemptSummary{
						Strategy: strat.name, Profile: sub.Profile, OK: sub.OK, Status: sub.Status,
						Ms: sub.Ms, Note: sub.Note, Blocked: sub.Blocked, Bytes: sub.Bytes,
					})
					if sub.Blocked {
						sawChallenge = true
					}
				}
			} else {
				attempts = append(attempts, AttemptSummary{Strategy: strat.name, OK: res.ok, Status: res.status, Ms: ms, Note: res.note})
			}
			for _, w := range res.warnings {
				if !containsStr(warnings, w) {
					warnings = append(warnings, "["+strat.name+"] "+w)
				}
			}

			// 主机健康度记忆：本链内被 429/503 → 记一次限流退避（Retry-After 优先）
			if res.status == 429 || res.status == 503 {
				noteRateLimited(host, res.retryAfter)
			}

			if res.ok {
				recordStrategySuccess(host, strat.name)
				noteChainSuccess(host)
				dec := decodeHtml(res.bytes, opts.forcedCharset, charsetFromContentType(res.contentType))
				for _, w := range dec.Warnings {
					warnings = append(warnings, "[charset] "+w)
				}
				return fetchPageResult{
					ok: true, html: dec.Text, encoding: dec.Encoding, strategy: strat.name,
					status: res.status, warnings: warnings, attempts: attempts,
					robots:    RobotsSummary{Checked: robots.info.checked, Disallowed: robots.info.disallowed, CrawlDelayMs: robots.info.crawlDelayMs},
					elapsedMs: nowMs() - t0,
				}
			}

			lastStatus = res.status
			lastNote = res.note
			lastRetryAfterMs = res.retryAfter
			if lastNote == "challenge-page" {
				sawChallenge = true
			}
			// selfRetrying 策略内部已有多画像/多协议重试梯子，外层不再重复重试
			if !strat.selfRetrying && isRetryableStatus(res.status) && attempt < maxAttempts {
				delay := backoffDelay(attempt)
				statusDesc := "HTTP " + strconv.Itoa(res.status)
				if res.status == 0 {
					statusDesc = "网络错误"
				}
				warnings = append(warnings, "["+strat.name+"] 第 "+strconv.Itoa(attempt)+" 次尝试失败（"+statusDesc+"），"+strconv.FormatInt(delay, 10)+"ms 后重试")
				sleepMs(delay)
				continue
			}
			break
		}

		// 策略间退避：429/5xx/网络错误 → 进入下一策略前显式指数退避+jitter。
		// 剩余预算 <3s 时不再退避（宁可靠限速器自身 1.2s 间隔，也不突破 55s 硬上限）；
		// 最后一个策略后无需退避。
		if si < len(order)-1 && isRetryableStatus(lastStatus) {
			remaining := deadline - nowMs()
			if remaining > 3000 {
				capMs := remaining - 2500
				attemptIdx := 1
				if lastStatus == 429 {
					attemptIdx = 2
				}
				delay := backoffDelay(attemptIdx)
				if delay > capMs {
					delay = capMs
				}
				if lastStatus == 429 && lastRetryAfterMs != nil && *lastRetryAfterMs > 0 {
					if *lastRetryAfterMs > delay {
						delay = *lastRetryAfterMs
					}
					if delay > capMs {
						delay = capMs
					}
					w := "HTTP 429 已按站点 Retry-After=" + strconv.FormatFloat(float64(*lastRetryAfterMs)/1000, 'f', 1, 64) +
						"s 退避（受整体预算约束，实际上限 " + strconv.FormatFloat(float64(capMs)/1000, 'f', 1, 64) + "s）"
					if !containsStr(warnings, w) {
						warnings = append(warnings, "[chain] "+w)
					}
				} else if lastStatus == 429 {
					w := "HTTP 429 目标站限流，已按指数退避+jitter 等待后继续后续策略"
					if !containsStr(warnings, w) {
						warnings = append(warnings, "[chain] "+w)
					}
				} else if lastStatus >= 500 {
					w := "HTTP " + strconv.Itoa(lastStatus) + " 目标站服务器错误，已按指数退避+jitter 等待后继续后续策略"
					if !containsStr(warnings, w) {
						warnings = append(warnings, "[chain] "+w)
					}
				}
				if delay > 0 {
					sleepMs(delay)
				}
			}
		}
	}

	// 整链失败 → 记一次连败（达熔断阈值后后续请求快速失败）
	noteChainFailure(host)

	detailParts := make([]string, 0, len(attempts))
	for _, a := range attempts {
		note := a.Note
		if note == "" {
			if a.Blocked {
				note = "challenge-page"
			} else {
				note = "HTTP " + strconv.Itoa(a.Status)
			}
		}
		p := a.Strategy
		if a.Profile != "" {
			p += "/" + a.Profile
		}
		detailParts = append(detailParts, p+": "+note)
	}
	detail := strings.Join(detailParts, "; ")
	if detail == "" {
		detail = "无可用策略（所有策略探测失败）"
	}
	if lastNote != "" {
		detail += "，最后备注: " + lastNote
	}
	if sawChallenge {
		detail += "；检测到疑似挑战页，目标站可能有反爬防护"
	}
	return fetchPageResult{
		ok: false, html: "", encoding: "", strategy: opts.requestedStrategy, status: lastStatus,
		warnings: warnings, attempts: attempts,
		robots:    RobotsSummary{Checked: robots.info.checked, Disallowed: robots.info.disallowed, CrawlDelayMs: robots.info.crawlDelayMs},
		elapsedMs: nowMs() - t0,
		err:       "全部可用策略均抓取失败",
		detail:    detail,
	}
}

// safeStrategyRun 策略运行 + panic 兜底（TS 版以 try/catch 转 internal-error，语义对齐）
func safeStrategyRun(s *strategyDef, targetURL string, timeoutMs int64, ctx *strategyRunCtx) (res attemptResult) {
	defer func() {
		if r := recover(); r != nil {
			res = attemptResult{
				ok: false, status: 0, bytes: []byte{}, contentType: "",
				warnings: []string{"策略内部异常: " + fmt.Sprint(r)},
				note:     "internal-error",
			}
		}
	}()
	return s.run(targetURL, timeoutMs, ctx)
}

func containsStr(arr []string, v string) bool {
	for _, s := range arr {
		if s == v {
			return true
		}
	}
	return false
}

var _ = rand.Intn
