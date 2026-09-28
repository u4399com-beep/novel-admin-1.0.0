/**
 * audit56a_test.go —— Task 56-a（第 18 轮零散面+最新变更面深审）回归锁定：
 * ①execErrDetail（P4 修复）：curl/python 子进程失败时 ExitError.Stderr 的人读错误
 *   （--show-error 文本/traceback）透出到 warnings——旧实现只透出裸 "exit status N"。
 * ②SSRF IPv4 全文本形态锁定（辖区此前零直测）：parseIpv4TextOk 的「纯十进制 vs 纯八进制」
 *   分支序是 reAllDec 先于 reOct 的陷阱面——017700000001 必须按八进制解出 127.0.0.1
 *   （curl/inet_aton 语义），纯十进制 2130706433 同值也判内网，双双被 assertHostPublic 拒绝。
 * ③E15 curl 车道（fetch-curl，真实 curl 二进制 wire 测试）：
 *   - 末跳 cf-mitigated: challenge + 完全正常正文 → challenge-page 失败（头探测接线闭合）；
 *   - 中间跳 302 自报挑战 + 末跳干净 → 成功（E15「仅末跳计数/不粘性」语义锁定，
 *     挑战重定向放行链路不误杀）。
 * 运行：cd mini-services/scraper-go && go test -race ./... -count=1
 */
package main

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"
)

// ---- ① execErrDetail ----

func TestExecErrDetail(t *testing.T) {
	// ExitError + stderr：透出人读错误（curl 连接失败/traceback 形态）
	ee := &exec.ExitError{Stderr: []byte("curl: (7) Failed to connect to 127.0.0.1 port 9: Connection refused\n")}
	if got := execErrDetail(ee); !strings.Contains(got, "curl: (7)") || strings.Contains(got, "\n") {
		t.Fatalf("ExitError.Stderr 应透出且已 TrimSpace: %q", got)
	}
	// 非 ExitError：回退 Error()
	plain := errors.New("boom")
	if got := execErrDetail(plain); got != "boom" {
		t.Fatalf("非 ExitError 应回退 Error(): %q", got)
	}
	// 真实 ExitError（stderr 空）：回退 "exit status 1"（与旧行为兼容）
	if _, err := exec.Command("false").Output(); err != nil {
		if got := execErrDetail(err); got != "exit status 1" {
			t.Fatalf("空 stderr ExitError 应回退 Error(): %q", got)
		}
	} else {
		t.Skip("false 命令未按预期失败")
	}
	// context 错误（超时 kill 路径）原样透出
	if got := execErrDetail(context.DeadlineExceeded); got != context.DeadlineExceeded.Error() {
		t.Fatalf("context 错误应原样透出: %q", got)
	}
	// 超长 stderr 截断（300 rune 上限）
	long := strings.Repeat("x", 1000)
	if got := execErrDetail(&exec.ExitError{Stderr: []byte(long)}); len([]rune(got)) != 300 {
		t.Fatalf("超长 stderr 应截断到 300 rune: %d", len([]rune(got)))
	}
}

// ---- ② SSRF IPv4 全文本形态 ----

func TestParseIpv4TextOkAllForms(t *testing.T) {
	private := []string{
		"127.0.0.1",       // 点分十进制
		"127.1",           // 短格式
		"0177.0.0.1",      // 段八进制
		"0x7f.0x0.0.1",    // 段十六进制
		"2130706433",      // 纯十进制（=127.0.0.1）
		"0x7f000001",      // 纯十六进制
		"017700000001",    // 纯八进制（=127.0.0.1，reAllDec 先于 reOct 的分支序陷阱面）
		"0",               // 0.0.0.0/8
		"10.0.0.1",        // 10/8
		"169.254.169.254", // 云元数据端点
		"172.16.0.1",      // 172.16/12
		"172.31.255.255",  // 172.16/12 上界
		"192.168.1.1",     // 192.168/16
		"100.64.0.1",      // CGNAT 100.64/10
		"100.127.255.255", // CGNAT 上界
		"198.18.0.1",      // 基准测试保留 198.18/15
		"224.0.0.1",       // 组播 224/4
		"255.255.255.255", // 保留 240/4（广播）
	}
	for _, h := range private {
		n, ok := parseIpv4TextOk(h)
		if !ok {
			t.Fatalf("%q 应可解析为 IPv4", h)
		}
		if !ipv4IsPrivate(n) {
			t.Fatalf("%q (%d) 应判内网/保留段", h, n)
		}
	}
	public := []string{"8.8.8.8", "1.2.3.4", "203.0.113.10", "172.32.0.1", "100.128.0.1", "198.20.0.1"}
	for _, h := range public {
		n, ok := parseIpv4TextOk(h)
		if !ok {
			t.Fatalf("%q 应可解析为 IPv4", h)
		}
		if ipv4IsPrivate(n) {
			t.Fatalf("%q 应判公网", h)
		}
	}
	unparseable := []string{"", "256.1.1.1", "1.2.3.4.5", "1..2.3", "99999999999999999999", "0x1ffffffff", "abc", "0xzz"}
	for _, h := range unparseable {
		if _, ok := parseIpv4TextOk(h); ok {
			t.Fatalf("%q 不应被解析为 IPv4", h)
		}
	}
}

func TestIsPrivateHostEdgeForms(t *testing.T) {
	priv := []string{
		"localhost", "foo.localhost", "a.local", "x.internal",
		"LOCALHOST.",  // 尾点 + 大小写
		"127.0.0.1..", // 双尾点（单一 TrimSuffix 曾漏）
		"[::1]", "::1", "::",
		"::ffff:127.0.0.1",        // IPv4-mapped 递归
		"::ffff:7f00:1",           // IPv4-mapped 十六进制形态
		"fe80::1",                 // 链路本地
		"fc00::1", "fd12:3456::1", // ULA fc00::/7
		"64:ff9b::7f00:1", // NAT64 递归
		"fe80::1%eth0",    // zone id → 解析失败 fail-closed
		"[::1]:8443",      // 带端口括号形态（剥括号后判）
	}
	for _, h := range priv {
		if !isPrivateHost(h) {
			t.Fatalf("%q 应判内网/保留", h)
		}
	}
	pub := []string{"example.com", "8.8.8.8", "2001:db8::1", "2606:4700::1", "www.dingdian1.com"}
	for _, h := range pub {
		if isPrivateHost(h) {
			t.Fatalf("%q 应判公网", h)
		}
	}
}

// assertHostPublic 端到端：纯八进制/纯十六进制 IP 字面量（curl/inet_aton 语义可直连本机）
// 必须在校验层就被拒——这是 curl 车道（--resolve 钉死对 IP 字面量不生效）的 SSRF 前置闸。
func TestAssertHostPublicOctalFormBlocked(t *testing.T) {
	saved := allowPrivate
	allowPrivate = false
	defer func() { allowPrivate = saved }()

	for _, h := range []string{"017700000001", "2130706433", "0x7f000001", "127.1"} {
		if check := assertHostPublic(h); check.ok {
			t.Fatalf("%q 应被 SSRF 校验拒绝（inet_aton 形态直连本机）", h)
		}
	}
	if check := assertHostPublic("example.com"); !check.ok {
		// 域名走 DNS 尽力校验（fail-open）；沙箱无外网 DNS 时 negative 缓存仍 ok=true
		if check.reason != "" && !strings.Contains(check.warning, "DNS") {
			t.Fatalf("公网域名不应被文本层拒绝: %+v", check)
		}
	}
}

// ---- ③ E15 curl 车道 wire 测试（真实系统 curl；缺失时跳过） ----

// 末跳自报挑战：200 + 完全正常正文 + cf-mitigated: challenge → fetch-curl 判失败
// note=challenge-page（旧实现仅凭体判定会把它当成功入库）。
func TestFetchCurlLaneCFMitigatedFinalHopBlocked(t *testing.T) {
	if detectPlainCurl() == "" {
		t.Skip("系统 curl 不可用")
	}
	savedPrivate := allowPrivate
	allowPrivate = true
	defer func() { allowPrivate = savedPrivate }()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("cf-mitigated", "challenge") // 小写变体：headerLines 大小写不敏感
		_, _ = w.Write([]byte("<html><body>第一千零三章 伪装成正常页的挑战壳</body></html>"))
	}))
	defer srv.Close()

	res := curlPlainStrategy.run(srv.URL+"/shielded", 8_000, &strategyRunCtx{})
	if res.ok {
		t.Fatalf("curl 车道 WAF 自报挑战不得判成功: %+v", res)
	}
	found := false
	for _, sa := range res.subAttempts {
		if sa.Status == 200 && sa.Note == "challenge-page" {
			found = true
		}
	}
	if !found {
		t.Fatalf("子尝试应含 challenge-page（HTTP 200）: %+v", res.subAttempts)
	}
}

// 中间跳不粘性（E15 语义锁定）：302 自报挑战 → 末跳干净 200 → 判成功。
// CF 托管挑战实态是 403+头自报（末跳即被拦），3xx 挑战重定向后落地正常页属挑战流程已过；
// 若中间跳头粘进末跳评估，经挑战边界的正常链路会被整体误杀。
func TestFetchCurlLaneCFMitigatedIntermediateHopNotSticky(t *testing.T) {
	if detectPlainCurl() == "" {
		t.Skip("系统 curl 不可用")
	}
	savedPrivate := allowPrivate
	allowPrivate = true
	defer func() { allowPrivate = savedPrivate }()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/jump" {
			w.Header().Set("Cf-Mitigated", "challenge") // 大写规范形态
			w.Header().Set("Location", "/clean")
			w.WriteHeader(302)
			return
		}
		_, _ = w.Write([]byte("<html><body>clean final landing page body</body></html>"))
	}))
	defer srv.Close()

	res := curlPlainStrategy.run(srv.URL+"/jump", 8_000, &strategyRunCtx{})
	if !res.ok {
		t.Fatalf("中间跳挑战头不应粘性到末跳（已放行链路误杀）: %+v", res)
	}
	if !bytes.Contains(res.bytes, []byte("clean final landing")) {
		t.Fatalf("应返回末跳落地页正文: %q", truncateStr(string(res.bytes), 120))
	}
}
