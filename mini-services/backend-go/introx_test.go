/**
 * introx_test.go —— Task 41 简介噪声清洗 + 「相关小说」长尾词 pSEO 转换回归锁定。
 * 用例取自全库实证噪声样本（书 35/37/41/46/57/61/67/83/150/158），逐家族覆盖：
 * 实体全角分号（用户贴文「[]」病灶）/HTML 标签/U+FFFD/分隔线推广块/书友群尾/
 * 整条元信息样板/相关小说尾块截断+提取；幂等契约 clean(clean(x))==clean(x)；
 * 提取词质量闸门与入库血缘（source='intro'、seed=书名）；存量回填幂等零写放大。
 */
package main

import (
	"database/sql"
	"strings"
	"testing"
)

func TestCleanNovelIntroNoiseFamilies(t *testing.T) {
	cases := []struct {
		name       string
		in         string
		want       string // 期望清洗后文本（"" 表示全清空）；wantWords 非空时仍须精确比对
		wantWords  []string
		wordsAtLei int // 提取词数下限（清单长度不定时用 0=不校验，>0 表示 >= 该数）
	}{
		{
			name:       "相关小说尾块_洗掉并提取（书35实证）",
			in:         "叶天深山采药，遭遇凶兽坠落悬崖。炼气，筑基，结丹，元婴，化神……。 相关小说：灵鼎奇缘凡人修仙传主角叶天、凡人修仙传灵草篇、凡人修仙传 灵婴、凡人修仙传虚灵鼎",
			want:       "叶天深山采药，遭遇凶兽坠落悬崖。炼气，筑基，结丹，元婴，化神……。",
			wordsAtLei: 3,
		},
		{
			name: "全角分号实体转换（书67/用户贴文[]病灶）",
			in:   "&#091；轻松军旅&#093；+&#091；军队为主&#093；+&#091；热血幽默&#093； 向前对着摄像机说",
			want: "[轻松军旅]+[军队为主]+[热血幽默] 向前对着摄像机说",
		},
		{
			name: "br标签转换行（书46实证）",
			in:   "老者：“你想报仇？”<br /> 少年：“我怎么不想报仇？”<br />老者微微一笑",
			want: "老者：“你想报仇？”\n少年：“我怎么不想报仇？”\n老者微微一笑",
		},
		{
			name: "分隔线后作者推广截断（书37/41实证）",
			in:   "“有我一日，人族不灭！” ------------------- 白驹易逝，其作品以玄幻、仙侠类题材为主，其代表作有我真的是正派",
			want: "“有我一日，人族不灭！”",
		},
		{
			name: "书友群推广尾截断（书57实证）",
			in:   "徒弟修炼我越强。你突破到了元婴期巅峰！【书友群：790924091欢迎各位书友加入",
			want: "徒弟修炼我越强。你突破到了元婴期巅峰！",
		},
		{
			name: "整条元信息样板全清空（书150实证）",
			in:   "每日一卦，从坊市散修到长生仙尊免费在线阅读，作者：北境南风，分类：其他，状态：连载中，字数：321.55万字，章节：668章。",
			want: "",
		},
		{
			name:       "FFFD乱码+状态残臂+相关块（书61实证）",
			in:         "�已完结】 十七岁那年，他站上河岸，前路尽毁。 相关小说：南城小巷时玖远的小说、南城小巷全文免费阅读、南城小巷小说",
			want:       "十七岁那年，他站上河岸，前路尽毁。",
			wordsAtLei: 2,
		},
		{
			name:      "相关块后再拼书友群尾_清单不含推广项",
			in:        "问剑天下英雄! 相关小说：道岳独尊修炼体系详解、道岳独尊百度百科、书友群：123456、道岳独尊下载",
			want:      "问剑天下英雄!",
			wantWords: []string{"道岳独尊修炼体系详解", "道岳独尊百度百科", "道岳独尊下载"},
		},
		{
			name: "干净叙事简介零改动零提取（书34形态）",
			in:   "江宁穿越而来，时逢天下将乱。为求保全自身，他凭借能肝经验的面板开始练武，默默发育。",
			want: "江宁穿越而来，时逢天下将乱。为求保全自身，他凭借能肝经验的面板开始练武，默默发育。",
		},
		{
			name: "叙事中不带冒号的「类似小说」不误伤",
			in:   "他看过很多类似小说，却从没想过自己会穿越。",
			want: "他看过很多类似小说，却从没想过自己会穿越。",
		},
		{
			name: "转码问号装饰_串首与段首（书1实证）",
			in:   "??本文只有三个世界。（慢穿，超慢。）?世界一:我在现代用歌曲文学养鱼塘（已完结65万字。）?二我在古代用诗词歌赋养鱼塘",
			want: "本文只有三个世界。（慢穿，超慢。）世界一:我在现代用歌曲文学养鱼塘（已完结65万字。）二我在古代用诗词歌赋养鱼塘",
		},
		{
			name: "语气问号不误伤（句中叠用/?!连用/双问尾）",
			in:   "什么？？？你确定？！真的吗??我不信。你说呢？",
			want: "什么？？？你确定？！真的吗??我不信。你说呢？",
		},
		{
			name: "超长问号串剥除（4+必为转码噪声）",
			in:   "本文第六章??????分割线",
			want: "本文第六章分割线",
		},
		{
			name: "多行简介行首问号装饰剥除",
			in:   "第一段叙事。\n?第二段带装饰\n第三段叙事。",
			want: "第一段叙事。\n第二段带装饰\n第三段叙事。",
		},
		{
			name: "多行简介行归一（去空行与纯分隔线行）",
			in:   "第一段叙事。\n\n————————\n\n第二段叙事。",
			want: "第一段叙事。\n第二段叙事。",
		},
		{
			name: "空串与纯空白",
			in:   "   ",
			want: "",
		},
	}
	for _, c := range cases {
		got, words := cleanNovelIntro(c.in)
		if got != c.want {
			t.Errorf("%s: clean = %q, want %q", c.name, got, c.want)
		}
		if c.wantWords != nil {
			if strings.Join(words, "|") != strings.Join(c.wantWords, "|") {
				t.Errorf("%s: words = %v, want %v", c.name, words, c.wantWords)
			}
		} else if c.wordsAtLei > 0 {
			if len(words) < c.wordsAtLei {
				t.Errorf("%s: 提取词数 %d < 下限 %d，words=%v", c.name, len(words), c.wordsAtLei, words)
			}
		} else if len(words) != 0 {
			t.Errorf("%s: 不应提取词，got %v", c.name, words)
		}
		// 幂等契约：clean(clean(x)) == clean(x) 且二次提取为空
		got2, words2 := cleanNovelIntro(got)
		if got2 != got {
			t.Errorf("%s: 幂等破坏，二次 clean = %q, 一次 = %q", c.name, got2, got)
		}
		if len(words2) != 0 {
			t.Errorf("%s: 二次清洗不应再提取词，got %v", c.name, words2)
		}
	}
}

func TestExtractIntroWordsGates(t *testing.T) {
	tail := "、https://www.example.com/book、12345、玄鉴仙族下载、玄鉴仙族下载、a、玄鉴仙族番外、玄鉴仙族李周巍番外篇超长词超长词超长词超长词超长词超长词超长词、玄鉴仙族 灵婴"
	words := extractIntroWords(tail)
	joined := strings.Join(words, "|")
	if !strings.Contains(joined, "玄鉴仙族下载") {
		t.Errorf("合法词丢失: %v", words)
	}
	if !strings.Contains(joined, "玄鉴仙族 灵婴") {
		t.Errorf("条目内部空格应保留（下拉词原形）: %v", words)
	}
	for _, bad := range []string{"http", "12345", "书友群"} {
		if strings.Contains(joined, bad) {
			t.Errorf("垃圾/推广项混入: %v", words)
		}
	}
	// 归一去重：「玄鉴仙族下载」出现两次只留一个
	count := strings.Count(joined, "玄鉴仙族下载")
	if count != 1 {
		t.Errorf("去重失败，出现 %d 次: %v", count, words)
	}
	// 长度上限：超长词被拒（30 rune 上限，末尾 7 组「超长词」= 31 rune）
	if len(words) != 3 {
		t.Errorf("提取词数 = %d, want 3: %v", len(words), words)
	}
}

func TestInsertIntroKeywords(t *testing.T) {
	db, err := getDB()
	if err != nil {
		t.Fatalf("getDB: %v", err)
	}
	cleanup := func() { _, _ = db.Exec(`DELETE FROM "PseoKeyword"`) }
	cleanup()
	t.Cleanup(cleanup)

	title := "测试相关书"
	added := insertIntroKeywords(title, []string{"测试相关书主角是谁", "测试相关书 txt下载", "", "测试相关书主角是谁"})
	if added != 2 {
		t.Fatalf("added = %d, want 2", added)
	}
	var source, seed, status string
	if err := db.QueryRow(
		`SELECT "source","seed","status" FROM "PseoKeyword" WHERE "keyword" = '测试相关书主角是谁'`,
	).Scan(&source, &seed, &status); err != nil {
		t.Fatalf("read keyword: %v", err)
	}
	if source != "intro" || seed != title || status != "pending" {
		t.Fatalf("血缘字段错误 source=%q seed=%q status=%q", source, seed, status)
	}
	// 幂等：重复入库零新增（唯一约束兜底）
	if again := insertIntroKeywords(title, []string{"测试相关书主角是谁"}); again != 0 {
		t.Fatalf("重复入库 added = %d, want 0", again)
	}
}

func TestBackfillNovelIntroClean(t *testing.T) {
	db, err := getDB()
	if err != nil {
		t.Fatalf("getDB: %v", err)
	}
	cleanup := func() {
		_, _ = db.Exec(`DELETE FROM "Novel"`)
		_, _ = db.Exec(`DELETE FROM "Category"`)
		_, _ = db.Exec(`DELETE FROM "PseoKeyword"`)
	}
	cleanup()
	t.Cleanup(cleanup)

	if _, err := db.Exec(`INSERT INTO "Category" ("name") VALUES ('测试分类')`); err != nil {
		t.Fatalf("seed category: %v", err)
	}
	var catID int64
	if err := db.QueryRow(`SELECT "id" FROM "Category" WHERE "name" = '测试分类'`).Scan(&catID); err != nil {
		t.Fatalf("read category: %v", err)
	}
	noisy := "夜林拿到了阿拉德大陆的天之印。 相关小说：阿拉德的不正经救世主txt、阿拉德不正经救世主小说、阿拉德救世主结局"
	if _, err := db.Exec(
		`INSERT INTO "Novel" ("title","author","description","categoryId","status","createdAt","updatedAt") VALUES ('测试噪声书','测试作者',?,?, 'serial',1,1)`,
		noisy, catID); err != nil {
		t.Fatalf("seed novel: %v", err)
	}
	cleanDesc := "夜林拿到了阿拉德大陆的天之印。"
	if _, err := db.Exec(
		`INSERT INTO "Novel" ("title","author","description","categoryId","status","createdAt","updatedAt") VALUES ('测试干净书','测试作者',?,?, 'serial',1,1)`,
		cleanDesc, catID); err != nil {
		t.Fatalf("seed clean novel: %v", err)
	}

	if err := backfillNovelIntroClean(db); err != nil {
		t.Fatalf("backfill: %v", err)
	}
	var got string
	if err := db.QueryRow(`SELECT "description" FROM "Novel" WHERE "title" = '测试噪声书'`).Scan(&got); err != nil {
		t.Fatalf("read novel: %v", err)
	}
	if got != cleanDesc {
		t.Fatalf("噪声书简介未清洗: %q", got)
	}
	// 提取词已入库且血缘指向本书
	var cnt int
	if err := db.QueryRow(`SELECT COUNT(*) FROM "PseoKeyword" WHERE "seed" = '测试噪声书' AND "source" = 'intro'`).Scan(&cnt); err != nil {
		t.Fatalf("count keywords: %v", err)
	}
	if cnt != 3 {
		t.Fatalf("提取词数 = %d, want 3", cnt)
	}
	// 幂等：第二遍零新增零改写（干净行 cleanNovelIntro 原样返回）
	if err := backfillNovelIntroClean(db); err != nil {
		t.Fatalf("backfill idempotent: %v", err)
	}
	var cnt2 int
	if err := db.QueryRow(`SELECT COUNT(*) FROM "PseoKeyword" WHERE "seed" = '测试噪声书' AND "source" = 'intro'`).Scan(&cnt2); err != nil {
		t.Fatalf("count keywords 2: %v", err)
	}
	if cnt2 != 3 {
		t.Fatalf("幂等破坏，提取词数变为 %d", cnt2)
	}
}

// TestEnrichDrainsPendingWithoutBookSeed 锁定 Task 41 兜底路径：无 pending 书名种子时
// （存量书种子均已 generated 的常态），enrichOneBookSeed 仍消化 pending 词池——
// 否则简介提取词滞留 pending，书籍页虽可实时兜底但聚合页 TDK 永不生成。
func TestEnrichDrainsPendingWithoutBookSeed(t *testing.T) {
	db, err := getDB()
	if err != nil {
		t.Fatalf("getDB: %v", err)
	}
	cleanup := func() {
		_, _ = db.Exec(`DELETE FROM "PseoKeyword"`)
		_, _ = db.Exec(`DELETE FROM "Novel"`)
		_, _ = db.Exec(`DELETE FROM "Category"`)
	}
	cleanup()
	t.Cleanup(cleanup)

	if _, err := db.Exec(`INSERT INTO "Category" ("name") VALUES ('测试分类2')`); err != nil {
		t.Fatalf("seed category: %v", err)
	}
	var catID int64
	if err := db.QueryRow(`SELECT "id" FROM "Category" WHERE "name" = '测试分类2'`).Scan(&catID); err != nil {
		t.Fatalf("read category: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO "Novel" ("title","author","description","categoryId","status","createdAt","updatedAt") VALUES ('测试书X','作者甲','测试书X简介内容',?,'serial',1,1)`,
		catID); err != nil {
		t.Fatalf("seed novel: %v", err)
	}
	// intro 词入库（pending），且词池中无 pending 书名种子
	if n := insertIntroKeywords("测试书X", []string{"测试书X相关推荐词"}); n != 1 {
		t.Fatalf("intro 入库数 = %d, want 1", n)
	}
	enrichOneBookSeed()
	var st string
	if err := db.QueryRow(`SELECT "status" FROM "PseoKeyword" WHERE "keyword" = '测试书X相关推荐词'`).Scan(&st); err != nil {
		t.Fatalf("read status: %v", err)
	}
	if st != "generated" {
		t.Fatalf("无书名种子时 pending 词未被消化，status = %q", st)
	}
	// 聚合页 TDK 已生成（pageData 非空）
	var pd sql.NullString
	if err := db.QueryRow(`SELECT "pageData" FROM "PseoKeyword" WHERE "keyword" = '测试书X相关推荐词'`).Scan(&pd); err != nil {
		t.Fatalf("read pageData: %v", err)
	}
	if !pd.Valid || pd.String == "" {
		t.Fatalf("generated 词的 pageData 为空")
	}
}
