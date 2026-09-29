/**
 * audit54a_test.go —— 第 16 轮收敛深审（解析层专项）回归锁定。
 *
 * 本轮修复（均在 content.go，探针实证「修复前行为是坏的」后落码）：
 *   FIX-1 (P3) decodeEntityOne 数字实体 int64→rune 截断：&#4294967361;（2^32+65）
 *              修复前解出 'A'——超出 Unicode 码位的十进制实体可向正文注入任意码位；
 *              修复后按 HTML5 语义出 U+FFFD（0x110000..0x7FFFFFFF 区间旧版即落 U+FFFD，
 *              本守卫把 ≥2^31 的未定义截断并轨到同一语义，合法码位/控制字符语义不变）。
 *   FIX-2 (P3) reResidualEntity 数字实体十六进制形态只认小写 x：&#X41;（HTML5 与
 *              x/net/html 首层解码均接受的合法形态）修复前原样残留入库；
 *              decodeEntityOne 的 "&#X" HasPrefix 分支此前因正则不喂该形态而不可达。
 *   FIX-3 (精简) cleanContainer 全角空格预替换 no-op 移除（reJSWhitespace 类已含
 *              \x{3000}，与 Task 46-a 移除 NBSP no-op 同族），用例锁定折叠输出逐字节不变。
 * 另锁 extractChapterRefs 同 URL 去重「后位胜出」索引迁移不变式（全仓唯一无直测的
 * 手写索引搬移逻辑，交错重复场景此前零回归防护）。
 */
package main

import (
	"strings"
	"testing"

	"github.com/PuerkitoBio/goquery"
)

// TestDecodeResidualEntitiesAstralRangeGuard FIX-1 回归：超码位十进制实体不再经截断注入任意字符。
func TestDecodeResidualEntitiesAstralRangeGuard(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{
			// 修复前：rune(4294967361) 截断为 int32 低 32 位 = 0x41 → 'A'（坏）
			name: "超码位截断注入面_2pow32加65",
			in:   "&#4294967361;",
			want: "\uFFFD",
		},
		{
			// ≥2^31 的另一形态（旧版截断为负数 rune → 恰好也是 U+FFFD，锁定并轨后不变）
			name: "超码位_2pow31",
			in:   "&#2147483648;",
			want: "\uFFFD",
		},
		{
			// 0x5F5E0FF > MaxRune：旧版 string(非法码位) 即 U+FFFD，语义保持
			name: "超码位_区间内_语义保持",
			in:   "&#99999999;",
			want: "\uFFFD",
		},
		{
			// 合法星面码位必须照常解码（修复不得误伤 Task 31-c 字体混淆恢复能力）
			name: "合法星面码位_emoji",
			in:   "&#128512;",
			want: "😀",
		},
		{
			// BMP 合法码位照常
			name: "合法BMP码位",
			in:   "&#x38C9;",
			want: "\u38c9",
		},
		{
			// Task 61-R3-c 回归：十六进制 ≥2^31 与十进制并轨（旧版 ParseInt 位宽 32
			// 对 [2^31,2^32) 直接 ErrRange 原文残留，同值十进制形态却出 U+FFFD）
			name: "超码位_HEX_2pow31",
			in:   "&#x80000000;",
			want: "\uFFFD",
		},
		{
			name: "超码位_HEX_2pow32减1",
			in:   "&#xFFFFFFFF;",
			want: "\uFFFD",
		},
		{
			// Task 34 P3-23 语义保持：NUL/控制字符出原文不进正文
			name: "控制字符_保持原文",
			in:   "&#0;&#1;",
			want: "&#0;&#1;",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := decodeResidualEntities(tc.in); got != tc.want {
				t.Fatalf("decodeResidualEntities(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// TestDecodeResidualEntitiesUpperHexPrefix FIX-2 回归：大写 X 十六进制实体照常解码。
func TestDecodeResidualEntitiesUpperHexPrefix(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{
			// 修复前：&#X41; 不被白名单命中 → 原样残留（坏）
			name: "大写X_HEX解码",
			in:   "&#X41;&#x42;",
			want: "AB",
		},
		{
			name: "大写X_星面码位",
			in:   "&#X1F600;",
			want: "😀",
		},
		{
			name: "大写X_双重转义残一层",
			in:   "&amp;#X41;",
			want: "A",
		},
		{
			name: "非法十六进制位_保持原文",
			in:   "&#XZZ;",
			want: "&#XZZ;",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := decodeResidualEntities(tc.in); got != tc.want {
				t.Fatalf("decodeResidualEntities(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// TestCleanContainerFullWidthSpaceFoldUnchanged FIX-3 回归：全角空格折叠输出与移除 no-op 前逐字节一致。
func TestCleanContainerFullWidthSpaceFoldUnchanged(t *testing.T) {
	html := `<div id="c"><p>第一段　　行内全角空格</p><p>第二段　起始全角</p></div>`
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(html))
	if err != nil {
		t.Fatalf("parse html: %v", err)
	}
	got := cleanContainer(doc.Find("#c")).paragraphs
	want := []string{"第一段 行内全角空格", "第二段 起始全角"}
	if len(got) != len(want) {
		t.Fatalf("paragraphs = %#q, want %#q", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("paragraphs[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

// TestExtractChapterRefsDedupLastWinsOrder 不变式锁定：同 URL 重复「后位胜出」——
// 前位原样删除、后位按 DOM 顺序追加，其间交错条目的 seen 下标必须同步收缩。
// novel#147-158 章序错乱修复过的手写索引搬移逻辑此前无直测。
func TestExtractChapterRefsDedupLastWinsOrder(t *testing.T) {
	base := "https://toc.example.com/book/1/"
	link := func(id, frag string) string {
		return `<a href="` + base + id + `.html` + frag + `">第` + id + `章</a>`
	}
	cases := []struct {
		name string
		html string
		want []string
	}{
		{
			// c1 c2 c1 c3 c1 c4 → 每次「删除前位+尾部追加」，c1 终态位次为 c4 之前（探针实证）
			name: "交错重复_后位胜出",
			html: link("1", "") + link("2", "") + link("1", "") + link("3", "") + link("1", "") + link("4", ""),
			want: []string{"2", "3", "1", "4"},
		},
		{
			name: "相邻重复",
			html: link("1", "") + link("1", "") + link("2", ""),
			want: []string{"1", "2"},
		},
		{
			name: "中位重复_保序",
			html: link("1", "") + link("2", "") + link("1", ""),
			want: []string{"2", "1"},
		},
		{
			name: "锚点变体同URL去重",
			html: link("1", "") + link("2", "#top") + link("2", ""),
			want: []string{"1", "2"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			doc, err := goquery.NewDocumentFromReader(strings.NewReader("<html><body>" + tc.html + "</body></html>"))
			if err != nil {
				t.Fatalf("parse html: %v", err)
			}
			refs := extractChapterRefs(doc, map[string]string{"chapterLinkSelector": "a"}, base, &[]string{})
			var got []string
			for _, r := range refs {
				if r.Url == nil {
					t.Fatalf("章节引用 Url 不应为 nil（无 URL 引用应被跳过）")
				}
				got = append(got, strings.TrimSuffix(strings.TrimPrefix(*r.Url, base), ".html"))
			}
			if len(got) != len(tc.want) {
				t.Fatalf("refs = %v, want %v", got, tc.want)
			}
			for i := range tc.want {
				if got[i] != tc.want[i] {
					t.Fatalf("refs[%d] = %q, want %q（全序 = %v）", i, got[i], tc.want[i], got)
				}
			}
		})
	}
}
