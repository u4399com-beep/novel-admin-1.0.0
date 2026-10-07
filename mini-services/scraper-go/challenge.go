/**
 * 挑战页/拦截页检测（四层，逐行移植自 strategies/challenge.ts）：
 * 1) 反爬平台强特征：前 32KB 内命中即判定（Cloudflare / DDoS-Guard / Incapsula / Sucuri / AWS WAF
 *    及国产 WAF JS 挑战壳 token：acw_sc__v2 / __jsl_clearance / __jsluid / yunsuo / wzws）；
 *    challenge-platform / cdn-cgi/challenge 为「近空正文才判定」的弱特征
 *    （CF Bot Fight Mode 会向站点所有正常页面注入前置脚本，强特征会误杀真实页面）；
 * 2) 近空正文（<80 可见字符）+ JS 跳转脚本 / 「需启用 JS」壳 / 「JS 计算 cookie + 原地 reload」壳：
 *    任意体积，覆盖 200 状态伪装的 JS 跳板、SPA 空壳与计算 cookie 型挑战；
 * 3) 极小页（<3KB）含挑战专用关键词：关键词按 latin1 + UTF-8 + GB18030 三种解码分别匹配；
 * 4) 极小页（<3KB）为 0 秒 meta-refresh 跳板且正文近空。
 */
package main

import (
	"bytes"
	"golang.org/x/net/html/charset"
	"regexp"
	"strings"
)

var (
	// 已知反爬/拦截平台强特征（任意体积都判定）
	reChallengePlatform = regexp.MustCompile(
		// Task 38-a: 补 btwaf（宝塔网站防火墙 token：拦截页 class/JS 变量/challenge cookie 名，
		// 中文小说站最常见面板系 WAF，该 token 不可能出现在正常页面）
		// Task 53: 补 GOEDGE_WAF_CAPTCHA（GoEdge WAF 人机验证表单专属 token：hidden 表单域
		// name/验证码图 URL 参数名，实测 kelexs/cunshu 全域强制验证——比 verify/captcha 泛词
		// 更精准，不受极小页+近空正文守卫限制，任意体积判定；正常站点不可能含该 token）
		`(?i)just a moment|cf-browser-verification|cf_chl_|checking your browser|attention required|ddos-guard|_Incapsula_Resource|incap_ses_|sucuri_cloudproxy|awswaf|aws waf|acw_sc__v2|__jsl_clearance|__jsluid|yunsuo_session_verify|wzws_cid|btwaf|GOEDGE_WAF_CAPTCHA`)
	// Cloudflare 注入型弱特征：仅近空正文时才判挑战
	reChallengeEmbed = regexp.MustCompile(`(?i)challenge-platform|cdn-cgi/challenge`)
	// 极小页启发式关键词（挑战专用词，不含裸词 javascript）
	// Task 38-a: 补「网站防火墙」（宝塔系拦截页标题/正文词；keyword 层自带极小页+近空守卫，
	// 正常叙事不可能整页只含该词）
	// Task 46-a（E3·软拦截识别增强）：补滑块/频控类词（滑块/滑动验证/异常流量/访问过于频繁/
	// 请稍后再试）——滑块型挑战壳与限流提示页此前仅在 softBlock 弱命中层面可见，极小页形态
	// 直接漏判；keyword 层自带「<3KB + 可见正文<200 字」双守卫，误杀面不变。仅窄义验证码/
	// 频控词，不收裸「验证」（订单验证/表单验证误杀面大）。
	reChallengeKeyword = regexp.MustCompile(`(?i)verify|challenge|captcha|安全验证|人机验证|请完成验证|网站防火墙|滑块|滑动验证|异常流量|访问过于频繁|访问频率|请稍后再试`)
	// 0 秒 meta refresh 跳板。Task 34 (P3-4): 属性顺序无关——旧正则要求 http-equiv 在 content
	// 之前，content 在前的写法（老式 CMS/手写跳板常见）漏杀；拆成两个独立子匹配同时命中才判
	reMetaRefreshEquiv = regexp.MustCompile(`(?i)<meta[^>]*http-equiv\s*=\s*["']?refresh["']?`)
	reMetaRefreshZero  = regexp.MustCompile(`(?i)<meta[^>]*content\s*=\s*["']?\s*0(\.0+)?\s*;`)
	// 近空正文 + JS 跳转脚本
	reJSRedirectShell = regexp.MustCompile(`(?i)window\.location(\.\w+)?\s*=|location\.(?:replace|assign)\s*\(|location\.href\s*=`)
	// JS 计算 cookie 壳的两个半特征（必须同时命中且可见正文近空才判定）
	reJSCookieSet = regexp.MustCompile(`(?i)document\.cookie\s*=`)
	reJSReload    = regexp.MustCompile(`(?i)(?:window\.)?location\.reload\s*\(\s*\)|location\s*=\s*location|location\.href\s*=\s*location`)
	// 近空正文 + 「需要启用 JavaScript」壳（所有分支都必须带 JS 语境）
	reJSRequiredShell = regexp.MustCompile(
		`(?i)enable.{0,20}javascript|javascript.{0,20}(?:is\s+)?(?:required|disabled|not\s+supported|needs?)|(?:请开启|请打开|请启用|启用|开启).{0,6}(?:javascript|js\b|脚本)|浏览器不支持.{0,10}javascript|不支持.{0,6}javascript`)
	reRiskControlShell = regexp.MustCompile(`环境异常|访问异常|操作异常|完成验证后|异常访问`)
	// Task 102-a（三层架构实战缺口）：通用风控验证壳词表——此类壳用 CSS/JS 把体积
	// 撑到几十 KB 绕过极小页闸，但可见正文仅一句提示（「当前环境异常，完成验证后
	// 即可继续访问」）。命中本词表 + 近空正文（<80 字，与下方壳判定同守卫）即判挑战页，
	// 任意体积生效。词表取窄义风控词；正常内容页（列表/书页/章节正文远超 80 字）不误伤。
)

var gb18030Encoding, _ = charset.Lookup("gb18030")

// headerSaysChallenge Task 54（E15·反反爬）：cf-mitigated 响应头探测。
// Cloudflare 对托管挑战/受拦响应自报 `cf-mitigated: challenge`（block 形态亦有）——这是
// WAF 自己承认「本响应是挑战/拦截页」的最精准信号：零体解析、零误杀面（正常内容页绝不
// 携带该头），且不受挑战页体积/形态伪装影响（正文做得再像正常页，头仍自报）。
// 仅接受白名单值（challenge/block）；其他值（未来未知形态）忽略，不影响既有四层体判定。
// 浏览器桥接车道（browser.go）的 payload 不含响应头，传 false 由体判定兜底。
func headerSaysChallenge(vals []string) bool {
	for _, v := range vals {
		switch strings.ToLower(strings.TrimSpace(v)) {
		case "challenge", "block":
			return true
		}
	}
	return false
}

// visibleBodyText 剥 script/style 与全部标签/实体后的可见正文（近空判定用）
func visibleBodyText(scan string) string {
	s := reScriptBlock.ReplaceAllString(scan, " ")
	s = reStyleBlock.ReplaceAllString(s, " ")
	s = reAnyTag.ReplaceAllString(s, " ")
	s = reHTMLEntity.ReplaceAllString(s, " ")
	s = reJSWhitespace.ReplaceAllString(s, " ")
	return trimJSSpace(s)
}

var (
	reScriptBlock = regexp.MustCompile(`(?i)<script[\s\S]*?</script>`)
	reStyleBlock  = regexp.MustCompile(`(?i)<style[\s\S]*?</style>`)
	reAnyTag      = regexp.MustCompile(`<[^>]+>`)
	reHTMLEntity  = regexp.MustCompile(`(?i)&[a-z]+;|&#[0-9]+;|&#x[0-9a-f]+;`) // Task 34 (P3-5): 数字实体并入（零宽空格实体堆叠曾把近空壳页顶过可见字闸）
)

// metaRefreshJumpHit 同一 meta 标签内同时含 http-equiv=refresh 与 content=0;（属性顺序无关）
func metaRefreshJumpHit(s string) bool {
	b := []byte(s)
	for _, m := range reMetaRefreshEquiv.FindAllIndex(b, 32) {
		end := m[1] + 400 // 同标签 content 属性通常紧跟其后，窗口 400B 足够
		if end > len(b) {
			end = len(b)
		}
		seg := b[m[0]:end]
		if c := reMetaRefreshZero.Find(seg); c != nil && reMetaRefreshEquiv.Match(c) {
			return true
		}
		// 更稳的做法：从 equiv 命中处向后找最近的 '>' 结束本标签，在标签内查 content=0;
		if gt := bytes.IndexByte(seg, '>'); gt > 0 {
			tag := seg[:gt]
			if reMetaRefreshZero.Match(tag) {
				return true
			}
		}
	}
	return false
}

// looksLikeChallenge 挑战页/拦截页检测（四层）。命中即 true（视为失败，继续后续策略）。
func looksLikeChallenge(b []byte) bool {
	if len(b) == 0 {
		return false
	}
	end := len(b)
	if end > 32768 {
		end = 32768
	}
	head := b[:end]
	scan := bytesToLatin1String(head)
	if reChallengePlatform.MatchString(scan) {
		return true
	}
	// Cloudflare 注入型弱特征：真实内容页（正文 ≥80 可见字符）包含 challenge-platform
	// 属 CF Bot Fight Mode 全站前置脚本注入，不判挑战；近空正文才可能是真挑战壳
	if reChallengeEmbed.MatchString(scan) && runeLen(visibleBodyText(scan)) < 80 {
		return true
	}
	// 壳/跳板判定需在多种解码视图上进行：JS 跳板特征是 ASCII（latin1 即可命中），
	// 中文「请开启 JavaScript」等短语必须按真实编码（utf8/gb18030）再各判一次
	variants := []string{scan, string(head)}
	if gb18030Encoding != nil {
		if decoded, err := gb18030Encoding.NewDecoder().Bytes(head); err == nil {
			variants = append(variants, string(decoded))
		}
	}
	for _, text := range variants {
		// 近空可见正文才启用壳/跳板判定（<80 字符）：有真实内容的页面绝不误伤
		if runeLen(visibleBodyText(text)) >= 80 {
			continue
		}
		if reJSRedirectShell.MatchString(text) {
			return true
		}
		// JS 计算 cookie + 原地重载壳（acw_sc__v2 型）：两个半特征同时命中才判定
		if reJSCookieSet.MatchString(text) && reJSReload.MatchString(text) {
			return true
		}
		if reJSRequiredShell.MatchString(text) {
			return true
		}
		// Task 102-a: 通用风控验证壳（「环境异常」型）——近空正文 + 风控词，任意体积
		if reRiskControlShell.MatchString(text) {
			return true
		}
	}
	if len(b) >= 3072 {
		return false
	}
	// Task 26-d 误判率收敛：极小页（<3KB）的关键词层加「可见正文近空（<200 字符）」守卫。
	// 真挑战壳的正文几乎全由脚本/提示语构成（可见正文极短）；小体积真实章节页若叙事中
	// 恰含「安全验证/verify」等词，旧版会被整页误判为挑战（引擎四策略全 blocked → 章节失败）。
	keywordHit := func(text string) bool {
		return reChallengeKeyword.MatchString(text) && runeLen(visibleBodyText(text)) < 200
	}
	if keywordHit(string(head)) {
		return true
	}
	if gb18030Encoding != nil {
		if decoded, err := gb18030Encoding.NewDecoder().Bytes(head); err == nil && keywordHit(string(decoded)) {
			return true
		}
	}
	if keywordHit(scan) {
		return true
	}
	bodyTextLatin1 := visibleBodyText(scan)
	if metaRefreshJumpHit(scan) && runeLen(bodyTextLatin1) < 80 {
		return true
	}
	return false
}

// 软拦截内容特征（Task 46-a E3）：200 空壳/频控提示页的标题与正文常含验证码/滑块/频控词，
// 但页面体积/正文形态达不到 looksLikeChallenge 的硬判层。本正则仅供 challengeFeatureSummary
// 做「弱命中」标注（softBlock 档案附加证据，供 backend 归类），不参与 ok/blocked 判定，
// 故不设体积守卫也不会误杀——标注错误的最大代价是档案多一个特征项。
// 词表：验证码/滑块/人机验证/频控提示/主流验证码产品名，全部窄义反爬词汇。
var reCaptchaShell = regexp.MustCompile(
	`(?i)captcha|recaptcha|hcaptcha|turnstile|gee\s?test|验证码|滑块|滑动验证|人机验证|安全验证|请完成验证|异常流量|访问过于频繁|访问频率|请稍后再试|请开启.{0,8}(?:cookie|javascript)`)

// reTitleTag 提取 <title> 文本（软拦截标题特征用；限 200 字防超长异常标签）
var reTitleTag = regexp.MustCompile(`(?i)<title[^>]*>([\s\S]{0,200}?)</title>`)

// recommendTierForChallenge（Task 102-a·三层架构挑战感知跳层）：
// 分析失败响应体形态，输出「建议下一跳策略层」——0=无推荐（按链序自然走），
// tierStrategyIv8(2)=建议跳过剩余 HTTP 层直接试 iv8 轻执行，
// tierStrategyBrowser(3)=建议跳过轻手段直接上隐身 Chromium。
//
// 分类依据（复用挑战检测四层的正则，不改判定只读特征）：
//   - 平台级 WAF 强特征（Cloudflare/DDoS-Guard/acw_sc__v2/__jsl_clearance/yunsuo/wzws/
//     btwaf/GoEdge 验证码等）→ Tier 3：这类 WAF 的对抗面是浏览器指纹/TLS 指纹/验证码，
//     纯 HTTP 换 UA/换协议大概率无效；隐身 Chromium（源码级指纹伪装）是对位手段。
//     注意 acw_sc__v2 同时是「JS 计算 cookie」的代名词，但它通常与真实 WAF 挑战页同在
//     （瑞数/阿里 WAF 生态），放 Tier 3 保守正确——跳层只影响尝试顺序，链序兜底仍在。
//   - JS 计算 cookie + 原地 reload 壳（js-cookie-shell）→ Tier 2：iv8 专治——页内脚本
//     在 V8 里算出 document.cookie 后回存引擎 jar，重放即放行（R101「首访 JS 种 cookie、
//     二访放行」链路），比真浏览器便宜百倍。
//   - 近空正文 JS 跳转壳（js-redirect-shell）→ Tier 2：跳转目标计算逻辑在脚本里，
//     HTTP 层无法执行；iv8 补环境跑脚本可算出真实落地页/参数。
//
// 只扫描前 32KB（与 looksLikeChallenge 同口径）；纯函数无 IO，表驱动测试见 tier_test.go。
func recommendTierForChallenge(b []byte) int {
	if len(b) == 0 {
		return 0
	}
	end := len(b)
	if end > 32768 {
		end = 32768
	}
	head := b[:end]
	scan := bytesToLatin1String(head)
	// 平台级 WAF 强特征 → Tier 3（指纹级对抗，直接上隐身 Chromium）
	if reChallengePlatform.MatchString(scan) {
		return tierStrategyBrowser
	}
	// 壳/跳板形态 → Tier 2（轻执行层可解）
	text := string(head)
	if reJSCookieSet.MatchString(text) && reJSReload.MatchString(text) {
		return tierStrategyIv8
	}
	if reJSRedirectShell.MatchString(text) && runeLen(visibleBodyText(scan)) < 80 {
		return tierStrategyIv8
	}
	// 通用风控验证壳（「环境异常」型）→ Tier 3：此类风控（指纹/验证码门槛）需真浏览器
	// 对位，iv8 补环境算不出人机验证结果；近空正文守卫与 looksLikeChallenge 同口径
	if runeLen(visibleBodyText(scan)) < 80 && reRiskControlShell.MatchString(text) {
		return tierStrategyBrowser
	}
	return 0
}

// challengeFeatureSummary Task 32-d: 200 空壳软拦截页的特征摘要（handlers 的 softBlock 档案用）。
// 背景：ixdzs8 形态——HTTP 200/19KB、挑战检测四层均未判死（looksLikeChallenge=false）、
// 但正文选择器命中为空。本函数复用挑战正则做「弱命中」标注，把页面证据交给调用方
// 组装 softBlock 档案（title/长度/特征列表），供 backend 更精准分类（isSoftBlockErr 家族）。
// 只扫描前 32KB（与 looksLikeChallenge 同口径），无命中返回空切片。
func challengeFeatureSummary(b []byte) []string {
	if len(b) == 0 {
		return nil
	}
	end := len(b)
	if end > 32768 {
		end = 32768
	}
	head := b[:end]
	scan := bytesToLatin1String(head)
	text := string(head)
	hits := []string{}
	if reChallengePlatform.MatchString(scan) {
		hits = append(hits, "platform-strong")
	}
	if reChallengeEmbed.MatchString(scan) {
		hits = append(hits, "cf-embed")
	}
	if reJSRedirectShell.MatchString(text) {
		hits = append(hits, "js-redirect-shell")
	}
	if reJSCookieSet.MatchString(text) && reJSReload.MatchString(text) {
		hits = append(hits, "js-cookie-shell")
	}
	if reJSRequiredShell.MatchString(text) {
		hits = append(hits, "js-required-shell")
	}
	if reChallengeKeyword.MatchString(text) {
		hits = append(hits, "challenge-keyword")
	}
	// Task 54（E16·54-a 留档③落地）：GB18030 解码视图——GBK 编码页的中文挑战词
	//（安全验证/滑块/验证码等）在字节视图上是 GBK 字节序列，UTF-8 词面正则漏匹配，
	// softBlock 档案据此少标注特征（54-a 留档：代价=档案少一项非误杀）。补第三视图：
	// 解码成功且与字节视图不同才追加；仅影响档案标注层，ok/blocked 判定零参与。
	views := []string{text}
	if gb18030Encoding != nil {
		if decoded, err := gb18030Encoding.NewDecoder().Bytes(head); err == nil && !bytes.Equal(decoded, head) {
			views = append(views, string(decoded))
		}
	}
	seen := map[string]bool{}
	for _, view := range views {
		if reChallengeKeyword.MatchString(view) {
			if !seen["challenge-keyword"] {
				seen["challenge-keyword"] = true
				hits = append(hits, "challenge-keyword")
			}
		}
		// Task 46-a（E3·软拦截识别增强）：验证码/滑块/频控词特征——①<title> 命中（如
		// 「安全验证」「请完成验证后继续访问」，标题层是 WAF 拦截页最强证据）②近空正文命中
		//（频控提示页正文常仅一句话）。仅追加 softBlock 档案特征项，不改 ok/blocked 判定。
		if m := reTitleTag.FindStringSubmatch(view); m != nil && reCaptchaShell.MatchString(m[1]) {
			if !seen["captcha-title"] {
				seen["captcha-title"] = true
				hits = append(hits, "captcha-title")
			}
		}
		if runeLen(visibleBodyText(view)) < 200 && reCaptchaShell.MatchString(view) {
			if !seen["captcha-shell"] {
				seen["captcha-shell"] = true
				hits = append(hits, "captcha-shell")
			}
		}
	}
	if metaRefreshJumpHit(scan) {
		hits = append(hits, "meta-refresh-0s")
	}
	if runeLen(visibleBodyText(text)) == 0 && len(hits) == 0 {
		hits = append(hits, "near-empty-body")
	}
	return hits
}
