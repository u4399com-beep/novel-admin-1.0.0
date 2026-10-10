/**
 * mirrorrot_test.go —— P3-2 规则级镜像域名轮换回归：
 *
 * 1) TestParseMirrorHosts：规范化（scheme 缺省/大小写/端口）、去重、剔除主域、非法条目丢弃。
 * 2) TestHostSwapURL：换域保路径/查询/锚；非法 URL 返回 ""。
 * 3) TestMirrorRotatorLifecycle：round-robin 轮转、连败降权（≥3）、成功复活、全降权回主域、
 *    主域 report 静默忽略、nil rotator 零开销透传。
 * 4) TestLoadRuleMirrors：ScrapeRule.mirrorHosts 列装载 → LoadedRule.Mirrors 规范化
 *    （主域剔除；空配置 nil）。
 * 5) TestRuleMirrorCheckHandler：mirror-check API——桩引擎按 URL host 区分行为，
 *    首页探针标题一致 → ok；标题不同 → diff；引擎失败 → dead。
 * 运行：cd mini-services/backend-go && go test -run 'TestParseMirrorHosts|TestHostSwapURL|TestMirrorRotator|TestLoadRuleMirrors|TestRuleMirrorCheck' -count=1 .
 */
package main

import (
        "io"
        "net/http"
        "net/http/httptest"
        "strings"
        "testing"
)

func TestParseMirrorHosts(t *testing.T) {
        main := "https://www.example.com/"
        cases := []struct {
                name string
                raw  string
                want []string
        }{
                {"空配置", "", nil},
                {"裸域补 https", "m1.example.com", []string{"https://m1.example.com"}},
                {"显式 http 保真", "http://m2.example.com:8080/", []string{"http://m2.example.com:8080"}},
                {"混合分隔去重", "m1.example.com, https://m1.example.com;;m3.example.com", []string{"https://m1.example.com", "https://m3.example.com"}},
                {"主域剔除", "www.example.com,m4.example.com", []string{"https://m4.example.com"}},
                {"非法条目丢弃", "m5.example.com/extra,ftp://x.example.com,,m6.example.com", []string{"https://m5.example.com", "https://m6.example.com"}},
                {"大小写归一", "M7.Example.COM", []string{"https://m7.example.com"}},
        }
        for _, tc := range cases {
                got := parseMirrorHosts(tc.raw, main)
                gotStrs := make([]string, len(got))
                for i, mh := range got {
                        gotStrs[i] = mh.String()
                }
                if len(gotStrs) != len(tc.want) {
                        t.Fatalf("%s: got %v want %v", tc.name, gotStrs, tc.want)
                }
                for i := range gotStrs {
                        if gotStrs[i] != tc.want[i] {
                                t.Fatalf("%s: got %v want %v", tc.name, gotStrs, tc.want)
                        }
                }
        }
}

func TestHostSwapURL(t *testing.T) {
        mh := mirrorHost{Scheme: "http", Host: "m.example.com:8080"}
        if got := hostSwapURL("https://www.example.com/book/123.html?page=2#toc", mh); got != "http://m.example.com:8080/book/123.html?page=2#toc" {
                t.Fatalf("换域保路径失败: %q", got)
        }
        if got := hostSwapURL("::::not-a-url", mh); got != "" {
                t.Fatalf("非法 URL 应返回空串: %q", got)
        }
        if got := hostSwapURL("/relative/only", mh); got != "" {
                t.Fatalf("相对 URL 应返回空串: %q", got)
        }
}

func TestMirrorRotatorLifecycle(t *testing.T) {
        hosts := parseMirrorHosts("m1.example.com,m2.example.com", "https://www.example.com/")
        if len(hosts) != 2 {
                t.Fatalf("前置失败: %v", hosts)
        }
        r := newMirrorRotator(hosts)
        if r == nil {
                t.Fatal("rotator 不应为 nil")
        }
        // round-robin 轮转：两次 pick 覆盖两个镜像
        seen := map[string]int{}
        for i := 0; i < 4; i++ {
                u2, ref2 := r.pickURL("https://www.example.com/chapter/1.html", "https://www.example.com/book/9.html")
                if !strings.HasPrefix(u2, "https://m1.example.com/") && !strings.HasPrefix(u2, "https://m2.example.com/") {
                        t.Fatalf("pickURL 未换域: %q", u2)
                }
                if !strings.Contains(ref2, "m1.example.com") && !strings.Contains(ref2, "m2.example.com") {
                        t.Fatalf("referer 未同步换域: %q", ref2)
                }
                if strings.HasSuffix(u2, "www.example.com") {
                        t.Fatalf("不应停在主域: %q", u2)
                }
                seen[u2]++
                r.report(u2, true)
        }
        if len(seen) != 2 {
                t.Fatalf("round-robin 应覆盖两个镜像: %v", seen)
        }
        // m1 直报三连败 → 降权；后续 pick 只剩 m2
        m1URL := "https://m1.example.com/c/1.html"
        for i := 0; i < mirrorFailDemote; i++ {
                r.report(m1URL, false)
        }
        for i := 0; i < 6; i++ {
                u2, _ := r.pickURL("https://www.example.com/c/1.html", "")
                if strings.Contains(u2, "m1.example.com") {
                        t.Fatalf("m1 已降权不应再被选中: %q", u2)
                }
        }
        if lc := r.liveCount(); lc != 1 {
                t.Fatalf("活镜像应为 1: %d", lc)
        }
        // m2 也三连败降权 → 回主域
        for i := 0; i < mirrorFailDemote; i++ {
                r.report("https://m2.example.com/c/1.html", false)
        }
        u2, ref2 := r.pickURL("https://www.example.com/c/1.html", "https://www.example.com/b/2.html")
        if u2 != "https://www.example.com/c/1.html" || ref2 != "https://www.example.com/b/2.html" {
                t.Fatalf("全降权应原样回主域: %q %q", u2, ref2)
        }
        // m1 成功一次 → 复活（m2 仍降权 → 下一发必是 m1）
        r.report(m1URL, true)
        u2, _ = r.pickURL("https://www.example.com/c/1.html", "")
        if !strings.Contains(u2, "m1.example.com") {
                t.Fatalf("m1 复活后应重新可用: %q", u2)
        }
        // 主域 report 静默忽略（不 panic 不改状态）
        r.report("https://www.example.com/c/1.html", false)
        // nil rotator 全方法零开销透传
        var nr *mirrorRotator
        nu, nref := nr.pickURL("https://www.example.com/c/1.html", "https://www.example.com/b.html")
        if nu != "https://www.example.com/c/1.html" || nref != "https://www.example.com/b.html" {
                t.Fatalf("nil rotator 应透传: %q %q", nu, nref)
        }
        nr.report(nu, true)
        if nr.liveCount() != 0 || nr.summary() != "" {
                t.Fatal("nil rotator 观测应为零值")
        }
        if newMirrorRotator(nil) != nil {
                t.Fatal("空镜像列表应返回 nil rotator")
        }
}

func TestLoadRuleMirrors(t *testing.T) {
        db, err := getDB()
        if err != nil {
                t.Fatalf("open temp db: %v", err)
        }
        if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS ScrapeRule (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL DEFAULT '',
                siteUrl TEXT NOT NULL DEFAULT '',
                enabled INTEGER NOT NULL DEFAULT 1,
                charset TEXT NOT NULL DEFAULT 'utf-8',
                proxy TEXT NOT NULL DEFAULT '',
                insecureTLS INTEGER NOT NULL DEFAULT 0,
                cookies TEXT NOT NULL DEFAULT '',
                listRule TEXT NOT NULL DEFAULT '{}',
                bookRule TEXT NOT NULL DEFAULT '{}',
                chapterRule TEXT NOT NULL DEFAULT '{}',
                mirrorHosts TEXT NOT NULL DEFAULT '',
                notes TEXT NOT NULL DEFAULT '',
                createdAt INTEGER NOT NULL DEFAULT 0,
                updatedAt INTEGER NOT NULL DEFAULT 0
        )`); err != nil {
                t.Fatalf("create ScrapeRule: %v", err)
        }
        t.Cleanup(func() { _, _ = db.Exec(`DELETE FROM ScrapeRule WHERE id IN (9001, 9002)`) })
        if _, err := db.Exec(`INSERT INTO ScrapeRule (id, name, siteUrl, mirrorHosts) VALUES (9001, 'mir-test', 'https://www.example.com/', 'm1.example.com, www.example.com')`); err != nil {
                t.Fatalf("insert rule: %v", err)
        }
        if _, err := db.Exec(`INSERT INTO ScrapeRule (id, name, siteUrl) VALUES (9002, 'nomir-test', 'https://www.example.com/')`); err != nil {
                t.Fatalf("insert rule2: %v", err)
        }
        id1, id2 := 9001, 9002
        lr := loadRule(&id1)
        if len(lr.Mirrors) != 1 || lr.Mirrors[0].String() != "https://m1.example.com" {
                t.Fatalf("镜像装载应剔除主域并规范化: %v", lr.Mirrors)
        }
        lr2 := loadRule(&id2)
        if len(lr2.Mirrors) != 0 {
                t.Fatalf("空配置应为零镜像: %v", lr2.Mirrors)
        }
}

// TestRuleMirrorCheckHandler mirror-check API：桩引擎按 URL host 区分行为。
//   - www.example.com（主域）/ m1…（镜像）→ 标题一致 → ok
//   - diff.example.com → 标题不同 → diff
//   - dead 镜像 → 引擎 ok:false → dead
func TestRuleMirrorCheckHandler(t *testing.T) {
        db, err := getDB()
        if err != nil {
                t.Fatalf("open temp db: %v", err)
        }
        if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS ScrapeRule (
                id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '', siteUrl TEXT NOT NULL DEFAULT '',
                enabled INTEGER NOT NULL DEFAULT 1, charset TEXT NOT NULL DEFAULT 'utf-8',
                proxy TEXT NOT NULL DEFAULT '', insecureTLS INTEGER NOT NULL DEFAULT 0,
                cookies TEXT NOT NULL DEFAULT '', listRule TEXT NOT NULL DEFAULT '{}',
                bookRule TEXT NOT NULL DEFAULT '{}', chapterRule TEXT NOT NULL DEFAULT '{}',
                mirrorHosts TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
                createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0
        )`); err != nil {
                t.Fatalf("create ScrapeRule: %v", err)
        }
        t.Cleanup(func() { _, _ = db.Exec(`DELETE FROM ScrapeRule WHERE id = 9101`) })
        if _, err := db.Exec(`INSERT INTO ScrapeRule (id, name, siteUrl, mirrorHosts) VALUES (9101, 'mir-check-test', 'https://www.example.com/', 'm1.example.com, diff.example.com, dead.example.com')`); err != nil {
                t.Fatalf("insert rule: %v", err)
        }

        stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                body, _ := io.ReadAll(r.Body) // 从 body.url 取 host 判定行为
                raw := string(body)
                if strings.Contains(raw, "dead.example.com") {
                        _, _ = w.Write([]byte(`{"ok":false,"error":"stub 引擎全链失败（模拟镜像不可达）","warnings":[]}`))
                        return
                }
                title := "测试站点首页"
                if strings.Contains(raw, "diff.example.com") {
                        title = "完全不同的镜像站点"
                }
                _, _ = w.Write([]byte(`{"ok":true,"data":{"book":{"title":"` + title + `","chapters":[]}},"warnings":[],"elapsedMs":5}`))
        }))
        t.Cleanup(stub.Close)
        t.Setenv("BACKEND_ENGINE_URL", stub.URL)

        rr := httptest.NewRequest("POST", "/api/scrape-rules/mirror-check", strings.NewReader(`{"id":9101}`))
        w := httptest.NewRecorder()
        handleRuleMirrorCheck(w, rr, map[string]string{})
        if w.Code != 200 {
                t.Fatalf("mirror-check 应 200: %d %s", w.Code, w.Body.String())
        }
        out := w.Body.String()
        for _, want := range []string{
                `"probeKind":"home"`,
                `https://m1.example.com","verdict":"ok"`,
                `https://diff.example.com","verdict":"diff"`,
                `https://dead.example.com","verdict":"dead"`,
                `1/3 镜像一致`,
        } {
                if !strings.Contains(out, want) {
                        t.Fatalf("结果缺 %s:\n%s", want, out)
                }
        }
}
