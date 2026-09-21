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
        "golang.org/x/net/html/charset"
        "regexp"
        "strings"
)

var (
        // 已知反爬/拦截平台强特征（任意体积都判定）
        reChallengePlatform = regexp.MustCompile(
                `(?i)just a moment|cf-browser-verification|cf_chl_|checking your browser|attention required|ddos-guard|_Incapsula_Resource|incap_ses_|sucuri_cloudproxy|awswaf|aws waf|acw_sc__v2|__jsl_clearance|__jsluid|yunsuo_session_verify|wzws_cid`)
        // Cloudflare 注入型弱特征：仅近空正文时才判挑战
        reChallengeEmbed = regexp.MustCompile(`(?i)challenge-platform|cdn-cgi/challenge`)
        // 极小页启发式关键词（挑战专用词，不含裸词 javascript）
        reChallengeKeyword = regexp.MustCompile(`(?i)verify|challenge|captcha|安全验证|人机验证|请完成验证`)
        // 0 秒 meta refresh 跳板
        reMetaRefreshJump = regexp.MustCompile(`(?i)<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]+content\s*=\s*["']?\s*0(\.0+)?\s*;`)
        // 近空正文 + JS 跳转脚本
        reJSRedirectShell = regexp.MustCompile(`(?i)window\.location(\.\w+)?\s*=|location\.(?:replace|assign)\s*\(|location\.href\s*=`)
        // JS 计算 cookie 壳的两个半特征（必须同时命中且可见正文近空才判定）
        reJSCookieSet = regexp.MustCompile(`(?i)document\.cookie\s*=`)
        reJSReload    = regexp.MustCompile(`(?i)(?:window\.)?location\.reload\s*\(\s*\)|location\s*=\s*location|location\.href\s*=\s*location`)
        // 近空正文 + 「需要启用 JavaScript」壳（所有分支都必须带 JS 语境）
        reJSRequiredShell = regexp.MustCompile(
                `(?i)enable.{0,20}javascript|javascript.{0,20}(?:is\s+)?(?:required|disabled|not\s+supported|needs?)|(?:请开启|请打开|请启用|启用|开启).{0,6}(?:javascript|js\b|脚本)|浏览器不支持.{0,10}javascript|不支持.{0,6}javascript`)
)

var gb18030Encoding, _ = charset.Lookup("gb18030")

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
        reHTMLEntity  = regexp.MustCompile(`(?i)&[a-z]+;`)
)

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
        }
        if len(b) >= 3072 {
                return false
        }
        // 中文挑战关键词在 latin1 视图下永远无法命中：按真实编码再解码一次才能命中
        if reChallengeKeyword.MatchString(string(head)) {
                return true
        }
        if gb18030Encoding != nil {
                if decoded, err := gb18030Encoding.NewDecoder().Bytes(head); err == nil && reChallengeKeyword.MatchString(string(decoded)) {
                        return true
                }
        }
        if reChallengeKeyword.MatchString(scan) {
                return true
        }
        bodyTextLatin1 := visibleBodyText(scan)
        if reMetaRefreshJump.MatchString(scan) && runeLen(bodyTextLatin1) < 80 {
                return true
        }
        return false
}

var _ = strings.TrimSpace
