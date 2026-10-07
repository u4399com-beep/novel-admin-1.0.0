package main

/**
 * audit96b_test.go —— R96 分页能力防回退回归（backend-go 侧）。
 *
 * 跨服务契约锁定：引擎 R96 内置机会性分页回退的警告文案必须能被
 * pageWarnedTocPagination（小目录护栏的判断依据）按子串命中——
 * 「chapterListPaginationSelector」+「发现目录分页」。若引擎文案漂移，
 * 护栏失明，walker 退化重试不再触发，目录截断回归。
 *
 * 注：引擎侧语义（回退发现/显式键治理/零锚零变化）由 scraper-go audit96a_test.go
 * 全覆盖；后端 fetchFullToc/REPLACE/护栏端到端由 audit82b/audit85b 覆盖，不重复。
 */

import (
	"strings"
	"testing"
)

func TestPageWarnedTocPaginationAcceptsR96FallbackWarning(t *testing.T) {
	// R96 引擎回退路径的实际文案（extract.go，含「（内置机会性回退）」插入段）
	const fallbackWarning = "chapterListPaginationSelector（内置机会性回退）：发现目录分页 8 页，由 worker 逐页跟随"
	if !pageWarnedTocPagination([]string{fallbackWarning}) {
		t.Fatalf("护栏未命中 R96 回退警告（跨服务契约断裂）: %q", fallbackWarning)
	}
	// 规则显式配置路径的原文案（R82 语义）仍须命中
	const ruleWarning = "chapterListPaginationSelector：发现目录分页 2 页，由 worker 逐页跟随"
	if !pageWarnedTocPagination([]string{ruleWarning}) {
		t.Fatalf("护栏未命中规则配置警告: %q", ruleWarning)
	}
}

func TestPageWarnedTocPaginationRejectsUnrelated(t *testing.T) {
	// 负例不得包含「发现目录分页」子串（pageWarnedTocPagination 按子串匹配，
	// 引擎从不发出这些形态）
	negatives := [][]string{
		{"chapterListPaginationSelector：分页锚缺失"}, // 有键但未报告分页
		{"目录分页页抓取失败"},                           // 无键前缀
		{},
	}
	for i, w := range negatives {
		if pageWarnedTocPagination(w) {
			t.Fatalf("case %d 误命中: %v", i, w)
		}
	}
	// 混合列表：噪声警告 + 正确警告 → 仍命中
	if !pageWarnedTocPagination([]string{"无关警告", "chapterListPaginationSelector（内置机会性回退）：发现目录分页 3 页，由 worker 逐页跟随"}) {
		t.Fatal("混合列表未命中回退警告")
	}
}

func TestWalkerDegenerateR96ContractUnchanged(t *testing.T) {
	// walker 退化语义不被 R96 改变（回退发现分页后，退化重试护栏照常工作）
	if !walkerDegenerate(0, []ChapterRef{{}}) {
		t.Fatal("0 页应判退化")
	}
	if !walkerDegenerate(3, nil) {
		t.Fatal("0 条应判退化")
	}
	if walkerDegenerate(3, []ChapterRef{{}}) {
		t.Fatal("3 页 1 条不应判退化")
	}
}

// 防御性编译契约：ChapterRef 可零值构造（walker 测试基建依赖）
func TestChapterRefZeroValueCompiles(t *testing.T) {
	var r ChapterRef
	_ = strings.TrimSpace(r.Title)
}
