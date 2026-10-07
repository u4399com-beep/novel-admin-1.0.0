/**
 * Task 101-a: stealth-service 侧车策略测试（httptest 假侧车，零真实网络依赖）。
 *
 * 覆盖面：
 *   - /health 探测：可用/能力位 → 两策略 probe 语义（fetch-cloak 需 cloak+二进制双真，
 *     fetch-iv8 需 iv8 真）；
 *   - 探测缓存：成功/失败 TTL 门控 + 失败不永久拉黑（冷却后重新探测恢复 true）；
 *   - 策略成功路径：假侧车 /cloak、/iv8 返回 HTML → 策略 ok、assess 通过、子尝试
 *     profile 记账（cloak-sidecar / iv8-sidecar）；
 *   - cookie 回存：/iv8 的 "k=v; k2=v2" 进入引擎会话桶（与 browser 策略同语义）；
 *   - 失败语义分层：侧车调用层失败（拒连）→ "unavailable-sidecar"（引擎自状态，
 *     不计入站点网络连败——isEngineStateNote 前缀契约）；侧车业务层失败（ok:false）
 *     → "cloak-render-failed"/"iv8-run-failed"（真实网络证据）；
 *   - 链序契约：fetch-cloak 紧随 fetch-browser，fetch-iv8 恒为链尾；
 *   - 链层端到端：显式指定 strategy=fetch-cloak 时单策略链命中假侧车成功；侧车下线
 *     时回退全链不报错（pickOrder 既有语义）。
 */
package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
)

// TestMain 单测进程级基线：侧车视为不可用（指向必拒连端口），与「curl-impersonate
// 二进制缺失」同形态——既有全链测试不受沙箱里真实侧车进程（:3031）可用性抖动影响，
// 失败路径断言（全策略失败/子尝试序列）保持确定性。
func TestMain(m *testing.M) {
	_ = os.Setenv("SCRAPE_SIDECAR_URL", "http://127.0.0.1:9")
	resetSidecarProbeCache()
	code := m.Run()
	os.Exit(code)
}

// fakeSidecar 可编程假侧车：health 载荷 + cloak/iv8 处理器均可运行时替换
type fakeSidecar struct {
	mu            sync.Mutex
	healthPayload func() string
	cloakHandler  func(w http.ResponseWriter, body map[string]any)
	iv8Handler    func(w http.ResponseWriter, body map[string]any)
	lastCloakBody map[string]any
	lastIv8Body   map[string]any
	srv           *httptest.Server
}

func newFakeSidecar(t *testing.T) *fakeSidecar {
	t.Helper()
	fs := &fakeSidecar{
		healthPayload: func() string {
			return `{"ok":true,"service":"stealth-service","cloak":true,"cloakBinary":true,"iv8":true,"version":"1.0.0"}`
		},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		fs.mu.Lock()
		h := fs.healthPayload
		fs.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(h()))
	})
	mux.HandleFunc("/cloak", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		fs.mu.Lock()
		fs.lastCloakBody = body
		h := fs.cloakHandler
		fs.mu.Unlock()
		if h == nil {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":false,"error":"no cloak handler"}`))
			return
		}
		h(w, body)
	})
	mux.HandleFunc("/iv8", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		fs.mu.Lock()
		fs.lastIv8Body = body
		h := fs.iv8Handler
		fs.mu.Unlock()
		if h == nil {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":false,"error":"no iv8 handler"}`))
			return
		}
		h(w, body)
	})
	fs.srv = httptest.NewServer(mux)
	t.Cleanup(fs.srv.Close)
	// 指向假侧车并清空探测缓存（TestMain 的死口基线被本用例覆盖，用完恢复）
	t.Setenv("SCRAPE_SIDECAR_URL", fs.srv.URL)
	resetSidecarProbeCache()
	t.Cleanup(resetSidecarProbeCache)
	return fs
}

func (fs *fakeSidecar) lastRequest(kind string) map[string]any {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	if kind == "cloak" {
		return fs.lastCloakBody
	}
	return fs.lastIv8Body
}

// setHealth / setHandlers 用例中替换假侧车行为
func (fs *fakeSidecar) setHealth(payload string) {
	fs.mu.Lock()
	fs.healthPayload = func() string { return payload }
	fs.mu.Unlock()
}

// TestSidecarHealthProbe /health 探测与两策略 probe 语义
func TestSidecarHealthProbe(t *testing.T) {
	fs := newFakeSidecar(t)
	if !sidecarAvailable() {
		t.Fatalf("假侧车在线时 sidecarAvailable 应 true")
	}
	caps := sidecarCapabilities()
	if !caps.Cloak || !caps.CloakBinary || !caps.IV8 {
		t.Fatalf("能力位应全真，got %+v", caps)
	}
	if !probeSidecarCloak() || !probeSidecarIv8() {
		t.Fatalf("能力全真时两策略 probe 应 true（cloak=%v iv8=%v）", probeSidecarCloak(), probeSidecarIv8())
	}

	// cloak 库可导入但二进制未就绪 → fetch-cloak 不可用，fetch-iv8 不受影响
	fs.setHealth(`{"ok":true,"cloak":true,"cloakBinary":false,"iv8":true,"version":"1.0.0"}`)
	resetSidecarProbeCache()
	if probeSidecarCloak() {
		t.Fatalf("cloakBinary=false 时 fetch-cloak probe 应 false（二进制未就绪=不可用）")
	}
	if !probeSidecarIv8() {
		t.Fatalf("fetch-iv8 probe 不受 cloakBinary 影响，应 true")
	}

	// 侧车 /health 返回非法 JSON → available=false，两策略全跳过
	fs.setHealth(`<html>not json</html>`)
	resetSidecarProbeCache()
	if sidecarAvailable() {
		t.Fatalf("侧车返回非法 JSON 时 available 应 false")
	}
	if probeSidecarCloak() || probeSidecarIv8() {
		t.Fatalf("侧车不可用时两策略 probe 必须全 false（链自动跳过）")
	}
}

// TestSidecarProbeCacheTTL 探测缓存 TTL 门控 + 失败不永久拉黑
func TestSidecarProbeCacheTTL(t *testing.T) {
	fs := newFakeSidecar(t)
	if !sidecarAvailable() {
		t.Fatalf("首次探测应在线")
	}
	// 成功结果缓存期内：即便侧车此刻换载荷，缓存仍应命中（不重复探测）
	fs.setHealth(`{"ok":true,"cloak":false,"cloakBinary":false,"iv8":false,"version":"1.0.0"}`)
	if !sidecarAvailable() {
		t.Fatalf("成功缓存 TTL 内不应重新探测")
	}

	// 失败缓存：探测失败后 available=false；TTL 内不重新探测
	fs.setHealth(`not-json`)
	resetSidecarProbeCache()
	if sidecarAvailable() {
		t.Fatalf("失败探测应 false")
	}
	if sidecarAvailable() {
		t.Fatalf("失败缓存 TTL 内不应重新探测")
	}
	// 手动回拨出失败 TTL（10s），并把侧车恢复健康 → 重新探测应转 true（不永久拉黑）
	sidecarMu.Lock()
	sidecarCheckedAt = nowMs() - sidecarProbeFailTTLMS - 1
	sidecarMu.Unlock()
	fs.setHealth(`{"ok":true,"cloak":true,"cloakBinary":true,"iv8":true,"version":"1.0.0"}`)
	if !sidecarAvailable() {
		t.Fatalf("失败缓存过期后重新探测应恢复 true（失败不永久拉黑）")
	}
}

// TestSidecarCloakStrategyRun fetch-cloak 成功路径 + /cloak 请求体透传
func TestSidecarCloakStrategyRun(t *testing.T) {
	fake := newFakeSidecar(t)
	fake.mu.Lock()
	fake.cloakHandler = func(w http.ResponseWriter, _ map[string]any) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"html":"<html><body>hello cloak</body></html>","status":200,"finalUrl":"http://final.test/","elapsedMs":123}`))
	}
	fake.mu.Unlock()

	res := fetchCloakStrategy.run("http://cloak-target.invalid/page", 8000, &strategyRunCtx{})
	if !res.ok {
		t.Fatalf("fetch-cloak 应成功，got note=%s warnings=%v", res.note, res.warnings)
	}
	if !strings.Contains(string(res.bytes), "hello cloak") {
		t.Fatalf("应返回侧车渲染后的 DOM，got %q", truncateStr(string(res.bytes), 120))
	}
	if res.status != 200 || res.note != "" || len(res.subAttempts) != 1 || res.subAttempts[0].Profile != "cloak-sidecar" {
		t.Fatalf("status/subAttempts 记账异常: status=%d note=%q sub=%+v", res.status, res.note, res.subAttempts)
	}
	body := fake.lastRequest("cloak")
	if body == nil || body["url"] != "http://cloak-target.invalid/page" {
		t.Fatalf("/cloak 请求体应透传目标 URL，got %v", body)
	}
}

// TestSidecarIv8StrategyRun fetch-iv8 成功路径 + cookie 回存引擎会话桶
func TestSidecarIv8StrategyRun(t *testing.T) {
	fake := newFakeSidecar(t)
	fake.mu.Lock()
	fake.iv8Handler = func(w http.ResponseWriter, _ map[string]any) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"html":"<html><body>iv8 executed</body></html>","cookies":"acw_sc__v2=abc123; jsluid=777","status":200,"elapsedMs":45,"executedScripts":2,"missingScripts":0,"finalUrl":"http://iv8-target.invalid/"}`))
	}
	fake.mu.Unlock()

	target := "http://iv8-target.invalid/chapter/1"
	res := fetchIv8Strategy.run(target, 8000, &strategyRunCtx{})
	if !res.ok {
		t.Fatalf("fetch-iv8 应成功，got note=%s warnings=%v", res.note, res.warnings)
	}
	if !strings.Contains(string(res.bytes), "iv8 executed") {
		t.Fatalf("应返回执行后 DOM，got %q", truncateStr(string(res.bytes), 120))
	}
	if res.subAttempts[0].Profile != "iv8-sidecar" {
		t.Fatalf("子尝试 profile 应为 iv8-sidecar，got %+v", res.subAttempts)
	}
	// cookie 回存：与 browser 策略同语义（「首访 JS 种 cookie、二访放行」链路）
	got := cookieHeaderFor(hostOf(target), false)
	if !strings.Contains(got, "acw_sc__v2=abc123") || !strings.Contains(got, "jsluid=777") {
		t.Fatalf("iv8 算出的 cookie 应回存引擎会话桶，got %q", got)
	}
}

// TestSidecarFailureSemantics 失败语义分层：调用层失败 vs 业务层失败
func TestSidecarFailureSemantics(t *testing.T) {
	t.Run("业务层失败 ok:false", func(t *testing.T) {
		fake := newFakeSidecar(t)
		fake.mu.Lock()
		fake.cloakHandler = func(w http.ResponseWriter, _ map[string]any) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":false,"error":"渲染失败: net::ERR_CONNECTION_REFUSED"}`))
		}
		fake.iv8Handler = func(w http.ResponseWriter, _ map[string]any) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":false,"error":"URLError: <urlopen error refused>"}`))
		}
		fake.mu.Unlock()

		cloakRes := fetchCloakStrategy.run("http://biz-fail.invalid/a", 8000, &strategyRunCtx{})
		if cloakRes.ok || cloakRes.note != "cloak-render-failed" {
			t.Fatalf("cloak 业务失败应 note=cloak-render-failed，got %q ok=%v", cloakRes.note, cloakRes.ok)
		}
		if !hasRealNetworkAttempt([]AttemptSummary{{Strategy: "fetch-cloak", Status: cloakRes.status, Note: cloakRes.note}}) {
			t.Fatalf("业务层失败（侧车确实向目标站发起了请求）应计真实网络证据")
		}
		iv8Res := fetchIv8Strategy.run("http://biz-fail.invalid/b", 8000, &strategyRunCtx{})
		if iv8Res.ok || iv8Res.note != "iv8-run-failed" {
			t.Fatalf("iv8 业务失败应 note=iv8-run-failed，got %q", iv8Res.note)
		}
	})

	t.Run("调用层失败 拒连 → 引擎自状态不计站点连败", func(t *testing.T) {
		// TestMain 基线即死口 :9——这里直接恢复死口基线验证拒连路径
		t.Setenv("SCRAPE_SIDECAR_URL", "http://127.0.0.1:9")
		resetSidecarProbeCache()
		defer resetSidecarProbeCache()
		if probeSidecarCloak() || probeSidecarIv8() {
			t.Fatalf("拒连时两策略 probe 应 false")
		}
		cloakRes := fetchCloakStrategy.run("http://dead-sidecar.invalid/a", 5000, &strategyRunCtx{})
		if cloakRes.ok || cloakRes.note != "unavailable-sidecar" {
			t.Fatalf("拒连应 note=unavailable-sidecar，got %q", cloakRes.note)
		}
		iv8Res := fetchIv8Strategy.run("http://dead-sidecar.invalid/b", 5000, &strategyRunCtx{})
		if iv8Res.note != "unavailable-sidecar" {
			t.Fatalf("拒连应 note=unavailable-sidecar，got %q", iv8Res.note)
		}
		// isEngineStateNote 契约：侧车调用层失败不计入站点网络级连败（不触发熔断误判）
		if !isEngineStateNote("unavailable-sidecar") {
			t.Fatalf("unavailable-sidecar 应命中 isEngineStateNote（引擎自状态）")
		}
		if hasRealNetworkAttempt([]AttemptSummary{{Strategy: "fetch-cloak", Status: 0, Note: "unavailable-sidecar"}}) {
			t.Fatalf("侧车拒连不应计入站点网络证据")
		}
	})
}

// TestSidecarChainOrder 链序契约（Task 102-a 三层架构重排）：
// Tier 1 HTTP 层在前，fetch-iv8 独立占 Tier 2，fetch-cloak/browser 收尾 Tier 3；
// R101 的「cloak 紧随 browser、iv8 链尾」旧契约已按成本递增架构升级
func TestSidecarChainOrder(t *testing.T) {
	names := strategyNames
	if len(names) != 10 {
		t.Fatalf("策略链应 10 条，got %d: %v", len(names), names)
	}
	if names[0] != "fetch-browser" {
		t.Fatalf("fetch-browser 应为链首，got %v", names)
	}
	// Tier 2：fetch-iv8 位于全部 Tier 1 之后、Tier 3 之前
	idxIv8, idxCloak, idxBrowser := -1, -1, -1
	for i, n := range names {
		switch n {
		case "fetch-iv8":
			idxIv8 = i
		case "fetch-cloak":
			idxCloak = i
		case "browser":
			idxBrowser = i
		}
	}
	if idxIv8 < 0 || idxCloak < 0 || idxBrowser < 0 {
		t.Fatalf("三侧车/桥接策略应全部在链上，got %v", names)
	}
	if idxIv8 < 7 {
		t.Fatalf("fetch-iv8 应在全部 7 个 Tier 1 策略之后，got idx=%d", idxIv8)
	}
	if !(idxIv8 < idxCloak && idxCloak < idxBrowser) {
		t.Fatalf("Tier 2/3 顺序应 iv8→cloak→browser，got %v", names)
	}
}

// TestSidecarChainEndToEnd 链层端到端（route() 直入）：
// ①显式指定 strategy=fetch-cloak → 单策略链命中假侧车成功；
// ②侧车下线 → 指定策略回退全链不报错（可用性探测跳过语义）。
func TestSidecarChainEndToEnd(t *testing.T) {
	savedPrivate := allowPrivate
	allowPrivate = true
	defer func() { allowPrivate = savedPrivate }()

	// 上游目标站（回环 httptest，允许私有地址后 SSRF 放行）
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte("<html><body>upstream-body-101a</body></html>"))
	}))
	defer upstream.Close()

	// ① 假侧车在线 + 显式 fetch-cloak：单策略链直接命中
	fake := newFakeSidecar(t)
	fake.mu.Lock()
	fake.cloakHandler = func(w http.ResponseWriter, _ map[string]any) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"html":"<html><body>cloak-e2e-body</body></html>","status":200,"finalUrl":"x","elapsedMs":10}`))
	}
	fake.mu.Unlock()
	rec := postRoute(t, "POST", "/api/test", `{"url":"`+upstream.URL+`/book/1","strategy":"fetch-cloak","timeoutMs":8000,"includeHtml":true}`)
	if rec.Code != 200 {
		t.Fatalf("显式 fetch-cloak 应 200，got %d body=%s", rec.Code, truncateStr(rec.Body.String(), 300))
	}
	var out struct {
		OK       bool   `json:"ok"`
		Strategy string `json:"strategy"`
		HTML     string `json:"html"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("响应非法 JSON: %v", err)
	}
	if !out.OK || out.Strategy != "fetch-cloak" || !strings.Contains(out.HTML, "cloak-e2e-body") {
		t.Fatalf("显式 fetch-cloak 端到端应命中假侧车，got ok=%v strategy=%q html=%q", out.OK, out.Strategy, truncateStr(out.HTML, 120))
	}

	// ② 侧车下线（死口）+ 显式 fetch-cloak → pickOrder 回退全链：不报错、正常返回
	t.Setenv("SCRAPE_SIDECAR_URL", "http://127.0.0.1:9")
	resetSidecarProbeCache()
	t.Cleanup(resetSidecarProbeCache)
	rec = postRoute(t, "POST", "/api/test", `{"url":"`+upstream.URL+`/book/2","strategy":"fetch-cloak","timeoutMs":8000,"includeHtml":true}`)
	if rec.Code != 200 {
		t.Fatalf("侧车下线回退全链应 200，got %d body=%s", rec.Code, truncateStr(rec.Body.String(), 300))
	}
	var out2 struct {
		OK       bool     `json:"ok"`
		Strategy string   `json:"strategy"`
		Warnings []string `json:"warnings"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out2); err != nil {
		t.Fatalf("响应非法 JSON: %v", err)
	}
	if !out2.OK {
		t.Fatalf("回退全链后应由 fetch 系策略成功，got %s", truncateStr(rec.Body.String(), 300))
	}
	fallbackWarned := false
	for _, w := range out2.Warnings {
		if strings.Contains(w, "当前不可用，回退默认顺序") {
			fallbackWarned = true
		}
	}
	if !fallbackWarned {
		t.Fatalf("应包含「指定策略不可用回退」警告，got %v", out2.Warnings)
	}
}

// TestSidecarStrategiesContract /api/strategies 响应包含两个侧车策略及描述
func TestSidecarStrategiesContract(t *testing.T) {
	rec := postRoute(t, "GET", "/api/strategies", "")
	if rec.Code != 200 {
		t.Fatalf("GET /api/strategies 应 200，got %d", rec.Code)
	}
	var out struct {
		Strategies []StrategyInfo `json:"strategies"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("strategies 响应非法 JSON: %v", err)
	}
	found := map[string]StrategyInfo{}
	for _, s := range out.Strategies {
		found[s.Name] = s
	}
	cloak, ok := found["fetch-cloak"]
	if !ok {
		t.Fatalf("fetch-cloak 应出现在 /api/strategies，got %d 条", len(out.Strategies))
	}
	iv8, ok := found["fetch-iv8"]
	if !ok {
		t.Fatalf("fetch-iv8 应出现在 /api/strategies")
	}
	if !strings.Contains(cloak.Description, "CloakBrowser") || !strings.Contains(cloak.Description, "侧车") {
		t.Fatalf("fetch-cloak 描述不符契约: %q", cloak.Description)
	}
	if !strings.Contains(iv8.Description, "iv8") || !strings.Contains(iv8.Description, "Tier 2") {
		t.Fatalf("fetch-iv8 描述不符契约: %q", iv8.Description)
	}
	// Task 102-a: tier 分层标注必须与链序一致
	if cloak.Tier != tierStrategyBrowser || iv8.Tier != tierStrategyIv8 {
		t.Fatalf("tier 标注不符：cloak=%d iv8=%d", cloak.Tier, iv8.Tier)
	}
	// 本测试进程基线已把侧车指向死口（TestMain）→ available 应为 false（探测失败=链跳过）
	if cloak.Available || iv8.Available {
		t.Fatalf("侧车基线下线时 available 应 false，got cloak=%v iv8=%v", cloak.Available, iv8.Available)
	}
}
