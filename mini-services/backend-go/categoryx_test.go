/**
 * categoryx_test.go —— Task 28-b 智能分类回归：
 * 1) classifyBookLocal 标题+简介双扫描（Task 28-b 修复：简介 240 字扫描此前为死代码——
 *    canonicalCategoryWithHint 只传标题；存量实证 5 本「其他」书简介含强语义词未被本地归类）；
 * 2) canonicalCategory L1 同义词/L2 关键词命中（含 Task 28-b 新增 重生/总裁/繁体补全），
 *    未命中路径由 TestMain 预置的 LLM 冷却窗短路（绝不发真实网络请求）；
 * 3) 归一化：全角/分隔符/大小写（N次元 → n次元 回归）。
 * 运行：cd mini-services/backend-go && go test -run 'TestClassify|TestCanonical|TestNormalizeCategory' ./...
 */
package main

import (
	"strings"
	"testing"
	"time"
)

// warmLLMCooldown 预置 30s 冷却窗：任何意外落入 L3 的用例由 llmChat 冷却短路返回 ""，
// 单测不发真实 LLM 请求（TestMain 在 recover_test.go，仅切 DB_PATH）。
func warmLLMCooldown() {
	llmMarkCooldown()
	_ = llmInCooldown()
	_ = time.Now()
}

func TestClassifyBookLocalTitleAndDesc(t *testing.T) {
	cases := []struct {
		name  string
		title string
		desc  string
		want  string
	}{
		// 标题命中（零成本主路径）
		{"标题-御兽", "万古御兽师", "", "玄幻奇幻"},
		{"标题-重生（Task 28-b 新词）", "攻略那个校草[重生]", "", "都市言情"},
		{"标题-总裁（Task 28-b 新词）", "霸道总裁爱上我", "", "都市言情"},
		// Task 28-b 存量实证样本：简介含强语义词、标题无分类词（旧路径全漏 → 滞留「其他」）
		{"简介-穿越（#33）", "四合院：开局所有技能加持20年",
			"本书又名方别本是一名实习中医师，因为加班劳累过度穿越到了1958年同名同姓的转业军医身上。", "都市言情"},
		{"简介-官场（#59）", "问鼎",
			"《问鼎》是何常在所着一部官场类小说，连载时原名《官神》，现改名为《问鼎》集结出版。", "都市言情"},
		{"简介-军事（#55）", "麒麟",
			"这裡有一位少校，他年方二十四，青春年少风华正茂，道德高尚思想端正，吃苦耐劳军事过硬。", "历史军事"},
		{"简介 51-100 字段命中（Task 28-b：旧 50 字窗口漏）", "盲嫂",
			strings.Repeat("这", 60) + "一部官场小说", "都市言情"},
		{"简介超 240 字截断（窗口外不误命中）", "盲嫂",
			strings.Repeat("这", 250) + "官场沉浮", ""},
		// 双空 → ""（交由 LLM/兜底，不误判）
		{"双空", "草稿纸随笔", "随便吃点，简介啥都不想写。", ""},
		{"空标题", "", "官场小说", "都市言情"},
	}
	for _, c := range cases {
		if got := classifyBookLocal(c.title, c.desc); got != c.want {
			t.Errorf("classifyBookLocal(%q, %q…) = %q, want %q", c.title, truncateRunes(c.desc, 20), got, c.want)
		}
	}
}

func TestCanonicalCategorySynonymsAndKeywords(t *testing.T) {
	warmLLMCooldown()
	cases := []struct {
		raw  string
		want string
	}{
		{"玄幻魔法", "玄幻奇幻"},    // L1
		{"重生", "都市言情"},      // Task 28-b 新增 L1
		{"總裁", "都市言情"},      // Task 28-b 新增繁体 L1
		{"官場", "都市言情"},      // Task 28-b 新增繁体 L1
		{"星際", "科幻未来"},      // Task 28-b 新增繁体 L1
		{"歷史軍事", "历史军事"},    // 既有繁体直映回归
		{"n次元", "轻小说"},      // Task 27-b 回归
		{"其他", "其他"},        // 兜底类名直映
		{"", "其他"},          // 空 → 兜底（不触 LLM）
		{"科幻机甲文集", "科幻未来"},  // L2 关键词包含
		{"重生之都市仙尊", "都市言情"}, // L2 重生（简体）
	}
	for _, c := range cases {
		if got := canonicalCategory(c.raw); got != c.want {
			t.Errorf("canonicalCategory(%q) = %q, want %q", c.raw, got, c.want)
		}
	}
}

func TestNormalizeCategory(t *testing.T) {
	warmLLMCooldown()
	cases := []struct{ raw, want string }{
		{"N次元", "n次元"},        // 全角→半角+小写（Task 27-b 回归）
		{" 玄幻 · 奇幻 ", "玄幻奇幻"}, // 空白与分隔符剔除
		{"歷史軍事", "歷史軍事"},      // 繁体原样保留（由 L1 直映表消费）
	}
	for _, c := range cases {
		if got := normalizeCategory(c.raw); got != c.want {
			t.Errorf("normalizeCategory(%q) = %q, want %q", c.raw, got, c.want)
		}
	}
}
