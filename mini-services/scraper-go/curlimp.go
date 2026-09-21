/**
 * curl-impersonate 策略（逐行移植自 strategies/curl-impersonate.ts）：
 * 系统 curl_chrome* / curl-impersonate-* 二进制（TLS/JA3 指纹级伪装），HTTP/2 失败自动降级
 * --http1.1；二进制缺失时 probe 失败优雅跳过。多二进制时按轮转调度 JA3 指纹轮换。
 *
 * SSRF 加固（与 TS 23-a 一致）：不使用 --location 由 curl 内部跟随重定向；curl 不带 --location
 * （默认不跟随），每跳解析 -D 抓包头中的 Status/Location，每一跳都做协议白名单 + SSRF 校验
 * （含首跳），同时逐跳回放/捕获引擎 cookie 会话。
 */
package main

import (
	"context"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

var reCurlImpersonate = regexp.MustCompile(
	`(?i)^(curl_chrome[\w.]*|curl_ff[\w.]*|curl_edge[\w.]*|curl_safari[\w.]*|curl-impersonate(?:-(?:chrome|ff|firefox|edge|safari)[\w.-]*)?)$`)

// binScore chrome 最新版优先，其次 firefox，再次 edge/safari
func binScore(name string) int {
	browser := 1
	if regexp.MustCompile(`(?i)chrome`).MatchString(name) {
		browser = 3
	} else if regexp.MustCompile(`(?i)ff|firefox`).MatchString(name) {
		browser = 2
	}
	ver := 0
	if m := regexp.MustCompile(`(\d{2,4})`).FindStringSubmatch(name); m != nil {
		ver, _ = strconv.Atoi(m[1])
	}
	return browser*10000 + ver
}

var (
	curlBinMu          sync.Mutex
	curlBins           []string
	curlBinsEmptyAt    int64 // 上次探测结果为空的时间戳（0=非空）：空结果仅缓存 60s
)

// detectCurlImpersonates 检测目录 = PATH 目录 + ~/.local/bin 兜底（引擎 PATH 常不含用户级 bin）
func detectCurlImpersonates() []string {
	curlBinMu.Lock()
	defer curlBinMu.Unlock()
	emptyExpired := curlBinsEmptyAt > 0 && nowMs()-curlBinsEmptyAt >= 60_000
	if curlBins != nil && !emptyExpired {
		return curlBins
	}
	dirs := filepath.SplitList(os.Getenv("PATH"))
	home, _ := os.UserHomeDir()
	if home != "" {
		dirs = append(dirs, filepath.Join(home, ".local", "bin"))
	}
	seen := map[string]bool{}
	type candidate struct {
		path string
		name string
	}
	candidates := []candidate{}
	for _, dir := range dirs {
		if dir == "" || seen[dir] {
			continue
		}
		seen[dir] = true
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			name := e.Name()
			if !reCurlImpersonate.MatchString(name) {
				continue
			}
			full := filepath.Join(dir, name)
			if info, err := os.Stat(full); err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
				candidates = append(candidates, candidate{path: full, name: name})
			}
		}
	}
	// chrome 最新版优先
	for i := 0; i < len(candidates); i++ {
		for j := i + 1; j < len(candidates); j++ {
			if binScore(candidates[j].name) > binScore(candidates[i].name) {
				candidates[i], candidates[j] = candidates[j], candidates[i]
			}
		}
	}
	out := []string{}
	for _, c := range candidates {
		out = append(out, c.path)
	}
	curlBins = out
	if len(out) == 0 {
		curlBinsEmptyAt = nowMs()
	} else {
		curlBinsEmptyAt = 0
	}
	return curlBins
}

var (
	curlCursorMu sync.Mutex
	curlBinCursor int
)

// headerLines 从 -D 抓包文本提取响应头（HTTP/2 头为小写，大小写不敏感匹配；同名多头全量返回）
func headerLines(hdrText, name string) []string {
	re := regexp.MustCompile(`(?i)^` + regexp.QuoteMeta(name) + `:\s*(.*)$`)
	out := []string{}
	for _, line := range strings.Split(hdrText, "\n") {
		if m := re.FindStringSubmatch(strings.TrimRight(line, "\r")); m != nil {
			out = append(out, strings.TrimSpace(m[1]))
		}
	}
	return out
}

var curlImpersonateStrategy = strategyDef{
	name: "curl-impersonate",
	description: "调用系统 curl_chrome*/curl-impersonate-* 二进制（TLS/JA3 指纹级浏览器伪装，多二进制时轮换指纹），HTTP/2 失败自动降级 --http1.1；需另行安装二进制，检测不到则不可用",
	probe:        func() bool { return len(detectCurlImpersonates()) > 0 },
	selfRetrying: true,
	run: func(targetURL string, timeoutMs int64, ctx *strategyRunCtx) attemptResult {
		warnings := []string{}
		subAttempts := []SubAttempt{}
		bins := detectCurlImpersonates()
		if len(bins) == 0 {
			return attemptResult{ok: false, status: 0, bytes: []byte{}, contentType: "", warnings: warnings, note: "missing-binary"}
		}
		curlCursorMu.Lock()
		bin := bins[curlBinCursor%len(bins)]
		curlBinCursor = (curlBinCursor + 1) % len(bins)
		curlCursorMu.Unlock()
		if len(bins) > 1 {
			warnings = append(warnings, "[curl-impersonate] JA3 指纹轮换：本轮使用 "+filepath.Base(bin)+"（"+itoa(len(bins))+" 个二进制轮转）")
		}
		explicitReferer := ctx.referer
		deadline := nowMs() + timeoutMs

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
				// 限速等待后再计算剩余预算（避免超时穿透 deadline）
				remaining := deadline - nowMs()
				if remaining < 1000 {
					subAttempts = append(subAttempts, SubAttempt{Profile: variant.profile, OK: false, Status: 0, Ms: 0, Blocked: false, Bytes: 0, Note: "timeout-budget"})
					stopVariants = true
					break
				}
				s0 := nowMs()
				tag := itoa(int(nowMs())) + "-" + strconv.FormatInt(rand.Int63(), 36)
				tmpOut := filepath.Join(os.TempDir(), "scraper-"+tag+".body")
				tmpHdr := filepath.Join(os.TempDir(), "scraper-"+tag+".hdr")
				// 不带 --location：curl 默认不跟随重定向，3xx 原样返回，
				// 由本策略逐跳校验后再发下一跳
				args := []string{
					"--silent", "--show-error",
					"--max-time", strconv.Itoa(int(remaining/1000) + 1),
					"--max-filesize", strconv.Itoa(maxBytes), // 恶意超大响应在 curl 层直接中止（exit 63）
					"--compressed",
					"--output", tmpOut,
					"--dump-header", tmpHdr,
					"--write-out", "%{http_code}\t%{content_type}",
				}
				if ctx.proxy != "" {
					args = append(args, "--proxy", ctx.proxy)
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
						note = "too-large" // curl --max-filesize 超限：单独标记
					}
					subAttempts = append(subAttempts, SubAttempt{Profile: variant.profile, OK: false, Status: 0, Ms: nowMs() - s0, Blocked: false, Bytes: 0, Note: note})
					msg := ""
					if execErr != nil {
						msg = execErr.Error()
					}
					warnings = append(warnings, "curl-impersonate 执行失败: "+msg)
					_ = os.Remove(tmpOut)
					_ = os.Remove(tmpHdr)
					stopVariants = true // 二进制级失败，HTTP/1.1 降级无意义
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
				hdrTextBytes, _ := os.ReadFile(tmpHdr)
				hdrText := string(hdrTextBytes)
				// Set-Cookie 捕获（每一跳都入会话——3xx 种子跳也在内）
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
						warnings = append(warnings, "curl-impersonate 非法 Location 头: "+truncateStr(locs[0], 200))
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
						warnings = append(warnings, "curl-impersonate 重定向超过 "+itoa(maxRedirectHops)+" 跳，已停止")
						stopVariants = true
						break
					}
					current = next.String()
					continue
				}

				raw, _ := os.ReadFile(tmpOut)
				_ = os.Remove(tmpOut)
				_ = os.Remove(tmpHdr)
				if len(raw) > maxBytes {
					subAttempts = append(subAttempts, SubAttempt{Profile: variant.profile, OK: false, Status: status, Ms: nowMs() - s0, Blocked: false, Bytes: len(raw), Note: "too-large"})
					warnings = append(warnings, "curl-impersonate 响应超过 "+itoa(maxBytes)+"B 上限，已放弃")
					stopVariants = true
					break
				}
				a := assess(status, raw, ctype)
				subAttempts = append(subAttempts, SubAttempt{Profile: variant.profile, OK: a.ok, Status: status, Ms: nowMs() - s0, Blocked: a.blocked, Bytes: a.size, Note: a.note})

				if a.warning != "" {
					warnings = append(warnings, "["+variant.profile+"] "+a.warning)
				}
				if status >= 400 {
					warnings = append(warnings, "curl-impersonate 收到 HTTP "+itoa(status))
				}
				if a.ok {
					return attemptResult{ok: true, status: status, bytes: raw, contentType: ctype, warnings: warnings, subAttempts: subAttempts}
				}
				break // 非重定向且非 2xx：换 HTTP/1.1 画像重试（由外层 variants 循环继续）
			}
			if stopVariants {
				break
			}
		}
		return attemptResult{ok: false, status: 0, bytes: []byte{}, contentType: "", warnings: warnings, note: "all-variants-failed", subAttempts: subAttempts}
	},
}
