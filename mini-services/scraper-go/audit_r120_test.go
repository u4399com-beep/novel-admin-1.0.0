/**
 * audit_r120_test.go —— R120（waitSelector 关键选择器等待 + cloak 会话记忆落盘）回归锁定：
 *
 * 1) TestCssSafeWaitSelector：pickText DSL 专有语法（:contains()/aref/ownText/text()）
 *    不透传侧车（wait_for_selector 非法），纯 CSS 原样放行，长度钳 256。
 * 2) TestCloakWaitSelectorPayload：ctx.waitSelector 非空 → /cloak 请求体带 waitSelector；
 *    侧车 waitSelectorFound=true → 策略成功且命中结果回传链层。
 * 3) TestCloakWaitSelectorMissFails：旧版侧车（无 waitSelectorFound 字段=未命中）→
 *    策略按失败处理（note=wait-selector-missed），bytes 保留供 debugHTML——「200 空壳
 *    抢跑」不再以假成功收割链路。
 * 4) TestCloakNoWaitSelectorZeroBehaviorChange：ctx.waitSelector 为空 → 请求体无
 *    waitSelector 键、旧 ok 语义零变化（向后兼容锁定）。
 * 复用 sidecar_test.go 的 newFakeSidecar httptest 假侧车（零真实网络依赖）。
 */
package main

import (
        "encoding/json"
        "net/http"
        "strings"
        "testing"
)

func TestCssSafeWaitSelector(t *testing.T) {
        cases := []struct {
                name, in, want string
        }{
                {"纯 CSS 列表选择器", "ol.custom-rank-list li.rank-item", "ol.custom-rank-list li.rank-item"},
                {"纯 CSS 正文选择器", "div.read-content", "div.read-content"},
                {"首尾空白裁剪", "  p.rank-t a  ", "p.rank-t a"},
                {":contains 文本锚拒绝", "a:contains(下一页)", ""},
                {"aref 属性 DSL 拒绝", "aref*='/menu/']", ""},
                {"ownText 关键字拒绝", "ownText", ""},
                {"text() 函数拒绝", "text()", ""},
                {"空串", "", ""},
                {"纯空白", "   ", ""},
                {"超长钳 256", strings.Repeat("a", 257), ""},
                {"256 上界放行", strings.Repeat("a", 256), strings.Repeat("a", 256)},
        }
        for _, c := range cases {
                if got := cssSafeWaitSelector(c.in); got != c.want {
                        t.Errorf("[%s] cssSafeWaitSelector(%q) = %q, want %q", c.name, c.in, got, c.want)
                }
        }
}

func cloakJSON(t *testing.T, payload string) func(w http.ResponseWriter, _ map[string]any) {
        t.Helper()
        return func(w http.ResponseWriter, _ map[string]any) {
                w.Header().Set("Content-Type", "application/json")
                _, _ = w.Write([]byte(payload))
        }
}

func TestCloakWaitSelectorPayload(t *testing.T) {
        fake := newFakeSidecar(t)
        fake.mu.Lock()
        fake.cloakHandler = cloakJSON(t, `{"ok":true,"html":"<html><body><ol><li class='rank-item'>x</li></ol></body></html>","status":200,"finalUrl":"http://t.invalid/","elapsedMs":10,"waitSelectorFound":true}`)
        fake.mu.Unlock()

        ctx := &strategyRunCtx{waitSelector: "ol.custom-rank-list li.rank-item"}
        res := fetchCloakStrategy.run("http://ws-target.invalid/rank", 15000, ctx)
        if !res.ok {
                t.Fatalf("waitSelector 命中时策略应成功，got note=%s warnings=%v", res.note, res.warnings)
        }
        if !res.waitSelectorFound {
                t.Fatalf("命中结果应回传链层（waitSelectorFound=true）")
        }
        if !res.waitApplied {
                t.Fatalf("cloak 恒消费等待：waitApplied 应为 true（R120b 观测语义）")
        }
        body := fake.lastRequest("cloak")
        if body == nil || body["waitSelector"] != "ol.custom-rank-list li.rank-item" {
                t.Fatalf("/cloak 请求体应带 waitSelector，got %v", body)
        }
}

func TestCloakWaitSelectorMissFails(t *testing.T) {
        fake := newFakeSidecar(t)
        // 旧版侧车形态：ok=true + 200 壳页，无 waitSelectorFound 字段（=未命中）
        fake.mu.Lock()
        fake.cloakHandler = cloakJSON(t, `{"ok":true,"html":"<html><body>shell page 230KB but rank list empty</body></html>","status":200,"finalUrl":"http://t.invalid/","elapsedMs":10}`)
        fake.mu.Unlock()

        ctx := &strategyRunCtx{waitSelector: "li.rank-item"}
        res := fetchCloakStrategy.run("http://ws-miss.invalid/rank", 15000, ctx)
        if res.ok {
                t.Fatalf("waitSelector 未命中时不得以假成功收割链路（200 空壳抢跑回归），got note=%s", res.note)
        }
        if res.note != "wait-selector-missed" {
                t.Fatalf("note 应为 wait-selector-missed，got %q", res.note)
        }
        if len(res.bytes) == 0 {
                t.Fatalf("bytes 应保留供整链失败 debugHTML 排障")
        }
        if !strings.Contains(strings.Join(res.warnings, "\n"), "waitSelector 未命中") {
                t.Fatalf("warnings 应含未命中证据，got %v", res.warnings)
        }
}

func TestCloakNoWaitSelectorZeroBehaviorChange(t *testing.T) {
        fake := newFakeSidecar(t)
        // 旧版侧车 + 无 waitSelector：assess 判定 ok（不触发 miss 分支——向后兼容红线）
        fake.mu.Lock()
        fake.cloakHandler = cloakJSON(t, `{"ok":true,"html":"<html><body>plain ok page</body></html>","status":200,"finalUrl":"http://t.invalid/","elapsedMs":10}`)
        fake.mu.Unlock()

        res := fetchCloakStrategy.run("http://ws-none.invalid/page", 8000, &strategyRunCtx{})
        if !res.ok {
                t.Fatalf("无 waitSelector 时旧语义零变化：应 assess 判定成功，got note=%s warnings=%v", res.note, res.warnings)
        }
        if res.waitApplied {
                t.Fatalf("无 waitSelector 时 waitApplied 恒 false（R120b：未请求等待不构成本策略证据）")
        }
        body := fake.lastRequest("cloak")
        if _, exists := body["waitSelector"]; exists {
                t.Fatalf("无 waitSelector 时请求体不得携带该键，got %v", body)
        }
}

// TestRenderArgs R120b: browser 策略 render.py argv 契约——argv[1..3] 既有三参不变，
// waitSelector 非空追加 argv[4]；DSL 语法在 renderArgs 内二次防线过滤（空则不追加）。
func TestRenderArgs(t *testing.T) {
        ua := "Mozilla/5.0 (test)"
        cases := []struct {
                name, ws string
                wantLen  int
                wantLast string
        }{
                {"无 waitSelector 保持三参", "", 3, ua},
                {"纯 CSS 追加第 4 参", "div.read-content", 4, "div.read-content"},
                {"DSL 选择器被二次过滤", "a:contains(下一页)", 3, ua},
                {"ownText 关键字被二次过滤", "ownText", 3, ua},
        }
        for _, c := range cases {
                args := renderArgs("http://t.invalid/", 20000, ua, c.ws)
                if len(args) != c.wantLen {
                        t.Errorf("[%s] renderArgs len = %d, want %d", c.name, len(args), c.wantLen)
                        continue
                }
                if args[len(args)-1] != c.wantLast {
                        t.Errorf("[%s] last argv = %q, want %q", c.name, args[len(args)-1], c.wantLast)
                }
                if args[0] != "http://t.invalid/" || args[1] != "20000" {
                        t.Errorf("[%s] 既有 argv 契约被破坏: %v", c.name, args[:2])
                }
        }
}

// TestBrowserWaitAppliedContract R120b: render.py payload 解析契约——waitSelectorFound
// 字段缺失（旧版脚本）=false 不炸；命中=true 正确解析。renderViaPython 的
// waitApplied 置位逻辑由 TestRenderArgs + TestCloakWaitSelectorPayload 两侧锁定。
func TestBrowserWaitAppliedContract(t *testing.T) {
        var p renderPayload
        if err := json.Unmarshal([]byte(`{"status":200,"html":"<html></html>","cookies":[]}`), &p); err != nil {
                t.Fatalf("旧版 payload（无 waitSelectorFound）解析不得失败: %v", err)
        }
        if p.WaitSelectorFound {
                t.Fatalf("缺省 waitSelectorFound 应为 false")
        }
        p = renderPayload{}
        if err := json.Unmarshal([]byte(`{"status":200,"html":"x","waitSelectorFound":true}`), &p); err != nil {
                t.Fatalf("新版 payload 解析失败: %v", err)
        }
        if !p.WaitSelectorFound {
                t.Fatalf("waitSelectorFound=true 应正确解析")
        }
}

// TestChallengeStormSkip R120c（挑战风暴预算保护）：
// ①阈值前（0/1 次挑战失败）不跳过；②≥2 次后纯 HTTP 层跳过（后序有重渲染层）；
// ③后序无重渲染层时不跳过（保留覆盖）；④iv8/cloak/browser 层永不跳过。
func TestChallengeStormSkip(t *testing.T) {
        // 默认全链：fetch-browser/fetch-curl/fetch-ua-rotate/fetch-mobile/fetch-spider
        // 等属 HTTP 层，fetch-iv8/fetch-cloak/browser 属重渲染层
        order := mkOrder(t, "fetch-browser", "fetch-ua-rotate", "fetch-curl", "fetch-iv8", "fetch-cloak", "browser")
        uaRotate, _ := strategyByName("fetch-ua-rotate")
        curl, _ := strategyByName("fetch-curl")
        iv8, _ := strategyByName("fetch-iv8")
        cloak, _ := strategyByName("fetch-cloak")

        if shouldSkipHTTPOnChallengeStorm(0, uaRotate.tier, order, 1) {
                t.Fatalf("0 次挑战失败不得跳过")
        }
        if shouldSkipHTTPOnChallengeStorm(1, uaRotate.tier, order, 1) {
                t.Fatalf("1 次挑战失败（可能是单策略指纹问题）不得跳过")
        }
        if !shouldSkipHTTPOnChallengeStorm(2, uaRotate.tier, order, 1) {
                t.Fatalf("2 次挑战失败后 HTTP 层应跳过（后序有 iv8/cloak/browser 接管）")
        }
        if !shouldSkipHTTPOnChallengeStorm(5, curl.tier, order, 2) {
                t.Fatalf("挑战风暴持续期后续 HTTP 层策略应继续跳过")
        }
        if shouldSkipHTTPOnChallengeStorm(5, iv8.tier, order, 3) {
                t.Fatalf("iv8 轻执行层不得被跳过")
        }
        if shouldSkipHTTPOnChallengeStorm(5, cloak.tier, order, 4) {
                t.Fatalf("重渲染层不得被跳过")
        }
        // 后序无重渲染层：跳过无收益，照旧尝试
        httpOnly := mkOrder(t, "fetch-browser", "fetch-ua-rotate", "fetch-curl")
        ua2, _ := strategyByName("fetch-ua-rotate")
        if shouldSkipHTTPOnChallengeStorm(5, ua2.tier, httpOnly, 1) {
                t.Fatalf("后序无重渲染层时不得跳过（保留覆盖）")
        }
}
