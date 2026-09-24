/**
 * content_test.go —— Task 30-b 回归锁定：cleanContainer 块级边界表
 * （td/th/tr/center 补齐修复的表驱动用例）。
 */
package main

import (
	"strings"
	"testing"

	"github.com/PuerkitoBio/goquery"
)

// TestCleanContainerBlockBoundaries 块级元素边界必须产出独立段落（Task 30-b 修复锁定：
// 旧版边界表缺 td/th/tr/center，表格布局正文相邻单元格文本粘连成一行）。
func TestCleanContainerBlockBoundaries(t *testing.T) {
	cases := []struct {
		name string
		html string
		want []string
	}{
		{
			name: "table_cells_不粘连",
			html: `<div id="c"><table><tr><td>第一章 起点</td></tr><tr><td>话说天下大势</td></tr><tr><td>分久必合。</td></tr></table></div>`,
			want: []string{"第一章 起点", "话说天下大势", "分久必合。"},
		},
		{
			name: "th_td_混合表头表体",
			html: `<div id="c"><table><tr><th>章节</th><th>内容</th></tr><tr><td>第一节</td><td>正文开篇</td></tr></table></div>`,
			want: []string{"章节", "内容", "第一节", "正文开篇"},
		},
		{
			name: "center_块级边界",
			html: `<div id="c"><center>第一段居中</center><center>第二段居中</center></div>`,
			want: []string{"第一段居中", "第二段居中"},
		},
		{
			name: "常规_p_div_边界不受影响",
			html: `<div id="c"><p>段落一</p><div>段落二</div><li>段落三</li></div>`,
			want: []string{"段落一", "段落二", "段落三"},
		},
		{
			name: "br_边界保留",
			html: `<div id="c">上行<br>下行<br/>末行</div>`,
			want: []string{"上行", "下行", "末行"},
		},
		{
			name: "表格布局正文中的水印行仍可被行级清洗剔除",
			// 粘连修复后水印行保持独立（≤100 字），reWatermarkLine 行级闸可命中
			html: `<div id="c"><table><tr><td>正文第一段。</td></tr><tr><td>本书来自 www.shuimi.com 请记住本站</td></tr><tr><td>正文第二段。</td></tr></table></div>`,
			want: []string{"正文第一段。", "正文第二段。"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			doc, err := goquery.NewDocumentFromReader(strings.NewReader(tc.html))
			if err != nil {
				t.Fatalf("parse html: %v", err)
			}
			got := cleanContainer(doc.Find("#c")).paragraphs
			if len(got) != len(tc.want) {
				t.Fatalf("paragraphs = %#q, want %#q", got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("paragraphs = %#q, want %#q", got, tc.want)
				}
			}
		})
	}
}
