/**
 * main_test.go —— csscheck 工具单元锁定（Task 58-b 深审收编）：
 * - plausible：工具类合法性过滤的表驱动双向锁定（Tailwind 变体/任意值/负 margin 接受；
 *   色值/URL/大写根/括号不平衡/逗号组/CSS 变量形态拒绝）——过滤口径单方面放宽会让
 *   文案/色值/URL 混进候选污染漂移报告，单方面收紧会漏报真漂移。
 * - dropInterpolation：Go 模板插值段剥离语义（每个 {{...}} 动作替换为单空格、未闭合
 *   截断到 {{ 为止）；动作之间的字面文本（含 class 属性）保守保留——warning-only
 *   扫描器宁多扫不漏扫，本测试锁定该语义不被单方面收紧。
 * 纯函数零 IO，不触 DB 与生产路径。
 */
package main

import (
	"strings"
	"testing"
)

func TestPlausibleClassTokens(t *testing.T) {
	yes := []string{
		"flex",                      // 基础工具类
		"-mt-2",                     // 负 margin（root 以 - 开头）
		"hover:bg-red-500",          // 变体前缀（root=hover 小写）
		"md:hover:text-white",       // 多级变体
		"sm:!text-white",            // important 前缀（! 不在括号外拒绝集）
		"bg-[#1B1B1F]",              // 任意值：括号内大写/# 合法
		"w-1/2",                     // 分数（/ 不在拒绝集）
		"grid-cols-[repeat(3,1fr)]", // 任意值内逗号/圆括号（depth>0 不拒）
		"-translate-x-[2px]",        // 负值 + 任意值组合
	}
	no := []string{
		"",                       // 空
		"g",                      // 过短（<2）
		"#1B1B1F",                // root 以 # 开头（十六进制色值）
		"Flex",                   // 大写开头（组件名非工具类）
		"bg(red)",                // 括号外圆括号拒绝
		"bg-[#123",               // 括号不平衡（未闭合）
		"bg-#123]",               // 逆序闭括号（depth<0）
		"foo,bar",                // 括号外逗号（选择器组/多值非工具类）
		"--my-var",               // CSS 自定义属性形态
		"https://x.com",          // URL（Task 58-b 补 "://" 守卫——头注宣称防 URL 混入）
		strings.Repeat("a", 121), // 超长（>120）
	}
	for _, tok := range yes {
		if !plausible(tok) {
			t.Errorf("合法工具类被误拒: %q", tok)
		}
	}
	for _, tok := range no {
		if plausible(tok) {
			t.Errorf("非工具类 token 被误收（会污染漂移报告）: %q", tok)
		}
	}
}

func TestDropInterpolation(t *testing.T) {
	cases := []struct{ in, want string }{
		// 每个 {{...}} 动作替换为单空格；动作之间字面文本保守保留
		{`<div class="flex {{.Cls}} items-center">`, `<div class="flex   items-center">`},
		{`{{if .X}}class="a"{{end}}class="b"`, ` class="a" class="b"`},
		{`<p class="{{range .Tags}}{{.}} {{end}}x">`, `<p class="    x">`},
		// 未闭合 {{：截断到 {{ 为止（其后内容全部丢弃，防半个动作漏出伪类名）
		{`<span class="a {{.Open`, `<span class="a `},
		{`no-interpolation`, `no-interpolation`},
	}
	for _, c := range cases {
		if got := dropInterpolation(c.in); got != c.want {
			t.Errorf("dropInterpolation(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
