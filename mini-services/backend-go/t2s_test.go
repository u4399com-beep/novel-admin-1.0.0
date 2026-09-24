/**
 * t2s_test.go —— 繁转简转换回归（Task 32-b）。
 * 覆盖：单字映射/词条语境一对多（皇后）/简体透传/非中文透传/占比判定阈值。
 */
package main

import "testing"

func TestT2sForce(t *testing.T) {
	cases := []struct{ in, want string }{
		{"愛麗絲夢遊仙境", "爱丽丝梦游仙境"},
		{"歷史軍事", "历史军事"},
		{"武俠仙俠", "武侠仙侠"},
		{"皇后大道", "皇后大道"},   // 词条语境：皇后 不误转 皇後
		{"乾淨的麵條", "干净的面条"}, // 词条+单字混合
		{"頭髮变白", "头发变白"},
		{"於是我們出發了", "于是我们出发了"},
		{"Hello World 123", "Hello World 123"}, // 非中文透传
		{"这是一段简体中文", "这是一段简体中文"},               // 简体透传（无繁体特征字）
		{"", ""},
	}
	for _, c := range cases {
		if got := t2sForce(c.in); got != c.want {
			t.Errorf("t2sForce(%q)=%q want %q", c.in, got, c.want)
		}
	}
}

func TestT2sPassthrough(t *testing.T) {
	// t2s 入口：简体/空串零开销透传（不走 force）
	s := "这是一段简体中文，没有任何繁体特征。"
	if got := t2s(s); got != s {
		t.Errorf("t2s 简体应原样返回，got %q", got)
	}
	if got := t2s(""); got != "" {
		t.Errorf("t2s 空串应原样返回")
	}
}

func TestNeedsT2S(t *testing.T) {
	if !needsT2S("這是一段繁體字測試文本內容驗證用例包含許多繁體特徵字符確保判定", 0) {
		t.Error("繁体文本应判定 needsT2S=true")
	}
	if needsT2S("这是一段简体中文测试文本，不包含繁体特征字符，判定应为否。", 0) {
		t.Error("简体文本应判定 needsT2S=false")
	}
	if needsT2S("", 0) || needsT2S("短文", 0) {
		t.Error("空串/过短文本不参与判定")
	}
}
