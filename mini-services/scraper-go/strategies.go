/**
 * 策略接口 + fetch 系策略工厂 + got-scraping Go 等价实现。
 *
 * 并发安全设计说明：strategyDef.run 的 warnings 由策略自持（attemptResult.warnings 返回给链层），
 * 不与调用方共享切片——硬时间闸超时后策略 goroutine 仍在后台收尾时，只会写自己的局部切片，
 * 无数据竞争（对齐 TS 语义：TS 每次尝试传入的也是独立 [] 数组，await 之后链层才合并）。
 */
package main

import (
	"context"
	"math/rand"
	"net/http"
	"strings"
	"time"
)

// strategyDef 策略定义（对齐 TS StrategyDef）
type strategyDef struct {
	name         string
	description  string
	probe        func() bool
	run          func(targetURL string, timeoutMs int64, ctx *strategyRunCtx) attemptResult
	selfRetrying bool
}

// strategyRunCtx 策略 run 的可选上下文。
// hardCtx（Task 27-c，25-a 遗留 c 收紧）：策略链硬时间闸的取消 context——超时后 cancel
// 会中止 Go 原生 HTTP 在途请求（fetchWithRedirectGuard / gotStrategyRun 经
// NewRequestWithContext 挂接），消除「硬闸已超时放行、策略 goroutine 仍空转到自身超时」
// 的有界泄漏；nil = 无取消（保持旧行为）。仅策略 goroutine 自身读写，无跨 goroutine 竞态。
type strategyRunCtx struct {
	referer     string
	proxy       string
	insecureTLS bool
	hardCtx     context.Context
}

// attemptResult 单次尝试结果（对齐 TS AttemptResult；warnings 为策略自持切片）
type attemptResult struct {
	ok          bool
	status      int
	bytes       []byte
	contentType string
	warnings    []string
	note        string
	subAttempts []SubAttempt
	retryAfter  *int64
}

// makeFetchStrategy fetch 系策略工厂：同一执行骨架 × 不同请求头画像梯子（selfRetrying=true）
func makeFetchStrategy(name, description string, profiles []headerProfile) strategyDef {
	return strategyDef{
		name:         name,
		description:  description,
		probe:        func() bool { return true }, // Go 原生 HTTP 客户端恒可用
		selfRetrying: true,                        // 内部画像梯子即是重试路径
		run: func(targetURL string, timeoutMs int64, ctx *strategyRunCtx) attemptResult {
			warnings := []string{}
			subAttempts := []SubAttempt{}
			deadline := nowMs() + timeoutMs
			var last *attemptResult
			// Task 38-a: 本策略内最近一次限流记忆（混合失败时提升返回，保住链层退避记忆）
			lastLimitedStatus := 0
			var lastLimitedRetryAfter *int64

			for _, profile := range profiles {
				// Task 35-b: 预算感知取槽（预计等待超预算时 shed，不预约不睡眠）+
				// 排队时间补偿 deadline（排队不吃服务时间窗；ixdzs8 12 车道实证：
				// 末位车道纯排队 18-30s 吃穿 20s 策略预算 → timeout-budget 全灭）
				waited, granted := acquireDomainSlotBudgeted(hostOf(targetURL), deadline, 1000)
				if !granted {
					subAttempts = append(subAttempts, SubAttempt{Profile: profile.id, OK: false, Status: 0, Ms: 0, Blocked: false, Bytes: 0, Note: "timeout-budget"})
					if last != nil {
						last.subAttempts = subAttempts // 同步快照防丢失（Task 34 P3-2 口径）
					}
					break
				}
				deadline += waited
				// 限速等待可能耗时 >1s：剩余预算必须在等待之后计算
				remaining := deadline - nowMs()
				if remaining < 1000 {
					subAttempts = append(subAttempts, SubAttempt{Profile: profile.id, OK: false, Status: 0, Ms: 0, Blocked: false, Bytes: 0, Note: "timeout-budget"})
					if last != nil {
						last.subAttempts = subAttempts // Task 34 (P3-2): budget 耗尽前 last 快照不含本条，同步防丢失
					}
					break
				}
				s0 := nowMs()
				// 显式 Referer 只覆盖「带 Referer」画像的来路；无 Referer 变体保持无 Referer（链内多样性保留）
				hdrs := profile.headers(targetURL, profile.withReferer, ctx.referer)
				r := fetchWithRedirectGuard(targetURL, hdrs, remaining, &warnings, ctx.proxy, ctx.insecureTLS, ctx.hardCtx)
				a := assess(r.status, r.bytes, r.contentType)
				ms := nowMs() - s0
				note := r.note
				if note == "" {
					note = a.note
				}
				subAttempts = append(subAttempts, SubAttempt{Profile: profile.id, OK: a.ok, Status: r.status, Ms: ms, Blocked: a.blocked, Bytes: a.size, Note: note})
				if r.warning != "" || a.warning != "" {
					w := r.warning
					if w == "" {
						w = a.warning
					}
					warnings = append(warnings, "["+profile.id+"] "+w)
				}

				if r.status == 429 || r.status == 503 {
					// Task 38-a: 记录限流状态供失败返回时提升（promoteRateLimitedStatus）
					lastLimitedStatus = r.status
					lastLimitedRetryAfter = r.retryAfter
				}
				if a.ok {
					return attemptResult{ok: true, status: r.status, bytes: r.bytes, contentType: r.contentType, warnings: warnings, subAttempts: subAttempts, retryAfter: r.retryAfter}
				}
				last = &attemptResult{ok: false, status: r.status, bytes: r.bytes, contentType: r.contentType, warnings: warnings, note: note, subAttempts: subAttempts, retryAfter: r.retryAfter}
				if r.status == 429 || r.status == 503 {
					// Task 38-a: 限流中换 UA 画像只会加重刺激（对齐 got 系「429/5xx 停止内部梯子，
					// 链层退避/健康记忆接手」口径），停止画像梯子
					break
				}
			}
			if last != nil {
				last.status, last.retryAfter = promoteRateLimitedStatus(last.status, last.retryAfter, lastLimitedStatus, lastLimitedRetryAfter)
				return *last
			}
			return attemptResult{ok: false, status: 0, bytes: []byte{}, contentType: "", warnings: warnings, note: "no-profile-attempted", subAttempts: subAttempts}
		},
	}
}

var fetchBrowserStrategy = makeFetchStrategy("fetch-browser",
	"原生 fetch + 完整 Chrome 桌面请求头（UA/Accept/Accept-Language/Referer 链/Sec-Fetch 族/客户端提示），最快最稳的默认策略",
	[]headerProfile{chromeDesktopProfile})

var fetchUaRotateStrategy = makeFetchStrategy("fetch-ua-rotate",
	"UA 轮换：Firefox → Safari（无 Referer 变体）→ Edge 桌面画像，对抗 UA 白名单类拦截",
	[]headerProfile{firefoxDesktopProfile, safariDesktopProfile, edgeDesktopProfile})

var fetchMobileStrategy = makeFetchStrategy("fetch-mobile",
	"移动端画像：Android Chrome（带 Referer）→ iPhone Safari（无 Referer），部分站点仅放行移动端 UA",
	[]headerProfile{androidChromeProfile, iphoneSafariProfile})

var fetchSpiderStrategy = makeFetchStrategy("fetch-spider",
	"搜索引擎 spider UA 降级：Googlebot → Baiduspider（仅采集公开内容，不伪造登录态/不破解验证码）",
	[]headerProfile{googlebotProfile, baiduspiderProfile})

// ==================== got-scraping 的 Go 等价实现 ====================

// headerGeneratorHeaders 随机真实桌面头（等价 header-generator chrome/edge 桌面 zh-CN）：
// 从 Chrome/Edge 桌面画像随机选一，并随机化 Accept-Language 权重形态。
func headerGeneratorHeaders(firstURL string) map[string]string {
	var base map[string]string
	if rand.Intn(2) == 0 {
		base = chromeDesktopProfile.headers(firstURL, true, "")
	} else {
		base = edgeDesktopProfile.headers(firstURL, true, "")
	}
	langs := []string{
		"zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
		"zh-CN,zh;q=0.9",
		"zh-CN,zh;q=0.9,en;q=0.8",
	}
	base["accept-language"] = langs[rand.Intn(len(langs))]
	return base
}

// gotStrategyRun 单变体（h2 → http1.1）执行：手动逐跳重定向 + SSRF + Cookie 会话。
// 语义对齐 TS got-scraping.ts：followRedirect:false 逐跳处理；429/5xx 直接结束梯子
// （换协议不会改变服务端决策，对限流中的站点追加降级请求只会加重刺激）。
func gotStrategyRun(targetURL string, timeoutMs int64, ctx *strategyRunCtx) attemptResult {
	warnings := []string{}
	subAttempts := []SubAttempt{}
	deadline := nowMs() + timeoutMs
	var lastRetryAfter *int64
	lastHTTPStatus := 0
	explicitReferer := ctx.referer
	// Task 27-c: 硬时间闸取消 context 挂接（nil → Background，保持旧行为）
	baseCtx := ctx.hardCtx
	if baseCtx == nil {
		baseCtx = context.Background()
	}
	variants := []struct {
		profile string
		noH2    bool
	}{{profile: "h2", noH2: false}, {profile: "http1.1", noH2: true}}

	// Task 34 (P3-11): 画像头在 variant 循环外生成一次——旧实现每跳重新随机，
	// 同一会话链内 UA/头在跳间跳变（真实浏览器跨跳恒定），属可被服务端识别的指纹矛盾
	variantHeaders := headerGeneratorHeaders(targetURL)
	for _, variant := range variants {
		current := targetURL
		hops := 0
		stopVariants := false
		for {
			// Task 35-b: 预算感知取槽 + 排队时间补偿（与 fetch 系同口径，见 makeFetchStrategy）
			waited, granted := acquireDomainSlotBudgeted(hostOf(current), deadline, 1000)
			if !granted {
				subAttempts = append(subAttempts, SubAttempt{Profile: variant.profile, OK: false, Status: 0, Ms: 0, Blocked: false, Bytes: 0, Note: "timeout-budget"})
				break
			}
			deadline += waited
			remaining := deadline - nowMs()
			if remaining < 1000 {
				subAttempts = append(subAttempts, SubAttempt{Profile: variant.profile, OK: false, Status: 0, Ms: 0, Blocked: false, Bytes: 0, Note: "timeout-budget"})
				break
			}
			s0 := nowMs()
			hopHeaders := map[string]string{}
			for hk, hv := range variantHeaders {
				hopHeaders[hk] = hv
			}
			if explicitReferer != "" {
				hopHeaders["referer"] = explicitReferer
			} else {
				hopHeaders["referer"] = urlParseHost(targetURL)
			}
			hopHost := hostOf(current)
			if hopCookie := cookieHeaderFor(hopHost, strings.HasPrefix(current, "https:")); hopCookie != "" {
				hopHeaders["cookie"] = hopCookie
			}

			tr, trWarn := transportFor(ctx.proxy, ctx.insecureTLS, variant.noH2)
			if trWarn != "" {
				warnings = append(warnings, trWarn)
			}
			req, err := http.NewRequestWithContext(baseCtx, "GET", current, nil)
			if err != nil {
				subAttempts = append(subAttempts, SubAttempt{Profile: variant.profile, OK: false, Status: 0, Ms: nowMs() - s0, Blocked: false, Bytes: 0, Note: "bad-url"})
				stopVariants = true
				break
			}
			for k, v := range hopHeaders {
				req.Header.Set(k, v)
			}
			client := manualClient(tr, time.Duration(remaining)*time.Millisecond)
			res, err := client.Do(req)
			if err != nil {
				// Task 38-a: 分类抽 netErrNote（与 fetch 系同口径）——硬时间闸 hcancel()
				// 中止的在途请求按 engine-cancel 归引擎自状态，不再落 network-error
				note := netErrNote(err)
				subAttempts = append(subAttempts, SubAttempt{Profile: variant.profile, OK: false, Status: 0, Ms: nowMs() - s0, Blocked: false, Bytes: 0, Note: note})
				warnings = append(warnings, "got-scraping 网络错误（"+variant.profile+"）: "+note)
				break
			}
			status := res.StatusCode
			hopHTTPS := strings.HasPrefix(current, "https:")

			// 3xx：解析 Location → 协议白名单 + 逐跳 SSRF 校验 → 限速后请求下一跳
			if isRedirectStatus(status) {
				lastHTTPStatus = status                       // Task 34 (P3-3): 终态 3xx 时 status 不再回 0（对齐 curl 系口径）
				recordResponseCookies(hopHost, res, hopHTTPS) // 中间跳下发的 Set-Cookie 也要入会话
				loc := res.Header.Get("Location")
				_ = res.Body.Close()
				if loc == "" {
					subAttempts = append(subAttempts, SubAttempt{Profile: variant.profile, OK: false, Status: status, Ms: nowMs() - s0, Blocked: false, Bytes: 0, Note: "redirect-no-location"})
					break
				}
				next := urlJoin(loc, current)
				if next == nil {
					subAttempts = append(subAttempts, SubAttempt{Profile: variant.profile, OK: false, Status: status, Ms: nowMs() - s0, Blocked: false, Bytes: 0, Note: "redirect-bad-location"})
					warnings = append(warnings, "got-scraping 非法 Location 头: "+truncateStr(loc, 200))
					break
				}
				if next.Scheme != "http" && next.Scheme != "https" {
					subAttempts = append(subAttempts, SubAttempt{Profile: variant.profile, OK: false, Status: status, Ms: nowMs() - s0, Blocked: false, Bytes: 0, Note: "ssrf-blocked"})
					warnings = append(warnings, "SSRF 防护: 重定向到非 http/https 协议已拒绝: "+next.Scheme)
					stopVariants = true
					break
				}
				check := assertHostPublic(next.Hostname())
				if !check.ok {
					subAttempts = append(subAttempts, SubAttempt{Profile: variant.profile, OK: false, Status: status, Ms: nowMs() - s0, Blocked: false, Bytes: 0, Note: "ssrf-blocked"})
					warnings = append(warnings, "SSRF 防护: 重定向终点 "+check.reason)
					stopVariants = true
					break
				}
				hops++
				if hops > maxRedirectHops {
					subAttempts = append(subAttempts, SubAttempt{Profile: variant.profile, OK: false, Status: status, Ms: nowMs() - s0, Blocked: false, Bytes: 0, Note: "too-many-redirects"})
					warnings = append(warnings, "got-scraping 重定向超过 "+itoa(maxRedirectHops)+" 跳，已停止")
					break
				}
				current = next.String()
				continue
			}

			recordResponseCookies(hopHost, res, hopHTTPS)
			body := readBodyCapped(res)
			contentType := body.contentType
			if body.note == "too-large" {
				lastHTTPStatus = status
				subAttempts = append(subAttempts, SubAttempt{Profile: variant.profile, OK: false, Status: status, Ms: nowMs() - s0, Blocked: false, Bytes: body.size, Note: "too-large"})
				warnings = append(warnings, "got-scraping 响应超过 "+itoa(maxBytes)+"B 上限，已放弃")
				stopVariants = true
				break
			}
			a := assess(status, body.bytes, contentType)
			subAttempts = append(subAttempts, SubAttempt{Profile: variant.profile, OK: a.ok, Status: status, Ms: nowMs() - s0, Blocked: a.blocked, Bytes: a.size, Note: a.note})
			if a.warning != "" {
				warnings = append(warnings, "["+variant.profile+"] "+a.warning)
			}
			if status >= 400 {
				warnings = append(warnings, "got-scraping 收到 HTTP "+itoa(status))
			}
			if status == 429 || status == 503 {
				if ra := parseRetryAfterMs(res.Header.Get("Retry-After")); ra != nil {
					lastRetryAfter = ra
				}
			}
			if a.ok {
				return attemptResult{ok: true, status: status, bytes: body.bytes, contentType: contentType, warnings: warnings, subAttempts: subAttempts, retryAfter: nil}
			}
			lastHTTPStatus = status
			// HTTP 状态码失败（含 429/5xx）直接结束梯子
			if status >= 400 {
				stopVariants = true
			}
			break
		}
		if stopVariants {
			break
		}
	}
	return attemptResult{ok: false, status: lastHTTPStatus, bytes: []byte{}, contentType: "", warnings: warnings, note: "all-variants-failed", subAttempts: subAttempts, retryAfter: lastRetryAfter}
}

var gotScrapingStrategy = strategyDef{
	name:         "got-scraping",
	description:  "随机真实浏览器头 + Go 原生 HTTP/2，失败自动降级 HTTP/1.1（got-scraping 策略的 Go 等价实现），对抗请求头/协议指纹拦截",
	probe:        func() bool { return true },
	selfRetrying: true,
	run:          gotStrategyRun,
}

// urlParseHost 取 origin+"/"（Referer 缺省值）
func urlParseHost(raw string) string {
	u, err := urlParse(raw)
	if err != nil {
		return ""
	}
	return u.Scheme + "://" + u.Host + "/"
}

// netErrNote Go 传输层网络错误 → 结构化备注（fetch 系 fetchWithRedirectGuard / got 系共用）。
// Task 38-a: "context canceled" 单独归类 engine-cancel——策略链硬时间闸超时 hcancel() 中止
// 在途请求属引擎自状态（站点只是慢/挂起，未拒绝本机）。旧实现按兜底 network-error 落账：
// 硬闸超时与策略 goroutine 收尾存在毫秒级竞态（select 双 ready），竞态下 network-error 会被
// 摊平进 attempts → hasRealNetworkAttempt=true → noteChainFailure(allNetErr=true) →
// netStreak 2 次即熔断——把「站点响应停滞（硬闸兜底）」误判成「站点连接层拒绝本机」提前熔断。
func netErrNote(err error) string {
	le := strings.ToLower(err.Error())
	if strings.Contains(le, "context canceled") {
		return "engine-cancel"
	}
	if strings.Contains(le, "timeout") || strings.Contains(le, "deadline") {
		return "timeout"
	}
	return "network-error"
}

// promoteRateLimitedStatus Task 38-a: 混合失败时的限流状态提升。
// 策略内部画像/协议梯子可能在多子尝试间经历「先 429/503 后 403」的混合失败：末位状态（403 等
// 确定性失败）若原样返回，链层 res.status==429/503 判定失败 → noteRateLimited/AIMD 退避记忆
// 全部丢失 → 下一条链立刻重打限流中的站点（健康度面失明）。本函数在「本策略内发生过限流且
// 末位状态非限流」时把返回状态提升为限流码（attempts 明细不受影响——子尝试自带各跳真实状态码，
// 提升只作用于链层策略级 status 的健康记忆消费点）。
func promoteRateLimitedStatus(finalStatus int, finalRA *int64, limitedStatus int, limitedRA *int64) (int, *int64) {
	if limitedStatus == 0 || finalStatus == 429 || finalStatus == 503 {
		return finalStatus, finalRA
	}
	return limitedStatus, limitedRA
}

// runWithHardGate 策略硬时间闸：任何策略都不得挂死整条链。底层库自身超时可能失效，
// 以「链剩余预算 + 2.5s 余量」为硬上限强制放行。超时后策略 goroutine 继续在后台收尾
// （仅写自己的局部状态，无共享竞争），结果被丢弃。
// Task 27-c（25-a 遗留 c 收紧）：f 接收取消 context——超时分支立即 cancel，挂接该 context
// 的 Go 原生 HTTP 请求（fetch 系/got-scraping）即刻中止，策略 goroutine 毫秒级退出而非
// 空转到自身超时；curl 系/browser 桥接为外部进程（自带 --max-time/SIGALRM 看门狗，
// 残余后台收尾 ≤3s，维持有界）；正常完成路径同样 cancel 释放 context 资源。
func runWithHardGate(f func(context.Context) attemptResult, hardMs int64, budgetNoteMs int64) (attemptResult, bool) {
	type out struct {
		res attemptResult
	}
	hctx, hcancel := context.WithCancel(context.Background())
	done := make(chan out, 1)
	go func() {
		defer hcancel() // 正常完成也释放（幂等，与超时分支的 cancel 不冲突）
		done <- out{res: f(hctx)}
	}()
	timer := time.NewTimer(time.Duration(hardMs) * time.Millisecond)
	defer timer.Stop()
	select {
	case o := <-done:
		return o.res, false
	case <-timer.C:
		hcancel() // Task 27-c: 通知在途 HTTP 请求立即中止
		return attemptResult{
			ok: false, status: 0, bytes: []byte{}, contentType: "",
			warnings: []string{"策略超过硬性时间闸（" + itoa(int(budgetNoteMs/1000)) + "s），已强制跳过（底层库超时失效保护）"},
			note:     "hard-timeout",
		}, true
	}
}
