/**
 * stealth-service 侧车客户端（Task 101-a）：scraper-go 策略链的两个反检测后端。
 *
 * 侧车 = mini-services/stealth-service（Python 标准库 HTTP 服务，:3031，零 Node/TS）：
 *   - /cloak：CloakBrowser 隐身 Chromium 渲染（C++ 源码级指纹伪装，过 Cloudflare/指纹检测；重但强）
 *   - /iv8  ：iv8 V8 环境模拟（无头执行站点 JS 算 cookie/参数，轻量高并发）
 *
 * 可用性探测：GET /health 带 TTL 缓存（成功 60s / 失败 10s——失败不永久拉黑，
 * 冷却后下次请求重新探测；与 curl-impersonate 二进制探测的空结果缓存同形态）。
 * 探测失败时两个侧车策略 available=false，链层自动跳过，不产生任何网络尝试。
 *
 * 域槽/限速：侧车策略与原生策略同样走 acquireDomainSlotBudgeted 取 host 域槽
 * （礼貌间隔红线不变——侧车只是「取回 HTML 的手段」不同，对目标站的请求节奏由引擎统一治理）。
 * 目标 URL 的 SSRF 校验已在链入口完成，侧车仅作为渲染/执行代理，不额外放宽。
 */
package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// sidecarBaseURL 侧车地址（env SCRAPE_SIDECAR_URL，默认本机 :3031）
func sidecarBaseURL() string {
	if v := strings.TrimRight(strings.TrimSpace(getenv("SCRAPE_SIDECAR_URL")), "/"); v != "" {
		return v
	}
	return "http://127.0.0.1:3031"
}

const (
	sidecarProbeOKTTLMS   int64 = 60_000 // 可用结果缓存 60s
	sidecarProbeFailTTLMS int64 = 10_000 // 失败缓存 10s：不永久拉黑，冷却后重新探测
	sidecarProbeTimeoutMS       = 2500   // /health 探测超时
	// 侧车调用余量：侧车自身有「真实取页 + JS 执行/渲染」两层耗时，HTTP 客户端
	// 在策略预算之外多给 5s，让侧车能把结构化错误传回来而不是被客户端先掐断
	sidecarSlackMS = 5000
)

var (
	sidecarMu        sync.Mutex
	sidecarAvail     bool
	sidecarCaps      sidecarHealth // 最近一次 /health 能力位（available=true 时有效）
	sidecarCheckedAt int64         // 0 = 从未探测过
)

// sidecarHealth /health 响应（只取需要的字段）
type sidecarHealth struct {
	Cloak       bool `json:"cloak"`
	CloakBinary bool `json:"cloakBinary"`
	IV8         bool `json:"iv8"`
}

// resetSidecarProbeCache 测试钩子：清空可用性缓存（sidecar_test.go 换假侧车地址后调用）
func resetSidecarProbeCache() {
	sidecarMu.Lock()
	defer sidecarMu.Unlock()
	sidecarAvail = false
	sidecarCheckedAt = 0
	sidecarCaps = sidecarHealth{}
}

// sidecarProbeUncached 实时探测（调用方持锁）
func sidecarProbeUncached() (sidecarHealth, bool) {
	var caps sidecarHealth
	raw, err := sidecarHTTPGet(sidecarBaseURL()+"/health", sidecarProbeTimeoutMS)
	if err != nil {
		return caps, false
	}
	if err := json.Unmarshal(raw, &caps); err != nil {
		return sidecarHealth{}, false
	}
	return caps, true
}

// sidecarAvailable 侧车 /health 可用性（带缓存探测）。
// 成功缓存 60s；失败缓存 10s（避免高并发下每请求都打探测超时，同时不永久拉黑）。
func sidecarAvailable() bool {
	sidecarMu.Lock()
	defer sidecarMu.Unlock()
	now := nowMs()
	if sidecarCheckedAt != 0 {
		ttl := sidecarProbeFailTTLMS
		if sidecarAvail {
			ttl = sidecarProbeOKTTLMS
		}
		if now-sidecarCheckedAt < ttl {
			return sidecarAvail
		}
	}
	caps, ok := sidecarProbeUncached()
	sidecarAvail = ok
	sidecarCaps = caps
	sidecarCheckedAt = now
	return ok
}

// sidecarCapabilities 最近一次成功探测的能力位（available=false 时零值）。
// 仅在 sidecarAvailable() 为 true 后读取有意义；链层 probe 先调 available 再取能力位。
func sidecarCapabilities() sidecarHealth {
	sidecarMu.Lock()
	defer sidecarMu.Unlock()
	return sidecarCaps
}

// ---------------------------------------------------------------------------
// HTTP 调用（侧车 JSON in/out；业务失败 HTTP 200 + ok:false，按业务层判定）
// ---------------------------------------------------------------------------

// sidecarHTTPGet GET + 短超时（探测用）
func sidecarHTTPGet(url string, timeoutMS int64) ([]byte, error) {
	client := &http.Client{Timeout: time.Duration(timeoutMS) * time.Millisecond}
	resp, err := client.Get(url)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	return io.ReadAll(io.LimitReader(resp.Body, maxBytes))
}

// sidecarPost POST JSON + timeoutMs+5s 余量，返回原始响应体
func sidecarPost(path string, payload any, timeoutMs int64) ([]byte, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	client := &http.Client{Timeout: time.Duration(timeoutMs+sidecarSlackMS) * time.Millisecond}
	resp, err := client.Post(sidecarBaseURL()+path, "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	return io.ReadAll(io.LimitReader(resp.Body, maxBytes))
}

// sidecarCloakResp /cloak 响应
type sidecarCloakResp struct {
	OK        bool   `json:"ok"`
	HTML      string `json:"html"`
	Status    int    `json:"status"`
	FinalURL  string `json:"finalUrl"`
	ElapsedMS int64  `json:"elapsedMs"`
	Error     string `json:"error"`
}

// sidecarIv8Resp /iv8 响应
type sidecarIv8Resp struct {
	OK              bool   `json:"ok"`
	HTML            string `json:"html"`
	Cookies         string `json:"cookies"`
	Status          int    `json:"status"`
	ElapsedMS       int64  `json:"elapsedMs"`
	ExecutedScripts int    `json:"executedScripts"`
	MissingScripts  int    `json:"missingScripts"`
	FinalURL        string `json:"finalUrl"`
	Error           string `json:"error"`
}

// sidecarCloakFetch CloakBrowser 渲染：返回渲染后 DOM/状态码/最终 URL/耗时。
// err != nil = 侧车调用层失败（拒连/超时/非法响应）；resp.OK=false = 侧车业务层失败（站点被拒等）。
func sidecarCloakFetch(url string, timeoutMs int64, proxy, ua string) (sidecarCloakResp, error) {
	payload := map[string]any{"url": url, "timeoutMs": timeoutMs}
	if proxy != "" {
		payload["proxy"] = proxy
	}
	if ua != "" {
		payload["userAgent"] = ua
	}
	raw, err := sidecarPost("/cloak", payload, timeoutMs)
	if err != nil {
		return sidecarCloakResp{}, err
	}
	var out sidecarCloakResp
	if err := json.Unmarshal(raw, &out); err != nil {
		return sidecarCloakResp{}, err
	}
	return out, nil
}

// sidecarIv8Fetch iv8 执行页面 JS：返回执行后 DOM/cookie/状态码/耗时。
// err 语义同上。
func sidecarIv8Fetch(url string, timeoutMs int64, ua string) (sidecarIv8Resp, error) {
	payload := map[string]any{"url": url, "timeoutMs": timeoutMs}
	if ua != "" {
		payload["userAgent"] = ua
	}
	raw, err := sidecarPost("/iv8", payload, timeoutMs)
	if err != nil {
		return sidecarIv8Resp{}, err
	}
	var out sidecarIv8Resp
	if err := json.Unmarshal(raw, &out); err != nil {
		return sidecarIv8Resp{}, err
	}
	return out, nil
}

// sidecarRecordCookies 把 /iv8 算出的 cookie（"k=v; k2=v2"）回存引擎会话桶。
// 与 browser 策略的 cookie 回存同语义：iv8 页内脚本种下的会话 cookie 对该主机
// 后续所有策略生效（「首访 JS 种 cookie、二访放行」站点的前半程由 iv8 完成）。
func sidecarRecordCookies(targetURL, cookieHeader string) {
	tu, err := urlParse(targetURL)
	if err != nil || tu == nil || strings.TrimSpace(cookieHeader) == "" {
		return
	}
	cookies := []bridgeCookie{}
	for _, part := range strings.Split(cookieHeader, ";") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		eq := strings.IndexByte(part, '=')
		if eq <= 0 {
			continue
		}
		cookies = append(cookies, bridgeCookie{Name: strings.TrimSpace(part[:eq]), Value: strings.TrimSpace(part[eq+1:])})
	}
	if len(cookies) > 0 {
		recordBridgeCookies(hostOf(targetURL), cookies)
	}
}
