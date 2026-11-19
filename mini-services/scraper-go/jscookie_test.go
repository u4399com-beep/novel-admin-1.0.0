package main

// jscookie_test.go —— JS 计算 cookie 型挑战求解（R141）回归锁定：
//   1) solveJSCookieChallenge：ixdzs8 真实挑战样本求值（__cn_v=ix26_k7m9p3w8 形态）
//   2) 变量追踪/字符串拼接/未知 token 截断/非挑战页失败
//   3) itoaRadix 基础形态
//   4) cookieChallengeProbe：httptest 挑战页 → jar 种入 → 返回 true（每 host 一次闸）

import (
        "net/http"
        "net/http/httptest"
        "strings"
        "testing"
        "time"
)

const ixdzsChallengeHTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Loading...</title></head><body><script>(function(){var d=new Date();d.setTime(d.getTime()+86400000);var t=(882654).toString(36)+"_"+(1583867302136).toString(36);document.cookie="__cn_v="+t+"; expires="+d.toUTCString()+"; path=/; SameSite=Lax";if(document.cookie.indexOf("__cn_v=")!==-1){location.reload();}else{document.body.innerHTML="Please enable Cookies and refresh.";}})();</script></body></html>`

func TestSolveJSCookieChallengeIxdzs(t *testing.T) {
        got, ok := solveJSCookieChallenge([]byte(ixdzsChallengeHTML))
        if !ok {
                t.Fatalf("ixdzs8 真实挑战样本应求解成功")
        }
        if got != "__cn_v=ix26_k7m9p3w8" {
                t.Fatalf("求解结果错误: %q（期望 __cn_v=ix26_k7m9p3w8）", got)
        }
}

func TestSolveJSCookieChallengeVariants(t *testing.T) {
        cases := []struct {
                html string
                want string
                ok   bool
                note string
        }{
                {`<script>var k=(255).toString(16);document.cookie='tk='+k;</script>`, "tk=ff", true, "单引号/无属性段"},
                {`<script>document.cookie="a"+"b"+"c";</script>`, "a=bc", true, "纯字符串拼接即 cookie a=bc（name 无等号形态合法）"},
                {`<html>正常页面无挑战</html>`, "", false, "无 document.cookie"},
                {`<script>document.cookie="x="+foo.bar;</script>`, "", false, "未知标识符查表失败"},
                {`<script>var s="pre";document.cookie="x="+s+"; path=/";</script>`, "x=pre", true, "变量+属性段截断"},
        }
        for _, c := range cases {
                got, ok := solveJSCookieChallenge([]byte(c.html))
                if ok != c.ok || (ok && got != c.want) {
                        t.Errorf("%s: got (%q,%v) want (%q,%v)", c.note, got, ok, c.want, c.ok)
                }
        }
}

func TestItoaRadix(t *testing.T) {
        cases := []struct {
                n     int64
                radix int
                want  string
        }{
                {882654, 36, "ix26"},
                {1583867302136, 36, "k7m9p3w8"},
                {0, 10, "0"},
                {255, 16, "ff"},
        }
        for _, c := range cases {
                if got := itoaRadix(c.n, c.radix); got != c.want {
                        t.Errorf("itoaRadix(%d,%d)=%q want %q", c.n, c.radix, got, c.want)
                }
        }
}

func TestCookieChallengeProbeSolvesAndSeeds(t *testing.T) {
        contentApiTestEnv(t)
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                _, _ = w.Write([]byte(ixdzsChallengeHTML))
        }))
        defer srv.Close()
        warnings := []string{}
        if !cookieChallengeProbe(srv.URL+"/read/619751/", &warnings) {
                t.Fatalf("挑战页探测应求解成功，warnings=%v", warnings)
        }
        if !strings.Contains(strings.Join(warnings, ""), "已求解") {
                t.Errorf("警告应含已求解，got %v", warnings)
        }
        // jar 已种：cookieHeaderFor 可取到
        if ck := cookieHeaderFor(hostOf(srv.URL), strings.HasPrefix(srv.URL, "https")); !strings.Contains(ck, "__cn_v=ix26_k7m9p3w8") {
                t.Errorf("求解 cookie 应入会话 jar，got %q", ck)
        }
        // 每 host 一次闸：第二次直接 false
        warnings2 := []string{}
        if cookieChallengeProbe(srv.URL+"/read/other/", &warnings2) {
                t.Errorf("同 host 第二次探测应被闸拒绝")
        }
}

func TestCookieChallengeProbeSetCookieOnly(t *testing.T) {
        contentApiTestEnv(t)
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                w.Header().Set("Set-Cookie", "sess=abc; Path=/")
                _, _ = w.Write([]byte("<html>normal page no challenge</html>"))
        }))
        defer srv.Close()
        warnings := []string{}
        if !cookieChallengeProbe(srv.URL+"/b/1/", &warnings) {
                t.Fatalf("有 Set-Cookie 无挑战页应返回 true（重放值得）")
        }
}

func TestCookieChallengeProbeNoHint(t *testing.T) {
        contentApiTestEnv(t)
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                _, _ = w.Write([]byte("<html>normal page</html>"))
        }))
        defer srv.Close()
        warnings := []string{}
        if cookieChallengeProbe(srv.URL+"/b/1/", &warnings) {
                t.Errorf("无 Set-Cookie 无挑战页应返回 false")
        }
        _ = time.Now()
}
