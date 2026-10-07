/**
 * 侧车策略（Task 101-a）：fetch-cloak / fetch-iv8。
 *
 * 链序（chain.go allStrategies）：
 *   - fetch-cloak 插在 fetch-browser 之后：同为完整浏览器渲染车道，CloakBrowser 是
 *     原生 fetch + 渲染兜底的「加强版」（源码级指纹伪装 + 隐身 Chromium），前序失败
 *     后先于其余 UA 梯子尝试（能过盾时后面的梯子都省了）；
 *   - fetch-iv8 链尾：所有 UA/curl/浏览器策略之后的轻量兜底——站点已经对真实浏览器
 *     渲染都不放行时，最后一个「纯 JS 执行」手段专治 JS 计算 cookie/参数的站。
 *
 * 与既有策略的一致性：
 *   - 域槽/限速：acquireDomainSlotBudgeted 同口径取 host 槽（礼貌间隔红线不变）；
 *   - 挑战页判定：assess() 同口径（侧车带回的 HTML 若仍是挑战壳，链继续下一策略）；
 *   - 亲和：成功后 recordStrategySuccess(host, name) 由链层统一记账，侧车策略
 *     下次自动提位（与其他策略无差别）；
 *   - cookie 会话：/iv8 返回的 document.cookie 回存引擎 jar（sidecarRecordCookies），
 *     「首访 JS 种 cookie、二访放行」站点的会话链路与 browser 策略同语义。
 *
 * 错误语义（与 isEngineStateNote 契约对齐）：
 *   - 侧车调用层失败（拒连/超时/非法响应）→ note "unavailable-sidecar"（前缀命中
 *     isEngineStateNote 的 "unavailable"）——侧车是引擎自有基础设施，其故障不计入
 *     站点网络级连败，不触发熔断误判；
 *   - 侧车业务层失败（ok:false，站点拒绝/渲染异常）→ status 透传（多为 0），note
 *     "cloak-render-failed"/"iv8-run-failed"——侧车确实向目标站发起了请求，属真实
 *     网络证据，正常参与健康度记账。
 */
package main

// sidecarStrategyRun 两个侧车策略的共享执行骨架（域槽 → 调用 → assess → 结果映射）
func sidecarStrategyRun(kind, targetURL string, timeoutMs int64, ctx *strategyRunCtx) attemptResult {
	warnings := []string{}
	deadline := nowMs() + timeoutMs
	// 预算感知取槽（与 fetch 系/got/curl 系同口径）：侧车策略对目标站的请求节奏
	// 同样受 per-host 域槽治理——礼貌间隔/突发抑制/AIMD 全部生效
	waited, granted := acquireDomainSlotBudgeted(hostOf(targetURL), deadline, 1000)
	if !granted {
		return attemptResult{ok: false, status: 0, bytes: []byte{}, contentType: "",
			warnings: warnings, note: "timeout-budget"}
	}
	deadline += waited // 排队时间补偿：排队不吃服务时间窗
	remaining := deadline - nowMs()
	if remaining < 1000 {
		return attemptResult{ok: false, status: 0, bytes: []byte{}, contentType: "",
			warnings: warnings, note: "timeout-budget"}
	}

	s0 := nowMs()
	// 侧车统一使用引擎进程级保鲜 Chrome UA（与 browser 桥接车道同款 UA 派生口径）
	ua := chromeUA

	if kind == "cloak" {
		resp, err := sidecarCloakFetch(targetURL, remaining, ctx.proxy, ua)
		ms := nowMs() - s0
		if err != nil {
			return attemptResult{ok: false, status: 0, bytes: []byte{}, contentType: "",
				warnings:    append(warnings, "CloakBrowser 侧车调用失败: "+errShort(err)),
				note:        "unavailable-sidecar",
				subAttempts: []SubAttempt{{Profile: "cloak-sidecar", OK: false, Status: 0, Ms: ms, Note: "unavailable-sidecar"}}}
		}
		if !resp.OK {
			return attemptResult{ok: false, status: resp.Status, bytes: []byte{}, contentType: "",
				warnings:    append(warnings, "CloakBrowser 渲染失败: "+errTextOr(resp.Error, "unknown")),
				note:        "cloak-render-failed",
				subAttempts: []SubAttempt{{Profile: "cloak-sidecar", OK: false, Status: resp.Status, Ms: ms, Blocked: false, Bytes: 0, Note: "cloak-render-failed"}}}
		}
		body := []byte(resp.HTML)
		// Task 54（E15）口径：侧车 payload 不含响应头，serverChallenge=false 由体判定兜底
		a := assess(resp.Status, body, "text/html; charset=utf-8", false)
		if a.warning != "" {
			warnings = append(warnings, a.warning)
		}
		return attemptResult{ok: a.ok, status: resp.Status, bytes: body, contentType: "text/html; charset=utf-8",
			warnings: warnings, note: a.note,
			subAttempts: []SubAttempt{{Profile: "cloak-sidecar", OK: a.ok, Status: resp.Status, Ms: ms, Blocked: a.blocked, Bytes: a.size, Note: a.note}},
		}
	}

	// kind == "iv8"
	resp, err := sidecarIv8Fetch(targetURL, remaining, ua)
	ms := nowMs() - s0
	if err != nil {
		return attemptResult{ok: false, status: 0, bytes: []byte{}, contentType: "",
			warnings:    append(warnings, "iv8 侧车调用失败: "+errShort(err)),
			note:        "unavailable-sidecar",
			subAttempts: []SubAttempt{{Profile: "iv8-sidecar", OK: false, Status: 0, Ms: ms, Note: "unavailable-sidecar"}}}
	}
	if !resp.OK {
		return attemptResult{ok: false, status: resp.Status, bytes: []byte{}, contentType: "",
			warnings:    append(warnings, "iv8 执行失败: "+errTextOr(resp.Error, "unknown")),
			note:        "iv8-run-failed",
			subAttempts: []SubAttempt{{Profile: "iv8-sidecar", OK: false, Status: resp.Status, Ms: ms, Blocked: false, Bytes: 0, Note: "iv8-run-failed"}}}
	}
	// iv8 算出的会话 cookie 回存引擎 jar（与 browser 策略渲染后回存同语义）
	sidecarRecordCookies(targetURL, resp.Cookies)
	body := []byte(resp.HTML)
	a := assess(resp.Status, body, "text/html; charset=utf-8", false)
	if a.warning != "" {
		warnings = append(warnings, a.warning)
	}
	return attemptResult{ok: a.ok, status: resp.Status, bytes: body, contentType: "text/html; charset=utf-8",
		warnings: warnings, note: a.note,
		subAttempts: []SubAttempt{{Profile: "iv8-sidecar", OK: a.ok, Status: resp.Status, Ms: ms, Blocked: a.blocked, Bytes: a.size, Note: a.note}},
	}
}

// errShort 错误消息截断（warnings 单条不超 200 字符，与 truncateStr 口径一致）
func errShort(err error) string {
	if err == nil {
		return ""
	}
	return truncateStr(err.Error(), 200)
}

func errTextOr(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return truncateStr(s, 200)
}

// probeSidecarCloak fetch-cloak 可用性：侧车在线 + cloakbrowser 可导入 + Chromium 二进制就绪。
// 任一缺失即 false（链自动跳过；与 curl-impersonate 二进制缺失同形态——不报错、不重试、不占用预算）。
func probeSidecarCloak() bool {
	if !sidecarAvailable() {
		return false
	}
	caps := sidecarCapabilities()
	return caps.Cloak && caps.CloakBinary
}

// probeSidecarIv8 fetch-iv8 可用性：侧车在线 + iv8 可导入。
func probeSidecarIv8() bool {
	return sidecarAvailable() && sidecarCapabilities().IV8
}

var fetchCloakStrategy = strategyDef{
	name: "fetch-cloak",
	// Task 101-a 描述（管理面 /api/strategies 透出）；102-a 重定位为 Tier 3 重渲染层：
	// R101 曾放链首 fetch-browser 之后「能过盾时后面的梯子都省了」，但单页 ~3.4s + ~1GB
	// 进程树的成本不该为每个新站点默认承担（文章实证：真实浏览器不应是默认执行环境）；
	// 新链序按成本递增，亲和/挑战跳层负责把真需要的站点路由到本层
	description:  "CloakBrowser 隐身 Chromium 渲染（侧车 :3031，Tier 3 重渲染）——源码级指纹伪装，过 Cloudflare/指纹检测；重但强",
	probe:        probeSidecarCloak,
	selfRetrying: true, // 昂贵策略不做链层外层重试（与 browser 策略同口径）
	tier:         tierStrategyBrowser,
	run: func(targetURL string, timeoutMs int64, ctx *strategyRunCtx) attemptResult {
		return sidecarStrategyRun("cloak", targetURL, timeoutMs, ctx)
	},
}

var fetchIv8Strategy = strategyDef{
	name:         "fetch-iv8",
	description:  "iv8 V8 环境模拟（侧车 :3031，Tier 2 轻执行）——无头执行站点 JS 算 cookie/参数，不启动 Chromium，纯脚本吞吐 ~100 倍于真实浏览器",
	probe:        probeSidecarIv8,
	selfRetrying: true,
	tier:         tierStrategyIv8,
	run: func(targetURL string, timeoutMs int64, ctx *strategyRunCtx) attemptResult {
		return sidecarStrategyRun("iv8", targetURL, timeoutMs, ctx)
	},
}
