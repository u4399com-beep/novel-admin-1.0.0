/**
 * fetch-urllib 策略（R188 OpenSSL TLS 指纹通道）。
 *
 * 背景：部分站点（sto55.com 实证，R186/R188 双轮）按 TLS 指纹分型而非仅 IP——
 * chrome 类画像（fetch-browser/ua-rotate/got-scraping）与 Go crypto/tls
 * （fetch-curl）均被 404 挑战壳拦截，而 python3 urllib（OpenSSL TLS + 默认
 * Python-urllib UA）经代理通行（200/29.5KB 全页双轮实证）。本策略把 urllib
 * 经 python3 子进程纳入策略链。
 *
 * 链位（chain.go）：fetch-browser 之后第 2 位——挑战风暴跳层（R120c，阈值 2）
 * 之前必然得到一次机会：chrome 类首策略吃 1 个挑战计数后本策略即上场，命中
 * OpenSSL 放行型站点直接胜出并记亲和；引擎重启亲和丢失后同一位置仍可自愈，
 * 不依赖人工单策略种子（R186 fetch-curl 亲和重启丢失卡死教训的根治位）。
 *
 * 执行骨架与 fetch-curl 同构：Go 侧逐跳管理重定向（每跳 SSRF 校验含首跳 +
 * DNS rebinding 钉死经 python getaddrinfo 猴补）、域槽预算排队、Cookie 会话
 * 回放/捕获；python 侧不跟随重定向、单跳拉取（HTTPError 含 3xx/4xx/5xx 统一
 * 读取响应头体）。socks 代理不支持（urllib ProxyHandler 仅 http/https）——
 * 诚实 fast-fail 不伪装成站点行为。
 */
package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	urllibPyMu     sync.Mutex
	urllibPyPath   string
	urllibPyMissAt int64 // 上次探测失败时间戳（0=可用）：失败仅缓存 60s
)

// detectPython3 定位 python3 解释器（引擎探活口径与 fetch-curl 的 detectPlainCurl 同构）
func detectPython3() string {
	urllibPyMu.Lock()
	defer urllibPyMu.Unlock()
	if urllibPyMissAt > 0 && nowMs()-urllibPyMissAt < 60_000 {
		return ""
	}
	if urllibPyPath != "" {
		return urllibPyPath
	}
	p, err := exec.LookPath("python3")
	if err != nil || p == "" {
		urllibPyMissAt = nowMs()
		return ""
	}
	urllibPyPath = p
	return p
}

// urllibFetchScript 单跳拉取脚本：不跟随重定向（3xx 由 Go 侧逐跳管理），
// 头体落盘与 curl --dump-header/--output 同构；stdout 输出 "STATUS\tCTYPE"。
// DNS 钉死：assertHostPublic 缓存的公网 IPv4 经 getaddrinfo 猴补复用（与
// curl --resolve 同口径，封堵 SSRF TOCTOU）。
const urllibFetchScript = `import sys, socket
url, proxy, timeout_s, insecure, cookie, pin_host, pin_ip, out, hdr = sys.argv[1:10]
import urllib.request, urllib.error
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None
handlers = [NoRedirect()]
if proxy:
    handlers.append(urllib.request.ProxyHandler({'http': proxy, 'https': proxy}))
if insecure == '1':
    import ssl
    handlers.append(urllib.request.HTTPSHandler(context=ssl._create_unverified_context()))
if pin_host and pin_ip:
    _ga = socket.getaddrinfo
    def pinned(host, *a, **k):
        if host == pin_host:
            return [(2, 1, 6, '', (pin_ip, 0))]
        return _ga(host, *a, **k)
    socket.getaddrinfo = pinned
socket.setdefaulttimeout(float(timeout_s))
op = urllib.request.build_opener(*handlers)
req = urllib.request.Request(url)
if cookie:
    req.add_header('Cookie', cookie)
try:
    r = op.open(req, timeout=float(timeout_s))
except urllib.error.HTTPError as e:
    r = e
body = b''
try:
    body = r.read(8 * 1024 * 1024 + 1)
except Exception:
    pass
if len(body) > 8 * 1024 * 1024:
    sys.exit(63)
open(out, 'wb').write(body)
with open(hdr, 'w') as f:
    for k, v in r.headers.items():
        f.write(k + ': ' + str(v).replace('\r', ' ').replace('\n', ' ') + '\r\n')
print(str(r.status if hasattr(r, 'status') else getattr(r, 'code', 0)) + '\t' + (r.headers.get('Content-Type', '') or ''))
`

var urllibFetchStrategy = strategyDef{
	name:         "fetch-urllib",
	description:  "python3 urllib 子进程（OpenSSL TLS 指纹通道：默认 Python-urllib UA，Go 侧逐跳重定向/SSRF/Cookie 同构管理）；针对「按 TLS 指纹分型拒绝 chrome 类与 Go crypto/tls 但放行 OpenSSL」的站点（sto55.com R186/R188 实证）",
	probe:        func() bool { return detectPython3() != "" },
	selfRetrying: true,
	tier:         tierStrategyHTTP,
	run: func(targetURL string, timeoutMs int64, ctx *strategyRunCtx) attemptResult {
		warnings := []string{}
		subAttempts := []SubAttempt{}
		bin := detectPython3()
		if bin == "" {
			return attemptResult{ok: false, status: 0, bytes: []byte{}, contentType: "", warnings: warnings, note: "missing-python"}
		}
		// 出口轮换：ctx.proxy 兼容单口（链层 pickProxy）与逗号池（/api/test 透传）两种
		// 形态；逐口轮换，连接级失败（exec-error）换下一口，任一口产生 HTTP 级响应
		// （含 4xx/5xx/重定向）即采纳返回——与 curl 逗号池故障轮换语义对齐
		proxyList := []string{}
		for _, p := range strings.Split(ctx.proxy, ",") {
			if p = strings.TrimSpace(p); p != "" {
				proxyList = append(proxyList, p)
			}
		}
		if len(proxyList) == 0 {
			proxyList = []string{""}
		}
		for _, px := range proxyList {
			if strings.HasPrefix(strings.ToLower(px), "socks") {
				// urllib ProxyHandler 仅支持 http/https 代理：socks 口诚实跳过
				//（不伪装成站点行为），池内继续轮下一口
				subAttempts = append(subAttempts, SubAttempt{Profile: "openssl", OK: false, Status: 0, Ms: 0, Blocked: false, Bytes: 0, Note: "socks-unsupported"})
				continue
			}
			res := urllibFetchOneExit(targetURL, timeoutMs, ctx, px, bin, warnings, subAttempts)
			warnings, subAttempts = res.warnings, res.subAttempts
			if res.note != "exec-error-next-exit" {
				return res
			}
			// 连接级失败：预算内换下一口重试（剩余预算不足即止）
			timeoutMs -= nowMs() - (nowMs() - timeoutMs)
			if timeoutMs <= 1000 {
				break
			}
		}
		return attemptResult{ok: false, status: 0, bytes: []byte{}, contentType: "", warnings: warnings, note: "all-variants-failed", subAttempts: subAttempts}
	},
}

// urllibFetchOneExit 单出口拉取（fetch-urllib 策略内部实现）：执行骨架与 fetch-curl
// 同构——逐跳重定向管理（SSRF 含首跳 + DNS 钉死）、域槽预算、Cookie 回放/捕获；
// 返回 note="exec-error-next-exit" 表示连接级失败可换口重试。
func urllibFetchOneExit(targetURL string, timeoutMs int64, ctx *strategyRunCtx, px string, bin string, warningsIn []string, subAttemptsIn []SubAttempt) attemptResult {
	warnings := append([]string{}, warningsIn...)
	subAttempts := append([]SubAttempt{}, subAttemptsIn...)
	deadline := nowMs() + timeoutMs
	var lastRetryAfter *int64
	totalWaited := int64(0)
	lastLimitedStatus := 0
	var lastLimitedRetryAfter *int64
	lastHTTPStatus := 0
	current := targetURL
	hops := 0
	for {
		tu, err := urlParse(current)
		if err != nil || tu.Host == "" {
			subAttempts = append(subAttempts, SubAttempt{Profile: "openssl", OK: false, Status: 0, Ms: 0, Blocked: false, Bytes: 0, Note: "bad-url"})
			break
		}
		if tu.Scheme != "http" && tu.Scheme != "https" {
			subAttempts = append(subAttempts, SubAttempt{Profile: "openssl", OK: false, Status: 0, Ms: 0, Blocked: false, Bytes: 0, Note: "ssrf-blocked"})
			warnings = append(warnings, "SSRF 防护: 重定向到非 http/https 协议已拒绝: "+tu.Scheme)
			break
		}
		check := assertHostPublic(tu.Hostname())
		if !check.ok {
			subAttempts = append(subAttempts, SubAttempt{Profile: "openssl", OK: false, Status: 0, Ms: 0, Blocked: false, Bytes: 0, Note: "ssrf-blocked"})
			warnings = append(warnings, "SSRF 防护: 重定向终点 "+check.reason)
			break
		}
		if check.warning != "" {
			warnings = append(warnings, "[ssrf] "+check.warning)
		}
		// DNS rebinding 钉死（与 fetch-curl --resolve 同口径）：代理模式连代理本体
		// 不适用；直连模式把 assertHostPublic 缓存 IPv4 猴补进 getaddrinfo
		pinHost, pinIP := "", ""
		if px == "" {
			if pin := curlResolvePin(tu); pin != "" {
				parts := strings.SplitN(pin, ":", 3)
				if len(parts) == 3 {
					pinHost, pinIP = parts[0], parts[2]
				}
			}
		}
		uw, granted := acquireDomainSlotBudgeted(slotKeyFor(hostOf(current), px), deadline, 1000)
		if !granted {
			subAttempts = append(subAttempts, SubAttempt{Profile: "openssl", OK: false, Status: 0, Ms: 0, Blocked: false, Bytes: 0, Note: "timeout-budget"})
			break
		}
		deadline += uw
		totalWaited += uw
		remaining := deadline - nowMs()
		if remaining < 1000 {
			subAttempts = append(subAttempts, SubAttempt{Profile: "openssl", OK: false, Status: 0, Ms: 0, Blocked: false, Bytes: 0, Note: "timeout-budget"})
			break
		}
		s0 := nowMs()
		tag := itoa(int(nowMs())) + "-u-" + strconv.FormatInt(time.Now().UnixNano()%1e9, 36)
		tmpOut := filepath.Join(os.TempDir(), "scraper-"+tag+".body")
		tmpHdr := filepath.Join(os.TempDir(), "scraper-"+tag+".hdr")
		https := tu.Scheme == "https"
		cookieVal := cookieHeaderFor(hostOf(current), https)
		insecure := "0"
		if ctx.insecureTLS {
			insecure = "1"
		}
		args := []string{"-c", urllibFetchScript,
			current, px,
			strconv.FormatFloat(float64(remaining)/1000.0, 'f', -1, 64),
			insecure, cookieVal, pinHost, pinIP, tmpOut, tmpHdr,
		}
		ctxExec, cancel := context.WithTimeout(context.Background(), time.Duration(remaining+3000)*time.Millisecond)
		cmd := exec.CommandContext(ctxExec, bin, args...)
		stdout, execErr := cmd.Output()
		cancel()
		if execErr != nil {
			note := "exec-error"
			if ee, ok := execErr.(*exec.ExitError); ok && ee.ExitCode() == 63 {
				note = "too-large"
			}
			subAttempts = append(subAttempts, SubAttempt{Profile: "openssl", OK: false, Status: 0, Ms: nowMs() - s0, Blocked: false, Bytes: 0, Note: note})
			warnings = append(warnings, "fetch-urllib 执行失败: "+execErrDetail(execErr))
			_ = os.Remove(tmpOut)
			_ = os.Remove(tmpHdr)
			if note == "exec-error" {
				// 连接级失败（代理不可达/TLS 握手失败等）：标记换口
				return attemptResult{ok: false, status: 0, bytes: []byte{}, contentType: "", warnings: warnings, note: "exec-error-next-exit", subAttempts: subAttempts, retryAfter: lastRetryAfter, queueMs: totalWaited}
			}
			break
		}
		parts := strings.Split(strings.TrimSpace(string(stdout)), "\t")
		status := 0
		if len(parts) > 0 {
			status, _ = strconv.Atoi(strings.TrimSpace(parts[0]))
		}
		ctype := ""
		if len(parts) > 1 {
			ctype = strings.TrimSpace(parts[1])
		}
		lastHTTPStatus = status
		hdrTextBytes, hdrErr := os.ReadFile(tmpHdr)
		if hdrErr != nil {
			warnings = append(warnings, "fetch-urllib 响应头文件读取失败: "+hdrErr.Error())
		}
		hdrText := string(hdrTextBytes)
		if scLines := headerLines(hdrText, "Set-Cookie"); len(scLines) > 0 {
			recordSetCookieLines(hostOf(current), scLines, https)
		}
		if isRedirectStatus(status) {
			locs := headerLines(hdrText, "Location")
			_ = os.Remove(tmpOut)
			_ = os.Remove(tmpHdr)
			if len(locs) == 0 {
				subAttempts = append(subAttempts, SubAttempt{Profile: "openssl", OK: false, Status: status, Ms: nowMs() - s0, Blocked: false, Bytes: 0, Note: "redirect-no-location"})
				break
			}
			next := urlJoin(locs[0], current)
			if next == nil {
				subAttempts = append(subAttempts, SubAttempt{Profile: "openssl", OK: false, Status: status, Ms: nowMs() - s0, Blocked: false, Bytes: 0, Note: "redirect-bad-location"})
				warnings = append(warnings, "fetch-urllib 非法 Location 头: "+truncateStr(locs[0], 200))
				break
			}
			if next.Scheme != "http" && next.Scheme != "https" {
				subAttempts = append(subAttempts, SubAttempt{Profile: "openssl", OK: false, Status: status, Ms: nowMs() - s0, Blocked: false, Bytes: 0, Note: "ssrf-blocked"})
				warnings = append(warnings, "SSRF 防护: 重定向到非 http/https 协议已拒绝: "+next.Scheme)
				break
			}
			hops++
			if hops > maxRedirectHops {
				subAttempts = append(subAttempts, SubAttempt{Profile: "openssl", OK: false, Status: status, Ms: nowMs() - s0, Blocked: false, Bytes: 0, Note: "too-many-redirects"})
				warnings = append(warnings, "fetch-urllib 重定向超过 "+itoa(maxRedirectHops)+" 跳，已停止")
				break
			}
			current = next.String()
			continue
		}
		raw, rawErr := os.ReadFile(tmpOut)
		if rawErr != nil {
			warnings = append(warnings, "fetch-urllib 响应体文件读取失败: "+rawErr.Error())
		}
		_ = os.Remove(tmpOut)
		_ = os.Remove(tmpHdr)
		if len(raw) > maxBytes {
			subAttempts = append(subAttempts, SubAttempt{Profile: "openssl", OK: false, Status: status, Ms: nowMs() - s0, Blocked: false, Bytes: len(raw), Note: "too-large"})
			warnings = append(warnings, "fetch-urllib 响应超过 "+itoa(maxBytes)+"B 上限，已放弃")
			break
		}
		a := assess(status, raw, ctype, headerSaysChallenge(headerLines(hdrText, "Cf-Mitigated")))
		subAttempts = append(subAttempts, SubAttempt{Profile: "openssl", OK: a.ok, Status: status, Ms: nowMs() - s0, Blocked: a.blocked, Bytes: a.size, Note: a.note})
		if a.warning != "" {
			warnings = append(warnings, "[openssl] "+a.warning)
		}
		if status >= 400 {
			warnings = append(warnings, "fetch-urllib 收到 HTTP "+itoa(status))
		}
		if status == 429 || status == 503 {
			lastLimitedStatus = status
			if ras := headerLines(hdrText, "Retry-After"); len(ras) > 0 {
				if ra := parseRetryAfterMs(ras[0]); ra != nil {
					lastRetryAfter = ra
					lastLimitedRetryAfter = ra
				}
			}
		}
		if a.ok {
			return attemptResult{ok: true, status: status, bytes: raw, contentType: ctype, warnings: warnings, subAttempts: subAttempts, retryAfter: lastRetryAfter, queueMs: totalWaited}
		}
		break
	}
	finalStatus, finalRA := promoteRateLimitedStatus(lastHTTPStatus, lastRetryAfter, lastLimitedStatus, lastLimitedRetryAfter)
	return attemptResult{ok: false, status: finalStatus, bytes: []byte{}, contentType: "", warnings: warnings, note: "all-variants-failed", subAttempts: subAttempts, retryAfter: finalRA, queueMs: totalWaited}
}
