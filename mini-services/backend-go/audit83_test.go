/**
 * audit83_test.go —— Task 83「检查下拉词获取 + 书籍页标签大多就 2 个」回归锁定：
 * 1) 引擎换血：supportedEngines 白名单不再含死端点 sogou，新增 google/qwant；
 * 2) suggestParseGoogle / suggestParseQwant 解析器（正常/畸形/status 非 success）；
 * 3) novelPseoTags ③ 衍生词兜底：无血缘词的书补齐至 8（空格分隔搜索长尾，
 *    词面分词 LIKE 必命中本书 → SSR 实时渲染零 404）；血缘词充足时兜底退场；
 * 4) enrichBookSeedBatch 批量路径：冷却种子跳过引擎（离线可测）、pending 词池照常消化、
 *    冷却种子保留 pending 等冷却后再富集。
 */
package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestSupportedEnginesNoSogou(t *testing.T) {
	for _, e := range supportedEngines {
		if e == "sogou" {
			t.Fatal("sogou 端点已死（sugproxy/suggnew 404），不应再出现在引擎白名单")
		}
	}
	has := func(want string) bool {
		for _, e := range supportedEngines {
			if e == want {
				return true
			}
		}
		return false
	}
	if !has("google") || !has("qwant") {
		t.Fatalf("引擎换血后应含 google/qwant，got %v", supportedEngines)
	}
}

func TestSuggestParseGoogle(t *testing.T) {
	// client=firefox 实测形态：["查询词",["词1","词2"],[],{"google:suggestsubtypes":[...]}]
	body := []byte(`["伏天氏",["伏天氏","伏天氏小说","伏天氏最新章节"],[],{"google:suggestsubtypes":[[512],[512],[512]]}]`)
	words := suggestParseGoogle(body)
	if len(words) != 3 || words[0] != "伏天氏" || words[2] != "伏天氏最新章节" {
		t.Fatalf("google 解析词错误: %v", words)
	}
	// 畸形：非 JSON / 元素缺失 / 第二元素非数组
	for _, bad := range []string{`not json`, `["只有查询词"]`, `["查询词","非数组"]`, `[]`} {
		if got := suggestParseGoogle([]byte(bad)); len(got) != 0 {
			t.Fatalf("畸形输入 %q 应返回空，got %v", bad, got)
		}
	}
	// 空字符串词条过滤
	words = suggestParseGoogle([]byte(`["q",["", "词", ""]]`))
	if len(words) != 1 || words[0] != "词" {
		t.Fatalf("空词条应被过滤: %v", words)
	}
}

func TestSuggestParseQwant(t *testing.T) {
	// v3 suggest 实测形态
	body := []byte(`{"status":"success","data":{"items":[{"value":"伏天氏txt下载","suggestType":0},{"value":"伏天氏笔趣阁","suggestType":0}]}}`)
	words := suggestParseQwant(body)
	if len(words) != 2 || words[0] != "伏天氏txt下载" || words[1] != "伏天氏笔趣阁" {
		t.Fatalf("qwant 解析词错误: %v", words)
	}
	// status 非 success 不硬失败，返回空
	if got := suggestParseQwant([]byte(`{"status":"error","data":{"items":[{"value":"x"}]}}`)); len(got) != 0 {
		t.Fatalf("status=error 应返回空，got %v", got)
	}
	// 畸形 JSON / value 缺失
	for _, bad := range []string{`not json`, `{"status":"success"}`, `{"status":"success","data":{"items":[{},{"value":""}]}}`} {
		if got := suggestParseQwant([]byte(bad)); len(got) != 0 {
			t.Fatalf("畸形输入 %q 应返回空，got %v", bad, got)
		}
	}
	// 合法 JSON 契约（空数组词条）
	var probe struct {
		Status string `json:"status"`
	}
	if json.Unmarshal([]byte(`{"status":"success"}`), &probe) != nil || probe.Status != "success" {
		t.Fatal("status 契约解析破坏")
	}
}

func TestNovelPseoTagsDerivedFallback(t *testing.T) {
	db, err := getDB()
	if err != nil {
		t.Fatalf("getDB: %v", err)
	}
	cleanup := func() { _, _ = db.Exec(`DELETE FROM "PseoKeyword"`) }
	cleanup()
	t.Cleanup(cleanup)

	// 场景一：零血缘词 + 佚名 —— 只有书名一个词，衍生词兜底必须补齐（空格分隔形态）
	tags := novelPseoTags("孤例之书", "佚名")
	if len(tags) < 6 {
		t.Fatalf("零血缘书标签应补齐至 ≥6，got %d: %v", len(tags), tags)
	}
	if tags[0] != "孤例之书" {
		t.Fatalf("首标签必须是书名，got %v", tags)
	}
	has := func(kw string) bool {
		for _, x := range tags {
			if x == kw {
				return true
			}
		}
		return false
	}
	for _, want := range []string{"孤例之书 小说", "孤例之书 全文阅读", "孤例之书 最新章节"} {
		if !has(want) {
			t.Errorf("衍生词兜底漏 %q，tags=%v", want, tags)
		}
	}
	for _, x := range tags {
		if strings.Contains(x, "佚名") {
			t.Errorf("佚名不应作为衍生词根，tags=%v", tags)
		}
	}
	// 空格分隔形态是零 404 契约的根基：归一形必须与「书名小说」等价（kwNorm 口径可被收录）
	if kwNormalize("孤例之书 小说") != kwNormalize("孤例之书小说") {
		t.Fatal("衍生词空格形态归一化破坏（空格剔除）")
	}

	// 场景二：有作者无血缘 —— 补齐至 8 且含作者衍生词
	tags = novelPseoTags("孤例之书", "作者甲")
	if len(tags) < 8 {
		t.Fatalf("书名+作者标签应补齐至 8，got %d: %v", len(tags), tags)
	}
	if tags[1] != "作者甲" {
		t.Fatalf("第二标签必须是作者词，got %v", tags)
	}
	has = func(kw string) bool {
		for _, x := range tags {
			if x == kw {
				return true
			}
		}
		return false
	}
	if !has("作者甲 小说") {
		t.Errorf("作者衍生词漏配，tags=%v", tags)
	}

	// 场景三：血缘词充足（12 个 generated）——真实下拉词占满，衍生词兜底退场
	entries := make([]kwEntry, 0, 12)
	for i := 0; i < 12; i++ {
		entries = append(entries, kwEntry{Word: "孤例之书" + strings.Repeat("尾", i+1), Engine: "baidu"})
	}
	if _, err := insertKeywords(entries, 50, "孤例之书"); err != nil {
		t.Fatalf("insertKeywords: %v", err)
	}
	if _, err := db.Exec(`UPDATE "PseoKeyword" SET "status" = 'generated' WHERE "seed" = '孤例之书'`); err != nil {
		t.Fatalf("set generated: %v", err)
	}
	tags = novelPseoTags("孤例之书", "作者甲")
	if len(tags) < 12 {
		t.Fatalf("血缘词应占满榜单，got %d: %v", len(tags), tags)
	}
	has = func(kw string) bool {
		for _, x := range tags {
			if x == kw {
				return true
			}
		}
		return false
	}
	for _, x := range tags {
		if x == "孤例之书 小说" || x == "作者甲 小说" {
			t.Errorf("血缘充足时衍生词应退场，tags=%v", tags)
		}
	}
}

func TestEnrichBatchCoolingSkipsEngine(t *testing.T) {
	db, err := getDB()
	if err != nil {
		t.Fatalf("getDB: %v", err)
	}
	cleanup := func() {
		_, _ = db.Exec(`DELETE FROM "PseoKeyword"`)
		_, _ = db.Exec(`DELETE FROM "AppMeta" WHERE "key" LIKE 'pseoEnrichRetry:%'`)
		_, _ = db.Exec(`DELETE FROM "Novel"`)
		_, _ = db.Exec(`DELETE FROM "Category"`)
	}
	cleanup()
	t.Cleanup(cleanup)

	if _, err := db.Exec(`INSERT INTO "Category" ("name") VALUES ('测试分类83')`); err != nil {
		t.Fatalf("seed category: %v", err)
	}
	var catID int64
	if err := db.QueryRow(`SELECT "id" FROM "Category" WHERE "name" = '测试分类83'`).Scan(&catID); err != nil {
		t.Fatalf("read category: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO "Novel" ("title","author","description","categoryId","status","createdAt","updatedAt") VALUES ('测试书83','作者83','测试书83简介内容',?,'serial',1,1)`,
		catID); err != nil {
		t.Fatalf("seed novel: %v", err)
	}
	// 两本 pending 书名种子（登记即 pending）+ 双双进入引擎全败冷却（有记账）
	enqueuePseoBookSeed("冷却书甲")
	enqueuePseoBookSeed("冷却书乙")
	setEnrichRetry("冷却书甲", 1, nowMillis())
	setEnrichRetry("冷却书乙", 1, nowMillis())
	// 词池 intro 词（pending）——冷却种子跳过引擎时必须照常消化
	if n := insertIntroKeywords("测试书83", []string{"测试书83相关推荐词"}); n != 1 {
		t.Fatalf("intro 入库数 = %d, want 1", n)
	}

	enrichOneBookSeed() // 批量路径：两种子均冷却 → 零引擎调用（离线确定性）→ 消化词池

	for _, kw := range []string{"冷却书甲", "冷却书乙"} {
		var st string
		if err := db.QueryRow(`SELECT "status" FROM "PseoKeyword" WHERE "keyword" = ?`, kw).Scan(&st); err != nil {
			t.Fatalf("read seed %s: %v", kw, err)
		}
		if st != "pending" {
			t.Fatalf("冷却种子 %s 应保留 pending 等冷却后再富集，got %q", kw, st)
		}
		if rn, _ := getEnrichRetry(kw); rn != 1 {
			t.Fatalf("冷却记账不应被冷却路径改写，%s rn=%d", kw, rn)
		}
	}
	var st string
	if err := db.QueryRow(`SELECT "status" FROM "PseoKeyword" WHERE "keyword" = '测试书83相关推荐词'`).Scan(&st); err != nil {
		t.Fatalf("read pool word: %v", err)
	}
	if st != "generated" {
		t.Fatalf("冷却跳过时 pending 词池未被消化，status = %q", st)
	}
}
