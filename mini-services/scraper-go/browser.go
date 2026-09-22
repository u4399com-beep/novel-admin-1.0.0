/**
 * browser 策略（移植自 strategies/browser.ts，Go 版统一走 Python Playwright 桥接）：
 * Playwright + Chromium 真实渲染（对抗 JS 挑战/动态渲染），环境不可用时优雅跳过。
 *
 * Go 版差异说明（见 types.go 文件头）：不实现 TS 版 Node Playwright 共享 Chromium 会话池，
 * 统一经 scripts/render.py 子进程渲染（独立浏览器进程天然无泄漏；render.py 自带 SIGALRM
 * 看门狗与 SSRF 拦截/重资源屏蔽语义，与 TS 桥接路径完全一致）。
 * 渲染前注入引擎 jar 中该主机的 cookie，渲染后把浏览器上下文 cookie 回存（挑战升级 cookie 生效）。
 */
package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// probeBrowserOnce/probeBrowserResult 探测结果进程级缓存。/api/strategies 与链内 probe()
// 会被多请求并发调用，裸 bool 双写是无同步数据竞争 → sync.Once 一次性初始化。
var (
	browserProbeOnce   sync.Once
	browserProbeResult bool
)

// probeBrowser 1) Python Playwright 可导入 2) ~/.cache/ms-playwright 存在 chromium 目录
func probeBrowser() bool {
	browserProbeOnce.Do(func() {
		browserProbeResult = probeBrowserUncached()
	})
	return browserProbeResult
}

func probeBrowserUncached() bool {
	// python3 -c 'import playwright'
	ctx, cancel := contextWithTimeout(10 * time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "python3", "-c", "import playwright")
	if err := cmd.Run(); err != nil {
		return false
	}
	home, _ := os.UserHomeDir()
	if home == "" {
		home = "/root"
	}
	entries, err := os.ReadDir(filepath.Join(home, ".cache", "ms-playwright"))
	if err != nil {
		return false
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "chromium") {
			return true
		}
	}
	return false
}

// renderPayload render.py 输出 JSON
type renderPayload struct {
	Status  int            `json:"status"`
	HTML    string         `json:"html"`
	Error   string         `json:"error"`
	Cookies []bridgeCookie `json:"cookies"`
}

// renderViaPython 参数经 argv 传递（URL 不含换行；UA 含空格由 exec 正确转义）；
// cookie/referer/proxy 走环境变量（cookie 头值可能较长，不适合 argv）。
func renderViaPython(targetURL string, timeoutMs int64, warnings *[]string, explicitReferer, cookieEnv, proxy string) attemptResult {
	renderPy := resolveRenderPy()
	env := os.Environ()
	env = append(env, "PYTHONUNBUFFERED=1")
	if cookieEnv != "" {
		env = append(env, "SCRAPER_COOKIES="+cookieEnv)
	}
	if explicitReferer != "" {
		env = append(env, "SCRAPER_REFERER="+explicitReferer)
	}
	if proxy != "" {
		env = append(env, "SCRAPER_PROXY="+proxy)
	}
	ctx, cancel := contextWithTimeout(time.Duration(timeoutMs+4000) * time.Millisecond)
	defer cancel()
	cmd := exec.CommandContext(ctx, "python3", renderPy, targetURL, itoa(int(timeoutMs)), chromeUA)
	cmd.Env = env
	stdout, err := cmd.Output()
	if err != nil {
		msg := "unknown"
		if err != nil {
			msg = err.Error()
		}
		if strings.Contains(msg, "\n") {
			msg = strings.Split(msg, "\n")[0]
		}
		return attemptResult{ok: false, status: 0, bytes: []byte{}, contentType: "",
			warnings: append(*warnings, "Python Playwright 桥接失败: "+msg), note: "render-error"}
	}
	var payload renderPayload
	if err := json.Unmarshal(stdout, &payload); err != nil {
		return attemptResult{ok: false, status: 0, bytes: []byte{}, contentType: "",
			warnings: append(*warnings, "Python Playwright 桥接输出解析失败: "+err.Error()), note: "render-error"}
	}
	if payload.Error != "" {
		return attemptResult{ok: false, status: 0, bytes: []byte{}, contentType: "",
			warnings: append(*warnings, "Python Playwright 渲染失败: "+payload.Error), note: "render-error"}
	}
	// 渲染会话 cookie 回存（浏览器自己收到的新 cookie 也进入引擎 jar）
	if len(payload.Cookies) > 0 {
		if tu, err := urlParse(targetURL); err == nil {
			recordBridgeCookies(tu.Host, payload.Cookies)
		}
	}
	bytes := []byte(payload.HTML)
	a := assess(payload.Status, bytes, "text/html; charset=utf-8")
	if a.warning != "" {
		*warnings = append(*warnings, a.warning)
	}
	return attemptResult{
		ok: a.ok, status: payload.Status, bytes: bytes, contentType: "text/html; charset=utf-8",
		warnings: *warnings, note: a.note,
		subAttempts: []SubAttempt{{Profile: "python-playwright", OK: a.ok, Status: payload.Status, Ms: 0, Blocked: a.blocked, Bytes: a.size, Note: a.note}},
	}
}

// resolveRenderPy 桥接脚本路径：可执行文件同目录的 scripts/render.py，兜底源码相对路径
func resolveRenderPy() string {
	if exe, err := os.Executable(); err == nil {
		p := filepath.Join(filepath.Dir(exe), "scripts", "render.py")
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	// go run / 源码运行时：以源文件目录推导（scraper-go/scripts/render.py）
	if wd, err := os.Getwd(); err == nil {
		p := filepath.Join(wd, "scripts", "render.py")
		if _, err := os.Stat(p); err == nil {
			return p
		}
		p2 := filepath.Join(wd, "mini-services", "scraper-go", "scripts", "render.py")
		if _, err := os.Stat(p2); err == nil {
			return p2
		}
	}
	return filepath.Join("mini-services", "scraper-go", "scripts", "render.py")
}

var browserStrategy = strategyDef{
	name:         "browser",
	description:  "Playwright + Chromium 真实渲染（经 Python Playwright 桥接），对抗 JS 挑战/动态渲染；环境不可用时优雅跳过",
	probe:        probeBrowser,
	selfRetrying: true,
	run: func(targetURL string, timeoutMs int64, ctx *strategyRunCtx) attemptResult {
		warnings := []string{"browser 策略为完整浏览器渲染，成本最高（约 1-5s），仅建议前序策略失败时使用"}
		// Cookie 会话：渲染前注入引擎 jar 中该主机的 cookie（SCRAPER_COOKIES 环境变量透传），
		// 渲染后把浏览器上下文 cookie 回存。命中「首访种 cookie、二访放行」的站点时，
		// 前序 fetch 策略种下的会话在这里直接生效。
		var tu, _ = urlParse(targetURL)
		cookieEnv := ""
		if tu != nil {
			https := tu.Scheme == "https"
			cookieEnv = cookieHeaderFor(tu.Host, https)
			// 注入格式 cookie 同样经 SCRAPER_COOKIES 透传（render.py 兼容两种格式）
			if injected := cookiesForPlaywright(tu.Host, https); len(injected) > 0 && cookieEnv == "" {
				parts := []string{}
				for _, c := range injected {
					parts = append(parts, c.Name+"="+c.Value)
				}
				cookieEnv = strings.Join(parts, "; ")
			}
		}
		return renderViaPython(targetURL, timeoutMs, &warnings, ctx.referer, cookieEnv, ctx.proxy)
	},
}
