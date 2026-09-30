package main

/**
 * main_test.go —— Task 58-a 审计：ruletest 响应信封解析回归。
 *
 * 锁定 P2 修复：引擎 /api/test 在「200 空壳/挑战竞态页」场景以对象形态透出 softBlock
 * （Task 32-d 档案：title/htmlLength/challengeFeatures…）。旧版 testResp.SoftBlock 声明为
 * bool——恰恰是本工具最需要诊断的挑战场景（对象）导致整包 json.Unmarshal 失败，
 * attempts/warnings/data 全部丢失并误报「响应解析失败」。改为 json.RawMessage 后三种
 * 形态（对象/缺席/字面量 false）均可解析。
 */

import (
	"encoding/json"
	"testing"
)

func TestTestRespSoftBlockShapes(t *testing.T) {
	cases := []struct {
		name    string
		body    string
		wantSB  bool // softBlock 是否应视为命中（非空且非 null/false）
		wantOK  bool
		wantErr bool
	}{
		{
			name:   "softBlock 对象（200 空壳挑战档案）必须可解析",
			body:   `{"ok":true,"strategy":"fetch-browser","softBlock":{"title":"安全验证","htmlLength":19500,"challengeFeatures":["captcha-title"]},"warnings":["HTTP 200 但规则提取结果全空"],"data":{}}`,
			wantSB: true, wantOK: true,
		},
		{
			name:   "softBlock 缺席（成功信封）",
			body:   `{"ok":true,"strategy":"fetch-browser","attempts":[],"warnings":[],"data":{"list":{"count":3}}}`,
			wantSB: false, wantOK: true,
		},
		{
			name:   "softBlock null（纵深防御）",
			body:   `{"ok":true,"softBlock":null}`,
			wantSB: false, wantOK: true,
		},
		{
			name:   "失败信封（502 整链失败，无 softBlock）",
			body:   `{"ok":false,"error":"全部可用策略均抓取失败","detail":"fetch-browser/chrome-desktop: network-error"}`,
			wantSB: false, wantOK: false,
		},
	}
	for _, c := range cases {
		var resp testResp
		if err := json.Unmarshal([]byte(c.body), &resp); err != nil {
			t.Fatalf("%s: 解析失败（P2 回归：对象形态 softBlock 不得破坏整包解析）: %v", c.name, err)
		}
		hit := len(resp.SoftBlock) > 0 && string(resp.SoftBlock) != "null" && string(resp.SoftBlock) != "false"
		if hit != c.wantSB {
			t.Fatalf("%s: softBlock 命中判定 = %v, want %v（原文 %q）", c.name, hit, c.wantSB, string(resp.SoftBlock))
		}
		if resp.OK != c.wantOK {
			t.Fatalf("%s: ok = %v, want %v", c.name, resp.OK, c.wantOK)
		}
	}
}
