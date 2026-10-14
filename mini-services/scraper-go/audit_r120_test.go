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
        body := fake.lastRequest("cloak")
        if _, exists := body["waitSelector"]; exists {
                t.Fatalf("无 waitSelector 时请求体不得携带该键，got %v", body)
        }
}
