/**
 * chapterorder_test.go —— ordering.ts 移植正确性测试（表驱动，期望值按 JS 语义推演）。
 *
 * 覆盖：chineseNumeralToInt（中文数字组合）、parseChapterNo（第N章/纯数字前缀/未编号）、
 * reorderChapterRefs（无重复序号全局重排 / 重复序号头部倒序块保守修复 / 信号不足原样返回）。
 * 运行：cd mini-services/backend-go && go test -run TestChapterOrder ./...
 */
package main

import "testing"

func TestChapterOrderChineseNumeral(t *testing.T) {
	cases := []struct {
		in   string
		want int64
		ok   bool
	}{
		{"两百零三", 203, true},
		{"一千零一十", 1010, true},
		{"三千五百万", 35_000_000, true},
		{"十五", 15, true},
		{"十", 10, true},
		{"零", 0, true},
		{"亿", 0, true},           // JS: section=(0+0)*1e8=0, any=true → 0
		{"一二三", 3, true},         // JS 实证：current 逐位覆盖，末位 3（非逐位累计 123）
		{"第", 0, false},          // 未知字符
		{"甲", 0, false},          // 未知字符
		{"", 0, false},           // 空串
		{"123", 123, true},       // 纯阿拉伯
		{"1234567890", 0, false}, // 超 9 位 → 走中文分支 → 未知字符 null
	}
	for _, c := range cases {
		got, ok := chineseNumeralToInt(c.in)
		if ok != c.ok || (ok && got != c.want) {
			t.Errorf("chineseNumeralToInt(%q) = (%d,%v), want (%d,%v)", c.in, got, ok, c.want, c.ok)
		}
	}
}

func TestChapterOrderParseChapterNo(t *testing.T) {
	cases := []struct {
		in   string
		want int64
		ok   bool
	}{
		{"第12章 开端", 12, true},
		{"第一千零一章 变故", 1001, true},
		{"第两百零三节", 203, true},
		{"第1234回", 1234, true},
		{"第 7 章 空白", 7, true}, // JS \s 含全角/多空白（jsSpaceClass 等价）
		{"第0章", 0, true},
		{"第3456789章", 3_456_789, true},
		{"第12345678章", 0, false}, // 8 位阿拉伯超 {1,7} → 整体不匹配
		{"123.标题", 123, true},
		{"123、标题", 123, true},
		{"123:标题", 123, true},
		{"123. ", 0, false}, // 前缀后无非空白内容 → 不匹配
		{"序章", 0, false},    // 无编号
		{"第一章", 1, true},    // 「一」在中文数字类内（JS 实证 parseInt=1，非「不匹配」）
		{"第2章", 2, true},    // 同上对照：阿拉伯分支
		{"第1卷", 0, false},   // 卷不在 [章节回话]
		{"番外 秋游", 0, false}, // 无编号
		{"第X章", 0, false},   // X 非数字
		{"", 0, false},
	}
	for _, c := range cases {
		got, ok := parseChapterNo(c.in)
		if ok != c.ok || (ok && got != c.want) {
			t.Errorf("parseChapterNo(%q) = (%d,%v), want (%d,%v)", c.in, got, ok, c.want, c.ok)
		}
	}
}

func mkRefs(titles []string) []ChapterRef {
	out := make([]ChapterRef, len(titles))
	for i, s := range titles {
		out[i] = ChapterRef{Title: s, URL: "u" + itoa(i)}
	}
	return out
}

func titlesOf(refs []ChapterRef) []string {
	out := make([]string, len(refs))
	for i, r := range refs {
		out[i] = r.Title
	}
	return out
}

func TestChapterOrderReorderNoDup(t *testing.T) {
	// 形态1：头部「最新章节 3 条（新→旧）」+ 正文块 第1..9章（旧→新），序号 1..12 无重复
	refs := mkRefs([]string{"第12章", "第11章", "第10章", "第1章", "第2章", "第3章", "第4章", "第5章", "第6章", "第7章", "第8章", "第9章"})
	rr := reorderChapterRefs(refs)
	if !rr.reordered {
		t.Fatalf("应触发重排（disorder=1.0 > 0.2）")
	}
	want := []string{"第1章", "第2章", "第3章", "第4章", "第5章", "第6章", "第7章", "第8章", "第9章", "第10章", "第11章", "第12章"}
	got := titlesOf(rr.refs)
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("重排结果[%d] = %s, want %s（全部：%v）", i, got[i], want[i], got)
		}
	}
	if rr.note == "" {
		t.Fatalf("重排说明不应为空")
	}
}

func TestChapterOrderFixLeadingDescendingBlock(t *testing.T) {
	// 形态2（重复序号，无分卷信息）：最新块 第12,11,10（新→旧）+ 正文 第1..10（旧→新）
	// JS 逐行推演：头部递减块延伸到 第1章（1<10 不满足 n>=prev 继续计数）→ k=4；
	// 其余 [2..10] 非降且 ≥8 → 块反转移尾
	refs := mkRefs([]string{"第12章", "第11章", "第10章", "第1章", "第2章", "第3章", "第4章", "第5章", "第6章", "第7章", "第8章", "第9章", "第10章"})
	rr := reorderChapterRefs(refs)
	if !rr.reordered {
		t.Fatalf("应触发头部倒序块修复")
	}
	want := []string{"第2章", "第3章", "第4章", "第5章", "第6章", "第7章", "第8章", "第9章", "第10章", "第1章", "第10章", "第11章", "第12章"}
	got := titlesOf(rr.refs)
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("修复结果[%d] = %s, want %s（全部：%v）", i, got[i], want[i], got)
		}
	}
}

func TestChapterOrderNoReorder(t *testing.T) {
	// 已有序目录：比率 0 → 原样返回
	refs := mkRefs([]string{"第1章", "第2章", "第3章", "第4章", "第5章", "第6章", "第7章", "第8章"})
	rr := reorderChapterRefs(refs)
	if rr.reordered {
		t.Fatalf("有序目录不应重排")
	}
	// 编号章节不足（信号不足）→ 原样返回
	refs2 := mkRefs([]string{"序章", "第1章", "番外", "第2章"})
	rr2 := reorderChapterRefs(refs2)
	if rr2.reordered {
		t.Fatalf("章节过少不应重排")
	}
}
