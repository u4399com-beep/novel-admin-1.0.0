/**
 * R132 数据清洗强化专项回归：
 * 1. reDescReprint 转载声明尾注（引擎侧 cleanDescription）——98 本存量 Novel.description
 *    实证同模板（blqiuge.cc/biqiuge8.com 系「 作者：X所写的《Y》无弹窗…转载作品。
 *    无弹窗推荐地址：URL」），与 backend introReprintRE 同族双侧闭环。
 * 2. reSeoSuffix +「在线阅读」——iqxsw 列表项标题「苏信赵凌一剑霸天最新章节在线阅读」
 *    入库残留实证（书 614/635）。
 * 3. ListItem 字段清洗接线（cleanBookTitle/stripAuthorLabel/stripFieldLabel）。
 * 4. cleanx R132 两类行级新规（reJSCallLine/reBadComment）的误杀面对照。
 */
package main

import "testing"

func TestCleanDescription_ReprintTail_R132(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "转载声明尾注截断（书29实证）",
			in:   "怪尽皆俯首！“有我一日，人族不灭！” 作者：白驹易逝所写的《人族镇守使》无弹窗免费全文阅读为转载作品,章节由网友发布。无弹窗推荐地址：https://www.blqiuge.cc/book/7802/",
			want: "怪尽皆俯首！“有我一日，人族不灭！”",
		},
		{
			name: "转载声明尾注截断（书105实证_极短剩余）",
			in:   "叫我 作者：被提线的木偶所写的《莫欺老年穷，一天增加一个天赋点》无弹窗免费全文阅读为转载作品,章节由网友发布。无弹窗推荐地址：https://www.blqiuge.cc/book/30769140/",
			want: "叫我",
		},
		{
			name: "无转载尾特征的「所写的《》」不误伤",
			in:   "这是他所写的《山河故人》里最动人的一个故事。",
			want: "这是他所写的《山河故人》里最动人的一个故事。",
		},
		{
			name: "干净叙事简介零改动",
			in:   "在破败中崛起，在寂灭中复苏。沧海成尘，雷电枯竭。",
			want: "在破败中崛起，在寂灭中复苏。沧海成尘，雷电枯竭。",
		},
	}
	for _, c := range cases {
		if got := cleanDescription(c.in); got != c.want {
			t.Errorf("%s: cleanDescription = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestCleanBookTitle_OnlineReadSuffix_R132(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"SEO后缀在线阅读剥离（书614形态）", "苏信赵凌一剑霸天最新章节在线阅读", "苏信赵凌一剑霸天"},
		{"免费阅读无弹窗剥离（书635形态）", "苏信赵凌免费阅读无弹窗", "苏信赵凌"},
		{"正常书名含「在线」不误伤", "在线肌肤诊疗手记", "在线肌肤诊疗手记"},
		{"正常书名零改动", "一剑霸天", "一剑霸天"},
	}
	for _, c := range cases {
		if got := cleanBookTitle(c.in); got != c.want {
			t.Errorf("%s: cleanBookTitle = %q, want %q", c.name, got, c.want)
		}
	}
}

// R132 行级新规误杀面对照：reJSCallLine 只认整行「标识符();」形态，
// 叙事句（中文标点/含其他文字）绝不可能命中；reBadComment 只认整行 <!...> 壳。
func TestIsNoiseLine_R132FalsePositives(t *testing.T) {
	cases := []struct {
		name string
		line string
		want bool
	}{
		{"英文叙事句尾句号非调用形态", "He stood still and waited.", false},
		{"叙事含半角括号非整行调用", "他说了一声“喂”然后挂了(hang up)。", false},
		{"调用词出现在句中不判噪声", "他大喊着app2()冲了出去；", false},
		{"含>的叙述不是注释壳", "她想着<!那件事>就没说话", false},
	}
	for _, c := range cases {
		if got := isNoiseLine(c.line); got != c.want {
			t.Errorf("isNoiseLine(%q) = %v, want %v", c.line, got, c.want)
		}
	}
}
