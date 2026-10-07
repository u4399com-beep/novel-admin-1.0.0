/**
 * cleanx_test.go —— R94 台湾聚合站推广行 + 混淆域名噪声规则回归锁定（backend-go 侧）。
 *
 * 与引擎侧 scraper-go/cleanx_test.go TestIsNoiseLine_R94_TaiwanPromo 同参互锁：
 * 引擎侧清洗发生在 t2s 之前（见繁体原样），backend 侧为入库第二道清洗 + clean-all 存量
 * 清洗（简体为主），两侧繁简双形态都必须命中。修改本文件时必须同步引擎侧用例。
 */
package main

import "testing"

func TestIsNoiseLine_R94_TaiwanPromo(t *testing.T) {
	cases := []struct {
		name string
		line string
		want bool
	}{
		// —— 用户实测样本（简体= t2s 后形态）——
		{"台湾推广行（用户实测样本）", "读台湾小说上台湾小说网，?????.???超省心", true},
		{"台湾推广行（变体尾注）", "台湾小说网欢迎你，?????.???超省心", true},
		// —— 繁体原样（引擎侧 t2s 前的形态，双形态同参锁定）——
		{"繁体推广行", "讀台灣小說上台灣小說網，?????.???超省心", true},
		{"繁体短推广", "請記住台灣小說網 twbook?????", true},
		// —— 混淆域名形态（不含台湾关键词）——
		{"纯混淆域名行", "?????.???", true},
		{"混淆域名短句", "请访问 w???.???.com 获取全文", true},
		{"省心变体域名行", "本站域名 ?????。???永不打烊", true},
		// —— 叙事保护 ——
		{"全角双问号对话放行", "什么？？你再说一遍？", false},
		{"单半角问号放行", "他说了句 what?", false},
		{"双半角问号放行", "哈?!", false},
		{"含台湾但为叙事长句放行", "爷爷讲起了当年跟着国民党去台湾的小说原型人物，说那位老兵用了三十年才回到大陆故乡，讲到动情处声音都哽咽了，在场的人无不动容。", false},
		{"普通叙事", "窗外的雨停了，屋檐还在滴水。", false},
	}
	for _, c := range cases {
		if got := isNoiseLine(c.line); got != c.want {
			t.Errorf("isNoiseLine(%q) = %v, want %v", c.line, got, c.want)
		}
	}
}

// cleanChapterContent 端到端：推广行从多行正文中被整行剔除，叙事行保留
func TestCleanChapterContent_R94_TaiwanPromoStripped(t *testing.T) {
	raw := "他推开门，屋里一片漆黑。\n读台湾小说上台湾小说网，?????.???超省心\n「谁在那儿？」他压低声音问道。"
	res := cleanChapterContent(raw)
	want := "他推开门，屋里一片漆黑。\n「谁在那儿？」他压低声音问道。"
	if res.Text != want {
		t.Errorf("cleanChapterContent:\n got %q\nwant %q", res.Text, want)
	}
	if res.RemovedLines != 1 {
		t.Errorf("removedLines = %d, want 1", res.RemovedLines)
	}
}
