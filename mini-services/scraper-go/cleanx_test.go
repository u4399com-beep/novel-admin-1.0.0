/**
 * cleanx.go 行级噪声规则回归锁定（Task 28-a）：
 * 用存量库审计实证的残留噪声样本（xinjianpan 85 字版权条、huangjinwu 独立标签残行）与
 * 易误杀的正常叙事行做双向断言，防止后续调参回退。
 */
package main

import "testing"

func TestIsNoiseLine_Task28a(t *testing.T) {
	cases := []struct {
		name string
		line string
		want bool
	}{
		// —— 应判噪声：Task 28-a 新增两类 ——
		{"xinjianpan 85字版权条（域名+变体选择符）", "《长征路上捡了个小福星》转载请注明来源：新键盘小说网xinjianpan.com，若浏览器显示没有新章节了，请尝试点击右上角↗️或右下角↘️的菜单，退出阅读模式即可，谢谢！", true},
		{"中长域名行 31-120 字", "本章内容来自某某小说网 www.example.com 每日更新", true},
		{"独立闭合标签残行", "</div", true},
		{"完整独立标签残行", `<div class="chapter-end">`, true},
		{"自闭合标签残行", "<br/>", true},
		{"独立开标签残行", "<p", true},
		// —— 应判噪声：既有规则回归锚点 ——
		{"短行域名", "www.xinjianpan.com", true},
		{"天才一秒记住样板", "天才一秒记住【新键盘小说网】地址：xinjianpan.com，谢谢！", true},
		{"断章提示", "本章未完，请点击下一页继续阅读", true},
		{"导航精确行", "下一页", true},
		{"纯数字页码", "3", true},
		// —— 不应判噪声：叙事保护 ——
		{"带标点对话（终章按钮词非链接）", "没有了。", false},
		{"标签包裹的叙事不是整行标签", "<p>第一幕开演</p>", false},
		{"超过120字的含域名长句放行", "他说他早在一九九八年就开始维护一个叫 example.com 的个人主页，后来又陆陆续续换了好几个域名，从静态页写到动态论坛再到移动端适配，前前后后折腾了二十多年，服务器从老家机房一路搬到云上，一直坚持到今天还在更新，这份执着让人敬佩，也让我们明白坚持的力量。", false},
		{"普通叙事长句", "宋微明抬手压住衣领，霍去病打量她半晌，忽然低声问了一句她平日里在槐里下田时穿的是什么衣裳。", false},
		{"普通短叙事", "快了！", false},
	}
	for _, c := range cases {
		if got := isNoiseLine(c.line); got != c.want {
			t.Errorf("isNoiseLine(%q) = %v, want %v", c.line, got, c.want)
		}
	}
}

func TestCleanChapterText_Task28a(t *testing.T) {
	// xinjianpan 尾注 + huangjinwu 标签残行混合样本
	raw := "更新前的第一段叙事。\n《书名》转载请注明来源：新键盘小说网xinjianpan.com，若浏览器显示没有新章节了，请尝试点击右上角↗️或右下角↘️的菜单，退出阅读模式即可，谢谢！\n</div\n第二段叙事继续。"
	stats := cleanChapterText(raw)
	want := "更新前的第一段叙事。\n第二段叙事继续。"
	if stats.Text != want {
		t.Errorf("cleanChapterText tail mismatch:\n got %q\nwant %q", stats.Text, want)
	}
	if stats.Removed != 2 {
		t.Errorf("Removed = %d, want 2", stats.Removed)
	}
}
