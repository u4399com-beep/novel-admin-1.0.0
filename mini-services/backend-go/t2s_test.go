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

// TestT2sFieldAuto Task 47: 短字段特征字两路计数——无歧义单繁字即转（「辰東」为生产
// API 实证残留形态），歧义两用字维持 ≥2 阈值（乾坤/宫商角徵羽/简体引号防误伤）。
func TestT2sFieldAuto(t *testing.T) {
	cases := []struct{ in, want string }{
		{"辰東", "辰东"},             // 无歧义繁体字 单字即转（生产 API 实证残留形态）
		{"斗破蒼穹", "斗破苍穹"},         // 同上（短书名）
		{"乾坤", "乾坤"},             // 歧义两用字单字不转（防 乾→干 误伤）
		{"乾隆王朝", "乾隆王朝"},         // 同上
		{"宫商角徵羽", "宫商角徵羽"},       // 徵 歧义字单字不转
		{"这是一段简体中文", "这是一段简体中文"}, // 简体透传
		{"愛麗絲夢遊仙境", "爱丽丝梦游仙境"},   // 全繁短文本
		{"「迷宫」", "“迷宫”"},         // 繁体引号成对（≥2 歧义字）按既有行为转换
		{"简体「引号", "简体「引号"},       // 单个歧义引号字不触发
		// Task 47-a 深审：t2sPhrases 词条产物残留特征字（127 条实证）的稳定化收敛——
		// 无歧义残留（拚）在 t2sField 内迭代转净，两用字残留（乾）由 ≥2 阈值保留词级校订
		{"滿拚自盡", "满拼自尽"}, // 词条映射产物残留拚→单遍实现重入会再变（非幂等病灶实证）
		{"蕭乾", "萧乾"},     // 人名词级校订保留乾（歧义字，不得被二次转换破坏）
		{"", ""},
	}
	for _, c := range cases {
		if got := t2sField("auto", c.in); got != c.want {
			t.Errorf("t2sField(auto,%q)=%q want %q", c.in, got, c.want)
		}
	}
	if got := t2sField("off", "辰東"); got != "辰東" {
		t.Errorf("off 模式应透传，got %q", got)
	}
	if got := t2sField("on", "乾坤"); got != "干坤" {
		t.Errorf("on 模式应无条件转换（歧义字风险由显式 on 的规则自担），got %q", got)
	}
	// 幂等：转换产物重入不再变化（存量回填/重采双路径的稳定性前提）
	for _, c := range cases {
		once := t2sField("auto", c.in)
		if got := t2sField("auto", once); got != once {
			t.Errorf("t2sField 非幂等: %q → %q → %q", c.in, once, got)
		}
	}
}
