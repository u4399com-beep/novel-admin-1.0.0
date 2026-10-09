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

// allStrategies 策略链（Task 102-a 三层架构重排，依据微信文章《实测 iv8 vs CloakBrowser》
// 的核心论点：「真实浏览器可能根本不应该成为爬虫系统的默认执行环境；HTTP、iv8、CloakBrowser
// 三者组合，才更接近大规模 Web 数据采集的合理架构」）：
//
//	Tier 1 HTTP 层（毫秒级，默认）：fetch-browser → fetch-ua-rotate → fetch-mobile →
//	                              fetch-spider → curl-impersonate → fetch-curl → got-scraping
//	Tier 2 iv8 轻执行层（~100ms）：fetch-iv8（V8 补环境跑页内 JS 算 cookie/参数/补 DOM，
//	                              不启动 Chromium；文章实测纯脚本吞吐 ~100 倍于真实浏览器）
//	Tier 3 重渲染层（秒级+）：    fetch-cloak（隐身 Chromium，源码级指纹伪装）→ browser
//	                              （Playwright 桥接）——深度 SPA/WAF 指纹挑战兜底
//
// 与 R101 链序的差异：fetch-cloak 从 fetch-browser 之后（第 2 位）移至 Tier 3——
// 单页 ~3.4s + ~1GB 进程树的成本不为新站点默认承担；fetch-iv8 从链尾移至 Tier 2——
// 所有纯 HTTP 手段失败后先试百倍轻的脚本执行层（专治 JS 种 cookie/计算参数站），
// 真浏览器只在轻手段也失败后才出手。运行时两个机制把「真需要的站点」路由到高成本层：
//   - 亲和记忆：recordStrategySuccess 按 host 记住攻克策略，后续请求直接提位链首；
//   - 挑战感知跳层：失败响应若呈 JS-cookie/JS-跳转形态 → 把 fetch-iv8 提前（跳过剩余
//     Tier 1）；平台级 WAF 强特征 → 把 fetch-cloak 提前（指纹对抗轻手段大概率无效）。
var allStrategies = []strategyDef{
	// ---- Tier 1：HTTP 层（毫秒级，默认执行环境） ----
	fetchBrowserStrategy,
	fetchUaRotateStrategy,
	fetchMobileStrategy,
	fetchSpiderStrategy,
	curlImpersonateStrategy,
	curlPlainStrategy, // Task 25: 普通 curl 诚实客户端策略（针对拦截已知爬虫指纹但放行系统 curl 的 WAF，5165.org 实证）
	gotScrapingStrategy,
	// ---- Tier 2：iv8 轻执行层（~100ms 级，V8 补环境执行页内 JS） ----
	fetchIv8Strategy, // Task 102-a: 从链尾上移——Tier 1 全灭后的第一跳升，成本 ~1/100 于真浏览器
	// ---- Tier 3：重渲染层（秒级+，真浏览器兜底） ----
	fetchCloakStrategy, // Task 102-a: 从链首后第 2 位下移——重渲染只服务深度 SPA/指纹挑战站点
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
	ruleCookies       string // Task 53: 规则级静态 cookie 底座（"k=v; k2=v2"，用户人工过验后提供；空=无）
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

// listStrategies 可用抓取策略及状态（Task 102-a：含三层架构层级标注）
func listStrategies() []StrategyInfo {
	out := make([]StrategyInfo, 0, len(allStrategies))
	for i := range allStrategies {
		s := &allStrategies[i]
		avail := false
		func() {
			defer func() { _ = recover() }()
			avail = s.probe()
		}()
		out = append(out, StrategyInfo{Name: s.name, Description: s.description, Available: avail, Tier: s.tier})
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
	minBudget := int64(timeoutMs + 8_000)
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
		// Task 38-a: host 键统一小写（hostOf 同口径）——host 同时用作限速槽/健康度熔断/
		// 策略亲和/限流记忆的 key，而各策略层取槽走 hostOf()（已小写）；链层若保留原样，
		// URL 带大写域名（http://Example.COM/）时同站点会分裂出两个槽桶/两份健康度，
		// 1.2s 合规限速被稀释、熔断/退避记忆互不可见
		host = strings.ToLower(u.Host)
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

	// Task 53（规则级静态 cookie 底座）：规则配置了人工过验会话 cookie 时，每次抓取前幂等
	// 重种入 host 桶（同名覆盖/到期自补/后续 Set-Cookie 照常接管，见 seedRuleCookies 注）。
	// 位置在 SSRF 校验后：非法目标不种；在熔断检查前：用户配置 cookie 即明确预期可通，
	// 历史连败熔断不应阻断人工放行后的重试。
	// Task 53-a 审计修复②：头非空但 0 条入库（属性段/非法名/超长/控制字符全被拒）必须
	// 显式告警——静默无效配置是排障黑洞（运维以为已种底座，实为零注入）。
	if opts.ruleCookies != "" {
		if n := seedRuleCookies(host, opts.ruleCookies); n > 0 {
			warnings = append(warnings, "[rule-cookies] 已注入 "+strconv.Itoa(n)+" 条规则静态 cookie 到 "+host+" 会话桶")
		} else {
			warnings = append(warnings, "[rule-cookies] 规则 cookie 头未解析出任何合法条目（期望 \"k=v; k2=v2\" 形态；Set-Cookie 属性段/非法名/超长/控制字符均被拒），本次未注入")
		}
	}

	// 站点级代理池（规则可配多个逗号分隔）：每次 fetchPage 调用轮换一个出口，
	// 失效代理由后续请求自然绕过（免费公共代理单点易失效的多出口容错）。
	// Task 58-a（E17）：池在熔断检查前解析——熔断按 (主机×出口) 记账，入口需知道本次
	// 候选出口集合（无池=仅直连 [""]；有池=仅池内代理，直连不参与）。
	proxyPool := []string{}
	if opts.proxy != "" {
		for _, p := range strings.Split(opts.proxy, ",") {
			p = strings.TrimSpace(p)
			if p != "" {
				proxyPool = append(proxyPool, p)
			}
		}
	}
	egresses := proxyPool
	if len(egresses) == 0 {
		egresses = []string{""}
	}

	// 主机熔断：连败达阈值的主机快速结构化失败，不空烧 55s 预算；
	// 冷却结束自动半开恢复，成功一次即复位。显式指定策略时视为人工调试，跳过熔断。
	// Task 58-a（E17）：熔断按 (主机×出口) 独立记账，仅当本次抓取的全部候选出口均处于
	// 熔断态才快速失败——直连被封锁时改配代理后新出口立即重试（旧实现裸 host 键会把
	// 直连连败的熔断持续拦截新出口 ~370s+，主线实测痛点）；部分出口熔断时链内
	// pickProxy 优先跳过熔断出口（临时降权不删除）。
	if opts.requestedStrategy == "" {
		if circuitMs, allOpen := egressCircuitsAllOpen(host, egresses); allOpen {
			// R97（代理池 407 直连兑底）：全部代理出口熔断且每个出口近期都因 HTTP 407
			//（代理要求认证/已改认证策略）失败——407 是代理本体的拒绝而非站点封锁，
			// 直连大概率可用。此时不再快速失败，而是把直连出口追加进本轮候选集合
			//（仅本次请求生效，规则 proxy 字段不动，待出口池自愈把 407 死口换血）。
			// trxsw 实证：规则只挂了一个需要认证的免费代理，全策略 407 → 全池熔断 →
			// 直连不参与 → 规则永久卡死。追加直连后引擎立刻恢复产出。
			if len(proxyPool) > 0 && egressAllAuthBroken(host, egresses) {
				warnings = append(warnings, "[chain] 全部代理出口因 HTTP 407（代理要求认证或已失效）熔断，本次追加直连出口兑底（代理池将由出口池自愈清洗死口）")
				proxyPool = append(append([]string{}, proxyPool...), "")
				egresses = append(append([]string{}, egresses...), "")
			} else {
				detail := "主机 " + host + " 连续整链失败已达熔断阈值，剩余冷却 " +
					strconv.Itoa(int((circuitMs+999)/1000)) + "s 后自动恢复尝试（一次成功即复位）"
				if len(egresses) > 1 {
					detail += "；当前规则 " + itoa(len(egresses)) + " 个出口全部熔断（熔断按出口独立记账，更换/新增代理出口后立即重试）"
				} else if egresses[0] != "" {
					detail += "；当前出口 " + reProxyCred.ReplaceAllString(egresses[0], "//***@") + " 熔断（熔断按出口独立记账，更换代理出口后立即重试）"
				} else {
					detail += "；直连出口熔断（熔断按出口独立记账）"
				}
				return fetchPageResult{
					ok: false, html: "", encoding: "", strategy: opts.requestedStrategy, status: 0, warnings: warnings,
					attempts: attempts, robots: RobotsSummary{CrawlDelayMs: nil},
					elapsedMs: nowMs() - t0,
					err:       "目标主机熔断中（近期连续整链失败，暂停请求以防刺激反爬/空耗预算）",
					detail:    detail,
				}
			}
		}
	}

	robots := checkRobots(rawURL)
	warnings = append(warnings, robots.warnings...)
	// Task 44-a（E2·反反爬/合规增强）：robots.txt Crawl-delay 采纳为主机礼貌间隔下限——
	// 源站明示的采集节奏优先于本地 1.2s 默认（只升不降、上界 30s，warn-only 不变）。
	// 见 ratelimit.go noteCrawlDelayFloor 注；active 期由本调用点随 robots 缓存自动维持
	if robots.info.crawlDelayMs != nil && *robots.info.crawlDelayMs > 0 {
		noteCrawlDelayFloor(host, int64(*robots.info.crawlDelayMs))
	}

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

	// P0-1（R107 提速·慢通道快速复探，sessionlock.go 详注）：亲和把 browser/cloak
	// 等慢策略锁定链首后，一次性挑战站点（挑战 cookie 已落共享会话桶）的毫秒级
	// HTTP 策略再无出场机会。此处按周期把首个可用 Tier 1 策略临时插到链首复探：
	// 命中即亲和自动接管（下章起回快通道）；未命中仅多付一次毫秒级探测，本轮
	// 照旧由慢策略出正文（预算闸保证复探绝不挤占正章产出）。
	if !slowProbeOff && opts.requestedStrategy == "" && slowLockProbeDue(host) {
		preferred := getPreferredStrategy(host)
		if strategyTierByName(preferred) == tierStrategyBrowser && deadline-nowMs() > slowLockProbeReserveMS {
			if p := firstAvailableTier1(); p != nil {
				slowLockNoteProbe(host)
				order = append([]strategyDef{*p}, order...)
				warnings = append(warnings, "[fast-probe] 主机 "+host+" 慢策略（"+preferred+"）服务中，已插快通道复探 "+p.name+"（挑战 cookie 落桶后 HTTP 常可直接放行；未命中不影响本轮慢策略出正文）")
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
	// Task 102-a（三层架构·挑战感知跳层）：最近一次失败策略的完整结果（挑战分类跳层用）
	var lastFailRes *attemptResult
	// Task 58-a（E17）：本次链上真实网络尝试的出口归因集合（首次使用序），供整链失败
	// 时按出口记账熔断。纯引擎自状态尝试（排队饱和/预算耗尽/硬闸）不入集合——
	// 引擎自拥堵不惩罚站点/出口（Task 35-b 语义在出口维度延续）。
	egressUsed := map[string]bool{}
	egressList := []string{}

	// 站点级代理池轮换出口。Task 58-a（E17）：熔断中的出口临时降权（不删除）——优先在
	// 未熔断出口间轮换；全部熔断时照旧全池轮转（冷却到期自然半开恢复；入口已在
	// 全部熔断时快速失败，此处仅并发窗口兜底）。无池时恒直连（""）。
	pickProxy := func() string {
		if len(proxyPool) == 0 {
			return ""
		}
		pool := proxyPool
		healthy := make([]string, 0, len(proxyPool))
		for _, p := range proxyPool {
			if egressCircuitOpenMs(host, p) <= 0 {
				healthy = append(healthy, p)
			}
		}
		if len(healthy) > 0 {
			pool = healthy
		}
		// Task 33-a: int() 转换在 32 位平台字长下会回绕为负，负数取模得负下标 → 切片越界
		// panic。先取模再补正，使游标轮换与平台字长解耦（64 位下语义不变）。
		idx := int(proxyCursor.Add(1))
		m := idx % len(pool)
		if m < 0 {
			m += len(pool)
		}
		return pool[m]
	}

	for si := 0; si < len(order); si++ {
		strat := &order[si]
		siAttemptsFrom := len(attempts) // Task 35-b: 本策略 attempts 起点（策略间退避门控用）
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
			// Task 35-b: 预算感知取槽——预计等待将超出剩余预算时不预约槽位、不睡眠，
			// 结构化快速失败（旧实现照样预约+锁外睡眠到预算耗尽，12 车道饱和时整波
			// 空耗 20s×N 且 sleep 不可被硬时间闸取消）。备注含 budget-exhausted 前缀：
			// ①isEngineStateNote 归零网络级连败计数 ②backend isRateLimitErrText 按关键词降档车道
			// Task 35-b 增强（链层排队上界=单策略预算）：链层取槽只是预等待，策略随后仍会以
			// 自身 timeoutMs 预算再取一次槽（双重限速为 TS 对齐语义，Task 34 P3-17）——
			// 排队若超过 timeoutMs+2s，策略层取槽必然 shed，链层先睡后废纯属白占车道
			//（ixdzs8 task8 实测：12 车道饱和时链层放行 30s 排队、策略层照样 shed，
			// 单章 30-50s 零产出且活跌车道被睡眠占满）。链层排队上界钳到
			// now+timeoutMs+2s（chainSlotDeadline），饱和时快速 shed，backend 降档信号秒级生效
			waited, granted := acquireDomainSlotBudgeted(host, chainSlotDeadline(deadline, int64(timeoutMs), nowMs()), 1500)
			if !granted {
				attempts = append(attempts, AttemptSummary{Strategy: strat.name, OK: false, Status: 0, Ms: 0, Note: "budget-exhausted（限速排队饱和，未预约槽位快速失败，backend 请降并发）"})
				break
			}
			_ = waited // 链层不补偿 deadline：紧随其后的 remaining 重算已把排队时间计入链预算
			remaining := deadline - nowMs()
			if remaining < 1500 {
				attempts = append(attempts, AttemptSummary{Strategy: strat.name, OK: false, Status: 0, Ms: 0, Note: "budget-exhausted（限速排队后预算耗尽）"})
				break
			}
			effTimeout := int64(timeoutMs)
			if remaining-500 < effTimeout {
				effTimeout = remaining - 500
			}
			// Task 34 (P3-24): 旧版 effTimeout<1000 兜底是死分支——入口已保证 remaining≥1500，
			// remaining-500≥1000，钳制永不触发。删除。
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
			attemptsBefore := len(attempts) // E17: 本次尝试的 attempts 起点（出口归因真实网络判定用）
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
			// E17: 本尝试含真实网络请求时，把其出口纳入整链失败的归因集合
			if hasRealNetworkAttempt(attempts[attemptsBefore:]) && !egressUsed[ctx.proxy] {
				egressUsed[ctx.proxy] = true
				egressList = append(egressList, ctx.proxy)
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
				// P0-1（sessionlock.go）：快慢通道双向自愈——Tier 1/2 成功清慢锁
				//（快通道接管，停止复探）；Tier 3 成功标记/续期慢锁（开启周期复探）
				if strat.tier <= tierStrategyIv8 {
					slowLockClear(host)
				} else {
					slowLockMark(host)
				}
				noteChainSuccess(host, ctx.proxy)                // E17: 仅复位本次成功出口的熔断（其余出口记忆保留）
				statsRecordChainOK(host, strat.name, nowMs()-t0) // E20: 整链成功计数（主机×策略）
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
			if !res.ok {
				lastFailRes = &res
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

		// Task 102-a（三层架构·挑战感知跳层）：刚失败策略的响应呈挑战形态时，按
		// recommendTierForChallenge 推荐把对应层首个策略提前到下一跳（成本递增架构下
		// 智能跳层，避免在已知无效的层里烧穿预算）：
		//   - JS 计算 cookie/JS 跳转壳 → 把 fetch-iv8（Tier 2）提前，跳过剩余 Tier 1；
		//   - 平台级 WAF 强特征 → 把 fetch-cloak（Tier 3）提前，指纹对抗轻手段大概率无效。
		// 显式指定策略时是单策略链（长度 1），本分支天然不触发。
		if lastFailRes != nil && len(lastFailRes.bytes) > 0 && si < len(order)-1 {
			if tier := recommendTierForChallenge(lastFailRes.bytes); tier > 0 {
				if newOrder, promoted := promoteTierAfter(order, si, tier); promoted != "" {
					order = newOrder
					warnings = append(warnings, "[tier] 挑战形态推荐 Tier "+itoa(tier)+"（"+tierName(tier)+"），已把策略 "+promoted+" 提前至下一跳")
				}
			}
		}

		// 策略间退避：429/5xx/网络错误 → 进入下一策略前显式指数退避+jitter。
		// 剩余预算 <3s 时不再退避（宁可靠限速器自身 1.2s 间隔，也不突破 55s 硬上限）；
		// 最后一个策略后无需退避。
		// Task 35-b: 纯引擎自状态失败（排队饱和 shed/预算耗尽/策略不可用）不退避——
		// 退避是对「目标站网络层受刺激」的礼貌，引擎自身没发过请求就无需客气；
		// ixdzs8 task8 实测：饱和链 8 策略 × 500-750ms 退避 ≈ 每章白烧 4-6s 且推迟
		// backend 拿到 budget-exhausted 降档信号的时点。
		lastStrategyHadNet := hasRealNetworkAttempt(attempts[siAttemptsFrom:])
		if si < len(order)-1 && isRetryableStatus(lastStatus) && lastStrategyHadNet {
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
	// Task 35-b: 整链未发起任何真实网络请求（纯引擎自状态：排队饱和 shed/预算耗尽/策略不可用）
	// 时不再计连败——hosthealth 度量的是站点健康度；ixdzs8 task7 实证：12 车道排队饱和的
	// 零网络链失败把 strikes 推到 6，熔断冷却指数涨到 600s，半开重试又一次排队超时 →
	// 10min 锁死。引擎自拥堵不应惩罚站点。
	// Task 58-a（E17）：熔断按出口记账——归因集合=真实网络尝试实际使用的出口（首次使用序）；
	// 理论上 hasRealNetworkAttempt=true 时 egressList 非空（每条真实尝试均有出口归属），
	// 空列表兜底为直连出口保持可归因。
	if hasRealNetworkAttempt(attempts) {
		list := egressList
		if len(list) == 0 {
			list = []string{""}
		}
		noteChainFailure(host, allAttemptsNetErr(attempts), list, allAttemptsProxyAuth(attempts))
	}
	// E20: 整链失败计数（挑战/断网分类与 hosthealth 同口径；纯引擎自状态不进站点桶）。
	// 61-R9: 真实流量闸改传 hasRealNetworkAttempt(attempts)——与上方 noteChainFailure 的
	// 连败闸同源同函数，修复混合链（真实网络失败尝试+引擎自状态尝试）下主机桶漏记 fail
	statsRecordChainFail(host, nowMs()-t0, sawChallenge, allAttemptsNetErr(attempts), int64(lastStatus), hasRealNetworkAttempt(attempts))

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

// chainSlotDeadline Task 35-b: 链层取槽的排队上界 = min(链预算 deadline, now+timeoutMs+2s)。
// 纯函数（表驱动测试见 audit35b_test.go）。timeoutMs≤0 视为无单策略约束（退化为链 deadline）。
func chainSlotDeadline(chainDeadline, timeoutMs, now int64) int64 {
	if timeoutMs <= 0 {
		return chainDeadline
	}
	if cap := now + timeoutMs + 2000; cap < chainDeadline {
		return cap
	}
	return chainDeadline
}

// promoteTierAfter（Task 102-a·挑战感知跳层）纯函数：在 order[si+1:] 里找第一个
// tier 匹配的策略并移动到 si+1 位置（原 si+1..j-1 依次后移，其余保序）。
//   - 目标已在 si+1 → 原切片原样返回，无提升；
//   - 后续无该层策略（或全部探测不可用不可知）→ 原样返回；
//   - 返回值第二参为被提前的策略名（空串=未动）。
//
// 必须 copy-on-write：order 可能直接引用 allStrategies 共享底层数组（pickOrder 默认路径），
// 原地交换会污染进程级全局链序（与亲和提位同款约束）。
func promoteTierAfter(order []strategyDef, si int, tier int) ([]strategyDef, string) {
	for j := si + 1; j < len(order); j++ {
		if order[j].tier != tier {
			continue
		}
		if j == si+1 {
			return order, "" // 已在下一跳位置
		}
		picked := order[j]
		out := make([]strategyDef, 0, len(order))
		out = append(out, order[:si+1]...)
		out = append(out, picked)
		out = append(out, order[si+1:j]...)
		out = append(out, order[j+1:]...)
		return out, picked.name
	}
	return order, ""
}

// tierName 层级中文名（警告文案/观测透出用）
func tierName(tier int) string {
	switch tier {
	case tierStrategyHTTP:
		return "HTTP 层"
	case tierStrategyIv8:
		return "iv8 轻执行层"
	case tierStrategyBrowser:
		return "重渲染层"
	default:
		return "未知层"
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
	// Task 38-a: engine-cancel = 硬时间闸 hcancel() 中止在途请求（netErrNote 归类），引擎自状态
	return note == "hard-timeout" || note == "internal-error" || note == "queue-saturated" ||
		note == "engine-cancel" ||
		strings.HasPrefix(note, "budget-exhausted") ||
		strings.HasPrefix(note, "unavailable") ||
		strings.HasPrefix(note, "timeout-budget") ||
		strings.HasPrefix(note, "missing-")
}

// hasRealNetworkAttempt Task 35-b: 本次链上是否发起过至少一次真实网络尝试（网络层发出过
// 请求或收到过响应）。纯引擎自状态（排队饱和/预算耗尽/策略不可用/missing-binary/内部 panic）
// 不算——hosthealth 连败计数与熔断只应由站点真实行为驱动（见 fetchPage 尾部调用点注释）。
func hasRealNetworkAttempt(attempts []AttemptSummary) bool {
	for _, a := range attempts {
		if a.Status != 0 || a.Blocked {
			return true
		}
		if !isEngineStateNote(a.Note) {
			return true // status=0 但备注非引擎自状态：network-error/timeout 等真实网络层证据
		}
	}
	return false
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

// allAttemptsProxyAuth 本次链上所有带 HTTP 状态的失败尝试是否全部为 407（代理认证失败）
// 且至少存在一条——R97 链层直连兜底的归因信号：407 只能由代理本体发出（要求认证/代理
// 已改认证策略），与目标站行为无关。挑战页（Blocked）不计入（403/挑战与代理无关也可能
// 被 Blocked 标记）；引擎自状态（status=0）不参与判定。纯函数，表驱动测试见 audit97a_test.go。
func allAttemptsProxyAuth(attempts []AttemptSummary) bool {
	sawHTTP := false
	for _, a := range attempts {
		if a.Status == 0 || a.Blocked || isEngineStateNote(a.Note) {
			continue
		}
		sawHTTP = true
		if a.Status != 407 {
			return false
		}
	}
	return sawHTTP
}

func containsStr(arr []string, v string) bool {
	for _, s := range arr {
		if s == v {
			return true
		}
	}
	return false
}
