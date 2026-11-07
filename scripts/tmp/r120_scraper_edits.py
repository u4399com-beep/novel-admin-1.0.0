#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""R120 scraper-go 语义编辑（python 精确替换，规避 Edit 工具 Go 缩进重写陷阱）。
每个替换断言恰好命中 1 次；任何断言失败即整体中止（不留半成品）。"""
import sys, io

BASE = "/home/z/my-project/mini-services/scraper-go/"

def edit(path, pairs):
    p = BASE + path
    src = io.open(p, encoding="utf-8").read()
    for old, new in pairs:
        n = src.count(old)
        if n != 1:
            print(f"FAIL {path}: pattern hit {n} times:\n{old[:200]}")
            sys.exit(1)
        src = src.replace(old, new)
    io.open(p, "w", encoding="utf-8").write(src)
    print(f"OK {path}: {len(pairs)} edits")

# ---------------- chain.go ----------------
edit("chain.go", [
    # 1) fetchPageOptions 增字段
    ("""        minTier int
}

// fetchPageResult 对齐 TS FetchPageResult""",
     """        minTier int
        // waitSelector R120（遗留①）：JS 慢渲染站的「关键选择器」——backend 从页面
        // 主提取选择器（列表 itemSelector/目录 chapterLinkSelector/正文 contentSelector）
        // 透传，fetch-cloak 转给侧车 /cloak 由子进程 wait_for_selector 等待渲染完成
        //（超时不失败；未命中时策略按失败处理让链继续复核，见 strategy_sidecar.go）。
        // 空值=不等待（HTTP 层策略不受影响），行为与旧版完全一致。
        waitSelector string
}

// fetchPageResult 对齐 TS FetchPageResult""",),
    # 2) fetchPageResult 增可观测字段
    ("""        // Task 32-d（Task 31 遗留②落地）：整链失败时策略链最后一次抓到的原始页面（已解码、
        // 截断到 debugHTMLCapBytes）——排障时直接看到挑战页/空壳页原文而非只剩状态码。
        // 成功路径恒为空（调用方用 html 字段）。includeHtml=true 时经 handlers 透出 htmlDebug。
        debugHTML string
}""",
     """        // Task 32-d（Task 31 遗留②落地）：整链失败时策略链最后一次抓到的原始页面（已解码、
        // 截断到 debugHTMLCapBytes）——排障时直接看到挑战页/空壳页原文而非只剩状态码。
        // 成功路径恒为空（调用方用 html 字段）。includeHtml=true 时经 handlers 透出 htmlDebug。
        debugHTML string
        // R120: waitSelector 回显与命中结果（handlers 透出 /api/test·/api/chapter 供观测；
        // waitSelectorFound=false + 200 = 「JS 空壳抢跑」的显式证据）
        waitSelector       string
        waitSelectorFound  bool
}""",),
    # 4) ctx 构造透传
    ("""                        ctx := &strategyRunCtx{referer: opts.referer, proxy: px, insecureTLS: opts.insecureTLS}""",
     """                        ctx := &strategyRunCtx{referer: opts.referer, proxy: px, insecureTLS: opts.insecureTLS, waitSelector: opts.waitSelector}""",),
    # 5) 获胜路径回填 fetchPageResult
    ("""                                return fetchPageResult{
                                        ok: true, html: dec.Text, encoding: dec.Encoding, strategy: strat.name,
                                        status: res.status, warnings: warnings, attempts: attempts,
                                        robots:    RobotsSummary{Checked: robots.info.checked, Disallowed: robots.info.disallowed, CrawlDelayMs: robots.info.crawlDelayMs},
                                        elapsedMs: nowMs() - t0,
                                        queueMs:   chainQueueMs + res.queueMs, // R114: 链层+获胜策略排队累计
                                }""",
     """                                return fetchPageResult{
                                        ok: true, html: dec.Text, encoding: dec.Encoding, strategy: strat.name,
                                        status: res.status, warnings: warnings, attempts: attempts,
                                        robots:    RobotsSummary{Checked: robots.info.checked, Disallowed: robots.info.disallowed, CrawlDelayMs: robots.info.crawlDelayMs},
                                        elapsedMs: nowMs() - t0,
                                        queueMs:   chainQueueMs + res.queueMs, // R114: 链层+获胜策略排队累计
                                        waitSelector: opts.waitSelector, waitSelectorFound: res.waitSelectorFound, // R120
                                }""",),
])

# ---------------- strategies.go ----------------
edit("strategies.go", [
    ("""type strategyRunCtx struct {
        referer     string
        proxy       string
        insecureTLS bool
        hardCtx     context.Context
}""",
     """type strategyRunCtx struct {
        referer     string
        proxy       string
        insecureTLS bool
        hardCtx     context.Context
        // waitSelector R120: 关键选择器等待（仅 fetch-cloak 消费——透传侧车 /cloak 由
        // 子进程 wait_for_selector；其余策略不读此字段，零行为变化）
        waitSelector string
}""",),
    # 2) attemptResult 增命中结果字段
    ("""        subAttempts []SubAttempt
        retryAfter  *int64""",
     """        subAttempts []SubAttempt
        retryAfter  *int64
        // waitSelectorFound R120: 侧车 cloak 渲染对 waitSelector 的命中结果（仅
        // fetch-cloak 置位；其余策略零值=false 但无 waitSelector 语义，不参与判定）
        waitSelectorFound bool""",),
])

# ---------------- handlers.go ----------------
edit("handlers.go", [
    # 1) fetchAndPrepare 解析
    ("""        page := fetchPageOptions{
                requestedStrategy: strategy,
                forcedCharset:     charset,
                timeoutMs:         timeoutMs,
                referer:           referer,
                proxy:             proxy,
                insecureTLS:       insecureTLS,
                ruleCookies:       ruleCookies,
        // minTier R119: 规则级策略分层下限（0=全链默认；pilishuwu 类 JS 渲染站设 3）
        minTier:           clampIntField(body["minTier"], 0, 3),
        })""",
     """        page := fetchPageOptions{
                requestedStrategy: strategy,
                forcedCharset:     charset,
                timeoutMs:         timeoutMs,
                referer:           referer,
                proxy:             proxy,
                insecureTLS:       insecureTLS,
                ruleCookies:       ruleCookies,
        // minTier R119: 规则级策略分层下限（0=全链默认；pilishuwu 类 JS 渲染站设 3）
        minTier:           clampIntField(body["minTier"], 0, 3),
        // waitSelector R120: 关键选择器等待（backend 从页面主提取选择器透传；
        // 空值=不等待零行为变化。cssSafeWaitSelector 在 backend 侧已过滤 DSL 语法）
        waitSelector:      strField(body["waitSelector"], 256),
        })""",),
    # 2) handleTest 响应透出
    ("""        resp := map[string]any{
                "ok": true, "url": baseURL, "strategy": page.strategy, "status": page.status,
                "elapsedMs": nowMs() - t0, "fetchElapsedMs": page.elapsedMs, "queueMs": page.queueMs, "encoding": page.encoding,
                "htmlLength": runeLen(page.html), "robots": page.robots, "attempts": page.attempts,
                "data": data, "warnings": warnings,
        }""",
     """        resp := map[string]any{
                "ok": true, "url": baseURL, "strategy": page.strategy, "status": page.status,
                "elapsedMs": nowMs() - t0, "fetchElapsedMs": page.elapsedMs, "queueMs": page.queueMs, "encoding": page.encoding,
                "htmlLength": runeLen(page.html), "robots": page.robots, "attempts": page.attempts,
                "data": data, "warnings": warnings,
        }
        if page.waitSelector != "" { // R120: 关键选择器命中结果透出（false+200=空壳抢跑证据）
                resp["waitSelector"] = page.waitSelector
                resp["waitSelectorFound"] = page.waitSelectorFound
        }""",),
    # 3) handleChapter 响应透出
    ("""        resp := map[string]any{
                "ok": true, "url": baseURL, "strategy": page.strategy, "status": page.status,
                "elapsedMs": nowMs() - t0, "fetchElapsedMs": page.elapsedMs, "queueMs": page.queueMs, "encoding": page.encoding,
                "robots": page.robots, "attempts": page.attempts, "data": data, "warnings": warnings,
        }""",
     """        resp := map[string]any{
                "ok": true, "url": baseURL, "strategy": page.strategy, "status": page.status,
                "elapsedMs": nowMs() - t0, "fetchElapsedMs": page.elapsedMs, "queueMs": page.queueMs, "encoding": page.encoding,
                "robots": page.robots, "attempts": page.attempts, "data": data, "warnings": warnings,
        }
        if page.waitSelector != "" { // R120: 关键选择器命中结果透出
                resp["waitSelector"] = page.waitSelector
                resp["waitSelectorFound"] = page.waitSelectorFound
        }""",),
])

# ---------------- sidecar.go ----------------
edit("sidecar.go", [
    ("""// sidecarCloakResp /cloak 响应
type sidecarCloakResp struct {
        OK        bool           `json:"ok"`
        HTML      string         `json:"html"`
        Status    int            `json:"status"`
        FinalURL  string         `json:"finalUrl"`
        Cookies   []bridgeCookie `json:"cookies"` // R110：过盾后的会话 cookie（cf_clearance 等）回存引擎 jar
        ElapsedMS int64          `json:"elapsedMs"`
        Error     string         `json:"error"`
}""",
     """// sidecarCloakResp /cloak 响应
type sidecarCloakResp struct {
        OK        bool           `json:"ok"`
        HTML      string         `json:"html"`
        Status    int            `json:"status"`
        FinalURL  string         `json:"finalUrl"`
        Cookies   []bridgeCookie `json:"cookies"` // R110：过盾后的会话 cookie（cf_clearance 等）回存引擎 jar
        ElapsedMS int64          `json:"elapsedMs"`
        Error     string         `json:"error"`
        // R120（遗留①）：waitSelector 命中结果（请求带 waitSelector 时侧车必回；
        // 旧版侧车/未带等待时 false——调用方仅在 ctx.waitSelector != "" 时消费）
        WaitSelectorFound bool `json:"waitSelectorFound"`
}""",),
    ("""// sidecarCloakFetch CloakBrowser 渲染：返回渲染后 DOM/状态码/最终 URL/耗时。
// err != nil = 侧车调用层失败（拒连/超时/非法响应）；resp.OK=false = 侧车业务层失败（站点被拒等）。
func sidecarCloakFetch(url string, timeoutMs int64, proxy, ua string) (sidecarCloakResp, error) {
        payload := map[string]any{"url": url, "timeoutMs": timeoutMs}
        if proxy != "" {
                payload["proxy"] = proxy
        }
        if ua != "" {
                payload["userAgent"] = ua
        }""",
     """// sidecarCloakFetch CloakBrowser 渲染：返回渲染后 DOM/状态码/最终 URL/耗时。
// err != nil = 侧车调用层失败（拒连/超时/非法响应）；resp.OK=false = 侧车业务层失败（站点被拒等）。
// R120：waitSelector 非空时透传侧车（子进程 wait_for_selector 等待关键选择器渲染完成，
// 超时不失败；waitSelectorTimeoutMs 一并下发，默认 15s 上限 30s 由侧车钳制）。
func sidecarCloakFetch(url string, timeoutMs int64, proxy, ua, waitSelector string) (sidecarCloakResp, error) {
        payload := map[string]any{"url": url, "timeoutMs": timeoutMs}
        if proxy != "" {
                payload["proxy"] = proxy
        }
        if ua != "" {
                payload["userAgent"] = ua
        }
        if ws := cssSafeWaitSelector(waitSelector); ws != "" {
                payload["waitSelector"] = ws
        }""",),
])

# ---------------- strategy_sidecar.go ----------------
edit("strategy_sidecar.go", [
    ("""        if kind == "cloak" {
                resp, err := sidecarCloakFetch(targetURL, remaining, ctx.proxy, ua)""",
     """        if kind == "cloak" {
                resp, err := sidecarCloakFetch(targetURL, remaining, ctx.proxy, ua, ctx.waitSelector)""",),
    ("""                body := []byte(resp.HTML)
                // Task 54（E15）口径：侧车 payload 不含响应头，serverChallenge=false 由体判定兜底
                a := assess(resp.Status, body, "text/html; charset=utf-8", false)
                if a.warning != "" {
                        warnings = append(warnings, a.warning)
                }
                return attemptResult{ok: a.ok, status: resp.Status, bytes: body, contentType: "text/html; charset=utf-8",
                        warnings: warnings, note: a.note, queueMs: waited, // R114: 侧车取槽排队计入饱和观测
                        subAttempts: []SubAttempt{{Profile: "cloak-sidecar", OK: a.ok, Status: resp.Status, Ms: ms, Blocked: a.blocked, Bytes: a.size, Note: a.note}},
                }""",
     """                body := []byte(resp.HTML)
                // Task 54（E15）口径：侧车 payload 不含响应头，serverChallenge=false 由体判定兜底
                a := assess(resp.Status, body, "text/html; charset=utf-8", false)
                if a.warning != "" {
                        warnings = append(warnings, a.warning)
                }
                // R120（遗留①+反反爬强化）：关键选择器等待未命中——JS 慢渲染站的「200 空壳
                // 抢跑」显式化。旧路径此处 ok=true 返回壳页 → backend 提取 0 条 → softBlock
                // 软拦截 → 任务 pause+冷却，一整圈浪费；现按失败处理让链继续（minTier 站
                // 下一跳 fetch-browser 复核），并把证据留在 note/warnings。bytes 保留供
                // debugHTML 排障（整链失败时能看到壳页原文）。
                if ctx.waitSelector != "" && !resp.WaitSelectorFound && a.ok {
                        warnings = append(warnings, "waitSelector 未命中（侧车等待后关键选择器仍未出现：JS 慢渲染/选择器失效/空壳）: "+ctx.waitSelector)
                        return attemptResult{ok: false, status: resp.Status, bytes: body, contentType: "text/html; charset=utf-8",
                                warnings: warnings, note: "wait-selector-missed", queueMs: waited,
                                subAttempts: []SubAttempt{{Profile: "cloak-sidecar", OK: false, Status: resp.Status, Ms: ms, Blocked: a.blocked, Bytes: a.size, Note: "wait-selector-missed"}},
                        }
                }
                return attemptResult{ok: a.ok, status: resp.Status, bytes: body, contentType: "text/html; charset=utf-8",
                        warnings: warnings, note: a.note, queueMs: waited, // R114: 侧车取槽排队计入饱和观测
                        waitSelectorFound: resp.WaitSelectorFound, // R120: 命中结果回传链层（fetchPageResult 回显）
                        subAttempts: []SubAttempt{{Profile: "cloak-sidecar", OK: a.ok, Status: resp.Status, Ms: ms, Blocked: a.blocked, Bytes: a.size, Note: a.note}},
                }""",),
])

# ---------------- util.go ----------------
edit("util.go", [
    ("""// ==================== 超时钳制（clampTimeout） ====================""",
     """// ==================== waitSelector 安全过滤（R120） ====================

// cssSafeWaitSelector waitSelector 透传安全性过滤：引擎 pickText 规则 DSL 的专有语法
//（:contains() 文本锚 / aref 属性 DSL / ownText 关键字等）对 Playwright
// wait_for_selector 非法——此类选择器不透传（返回 ""= cloak 不等待，行为与旧版一致）；
// 纯 CSS（pilishuwu li.rank-item / div.read-content 等）原样放行。长度钳 256。
func cssSafeWaitSelector(s string) string {
        sel := strings.TrimSpace(s)
        if sel == "" || len(sel) > 256 {
                return ""
        }
        low := strings.ToLower(sel)
        for _, tok := range []string{":contains(", "aref", "owntext", "text(", "@style", "attr("} {
                if strings.Contains(low, tok) {
                        return ""
                }
        }
        return sel
}

// ==================== 超时钳制（clampTimeout） ====================""",),
])

print("ALL SCRAPER-GO EDITS DONE")
