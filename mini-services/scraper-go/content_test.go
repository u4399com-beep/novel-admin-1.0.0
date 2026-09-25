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
		// ---- Task 31-d 补齐：边界表缺 table/ul/ol/dl/dt/h5/h6 的同类粘连 ----
		{
			// dt 缺边界时 dt 与首个 dd 粘连成「卷一第一段」（探针实测）
			name: "dl_dt_dd_边界",
			html: `<div id="c"><dl><dt>卷一</dt><dd>第一段</dd><dd>第二段</dd></dl></div>`,
			want: []string{"卷一", "第一段", "第二段"},
		},
		{
			// table 元素缺边界时，</table> 前裸文本 foster 前移与单元格文本粘连（探针实测）
			name: "table_尾裸文本不粘连",
			html: `<div id="c"><table><tr><td>A段</td></tr>表尾裸文本</table><p>下一段</p></div>`,
			want: []string{"表尾裸文本", "A段", "下一段"},
		},
		{
			// ul 缺边界时列表尾裸文本与后续块粘连（探针实测「列表尾文本尾段」）
			name: "ul_尾裸文本不粘连",
			html: `<div id="c"><ul><li>条目一</li><li>条目二</li>列表尾文本</ul><p>尾段</p></div>`,
			want: []string{"条目一", "条目二", "列表尾文本", "尾段"},
		},
		{
			// h5/h6 缺边界时小标题与正文粘连（探针实测「小标题五小标题六正文」）
			name: "h5_h6_块级边界",
			html: `<div id="c"><h5>小标题五</h5><h6>小标题六</h6><p>正文</p></div>`,
			want: []string{"小标题五", "小标题六", "正文"},
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

// TestCleanContainerResidualEntities_Task31c 残留实体再解码回归锁定（Task 31-c）：
// 全库审计实测三类源站双重/三重转义正文——ggd66 对话引号 &amp;quot;（live 6/112 章脏）、
// ddyueshu 系作者注 &amp;amp;/&amp;lt;…&amp;gt;（导入存量）、ixdzs8 系简介分隔符 &amp;amp;&amp;amp;。
// 源站 HTML 中转义层级 = DB 观测残留层数 + goquery Text() 已解码的一层。
func TestCleanContainerResidualEntities_Task31c(t *testing.T) {
	cases := []struct {
		name string
		html string
		want []string
	}{
		{
			// 实测样本 novel 24 ch 500143：源 HTML 三重转义，Text() 残两层
			name: "ggd66_三重转义对话引号",
			html: `<div id="c"><p>&amp;amp;quot;噗~&amp;amp;quot;林雾宜被她可怜兮兮的样子逗笑了。</p></div>`,
			want: []string{`"噗~"林雾宜被她可怜兮兮的样子逗笑了。`},
		},
		{
			// 实测样本 novel 1 ch 18：源 HTML 双重转义 & → Text() 残 &amp;
			name: "双重转义_amp_残一层",
			html: `<div id="c"><p>只是在这个小小的玄兽。。&amp;amp;。交易市场</p></div>`,
			want: []string{"只是在这个小小的玄兽。。&。交易市场"},
		},
		{
			// 实测样本 novel 1 ch 156：作者注尖括号双重转义
			name: "双重转义_lt_gt_作者注",
			html: `<div id="c"><p>&amp;lt;在外开会，若有错别字，兄弟们先给我记录&amp;gt;</p></div>`,
			want: []string{"<在外开会，若有错别字，兄弟们先给我记录>"},
		},
		{
			name: "双重转义_nbsp_归一空格",
			html: `<div id="c"><p>第一段&amp;nbsp;继续第二段</p></div>`,
			want: []string{"第一段 继续第二段"},
		},
		{
			// 实测样本 novel 534：字体混淆型数字实体，解码回站点数据层原字符
			name: "十六进制数字实体解码",
			html: `<div id="c"><p>一个粉丝的投稿跃&amp;#x38c9;她的眼中</p></div>`,
			want: []string{"一个粉丝的投稿跃\u38c9她的眼中"},
		},
		{
			// 单层转义（正常站点）Text() 已解码，再解码必须幂等不动
			name: "单层转义_幂等不误伤",
			html: `<div id="c"><p>&quot;正常单层引号&quot;与 AT&amp;T 和 Tom&amp;amp;Jerry</p></div>`,
			want: []string{`"正常单层引号"与 AT&T 和 Tom&Jerry`},
		},
		{
			// 解码后行长缩短，水印行闸（runeLen<=100 && reWatermarkLine）仍正常命中
			name: "解码后水印行闸仍生效",
			html: `<div id="c"><p>本书来自&amp;quot;www.shuimi.com&amp;quot; 请记住本站</p></div>`,
			want: []string{},
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
