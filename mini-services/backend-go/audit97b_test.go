package main

/**
 * audit97b_test.go —— R97 回归（backend-go 侧）：
 *
 * 1. probeProxyViaProxy 407 判死（trxsw 实证：认证死口滞留池内自愈组件却不换血）——
 *    httptest 假代理服务器返回 407/200 两种形态，锁定「407=死口、其余状态=可达」口径。
 * 2. 全局代理池设置：PATCH /api/settings proxyPool → pickEgressProxy 兜底注入（规则自有池优先）；
 *    保存端经 parseProxyField 同规则校验。
 * 3. TXT/封面自定义存储目录：sanitizeStorageDir 白名单 + PATCH → 读取缓存失效 → 覆盖生效。
 * 4. maskProxyCred 凭证脱敏（测试按钮结果不得回显明文凭证）。
 */

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// ---- 1. proxy 探测 407 判死 ----

func TestProbeProxyViaProxy407JudgedDeadR97(t *testing.T) {
	// 假代理：返回 407（Proxy Authentication Required）——只能由代理本体发出
	authRequired := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusProxyAuthRequired)
	}))
	defer authRequired.Close()

	ok, _ := probeProxyViaProxy(authRequired.URL, "http://target.example/page")
	if ok {
		t.Fatal("407（代理要求认证）必须判定死口——旧口径把 407 当可达导致 trxsw 认证死口永久滞留池内")
	}

	// 假代理：返回 403（WAF 拦截=站点行为，出口链路通）→ 仍判定可达
	waf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer waf.Close()
	ok, _ = probeProxyViaProxy(waf.URL, "http://target.example/page")
	if !ok {
		t.Fatal("403（WAF 拦截）应判定可达——E25 口径：任何非 407 HTTP 状态均视为出口可达")
	}

	// 假代理：200 → 可达
	alive := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer alive.Close()
	ok, ms := probeProxyViaProxy(alive.URL, "http://target.example/page")
	if !ok {
		t.Fatal("200 应判定可达")
	}
	if ms < 0 {
		t.Fatal("可达时延不应为负")
	}
}

// ---- 2. 全局代理池 ----

func TestSettingsProxyPoolPatchAndEgressInjectionR97(t *testing.T) {
	mustInitSiteSettingTable(t)

	// 非法形态 400（复用规则级 parseProxyField 校验）
	code, _ := patchSettings(t, `{"proxyPool":"ftp://bad-form:1"}`)
	if code != 400 {
		t.Fatalf("非法 scheme 应 400，got %d", code)
	}

	// 合法池保存
	code, body := patchSettings(t, `{"proxyPool":"http://10.9.9.9:3128, socks5h://u:p@10.0.0.1:1080"}`)
	if code != 200 {
		t.Fatalf("合法 proxyPool 应 200，got %d（%v）", code, body)
	}

	// 读取缓存失效后 pickEgressProxy 兜底注入
	proxyPoolCache.invalidate()
	if got := pickEgressProxy(""); got != "http://10.9.9.9:3128,socks5h://u:p@10.0.0.1:1080" {
		t.Fatalf("规则无自有池时应兜底全局池，got %q", got)
	}
	// 规则自有池优先
	if got := pickEgressProxy("http://rule-own.example:1"); got != "http://rule-own.example:1" {
		t.Fatalf("规则自有池应优先，got %q", got)
	}

	// GET 透出
	req := httptest.NewRequest(http.MethodGet, "/api/settings", nil)
	rec := httptest.NewRecorder()
	handleSettingsGet(rec, req, nil)
	if rec.Code != 200 {
		t.Fatalf("GET settings %d", rec.Code)
	}
	var m map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if m["proxyPool"] != "http://10.9.9.9:3128,socks5h://u:p@10.0.0.1:1080" {
		t.Fatalf("GET 未透出 proxyPool: %v", m["proxyPool"])
	}
}

// ---- 3. 存储目录 ----

func TestSanitizeStorageDirR97(t *testing.T) {
	cases := []struct {
		name string
		in   any
		want string // 期望清洗值；errWant 非空时忽略
		err  string // 期望错误子串（空=应成功）
	}{
		{"重置默认（空串）", "", "", ""},
		{"合法绝对路径", "/data/novel-txt", "/data/novel-txt", ""},
		{"尾斜杠归一", "/data/covers/", "/data/covers", ""},
		{"相对路径拒绝", "data/rel", "", "绝对路径"},
		{"穿越段拒绝", "/data/../etc", "", ".."},
		{"控制字符拒绝", "/data/a\x01b", "", "控制字符"},
		{"非字符串拒绝", 123, "", "必须是字符串"},
	}
	for _, c := range cases {
		got, err := sanitizeStorageDir(c.in, "txtDir")
		if c.err != "" {
			if !strings.Contains(err, c.err) {
				t.Fatalf("%s: err = %q, want contains %q", c.name, err, c.err)
			}
			continue
		}
		if err != "" {
			t.Fatalf("%s: 意外错误 %q", c.name, err)
		}
		if got != c.want {
			t.Fatalf("%s: got %q want %q", c.name, got, c.want)
		}
	}
}

func TestSettingsStorageDirsPatchOverridesR97(t *testing.T) {
	mustInitSiteSettingTable(t)

	// 非法目录 400
	if code, _ := patchSettings(t, `{"txtDir":"relative/path"}`); code != 400 {
		t.Fatalf("相对路径应 400，got %d", code)
	}

	// 合法保存 → 缓存失效 → 读取链覆盖生效
	if code, _ := patchSettings(t, `{"txtDir":"/data/r97-txt","coversDir":"/data/r97-covers"}`); code != 200 {
		t.Fatal("合法目录保存失败")
	}
	txtDirCache.invalidate()
	coversDirCache.invalidate()
	if got := storageTxtDirOverride(); got != "/data/r97-txt" {
		t.Fatalf("txtDir 覆盖未生效: %q", got)
	}
	if got := storageCoversDirOverride(); got != "/data/r97-covers" {
		t.Fatalf("coversDir 覆盖未生效: %q", got)
	}

	// 空串重置默认
	if code, _ := patchSettings(t, `{"txtDir":" "}`); code != 200 {
		t.Fatal("空串重置应 200")
	}
	txtDirCache.invalidate()
	if got := storageTxtDirOverride(); got != "" {
		t.Fatalf("空串应重置默认（空覆盖），got %q", got)
	}
}

// ---- 4. 凭证脱敏 + 测试端点 ----

func TestMaskProxyCredR97(t *testing.T) {
	if got := maskProxyCred("socks5h://user:pass@10.0.0.1:1080"); got != "socks5h://***@10.0.0.1:1080" {
		t.Fatalf("凭证未脱敏: %q", got)
	}
	if got := maskProxyCred("http://10.0.0.2:3128"); got != "http://10.0.0.2:3128" {
		t.Fatalf("无凭证不应改动: %q", got)
	}
	if got := maskProxyCred("http://u@10.0.0.3:80"); got != "http://***@10.0.0.3:80" {
		t.Fatalf("仅用户名也应脱敏: %q", got)
	}
}

func TestProxyPoolTestEndpointR97(t *testing.T) {
	mustInitSiteSettingTable(t)
	alive := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer alive.Close()
	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusProxyAuthRequired)
	}))
	defer dead.Close()

	// target 用 http:// 形态（假代理为纯 HTTP 服务器，无法完成 CONNECT 隧道 TLS；
	// https 目标在生产经真实代理 CONNECT 转发，探测语义不变：任何非 407 响应=可达）
	body := `{"pool":"` + alive.URL + `,` + dead.URL + `","target":"http://target.example/page"}`
	req := httptest.NewRequest(http.MethodPost, "/api/scrape/proxy-pool/test", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handleProxyPoolTest(rec, req, nil)
	if rec.Code != 200 {
		t.Fatalf("test endpoint %d: %s", rec.Code, rec.Body.String())
	}
	var m struct {
		Target  string `json:"target"`
		Total   int    `json:"total"`
		Alive   int    `json:"alive"`
		Results []struct {
			Proxy string `json:"proxy"`
			OK    bool   `json:"ok"`
			Error string `json:"error"`
		} `json:"results"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if m.Total != 2 || m.Alive != 1 {
		t.Fatalf("total/alive = %d/%d, want 2/1", m.Total, m.Alive)
	}
	if !m.Results[0].OK || m.Results[1].OK {
		t.Fatalf("探测结果错位: %+v", m.Results)
	}

	// 非法 target 400
	badReq := httptest.NewRequest(http.MethodPost, "/api/scrape/proxy-pool/test",
		strings.NewReader(`{"pool":"`+alive.URL+`","target":"ftp://x"}`))
	badRec := httptest.NewRecorder()
	handleProxyPoolTest(badRec, badReq, nil)
	if badRec.Code != 400 {
		t.Fatalf("非法 target 应 400，got %d", badRec.Code)
	}
}
