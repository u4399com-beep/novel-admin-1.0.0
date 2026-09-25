/**
 * fetch-curl 策略（Task 25 反反爬增强）：
 * 调用系统原生 curl（非 curl-impersonate 指纹二进制）。实测背景：部分站点的 Cloudflare WAF
 * 会拦截 curl-impersonate 等已知爬虫指纹（JA3 进黑名单），却放行「普通 curl + 浏览器 UA」
 * 的诚实客户端（5165.org 实证：全策略 403 challenge-page，系统 curl + Chrome UA 三连 200）。
 *
 * 执行骨架与 curlimp.go 同构：不带 --location 逐跳解析重定向 + 每跳协议白名单 + SSRF 校验
 * （含首跳）+ Cookie 会话回放/捕获 + Retry-After 透出；HTTP/2 失败自动降级 --http1.1。
 */
package main

import (
	"context"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	curlPlainMu     sync.Mutex
	curlPlainPath   string
	curlPlainMissAt int64 // 上次探测失败的时间戳（0=可用）：失败结果仅缓存 60s
)

// detectPlainCurl 定位系统原生 curl（basename 必须恰为 curl，避免误抓 curl_chrome* 指纹二进制）
func detectPlainCurl() string {
	curlPlainMu.Lock()
	defer curlPlainMu.Unlock()
	if curlPlainMissAt > 0 && nowMs()-curlPlainMissAt < 60_000 {
		return "" // 60s 内刚探测失败：跳过
	}
	if curlPlainPath != "" {
		return curlPlainPath
	}
	p, err := exec.LookPath("curl")
	if err != nil || p == "" {
		curlPlainMissAt = nowMs()
		return ""
	}
	base := strings.ToLower(baseName(p))
	if base != "curl" && base != "curl.exe" {
		curlPlainMissAt = nowMs()
		return ""
	}
	curlPlainPath = p
	return p
}

func baseName(p string) string {
	if i := strings.LastIndexAny(p, "/\\"); i >= 0 {
		return p[i+1:]
	}
	return p
}

var curlPlainStrategy = strategyDef{
	name:         "fetch-curl",
	description:  "调用系统原生 curl（诚实客户端指纹：普通 curl + 桌面/移动浏览器 UA 轮换，HTTP/2 失败自动降级 --http1.1）；针对「拦截已知爬虫指纹但放行普通 curl」的 WAF 站点（Task 25 新增）",
	probe:        func() bool { return detectPlainCurl() != "" },
	selfRetrying: true,
	run: func(targetURL string, timeoutMs int64, ctx *strategyRunCtx) attemptResult {
		warnings := []string{}
		subAttempts := []SubAttempt{}
		bin := detectPlainCurl()
		if bin == "" {
			return attemptResult{ok: false, status: 0, bytes: []byte{}, contentType: "", warnings: warnings, note: "missing-curl"}
		}
		explicitReferer := ctx.referer
		deadline := nowMs() + timeoutMs
		var lastRetryAfter *int64
		// Task 32-d 修复：失败时 status 恒回 0 → 链层限流记忆（429/503）丢失，与 curlimp.go 同口径修复
		lastHTTPStatus := 0

		// 子尝试梯子：默认（HTTP/2）→ --http1.1（覆盖协议指纹差异）
		variants := []struct {
			profile   string
			extraArgs []string
		}{{profile: "h2-default", extraArgs: nil}, {profile: "http1.1", extraArgs: []string{"--http1.1"}}}

		for _, variant := range variants {
			current := targetURL
			hops := 0
			stopVariants := false
			for {
				tu, err := urlParse(current)
				if err != nil || tu.Host == "" {
					subAttempts = append(subAttempts, SubAttempt{Profile: variant.profile, OK: false, Status: 0, Ms: 0, Blocked: false, Bytes: 0, Note: "bad-url"})
					stopVariants = true
					break
				}
				if tu.Scheme != "http" && tu.Scheme != "https" {
					subAttempts = append(subAttempts, SubAttempt{Profile: variant.profile, OK: false, Status: 0, Ms: 0, Blocked: false, Bytes: 0, Note: "ssrf-blocked"})
					warnings = append(warnings, "SSRF 防护: 重定向到非 http/https 协议已拒绝: "+tu.Scheme)
					stopVariants = true
					break
				}
				// 逐跳 SSRF 校验（含首跳，DNS 结果走进程内缓存）
				check := assertHostPublic(tu.Hostname())
				if !check.ok {
					subAttempts = append(subAttempts, SubAttempt{Profile: variant.profile, OK: false, Status: 0, Ms: 0, Blocked: false, Bytes: 0, Note: "ssrf-blocked"})
					warnings = append(warnings, "SSRF 防护: 重定向终点 "+check.reason)
					stopVariants = true
					break
				}
				if check.warning != "" {
					warnings = append(warnings, "[ssrf] "+check.warning)
				}

				acquireDomainSlot(hostOf(current))
				remaining := deadline - nowMs()
				if remaining < 1000 {
					subAttempts = append(subAttempts, SubAttempt{Profile: variant.profile, OK: false, Status: 0, Ms: 0, Blocked: false, Bytes: 0, Note: "timeout-budget"})
					stopVariants = true
					break
				}
				s0 := nowMs()
				// Task 27-c 修复：旧 tag 仅 nowMs+"-c"，同毫秒并发的两次 fetch-curl 请求
				// 临时文件同名互踩（正文串章/头文件混写/提前删除）；补随机后缀与
				// curlimp.go 同构。随机位数足够，冲突概率可忽略
				tag := itoa(int(nowMs())) + "-c-" + strconv.FormatInt(rand.Int63(), 36)
				tmpOut := filepath.Join(os.TempDir(), "scraper-"+tag+".body")
				tmpHdr := filepath.Join(os.TempDir(), "scraper-"+tag+".hdr")
				args := []string{
					"--silent", "--show-error",
					"--max-time", strconv.Itoa(int(remaining/1000) + 1),
					"--max-filesize", strconv.Itoa(maxBytes),
					"--compressed",
					"--output", tmpOut,
					"--dump-header", tmpHdr,
					"--write-out", "%{http_code}\t%{content_type}",
				}
				if ctx.proxy != "" {
					args = append(args, "--proxy", ctx.proxy)
				} else if pin := curlResolvePin(tu); pin != "" {
					// Task 27-c 补齐（与 curlimp.go 同构）：fetch-curl 此前漏挂 --resolve
					// DNS rebinding 钉死参数——assertHostPublic 的 Go 侧解析与 curl
					// 自身二次解析之间存在 TOCTOU 窗口（A 记录可在两次解析间从公网
					// 切到 127.0.0.1）。代理模式下 curl 连接的是代理本身，--resolve
					// 不适用故跳过
					args = append(args, "--resolve", pin)
				}
				if ctx.insecureTLS {
					args = append(args, "--insecure")
				}
				for k, v := range chromeDesktopProfile.headers(targetURL, true, explicitReferer) {
					args = append(args, "--header", k+": "+v)
				}
				https := tu.Scheme == "https"
				if cookie := cookieHeaderFor(tu.Host, https); cookie != "" {
					args = append(args, "--cookie", cookie)
				}
				args = append(args, variant.extraArgs...)
				args = append(args, "--", current) // -- 防止 URL 被解析为选项

				ctxExec, cancel := context.WithTimeout(context.Background(), time.Duration(remaining+3000)*time.Millisecond)
				cmd := exec.CommandContext(ctxExec, bin, args...)
				stdout, execErr := cmd.Output()
				cancel()
				if execErr != nil {
					note := "exec-error"
					if ee, ok := execErr.(*exec.ExitError); ok && ee.ExitCode() == 63 {
						note = "too-large"
					}
					subAttempts = append(subAttempts, SubAttempt{Profile: variant.profile, OK: false, Status: 0, Ms: nowMs() - s0, Blocked: false, Bytes: 0, Note: note})
					msg := ""
					if execErr != nil {
						msg = execErr.Error()
					}
					warnings = append(warnings, "fetch-curl 执行失败: "+msg)
					_ = os.Remove(tmpOut)
					_ = os.Remove(tmpHdr)
					stopVariants = true
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
				lastHTTPStatus = status // Task 32-d: 保留最后一个 HTTP 状态码（含 3xx/429/5xx）
				hdrTextBytes, hdrErr := os.ReadFile(tmpHdr)
				if hdrErr != nil {
					// Task 32-d: 错误不再吞没——头文件读不到时 Set-Cookie/Location 全部失效，需留痕
					warnings = append(warnings, "fetch-curl 响应头文件读取失败: "+hdrErr.Error())
				}
				hdrText := string(hdrTextBytes)
				if scLines := headerLines(hdrText, "Set-Cookie"); len(scLines) > 0 {
					recordSetCookieLines(tu.Host, scLines, https)
				}

				if isRedirectStatus(status) {
					locs := headerLines(hdrText, "Location")
					_ = os.Remove(tmpOut)
					_ = os.Remove(tmpHdr)
					if len(locs) == 0 {
						subAttempts = append(subAttempts, SubAttempt{Profile: variant.profile, OK: false, Status: status, Ms: nowMs() - s0, Blocked: false, Bytes: 0, Note: "redirect-no-location"})
						break
					}
					next := urlJoin(locs[0], current)
					if next == nil {
						subAttempts = append(subAttempts, SubAttempt{Profile: variant.profile, OK: false, Status: status, Ms: nowMs() - s0, Blocked: false, Bytes: 0, Note: "redirect-bad-location"})
						warnings = append(warnings, "fetch-curl 非法 Location 头: "+truncateStr(locs[0], 200))
						break
					}
					if next.Scheme != "http" && next.Scheme != "https" {
						subAttempts = append(subAttempts, SubAttempt{Profile: variant.profile, OK: false, Status: status, Ms: nowMs() - s0, Blocked: false, Bytes: 0, Note: "ssrf-blocked"})
						warnings = append(warnings, "SSRF 防护: 重定向到非 http/https 协议已拒绝: "+next.Scheme)
						stopVariants = true
						break
					}
					hops++
					if hops > maxRedirectHops {
						subAttempts = append(subAttempts, SubAttempt{Profile: variant.profile, OK: false, Status: status, Ms: nowMs() - s0, Blocked: false, Bytes: 0, Note: "too-many-redirects"})
						warnings = append(warnings, "fetch-curl 重定向超过 "+itoa(maxRedirectHops)+" 跳，已停止")
						stopVariants = true
						break
					}
					current = next.String()
					continue
				}

				raw, rawErr := os.ReadFile(tmpOut)
				if rawErr != nil {
					// Task 32-d: 错误不再吞没——body 文件读不到会被误判为 empty-body
					warnings = append(warnings, "fetch-curl 响应体文件读取失败: "+rawErr.Error())
				}
				_ = os.Remove(tmpOut)
				_ = os.Remove(tmpHdr)
				if len(raw) > maxBytes {
					subAttempts = append(subAttempts, SubAttempt{Profile: variant.profile, OK: false, Status: status, Ms: nowMs() - s0, Blocked: false, Bytes: len(raw), Note: "too-large"})
					warnings = append(warnings, "fetch-curl 响应超过 "+itoa(maxBytes)+"B 上限，已放弃")
					stopVariants = true
					break
				}
				a := assess(status, raw, ctype)
				subAttempts = append(subAttempts, SubAttempt{Profile: variant.profile, OK: a.ok, Status: status, Ms: nowMs() - s0, Blocked: a.blocked, Bytes: a.size, Note: a.note})

				if a.warning != "" {
					warnings = append(warnings, "["+variant.profile+"] "+a.warning)
				}
				if status >= 400 {
					warnings = append(warnings, "fetch-curl 收到 HTTP "+itoa(status))
				}
				if status == 429 || status == 503 {
					if ras := headerLines(hdrText, "Retry-After"); len(ras) > 0 {
						if ra := parseRetryAfterMs(ras[0]); ra != nil {
							lastRetryAfter = ra
						}
					}
				}
				if a.ok {
					return attemptResult{ok: true, status: status, bytes: raw, contentType: ctype, warnings: warnings, subAttempts: subAttempts, retryAfter: lastRetryAfter}
				}
				break
			}
			if stopVariants {
				break
			}
		}
		return attemptResult{ok: false, status: lastHTTPStatus, bytes: []byte{}, contentType: "", warnings: warnings, note: "all-variants-failed", subAttempts: subAttempts, retryAfter: lastRetryAfter}
	},
}
