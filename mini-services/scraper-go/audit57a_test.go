/**
 * audit57a_test.go —— Task 57-a（第 19 轮）跨服务契约锁定：scraper-go HTTP API 面 ↔
 * backend-go engineclient.go 消费端（只读对照 ../backend-go/engineclient.go callEngine 的
 * env 信封解析字段：ok/error/detail/warnings/strategy/attempts/data/softBlock）与
 * ../backend-go/worker.go 错误词表启发式（isRateLimitErrText/isSoftBlockErrText）。
 *
 * 此前辖区缺口：handlers.go 的 /api/test、/api/chapter 成功/502/400 响应从未被端到端
 * 测试覆盖（仅 pageFailureResponse/extractionEmpty 单元面），而 backend 的软拦截分类、
 * attempts 计数、data 对象判型全部建立在这些响应字段上——字段改名/形态漂移（如 ok 缺失、
 * data 非对象、错误词面被改掉）会让 backend 分类失准且无测试报警。
 *
 * 本文件用真实 route() 分发 + httptest 上游站端到端锁定：
 *   ①根/健康/404/OPTIONS 响应形态；②strategies/host-health 可观测端点字段面；
 *   ③/api/test 成功信封（ok/data.attempts/strategy/warnings，softBlock 缺席）；
 *   ④/api/chapter 200 空壳信封（ok=true + data.content="" + softBlock 对象在位——
 *     backend Task 46-b 消费契约 + isSoftBlockErrText「正文提取为空/空壳」词面对齐）；
 *   ⑤/api/test 整链失败 502 信封（ok=false + error 锚词「全部可用策略」——backend
 *     isRateLimitErrText 词表锚点；challengeSuspected/attempts/elapsedMs 形态）；
 *   ⑥主机熔断 502 信封（error「目标主机熔断中」/detail「熔断」——backend「熔断」词锚）；
 *   ⑦参数错误 400 信封（error/detail 形态，backend rawJSONString 容错消费）。
 * 运行：cd mini-services/scraper-go && go test -race ./... -count=1
 */
package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// backendEnvelope 复刻 backend-go engineclient.go callEngine 的响应信封解析结构
// （只读对照，字段名/类型/容错语义与消费端逐一对齐）：
//   - OK *bool：引擎成功路径恒写 ok=true，502 失败路径恒写 ok=false，400/500 仅 {error,detail}
//     （此时 OK 为 nil，backend 以 HTTP 状态码判定——本表把三种形态都锁死）；
//   - Error/Detail/Strategy/SoftBlock json.RawMessage：backend rawJSONString 对字符串原样解、
//     缺失/非字符串回退文本形态（SoftBlock 另有「null 不算命中」纵深防御）；
//   - Warnings/Attempts []any：warnings 逐条 %v 字符串化，attempts 仅取长度。
type backendEnvelope struct {
	OK        *bool           `json:"ok"`
	Error     json.RawMessage `json:"error"`
	Detail    json.RawMessage `json:"detail"`
	Warnings  []any           `json:"warnings"`
	Strategy  json.RawMessage `json:"strategy"`
	Attempts  []any           `json:"attempts"`
	Data      json.RawMessage `json:"data"`
	SoftBlock json.RawMessage `json:"softBlock"`
}

// rawJSONString 与 backend engineclient.go 同名函数同语义（信封字符串字段的消费形态）
func rawJSONString57a(r json.RawMessage) string {
	if len(r) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(r, &s); err == nil {
		return s
	}
	return string(r)
}

// postRoute 直接走 route() 分发（与 main.go mux 的业务入口一致，绕过 panic 兜底层）
func postRoute(t *testing.T, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	var rd *bytes.Reader
	if body == "" {
		rd = bytes.NewReader(nil)
	} else {
		rd = bytes.NewReader([]byte(body))
	}
	req := httptest.NewRequest(method, target, rd)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	route(rec, req)
	return rec
}

// newContractUpstream 起一个全路径返回固定 (status, html) 的上游站。
// 每用例独立实例 → host 键（127.0.0.1:port）互不交叉，限速槽/健康度/亲和缓存天然隔离。
func newContractUpstream(t *testing.T, status int, html string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(html))
	}))
	t.Cleanup(srv.Close)
	return srv
}

// TestRouteRootHealthNotFoundContract 根/健康/未知路由/CORS 预检的响应形态
// （backend api_scrape.go 代理透传与探活消费的锚点面）。
func TestRouteRootHealthNotFoundContract(t *testing.T) {
	rec := postRoute(t, "GET", "/", "")
	if rec.Code != 200 {
		t.Fatalf("GET / 应 200，got %d", rec.Code)
	}
	var root struct {
		OK        bool     `json:"ok"`
		Service   string   `json:"service"`
		Endpoints []string `json:"endpoints"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &root); err != nil {
		t.Fatalf("根响应非法 JSON: %v", err)
	}
	if !root.OK || root.Service != "scraper-service" || len(root.Endpoints) != 5 {
		t.Fatalf("根响应契约漂移: %+v", root)
	}

	rec = postRoute(t, "GET", "/api/health", "")
	if rec.Code != 200 {
		t.Fatalf("GET /api/health 应 200，got %d", rec.Code)
	}
	var health struct {
		OK      bool   `json:"ok"`
		Service string `json:"service"`
		Port    int    `json:"port"`
		Time    string `json:"time"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &health); err != nil {
		t.Fatalf("健康响应非法 JSON: %v", err)
	}
	if !health.OK || health.Service != "scraper-service" || health.Port <= 0 || health.Time == "" {
		t.Fatalf("健康响应契约漂移: %+v", health)
	}

	// 未知路由：{error, detail} 双字段（backend failJSON 消费形态）
	rec = postRoute(t, "GET", "/api/nope", "")
	if rec.Code != 404 {
		t.Fatalf("未知路由应 404，got %d", rec.Code)
	}
	var nf backendEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &nf); err != nil {
		t.Fatalf("404 响应非法 JSON: %v", err)
	}
	if rawJSONString57a(nf.Error) != "Not Found" || rawJSONString57a(nf.Detail) == "" {
		t.Fatalf("404 响应 error/detail 形态漂移: error=%q detail=%q", rawJSONString57a(nf.Error), rawJSONString57a(nf.Detail))
	}

	// CORS 预检 204
	rec = postRoute(t, "OPTIONS", "/api/test", "")
	if rec.Code != 204 || rec.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("OPTIONS 预检应 204 + CORS 头，got %d %v", rec.Code, rec.Header())
	}
}

// TestRouteStrategiesHostHealthContract 可观测端点字段面（strategies 消费于 backend
// /api/scrape?proxy=strategies 透传与探活；host-health 供运维/车道感知观测）。
func TestRouteStrategiesHostHealthContract(t *testing.T) {
	rec := postRoute(t, "GET", "/api/strategies", "")
	if rec.Code != 200 {
		t.Fatalf("GET /api/strategies 应 200，got %d", rec.Code)
	}
	var out struct {
		OK         bool   `json:"ok"`
		Service    string `json:"service"`
		Strategies []struct {
			Name        string `json:"name"`
			Description string `json:"description"`
			Available   bool   `json:"available"`
		} `json:"strategies"`
		Affinity      map[string]any `json:"affinity"`
		CookieSession map[string]any `json:"cookieSession"`
		HostHealth    map[string]any `json:"hostHealth"`
		Browser       map[string]any `json:"browserSession"`
		Compliance    map[string]any `json:"compliance"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("strategies 响应非法 JSON: %v", err)
	}
	if !out.OK || out.Service != "scraper-service" || len(out.Strategies) != 8 {
		t.Fatalf("strategies 契约漂移: ok=%v n=%d", out.OK, len(out.Strategies))
	}
	for _, key := range []string{"affinity", "cookieSession", "hostHealth", "browserSession", "compliance"} {
		if out.Affinity == nil || out.CookieSession == nil || out.HostHealth == nil || out.Browser == nil || out.Compliance == nil {
			t.Fatalf("strategies 说明块 %s 缺失", key)
		}
	}

	rec = postRoute(t, "GET", "/api/host-health", "")
	if rec.Code != 200 {
		t.Fatalf("GET /api/host-health 应 200，got %d", rec.Code)
	}
	var hh struct {
		OK                bool   `json:"ok"`
		BaseIntervalMs    int64  `json:"baseIntervalMs"`
		AimdMaxIntervalMs int64  `json:"aimdMaxIntervalMs"`
		AdaptiveHostCount int    `json:"adaptiveHostCount"`
		AdaptiveHosts     []any  `json:"adaptiveHosts"`
		AimdMultiplier    string `json:"aimdMultiplier"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &hh); err != nil {
		t.Fatalf("host-health 响应非法 JSON: %v", err)
	}
	if !hh.OK || hh.BaseIntervalMs < 1000 || hh.AimdMaxIntervalMs == 0 || hh.AdaptiveHosts == nil {
		t.Fatalf("host-health 契约漂移: %+v", hh)
	}

	rec = postRoute(t, "GET", "/api/host-health?host=contract57a.test", "")
	if rec.Code != 200 {
		t.Fatalf("host-health?host= 应 200，got %d", rec.Code)
	}
	var hd struct {
		OK                 bool   `json:"ok"`
		Host               string `json:"host"`
		AdaptiveIntervalMs int64  `json:"adaptiveIntervalMs"`
		PenaltyMs          int64  `json:"penaltyMs"`
		CircuitOpenMs      int64  `json:"circuitOpenMs"`
		FailStreak         int64  `json:"failStreak"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &hd); err != nil {
		t.Fatalf("host-health?host= 响应非法 JSON: %v", err)
	}
	if !hd.OK || hd.Host != "contract57a.test" {
		t.Fatalf("host-health 单主机契约漂移: %+v", hd)
	}
}

// TestApiTestSuccessEnvelopeContract /api/test 成功响应信封端到端（fetch-ua-rotate 车道
// 打本地上游站）：backend callEngine 的成功判定链 = HTTP 2xx + ok=true + data 为 JSON 对象，
// strategy/attempts/warnings 进入可观测记录——任何字段漂移在此报警。
func TestApiTestSuccessEnvelopeContract(t *testing.T) {
	savedPrivate := allowPrivate
	allowPrivate = true
	defer func() { allowPrivate = savedPrivate }()

	srv := newContractUpstream(t, 200,
		`<html><head><title>测试书页 - 契约站</title></head><body>`+
			`<nav><a href="/">首页</a> <a href="/sort">排行</a></nav>`+
			`<h1 class="book-title">测试书名</h1><div id="info"><span class="author">墨白山人</span></div>`+
			`<p>山风吹过山谷，少年握紧手中的长剑，望向远方的群山，心中涌起一股莫名的勇气与期待。</p>`+
			`</body></html>`)

	body := `{"url":"` + srv.URL + `/book/1.html","strategy":"fetch-ua-rotate","timeoutMs":8000,` +
		`"rule":{"bookRule":{"titleSelector":"h1.book-title","authorSelector":"span.author"}}}`
	rec := postRoute(t, "POST", "/api/test", body)
	if rec.Code != 200 {
		t.Fatalf("成功抓取应 200，got %d body=%s", rec.Code, rec.Body.String())
	}
	var env backendEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("响应非法 JSON: %v", err)
	}
	if env.OK == nil || !*env.OK {
		t.Fatalf("成功响应必须 ok=true（backend 以 ok 旗标判定），got %v", env.OK)
	}
	trimmed := strings.TrimSpace(string(env.Data))
	if trimmed == "" || trimmed == "null" || trimmed[0] != '{' {
		t.Fatalf("成功响应 data 必须是 JSON 对象（backend 判型硬闸），got %q", trimmed)
	}
	var data struct {
		Book *struct {
			Title  string `json:"title"`
			Author string `json:"author"`
		} `json:"book"`
	}
	if err := json.Unmarshal(env.Data, &data); err != nil {
		t.Fatalf("data 解析失败: %v", err)
	}
	if data.Book == nil || data.Book.Title != "测试书名" || data.Book.Author != "墨白山人" {
		t.Fatalf("data.book 提取契约漂移: %+v", data.Book)
	}
	if rawJSONString57a(env.Strategy) != "fetch-ua-rotate" {
		t.Fatalf("顶层 strategy 应为命中策略名，got %q", rawJSONString57a(env.Strategy))
	}
	if env.Attempts == nil || len(env.Attempts) == 0 {
		t.Fatalf("成功响应必须携带 attempts 明细（backend 记「尝试 N 次」），got nil")
	}
	if env.Warnings == nil {
		t.Fatalf("warnings 必须为数组形态（可为空数组，backend 逐条字符串化），got nil")
	}
	if len(env.SoftBlock) > 0 {
		t.Fatalf("提取非空时不应附 softBlock 档案（backend 200 空壳判定面），got %s", env.SoftBlock)
	}
	if len(env.Error) > 0 || len(env.Detail) > 0 {
		t.Fatalf("成功响应不应携带 error/detail: %s %s", env.Error, env.Detail)
	}
}

// TestApiChapterEmptyShellSoftBlockEnvelopeContract /api/chapter「HTTP 200 但正文为空」
// 软拦截信封端到端：ok 保持 true（不改成功语义）+ softBlock 结构化档案在位——backend
// fetchChapterPaged 拿到空正文走「章节正文为空」哨兵、fetchBookPage/fetchListPage 凭
// softBlock 旗标转 softBlockEmptyErrText（Task 46-b），warning 词面「正文提取为空/空壳」
// 与 backend isSoftBlockErrText 词表对齐。
func TestApiChapterEmptyShellSoftBlockEnvelopeContract(t *testing.T) {
	savedPrivate := allowPrivate
	allowPrivate = true
	defer func() { allowPrivate = savedPrivate }()

	srv := newContractUpstream(t, 200,
		`<html><head><title>第三章 试验 - 契约站</title></head><body>`+
			`<nav><a href="/">首页</a> <a href="/toc">目录</a></nav>`+
			`<h1 class="book-title">第三章 试验</h1><div id="content"></div>`+
			`<footer>上一章 下一章</footer></body></html>`)

	body := `{"url":"` + srv.URL + `/c/3.html","strategy":"fetch-ua-rotate","timeoutMs":8000,` +
		`"rule":{"titleSelector":"h1.book-title","contentSelector":"#content"}}`
	rec := postRoute(t, "POST", "/api/chapter", body)
	if rec.Code != 200 {
		t.Fatalf("200 空壳仍应按成功语义返回 200，got %d body=%s", rec.Code, rec.Body.String())
	}
	var env backendEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("响应非法 JSON: %v", err)
	}
	if env.OK == nil || !*env.OK {
		t.Fatalf("空壳哨兵是纯提示（ok 仍为 true），got %v", env.OK)
	}
	var data struct {
		Content string `json:"content"`
		Title   string `json:"title"`
	}
	if err := json.Unmarshal(env.Data, &data); err != nil {
		t.Fatalf("data 解析失败: %v", err)
	}
	if strings.TrimSpace(data.Content) != "" {
		t.Fatalf("空壳章正文应为空，got %q", data.Content)
	}
	// softBlock 档案：对象在位且非 null（backend Task 49-b null 纵深防御的引擎侧契约面）
	sb := bytes.TrimSpace(env.SoftBlock)
	if len(sb) == 0 || bytes.Equal(sb, []byte("null")) {
		t.Fatalf("200 空壳必须附 softBlock 对象（backend 软拦截归档依据），got %q", string(sb))
	}
	var prof struct {
		Status   int    `json:"status"`
		Strategy string `json:"strategy"`
		Title    string `json:"title"`
	}
	if err := json.Unmarshal(sb, &prof); err != nil {
		t.Fatalf("softBlock 应为对象档案: %v", err)
	}
	if prof.Status != 200 || prof.Strategy != "fetch-ua-rotate" {
		t.Fatalf("softBlock 基础字段漂移: %+v", prof)
	}
	// warning 词面与 backend isSoftBlockErrText 词表对齐（「正文提取为空」/「空壳」）
	joined := ""
	for _, w := range env.Warnings {
		joined += rawJSONString57a(mustJSON(t, w)) + "\n"
	}
	if !strings.Contains(joined, "正文提取为空") || !strings.Contains(joined, "空壳") {
		t.Fatalf("空壳 warning 词面漂移（backend 软拦截词表依赖）：%s", joined)
	}
}

// TestApiTestChainFailure502EnvelopeContract 整链失败 502 信封端到端：上游恒 403 →
// fetch-ua-rotate 三画像全败 → pageFailureResponse。锁两面：
// ①信封形态 ok=false/error/detail/challengeSuspected/attempts/warnings/elapsedMs；
// ②error 锚词「全部可用策略」在位——backend isRateLimitErrText 词表以该词面把整链失败
//
//	归入瞬态（paused 可自动恢复 + 车道降档），词面被改即分类失准，此处报警。
func TestApiTestChainFailure502EnvelopeContract(t *testing.T) {
	savedPrivate := allowPrivate
	allowPrivate = true
	defer func() { allowPrivate = savedPrivate }()

	srv := newContractUpstream(t, 403, `<html><body>拒绝访问</body></html>`)
	host := hostOf(srv.URL)
	defer func() { // 清理健康度/槽位，防跨测试污染
		noteChainSuccess(host)
		hostSlotsMu.Lock()
		delete(hostSlots, host)
		hostSlotsMu.Unlock()
	}()

	body := `{"url":"` + srv.URL + `/book/1.html","strategy":"fetch-ua-rotate","timeoutMs":8000}`
	rec := postRoute(t, "POST", "/api/test", body)
	if rec.Code != 502 {
		t.Fatalf("整链失败应结构化 502（而非 5xx panic），got %d body=%s", rec.Code, rec.Body.String())
	}
	var env backendEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("502 响应非法 JSON: %v", err)
	}
	if env.OK == nil || *env.OK {
		t.Fatalf("502 信封必须 ok=false，got %v", env.OK)
	}
	errText := rawJSONString57a(env.Error)
	detail := rawJSONString57a(env.Detail)
	if !strings.Contains(errText, "全部可用策略") {
		t.Fatalf("整链失败 error 必须含 backend 词锚「全部可用策略」（isRateLimitErrText 瞬态分类依据），got %q", errText)
	}
	if detail == "" || !strings.Contains(detail, "http-403") {
		t.Fatalf("detail 应携带逐尝试备注（http-403），got %q", detail)
	}
	// 403 非挑战页：challengeSuspected 应为 false（挑战路径由 Blocked/challenge-page note 驱动）
	var raw map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatalf("响应非法 JSON: %v", err)
	}
	if v, ok := raw["challengeSuspected"].(bool); !ok || v {
		t.Fatalf("403 全败不应标 challengeSuspected，got %v", raw["challengeSuspected"])
	}
	if v, ok := raw["elapsedMs"].(float64); !ok || v < 0 {
		t.Fatalf("502 信封应携带 elapsedMs 数值，got %v", raw["elapsedMs"])
	}
	if env.Attempts == nil || len(env.Attempts) == 0 {
		t.Fatalf("失败响应也必须携带 attempts 明细（契约：成功与失败都带），got nil")
	}
	if env.Warnings == nil {
		t.Fatalf("502 信封 warnings 应为数组形态")
	}
	if _, ok := raw["robots"]; !ok {
		t.Fatalf("502 信封应携带 robots 摘要字段（结构体或空对象）")
	}
}

// TestApiCircuitOpen502EnvelopeContract 主机熔断 502 信封端到端（零网络：熔断在链前
// 快速失败）：error「目标主机熔断中」/detail「熔断阈值+剩余冷却」——backend isRateLimitErrText
// 以「熔断」词面归入瞬态（车道降档 + paused 自动恢复），词面漂移即误分类「封禁」。
func TestApiCircuitOpen502EnvelopeContract(t *testing.T) {
	savedPrivate := allowPrivate
	allowPrivate = true
	defer func() { allowPrivate = savedPrivate }()

	srv := newContractUpstream(t, 200, `<html><body>不该被请求到</body></html>`)
	host := hostOf(srv.URL)
	defer func() {
		noteChainSuccess(host)
		hostSlotsMu.Lock()
		delete(hostSlots, host)
		hostSlotsMu.Unlock()
	}()
	// 混合失败 3 次 → 熔断（与 TestHostHealthNetStreakFastTrip 口径一致）
	noteChainFailure(host, false)
	noteChainFailure(host, false)
	noteChainFailure(host, false)
	if hostCircuitOpenMs(host) <= 0 {
		t.Fatalf("前置：3 次连败应触发熔断")
	}

	body := `{"url":"` + srv.URL + `/book/1.html","timeoutMs":8000}` // 不带 strategy → 熔断检查生效
	rec := postRoute(t, "POST", "/api/test", body)
	if rec.Code != 502 {
		t.Fatalf("熔断应结构化 502，got %d body=%s", rec.Code, rec.Body.String())
	}
	var env backendEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("502 响应非法 JSON: %v", err)
	}
	errText := rawJSONString57a(env.Error)
	detail := rawJSONString57a(env.Detail)
	if !strings.Contains(errText, "目标主机熔断中") {
		t.Fatalf("熔断 error 词面漂移（backend「熔断」词锚）：%q", errText)
	}
	if !strings.Contains(detail, "熔断") || !strings.Contains(detail, "冷却") {
		t.Fatalf("熔断 detail 应含阈值/冷却上下文，got %q", detail)
	}
	if env.OK == nil || *env.OK {
		t.Fatalf("熔断信封必须 ok=false，got %v", env.OK)
	}
	if len(env.Attempts) != 0 {
		t.Fatalf("熔断零网络请求，attempts 应为空数组，got %d 条", len(env.Attempts))
	}
}

// TestApiParamErrorShapesContract 参数错误 400 信封形态（backend rawJSONString 容错消费；
// 词面不含瞬态词 → backend 归「永久失败」终态——参数错误重试无益，语义正确）。
func TestApiParamErrorShapesContract(t *testing.T) {
	cases := []struct {
		name       string
		target     string
		body       string
		wantErr    string
		wantDetail string
	}{
		{"缺 url", "/api/test", `{}`, "参数错误", "缺少 url 参数"},
		{"协议白名单", "/api/test", `{"url":"ftp://x.test/y"}`, "参数错误", "仅支持 http/https"},
		{"未知策略", "/api/test", `{"url":"https://x.test/","strategy":"no-such"}`, "参数错误", "未知策略"},
		{"数组 body", "/api/test", `[1,2]`, "请求体错误", "JSON 对象"},
		{"chapter 缺 url", "/api/chapter", `{"rule":{}}`, "参数错误", "缺少 url 参数"},
	}
	for _, c := range cases {
		rec := postRoute(t, "POST", c.target, c.body)
		if rec.Code != 400 {
			t.Fatalf("%s: 应 400，got %d body=%s", c.name, rec.Code, rec.Body.String())
		}
		var env backendEnvelope
		if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
			t.Fatalf("%s: 响应非法 JSON: %v", c.name, err)
		}
		if got := rawJSONString57a(env.Error); got != c.wantErr {
			t.Fatalf("%s: error = %q, want %q", c.name, got, c.wantErr)
		}
		if !strings.Contains(rawJSONString57a(env.Detail), c.wantDetail) {
			t.Fatalf("%s: detail 应含 %q，got %q", c.name, c.wantDetail, rawJSONString57a(env.Detail))
		}
	}
}

// mustJSON 把 any 重编码为 json.RawMessage（warnings 词面断言辅助）
func mustJSON(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}
