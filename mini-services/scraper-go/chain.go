/**
 * 策略链编排（逐行移植自 strategies/index.ts 的 fetchPage）：
 * SSRF 校验 → 熔断检查 → robots 检查 → 主机限流退避 → 按序尝试策略链
 * （域名限速 + 指数退避重试 + 整体时间预算 + 按主机策略亲和提位 + 硬时间闸）→ 字符集解码。
 * 永不 panic，全部失败时返回结构化错误。
 */
package main

import (
	"context"
	"fmt"
	"math/rand"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
)

const chainBudgetMS = 55_000

// debugHTMLCapBytes Task 32-d: 整链失败时保留的响应体快照上限（20KB，透出为 htmlDebug 调试字段）。
// 挑战页/空壳页特征集中在前部（token 脚本/跳板 head），20KB 足够判形。
const debugHTMLCapBytes = 20 * 1024

// proxyCursor 站点级代理池轮换游标（跨请求轮换出口）。fetchPage 会被多请求并发调用，
// 游标必须原子递增（Go race detector 实证竞态点）；原子递增取模语义与 TS 版一致。
var proxyCursor atomic.Int64

var allStrategies = []strategyDef{
	fetchBrowserStrategy,
	fetchUaRotateStrategy,
	fetchMobileStrategy,
	fetchSpiderStrategy,
	curlImpersonateStrategy,
	curlPlainStrategy, // Task 25: 普通 curl 诚实客户端策略（针对拦截已知爬虫指纹但放行系统 curl 的 WAF，5165.org 实证）
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
	// Task 32-d（Task 31 遗留②落地）：整链失败时策略链最后一次抓到的原始页面（已解码、
	// 截断到 debugHTMLCapBytes）——排障时直接看到挑战页/空壳页原文而非只剩状态码。
	// 成功路径恒为空（调用方用 html 字段）。includeHtml=true 时经 handlers 透出 htmlDebug。
	debugHTML string
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
	var hostName string // Task 27-c: 不含端口的主机名（SSRF 校验口径与各策略逐跳一致）
	if u, err := url.Parse(rawURL); err == nil && u.Host != "" {
		host = u.Host
		hostName = u.Hostname()
	} else {
		return fetchPageResult{
			ok: false, html: "", encoding: "", strategy: "", status: 0, warnings: []string{"URL 无法解析"},
			attempts: attempts, robots: RobotsSummary{CrawlDelayMs: nil},
			elapsedMs: nowMs() - t0, err: "URL 无法解析", detail: rawURL,
		}
	}

	// 入口 SSRF 校验（文本层 + DNS 尽力）——重定向逐跳校验在各策略的 fetchWithRedirectGuard 中。
	// Task 27-c 修复：旧版传 hostOf(rawURL)（含端口），带显式端口的 URL（如 http://x.com:8080/）
	// 在 assertHostPublic 里因含 ":" 被当 IPv6 文本解析失败 → fail-closed 误拒（功能性阻断：
	// 所有带端口站点永远 SSRF 拦截）；改用与 fetchWithRedirectGuard/robots 同口径的 Hostname()
	entryCheck := assertHostPublic(hostName)
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
	// Task 32-d: 失败尝试响应体快照（debugHTML 注入用，见 fetchPageResult.debugHTML 注释）
	var lastFailBytes []byte
	lastFailCT := ""

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
		// Task 33-a: int() 转换在 32 位平台字长下会回绕为负，负数取模得负下标 → 切片越界
		// panic。先取模再补正，使游标轮换与平台字长解耦（64 位下语义不变）。
		idx := int(proxyCursor.Add(1))
		m := idx % len(proxyPool)
		if m < 0 {
			m += len(proxyPool)
		}
		return proxyPool[m]
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
			// 硬时间闸：任何策略都不得挂死整条链（链剩余预算 + 2.5s 余量）。
			// Task 27-c（25-a 遗留 c 收紧）：硬闸 context 传入策略，超时 cancel 后
			// Go 原生 HTTP 路径的在途请求立即中止，策略 goroutine 不再空转到自身超时
			ctx := &strategyRunCtx{referer: opts.referer, proxy: pickProxy(), insecureTLS: opts.insecureTLS}
			res, _ := runWithHardGate(func(hctx context.Context) attemptResult {
				ctx.hardCtx = hctx
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
				// Task 32-d: 透传状态码供 hosthealth 记忆（hostRateLimitMemo 注入失败错误用）
				noteRateLimited(host, res.status, res.retryAfter)
				// Task 31-b: AIMD 自适应限速「乘性增大」——该主机后续请求间隔 ×1.5 逐步放大
				//（上界 8s；Retry-After 直接采纳），被限流自动慢下来而非靠熔断停摆
				noteAdaptiveRateLimited(host, res.retryAfter)
			}

			// Task 32-d: 保留失败尝试的响应体快照（截断拷贝，不持整份 backing array），
			// 供整链失败时注入 debugHTML——挑战页/空壳页排障不再只看到状态码
			if !res.ok && len(res.bytes) > 0 {
				keep := res.bytes
				if len(keep) > debugHTMLCapBytes {
					keep = keep[:debugHTMLCapBytes]
				}
				snap := make([]byte, len(keep))
				copy(snap, keep)
				lastFailBytes = snap
				lastFailCT = res.contentType
			}

			if res.ok {
				recordStrategySuccess(host, strat.name)
				noteChainSuccess(host)
				// Task 31-b: AIMD 自适应限速「加性回落」——连续成功后该主机请求间隔
				// 每次成功 -50ms 缓慢降至基础间隔（1.2s），恢复后缓慢提速不突进
				noteAdaptiveSuccess(host)
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
			if lastNote == "challenge-page" || lastNote == "challenge-loop" {
				sawChallenge = true
			}
			// Task 32-d（挑战循环终止）：JS token 跳转跟随后仍命中挑战特征（challenge-loop）
			// 说明该站挑战无法经此路径通过——继续换策略只会重复烧穿预算。
			// 直接终止整链，错误消息带「挑战循环」（backend isSoftBlockErr 按「挑战」命中软拦截分类）
			if lastNote == "challenge-loop" {
				warnings = append(warnings, "[chain] 挑战循环：JS token 跳转跟随后仍为挑战页，终止后续策略尝试以防烧穿")
				break
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

		// Task 32-d: challenge-loop 属站点级挑战循环（换策略同因失败），终止整条策略链
		if lastNote == "challenge-loop" {
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

	// 整链失败 → 记一次连败（达熔断阈值后后续请求快速失败）。
	// allNetErr 判定（Task 26-d）：所有真实网络尝试均 status=0（连接层被拒/EOF/超时）且无挑战页
	// ——此时源站在连接层拒绝本机，hosthealth 会更快熔断+温和退避。
	// 预算耗尽（budget-exhausted）/策略不可用（unavailable）属引擎自身状态，不计入网络级连败，
	// 避免把「站点慢」误判成「站点拒绝」而提前熔断。
	noteChainFailure(host, allAttemptsNetErr(attempts))

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
	// Task 32-d（Task 31 遗留①）：错误消息注入 hosthealth 限流上下文——backend 侧
	// isRateLimitErr 熔断分类与失败采样日志从此能直接识别「近期被 429/503」的软拦截形态
	errMsg := "全部可用策略均抓取失败"
	if memo := hostRateLimitMemo(host); memo != "" {
		errMsg += " " + memo
		detail += "；" + memo
	}
	// Task 32-d（Task 31 遗留②）：整链失败时把最后一次失败响应体解码进 debugHTML
	//（无快照/快照为空则留空），includeHtml=true 时经 handlers 透出
	debugHTML := ""
	if len(lastFailBytes) > 0 {
		debugHTML = decodeHtml(lastFailBytes, opts.forcedCharset, charsetFromContentType(lastFailCT)).Text
	}
	return fetchPageResult{
		ok: false, html: "", encoding: "", strategy: opts.requestedStrategy, status: lastStatus,
		warnings: warnings, attempts: attempts,
		robots:    RobotsSummary{Checked: robots.info.checked, Disallowed: robots.info.disallowed, CrawlDelayMs: robots.info.crawlDelayMs},
		elapsedMs: nowMs() - t0,
		err:       errMsg,
		detail:    detail,
		debugHTML: debugHTML,
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

// isEngineStateNote 判定一条尝试备注是否为「引擎自身状态」而非目标站的网络级行为。
// 这些形态 status 恒为 0 且不产生任何真实到达目标站的网络证据：
//   - "hard-timeout"：策略链硬时间闸强制放行（Task 27-c 引入的引擎侧看门狗，站点只是慢/挂起）；
//   - "timeout-budget"：策略内部画像梯子的自身预算耗尽（fetch 系/got/curl 系子尝试）；
//   - "budget-exhausted"：整链时间预算耗尽（Task 26-d 已排除）；
//   - "unavailable"：策略探测失败未发起请求（Task 26-d 已排除）；
//   - "missing-*"：二进制/桥接缺失（missing-binary/missing-curl/missing-python，probe 竞态残余）；
//   - "internal-error"：策略内部 panic（代码缺陷非站点行为）。
//
// Task 29-b 修复：旧实现只排除 budget-exhausted/unavailable 两种前缀——策略内部预算子尝试
// （timeout-budget）与硬时间闸（hard-timeout）按 status=0 落入网络级失败。站点整体挂起
// （连接成功但响应停滞）时所有策略都被硬闸放行，两轮即触发 netBreakerStrikes=2 的
// 「源站连接层拒绝本机」快速熔断+网络级退避——把「站点慢」误判成「站点拒绝本机」，
// 与 Task 26-d 注释声明的意图（引擎自身状态不计入网络级连败）相悖。
func isEngineStateNote(note string) bool {
	return note == "hard-timeout" || note == "internal-error" ||
		strings.HasPrefix(note, "budget-exhausted") ||
		strings.HasPrefix(note, "unavailable") ||
		strings.HasPrefix(note, "timeout-budget") ||
		strings.HasPrefix(note, "missing-")
}

// allAttemptsNetErr 本次链上所有尝试是否全部为「网络级失败」（status=0、非挑战页、
// 非引擎自身状态）。空尝试（全链未发起任何请求）返回 false。纯函数，表驱动测试见
// chain_test.go（Task 29-b 自 fetchPage 内联判定抽出，便于回归锁定）。
func allAttemptsNetErr(attempts []AttemptSummary) bool {
	if len(attempts) == 0 {
		return false
	}
	for _, a := range attempts {
		if a.Status != 0 || a.Blocked || isEngineStateNote(a.Note) {
			return false
		}
	}
	return true
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
