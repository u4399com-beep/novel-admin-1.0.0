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

// TestCleanChapterText_TrailingJSArtifact_Task31c 行尾 JS 残留 token 剥离回归锁定（Task 31-c）：
// 全库审计实测源站把内联脚本尾巴拼在叙事行末（novel 1「…javascript:」、novel 4「… hf();」），
// 此类行超 30 字不能整行判噪声（会误删叙事），只剥行尾 token 本身。
func TestCleanChapterText_TrailingJSArtifact_Task31c(t *testing.T) {
	cases := []struct {
		name string
		line string
		want string
	}{
		// —— 实测样本 ——
		{"hf()调用残迹", "是的，梦霓裳关机了。在接了梦父电话后，她就立马关了手机。 hf();", "是的，梦霓裳关机了。在接了梦父电话后，她就立马关了手机。"},
		{"javascript伪协议残迹", "若是自己跟其他人一样，做了缩头乌龟，那么，现在也没自己什么事了。javascript:", "若是自己跟其他人一样，做了缩头乌龟，那么，现在也没自己什么事了。"},
		{"href分号形态", "他点点头，转身离开。javascript:;", "他点点头，转身离开。"},
		{"纯token行", "hf();", ""},
		// —— 大小写/变体 ——
		{"大写形态", "他挥手告别。JAVASCRIPT:", "他挥手告别。"},
		{"无叙事尾token重复", "她转身走了。javascript:hf();", "她转身走了。"},
		// —— 叙事保护：非行尾/非token形态不动 ——
		{"全角冒号结尾不是伪协议", "他只留下了一句话：", "他只留下了一句话："},
		// 长行（>30 字不触发 isNoiseLine 整行删除）且 token 不在行尾 → 不剥不动
		{"token不在行尾不剥", "写代码时我们用 javascript: 伪协议内联脚本，这是很久以前的老办法了。", "写代码时我们用 javascript: 伪协议内联脚本，这是很久以前的老办法了。"},
		{"普通叙事不动", "宋微明抬手压住衣领，忽然低声问了一句她平日里在槐里下田时穿的是什么衣裳。", "宋微明抬手压住衣领，忽然低声问了一句她平日里在槐里下田时穿的是什么衣裳。"},
	}
	for _, c := range cases {
		stats := cleanChapterText(c.line)
		if c.want == "" {
			if stats.Text != "" {
				t.Errorf("cleanChapterText(%q) = %q, want empty", c.line, stats.Text)
			}
			continue
		}
		if stats.Text != c.want {
			t.Errorf("cleanChapterText(%q):\n got %q\nwant %q", c.line, stats.Text, c.want)
		}
	}
}
