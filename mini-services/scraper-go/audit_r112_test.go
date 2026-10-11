/**
 * audit_r112_test.go —— R112 JS token 挑战跳转「落地偏离」修复回归锁定：
 *
 * 站点实证（aijjxs.com）：部分书目第 1 页（内容简介）对 Go TLS 指纹客户端下发
 * JS token 挑战壳，壳内 location 指向书籍入口页（跨路径弹回）而非同址回放。
 * 旧行为：跟随后把书籍页当 200 成功返回 → 章节提取空 →「200 空壳」误判 +
 * 车道控制误降档。新行为：跟随后落地 host/path 与发起页不同 → 本策略判失败
 * （note=challenge-landing），链层自动回退后续策略（curl-impersonate 等指纹
 * 差异策略可直接放行）；跳转升级的会话 cookie 已逐跳记录不丢。
 *
 * 运行：cd mini-services/scraper-go && go test -run TestJS -count=1 ./...
 */
package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// startR112Server 按路径返回固定响应体的测试站（含 query 精确匹配辅助）
func startR112Server(t *testing.T, routes map[string]string) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	for path, body := range routes {
		p := path
		mux.HandleFunc(p, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write([]byte(body))
		})
	}
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// TestJSBounceCrossPathFails 跨路径弹回 → challenge-landing 失败（R112 核心行为）
func TestJSBounceCrossPathFails(t *testing.T) {
	savedPrivate := allowPrivate
	allowPrivate = true
	defer func() { allowPrivate = savedPrivate }()

	srv := startR112Server(t, map[string]string{
		// 挑战壳：location 指向「入口页」——aijjxs 形态（深链被弹回书籍页）
		"/read/11/1.html": `<html><body><script>location.href="/txt/57629.html";</script></body></html>`,
		"/txt/57629.html": `<html><head><title>书籍页</title></head><body><div class="intro">书页内容</div></body></html>`,
	})
	warnings := []string{}
	res := fetchWithRedirectGuard(srv.URL+"/read/11/1.html", map[string]string{"user-agent": chromeUA}, 10_000, &warnings, "", false, nil)
	if res.ok {
		t.Fatalf("跨路径弹回应判失败，got ok=true note=%q", res.note)
	}
	if res.note != "challenge-landing" {
		t.Fatalf("note 应为 challenge-landing，got %q", res.note)
	}
	joined := strings.Join(warnings, "\n")
	if !strings.Contains(joined, "门控弹回") || !strings.Contains(joined, "回退后续策略") {
		t.Fatalf("警告应说明弹回与回退语义，got %v", warnings)
	}
	if !strings.Contains(res.warning, "门控弹回") {
		t.Fatalf("rawResponse.warning 应携带弹回说明，got %q", res.warning)
	}
}

// TestJSTokenSamePathReplayOK 同址 token 回放（query 变化）→ 照旧成功（防误伤）
func TestJSTokenSamePathReplayOK(t *testing.T) {
	savedPrivate := allowPrivate
	allowPrivate = true
	defer func() { allowPrivate = savedPrivate }()

	content := `<html><head><title>第1章 测试</title></head><body><div id="content">正文内容</div></body></html>`
	srv := startR112Server(t, map[string]string{
		"/chapter/1.html": content, // /chapter/1.html 与 /chapter/1.html?t=xxx 同路由
		"/gate/1.html":    `<html><body><script>location.href="/chapter/1.html?t=abc123";</script></body></html>`,
	})
	warnings := []string{}
	// 挑战壳跳到另一路径的正文页：老语义会成功；R112 语义下这是跨路径（仍失败）——
	// 真正的「同址回放」是 /gate/1.html 自己 ?t= 回放，见第二个断言段
	res := fetchWithRedirectGuard(srv.URL+"/gate/1.html", map[string]string{"user-agent": chromeUA}, 10_000, &warnings, "", false, nil)
	if res.ok || res.note != "challenge-landing" {
		t.Fatalf("跨路径跳正文页按 R112 应判 challenge-landing，got ok=%v note=%q", res.ok, res.note)
	}

	// 同址回放：挑战页 location 指向自身 + token query → 落地同路径 → 成功
	warnings2 := []string{}
	srv2 := startR112Server(t, map[string]string{
		"/chapter/2.html": `<html><body><script>location.href="/chapter/2.html?t=token42";</script></body></html>`,
	})
	// /chapter/2.html 无 query 时返回挑战壳、带 query 时返回正文（测试路由内判断）
	mux := http.NewServeMux()
	mux.HandleFunc("/chapter/2.html", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		if r.URL.RawQuery == "" {
			_, _ = w.Write([]byte(`<html><body><script>location.href="/chapter/2.html?t=token42";</script></body></html>`))
			return
		}
		_, _ = w.Write([]byte(content))
	})
	srv2.Close()
	srv3 := httptest.NewServer(mux)
	t.Cleanup(srv3.Close)
	res2 := fetchWithRedirectGuard(srv3.URL+"/chapter/2.html", map[string]string{"user-agent": chromeUA}, 10_000, &warnings2, "", false, nil)
	if !res2.ok {
		t.Fatalf("同址 token 回放应成功，got ok=false note=%q warnings=%v", res2.note, warnings2)
	}
	if !strings.Contains(string(res2.bytes), "正文内容") {
		t.Fatalf("同址回放应拿到正文，got %q", truncateStr(string(res2.bytes), 120))
	}
}

// TestJsLandingDiverged jsLandingDiverged 纯函数表驱动
func TestJsLandingDiverged(t *testing.T) {
	cases := []struct {
		name string
		from string
		to   string
		want bool
	}{
		{"同路径同query", "https://x.test/a/1.html", "https://x.test/a/1.html", false},
		{"同路径query变化(同址token回放)", "https://x.test/a/1.html", "https://x.test/a/1.html?t=abc", false},
		{"同路径hash变化", "https://x.test/a/1.html", "https://x.test/a/1.html#top", false},
		{"路径变化(弹回入口页)", "https://x.test/read/11/1.html", "https://x.test/txt/57629.html", true},
		{"host变化(跨域弹回)", "https://x.test/a/1.html", "https://y.test/a/1.html", true},
		{"尾斜杠差异视为偏离", "https://x.test/a/1", "https://x.test/a/1/", true},
		{"非法URL按未偏离", "://bad", "https://x.test/a", false},
	}
	for _, c := range cases {
		if got := jsLandingDiverged(c.from, c.to); got != c.want {
			t.Errorf("%s: jsLandingDiverged(%q,%q)=%v want %v", c.name, c.from, c.to, got, c.want)
		}
	}
}
