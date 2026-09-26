/**
 * pseo_tags_test.go —— Task 40 书籍页「相关标签」pseo 下拉词取词回归锁定：
 * 1) kwNormalize 归一形向量：全半角折叠（全角？书名 vs 半角?下拉词）、空白剔除、大小写；
 * 2) novelPseoTags 双通道取词：seed 血缘直取（含不含书名字面的相关词）+
 *    kwNorm 归一形 LIKE 兜底（seed 列引入前的存量词、无血缘跨引擎词）；
 * 3) backfillPseoKeywordNorm 存量回填幂等。
 */
package main

import (
	"testing"
)

func TestKwNormalizeVectors(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		// 核心病灶：全角？书名 与 半角?下拉词 归一后必须一致（书 293 实证漏配形态）
		{"我的职业面板怎么是二次元画风？", "我的职业面板怎么是二次元画风?"},
		{"我的职业面板怎么是二次元画风?", "我的职业面板怎么是二次元画风?"},
		// 空白形态差异：「捡个总裁老婆 小说」与「捡个总裁老婆小说」必须一致
		{"捡个总裁老婆 小说", "捡个总裁老婆小说"},
		{"捡个　总裁老婆　小说", "捡个总裁老婆小说"},
		// 大小写与全角字母数字折叠
		{"ABC def", "abcdef"},
		{"ＡＢＣ１２３", "abc123"},
		// 全角标点族：：！，：（）
		{"书名：续！卷，二（完）", "书名:续!卷,二(完)"},
		// 空串与纯空白
		{"", ""},
		{"  \t\n　", ""},
	}
	for _, c := range cases {
		if got := kwNormalize(c.in); got != c.want {
			t.Errorf("kwNormalize(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	// 归一等价性：核心病灶对（全角？/半角?）归一形必须相等
	if kwNormalize("画风？") != kwNormalize("画风?") {
		t.Error("全角？与半角?归一形不相等（回归病灶）")
	}
	if kwNormalize("老婆 小说") != kwNormalize("老婆小说") {
		t.Error("含空格与无空格归一形不相等（回归病灶）")
	}
}

func TestNovelPseoTagsSeedAndNorm(t *testing.T) {
	db, err := getDB()
	if err != nil {
		t.Fatalf("getDB: %v", err)
	}
	cleanup := func() { _, _ = db.Exec(`DELETE FROM "PseoKeyword"`) }
	cleanup()
	t.Cleanup(cleanup)

	// 书名带全角？（复刻书 293 病灶形态），下拉词为半角?变体 + 不含书名的相关词 + 存量无血缘词
	title := "测试之书？"
	entries := []kwEntry{
		{Word: "测试之书?笔趣阁", Engine: "baidu"},    // seed 血缘 + 含归一书名
		{Word: "测试之书?TXT下载", Engine: "bing"},   // seed 血缘 + 含归一书名
		{Word: "类似测试之书的小说推荐", Engine: "so360"}, // seed 血缘但词面不含书名（血缘直取的价值面）
		{Word: "测试之书?免费阅读", Engine: "sogou"},   // 无血缘（seed=''）存量词形态，靠 kwNorm 兜底
	}
	if _, err := insertKeywords(entries, 50, title); err != nil {
		t.Fatalf("insertKeywords: %v", err)
	}
	// 存量词模拟：seed 列引入前的行（kwNorm 已回填、seed=''）
	if _, err := db.Exec(
		`INSERT INTO "PseoKeyword" ("keyword","source","status","createdAt","updatedAt","kwNorm","seed") VALUES ('测试之书?最新章节','duckduckgo','generated',1,1,?, '')`,
		kwNormalize("测试之书?最新章节")); err != nil {
		t.Fatalf("insert legacy row: %v", err)
	}
	// 未生成词（pending）：血缘直取通道允许上榜（聚合页实时计算兜底），但排在 generated 之后
	if _, err := db.Exec(
		`UPDATE "PseoKeyword" SET "status" = 'pending' WHERE "keyword" = '测试之书?TXT下载'`); err != nil {
		t.Fatalf("set pending: %v", err)
	}
	// 干扰词：他人书籍的血缘词 + 不含书名的无血缘词，均不得上榜
	if _, err := insertKeywords([]kwEntry{{Word: "别的书?笔趣阁", Engine: "baidu"}}, 50, "别的书"); err != nil {
		t.Fatalf("insert other book: %v", err)
	}
	if _, err := db.Exec(
		`UPDATE "PseoKeyword" SET "status" = 'generated' WHERE "keyword" != '测试之书?TXT下载'`); err != nil {
		t.Fatalf("set generated: %v", err)
	}

	tags := novelPseoTags(title, "佚名")
	if len(tags) == 0 || tags[0] != title {
		t.Fatalf("首标签必须是书名种子词，got %v", tags)
	}
	has := func(kw string) bool {
		for _, x := range tags {
			if x == kw {
				return true
			}
		}
		return false
	}
	// ① 血缘直取：含书名变体与不含书名字面的相关词都必须上榜
	for _, kw := range []string{"测试之书?笔趣阁", "类似测试之书的小说推荐", "测试之书?TXT下载"} {
		if !has(kw) {
			t.Errorf("血缘/归一通道漏词 %q，tags=%v", kw, tags)
		}
	}
	// ② kwNorm 兜底：无血缘存量词（半角?变体）必须上榜
	if !has("测试之书?免费阅读") || !has("测试之书?最新章节") {
		t.Errorf("kwNorm 兜底漏存量词，tags=%v", tags)
	}
	// ③ 干扰词不得上榜
	if has("别的书?笔趣阁") {
		t.Errorf("他人书籍血缘词误上榜，tags=%v", tags)
	}
	// ④ 作者词第二位
	tags2 := novelPseoTags(title, "作者甲")
	if len(tags2) < 2 || tags2[1] != "作者甲" {
		t.Errorf("第二标签必须是作者词，got %v", tags2)
	}
	// ⑤ pending 词排在 generated 血缘词之后（generated 优先序）
	idxOf := func(kw string) int {
		for i, x := range tags {
			if x == kw {
				return i
			}
		}
		return -1
	}
	if p, g := idxOf("测试之书?TXT下载"), idxOf("测试之书?笔趣阁"); p >= 0 && g >= 0 && p < g {
		t.Errorf("pending 词(%d) 不应排在 generated 词(%d) 之前，tags=%v", p, g, tags)
	}
}

func TestBackfillPseoKeywordNorm(t *testing.T) {
	db, err := getDB()
	if err != nil {
		t.Fatalf("getDB: %v", err)
	}
	cleanup := func() { _, _ = db.Exec(`DELETE FROM "PseoKeyword"`) }
	cleanup()
	t.Cleanup(cleanup)

	if _, err := db.Exec(
		`INSERT INTO "PseoKeyword" ("keyword","source","status","createdAt","updatedAt","kwNorm") VALUES ('测试之书?笔趣阁','baidu','generated',1,1, '')`); err != nil {
		t.Fatalf("insert unbackfilled row: %v", err)
	}
	if err := backfillPseoKeywordNorm(db); err != nil {
		t.Fatalf("backfill: %v", err)
	}
	var norm string
	if err := db.QueryRow(`SELECT "kwNorm" FROM "PseoKeyword" WHERE "keyword" = '测试之书?笔趣阁'`).Scan(&norm); err != nil {
		t.Fatalf("read kwNorm: %v", err)
	}
	if norm != kwNormalize("测试之书?笔趣阁") || norm == "" {
		t.Fatalf("回填结果错误 kwNorm=%q", norm)
	}
	// 幂等：第二遍零错误（全表已回填，零扫描零写入）
	if err := backfillPseoKeywordNorm(db); err != nil {
		t.Fatalf("backfill idempotent: %v", err)
	}
}
