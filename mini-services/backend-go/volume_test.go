/**
 * volume_test.go —— Task 45-b 分卷功能闭环回归锁定（先红后绿）：
 * 1) detectVolume 契约：前缀识别/纯卷标题行保留原标题/非前缀形态（卷轴、画卷、「第X卷尾」
 *    无分隔符）不误伤；剥前缀后二次识别不再命中（幂等契约）；
 * 2) backfillChapterVolume 存量回填：volume+title 双写、纯卷行只记卷名、子串形态跳过、
 *    幂等（只扫 volume='' 行，二次运行零改写、不二次剥前缀）；
 * 3) 采集入库接线：storeChapterSkeletons 批量路径 volume 随行 + fillRows 携带归一标题
 *    （Phase 2 按标题匹配空骨架的续传契约）；归一后标题与既有空骨架续传命中不重复建行；
 *    storeChapter 直连路径 row.Volume 显式优先 / 留空兜底 detectVolume；
 * 4) TOC 分组 groupChaptersByVolume：组序=卷名首现顺序、无卷书返回空切片（模板平铺回退）、
 *    有卷书无卷章节单列「未分卷」组；
 * 5) GET /api/chapters/volumes 只读端点（admin 章节工具面板数据源）。
 * 复用 recover_test.go 的 TestMain 临时库（绝不触碰生产库）。
 */
package main

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDetectVolumeContract(t *testing.T) {
	cases := []struct {
		in   string
		vol  string
		rest string
		note string
	}{
		{"第一卷 第1章 宝宝满月", "第一卷", "第1章 宝宝满月", "空格分隔卷前缀"},
		{"第六卷·嬗变者", "第六卷", "嬗变者", "带卷名的卷头行：rest 作标题（detectVolume 既有契约，不丢行）"},
		{"第3卷：风起", "第3卷", "风起", "全角冒号分隔"},
		{"第12卷_终局", "第12卷", "终局", "下划线分隔"},
		{"第1章 卷轴", "", "第1章 卷轴", "章题含卷字不误伤"},
		{"第七章 画卷", "", "第七章 画卷", "章题含画卷不误伤"},
		{"第二卷尾", "", "第二卷尾", "无分隔符（卷尾/结语类）不命中，保守不误伤"},
		{"第三卷结语", "", "第三卷结语", "无分隔符不命中"},
		{"卷土重来", "", "卷土重来", "非第X卷形态"},
	}
	for _, c := range cases {
		vol, rest := detectVolume(c.in)
		if vol != c.vol || rest != c.rest {
			t.Fatalf("detectVolume(%q) = (%q,%q), want (%q,%q) —— %s", c.in, vol, rest, c.vol, c.rest, c.note)
		}
		// 幂等契约：剥前缀后的标题二次识别不再命中（rest 为纯卷行时标题未动，仍命中原卷名，
		// 属 detectVolume 保留语义；非纯卷行必须不再命中）
		if rest != c.in {
			if vol2, rest2 := detectVolume(rest); vol2 != "" || rest2 != rest {
				t.Fatalf("detectVolume 幂等破坏：%q 二次识别 = (%q,%q)", rest, vol2, rest2)
			}
		}
	}
}

func TestBackfillChapterVolume(t *testing.T) {
	db, err := getDB()
	if err != nil {
		t.Fatalf("getDB: %v", err)
	}
	cleanup := func() {
		_, _ = db.Exec(`DELETE FROM "Chapter"`)
		_, _ = db.Exec(`DELETE FROM "Novel"`)
		_, _ = db.Exec(`DELETE FROM "Category"`)
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
	res, err := db.Exec(`INSERT INTO "Novel" ("title","author","categoryId","createdAt","updatedAt") VALUES ('测试分卷书','作者',?,?,?)`, catID, 1, 1)
	if err != nil {
		t.Fatalf("seed novel: %v", err)
	}
	nid, _ := res.LastInsertId()

	rows := []struct {
		idx   int64
		title string
	}{
		{1, "第一卷 第1章 宝宝满月"},
		{2, "第一卷 第2章 疑云"},
		{3, "第二卷·风起"}, // 卷头行：rest 作标题（卷名不丢行）
		{4, "第1章 卷轴"}, // 子串形态：不动
		{5, "第二卷尾"},   // 无分隔符：不动
		{6, "普通章节标题"}, // 常规行：不动
	}
	for _, r := range rows {
		if _, err := db.Exec(`INSERT INTO "Chapter" ("novelId","idx","title","createdAt") VALUES (?,?,?,?)`,
			nid, r.idx, r.title, 1); err != nil {
			t.Fatalf("seed chapter idx=%d: %v", r.idx, err)
		}
	}

	if err := backfillChapterVolume(db); err != nil {
		t.Fatalf("backfill: %v", err)
	}
	type got struct {
		title  string
		volume string
	}
	want := map[int64]got{
		1: {"第1章 宝宝满月", "第一卷"},
		2: {"第2章 疑云", "第一卷"},
		3: {"风起", "第二卷"}, // 卷头行：只记卷名，标题为 rest
		4: {"第1章 卷轴", ""},
		5: {"第二卷尾", ""},
		6: {"普通章节标题", ""},
	}
	for idx, w := range want {
		var g got
		if err := db.QueryRow(`SELECT "title","volume" FROM "Chapter" WHERE "novelId" = ? AND "idx" = ?`, nid, idx).Scan(&g.title, &g.volume); err != nil {
			t.Fatalf("read chapter idx=%d: %v", idx, err)
		}
		if g != w {
			t.Fatalf("chapter idx=%d = %+v, want %+v", idx, g, w)
		}
	}

	// 幂等：改写一行 volume 制造「已处理」标记外的重扫场景，二次回填必须零改写
	//（含把第一行标题还原成旧前缀形态——已回填行 volume≠''，绝不允许二次剥前缀）
	if _, err := db.Exec(`UPDATE "Chapter" SET "title" = '第一卷 第1章 宝宝满月', "volume" = '第一卷' WHERE "novelId" = ? AND "idx" = 1`, nid); err != nil {
		t.Fatalf("reset row: %v", err)
	}
	if err := backfillChapterVolume(db); err != nil {
		t.Fatalf("backfill idempotent: %v", err)
	}
	var g got
	if err := db.QueryRow(`SELECT "title","volume" FROM "Chapter" WHERE "novelId" = ? AND "idx" = 1`, nid).Scan(&g.title, &g.volume); err != nil {
		t.Fatalf("re-read chapter: %v", err)
	}
	if g.title != "第一卷 第1章 宝宝满月" || g.volume != "第一卷" {
		t.Fatalf("幂等破坏：已回填行被二次触碰 %+v", g)
	}
}

// seedVolumeNovel 测试助手：建书 + 插入章节（title/volume 直写）
func seedVolumeNovel(t *testing.T, chapters []struct {
	idx   int64
	title string
	vol   string
}) int64 {
	t.Helper()
	db, err := getDB()
	if err != nil {
		t.Fatalf("getDB: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO "Category" ("name") VALUES ('测试分类')`); err != nil {
		t.Logf("seed category (可能已存在): %v", err)
	}
	var catID int64
	if err := db.QueryRow(`SELECT "id" FROM "Category" WHERE "name" = '测试分类'`).Scan(&catID); err != nil {
		t.Fatalf("read category: %v", err)
	}
	res, err := db.Exec(`INSERT INTO "Novel" ("title","author","categoryId","createdAt","updatedAt") VALUES (?,?,?,?,?)`,
		"测试分卷书-"+t.Name(), "作者", catID, 1, 1)
	if err != nil {
		t.Fatalf("seed novel: %v", err)
	}
	nid, _ := res.LastInsertId()
	for _, c := range chapters {
		if _, err := db.Exec(`INSERT INTO "Chapter" ("novelId","idx","title","volume","createdAt") VALUES (?,?,?,?,?)`,
			nid, c.idx, c.title, c.vol, 1); err != nil {
			t.Fatalf("seed chapter idx=%d: %v", c.idx, err)
		}
	}
	return nid
}

func TestSkeletonVolumeWiring(t *testing.T) {
	db, err := getDB()
	if err != nil {
		t.Fatalf("getDB: %v", err)
	}
	cleanup := func() {
		_, _ = db.Exec(`DELETE FROM "Chapter"`)
		_, _ = db.Exec(`DELETE FROM "Novel"`)
		_, _ = db.Exec(`DELETE FROM "Category"`)
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
	res, err := db.Exec(`INSERT INTO "Novel" ("title","author","categoryId","createdAt","updatedAt") VALUES ('测试骨架分卷书','作者',?,?,?)`, catID, 1, 1)
	if err != nil {
		t.Fatalf("seed novel: %v", err)
	}
	nid64, _ := res.LastInsertId()
	run := NewRun(0)

	refs := []refPair{
		{Title: "第一卷 第1章 宝宝满月", URL: "https://t.example/1"},
		{Title: "第一卷 第2章 疑云", URL: "https://t.example/2"},
		{Title: "第二卷·风起", URL: "https://t.example/3"},
		{Title: "第3章 无卷章节", URL: "https://t.example/4"},
	}
	sk, err := storeChapterSkeletons(run, int(nid64), refs, 100)
	if err != nil {
		t.Fatalf("storeChapterSkeletons: %v", err)
	}
	if sk.Stored != 4 {
		t.Fatalf("Stored = %d, want 4", sk.Stored)
	}
	// DB 行 volume/标题断言 + fillRows 携带归一标题（Phase 2 续传匹配契约）
	type row struct {
		title  string
		volume string
	}
	gotRows := map[string]row{}
	if err := queryList(`SELECT "title","volume" FROM "Chapter" WHERE "novelId" = ?`, func(rs *sql.Rows) error {
		var r row
		if err := rs.Scan(&r.title, &r.volume); err != nil {
			return err
		}
		gotRows[r.title] = r
		return nil
	}, nid64); err != nil {
		t.Fatalf("query chapters: %v", err)
	}
	wantRows := map[string]row{
		"第1章 宝宝满月": {"第1章 宝宝满月", "第一卷"},
		"第2章 疑云":   {"第2章 疑云", "第一卷"},
		"风起":       {"风起", "第二卷"},
		"第3章 无卷章节": {"第3章 无卷章节", ""},
	}
	if len(gotRows) != len(wantRows) {
		t.Fatalf("DB 行数 = %d, want %d（%v）", len(gotRows), len(wantRows), gotRows)
	}
	for title, w := range wantRows {
		g, ok := gotRows[title]
		if !ok {
			t.Fatalf("缺 DB 行 %q（实得 %v）", title, gotRows)
		}
		if g != w {
			t.Fatalf("DB 行 %q = %+v, want %+v", title, g, w)
		}
	}
	fillTitles := map[string]bool{}
	for _, fr := range sk.FillRows {
		fillTitles[fr.Title] = true
	}
	for title := range wantRows {
		if !fillTitles[title] {
			t.Fatalf("fillRows 缺归一标题 %q（Phase 2 续传将 miss）: %v", title, sk.FillRows)
		}
	}

	// 续传命中：重发同一批 refs（标题已归一）+ 既有空骨架（wordCount=0）→ 不重复建行
	sk2, err := storeChapterSkeletons(run, int(nid64), refs, 100)
	if err != nil {
		t.Fatalf("storeChapterSkeletons resume: %v", err)
	}
	if sk2.Stored != 0 {
		t.Fatalf("续传重发 Stored = %d, want 0（空骨架应走 resume 而非重建）", sk2.Stored)
	}
	var cnt int
	if err := db.QueryRow(`SELECT COUNT(*) FROM "Chapter" WHERE "novelId" = ?`, nid64).Scan(&cnt); err != nil {
		t.Fatalf("count: %v", err)
	}
	if cnt != 4 {
		t.Fatalf("续传后行数 = %d, want 4（重复建骨架行）", cnt)
	}
}

func TestStoreChapterVolumeDirect(t *testing.T) {
	db, err := getDB()
	if err != nil {
		t.Fatalf("getDB: %v", err)
	}
	cleanup := func() {
		_, _ = db.Exec(`DELETE FROM "Chapter"`)
		_, _ = db.Exec(`DELETE FROM "Novel"`)
		_, _ = db.Exec(`DELETE FROM "Category"`)
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
	res, err := db.Exec(`INSERT INTO "Novel" ("title","author","categoryId","createdAt","updatedAt") VALUES ('测试直连分卷书','作者',?,?,?)`, catID, 1, 1)
	if err != nil {
		t.Fatalf("seed novel: %v", err)
	}
	nid64, _ := res.LastInsertId()
	run := NewRun(0)

	// ① row.Volume 显式传入（调用方已识别）→ 优先采用，标题不再剥
	id1, ok1, msg1 := storeChapter(run, int(nid64), 1, ChapterRow{Title: "第9章 显式卷", Volume: "第三卷", WordCount: 0})
	if !ok1 {
		t.Fatalf("storeChapter 显式卷失败: %s", msg1)
	}
	_ = id1
	var g1 row2
	if err := db.QueryRow(`SELECT "title","volume" FROM "Chapter" WHERE "novelId" = ? AND "idx" = ?`, nid64, id1).Scan(&g1.title, &g1.volume); err != nil {
		t.Fatalf("read row1: %v", err)
	}
	if g1.title != "第9章 显式卷" || g1.volume != "第三卷" {
		t.Fatalf("显式卷行 = %+v, want {第9章 显式卷 第三卷}", g1)
	}
	// ② row.Volume 留空 → 标题兜底识别
	id2, ok2, msg2 := storeChapter(run, int(nid64), 2, ChapterRow{Title: "第五卷·终章", WordCount: 0})
	if !ok2 {
		t.Fatalf("storeChapter 兜底识别失败: %s", msg2)
	}
	_ = id2
	var g2 row2
	if err := db.QueryRow(`SELECT "title","volume" FROM "Chapter" WHERE "novelId" = ? AND "idx" = ?`, nid64, id2).Scan(&g2.title, &g2.volume); err != nil {
		t.Fatalf("read row2: %v", err)
	}
	if g2.title != "终章" || g2.volume != "第五卷" {
		t.Fatalf("兜底识别行 = %+v, want {终章 第五卷}（卷头行 rest 作标题）", g2)
	}
	// ③ 常规标题零影响
	id3, ok3, msg3 := storeChapter(run, int(nid64), 3, ChapterRow{Title: "第1章 普通", WordCount: 0})
	if !ok3 {
		t.Fatalf("storeChapter 普通行失败: %s", msg3)
	}
	_ = id3
	var g3 row2
	if err := db.QueryRow(`SELECT "title","volume" FROM "Chapter" WHERE "novelId" = ? AND "idx" = ?`, nid64, id3).Scan(&g3.title, &g3.volume); err != nil {
		t.Fatalf("read row3: %v", err)
	}
	if g3.title != "第1章 普通" || g3.volume != "" {
		t.Fatalf("普通行 = %+v, want {第1章 普通 }", g3)
	}
}

// row2 title/volume 二元组（测试内轻量载体）
type row2 struct {
	title  string
	volume string
}

func TestGroupChaptersByVolume(t *testing.T) {
	ch := func(id int64, title, vol string) map[string]any {
		return map[string]any{"id": id, "idx": id, "title": title, "volume": vol}
	}
	// 无卷书 → 空切片（模板平铺回退）
	flat := []map[string]any{ch(1, "第1章", ""), ch(2, "第2章", "")}
	if vols := groupChaptersByVolume(flat); len(vols) != 0 {
		t.Fatalf("无卷书 Volumes = %v, want 空", vols)
	}
	// 有卷书：组序=卷名首现顺序；无卷章节单列「未分卷」（name=""）
	mixed := []map[string]any{
		ch(1, "序章", ""), ch(2, "第1章", "第一卷"), ch(3, "第2章", "第一卷"),
		ch(4, "番外", ""), ch(5, "第3章", "第二卷"),
	}
	vols := groupChaptersByVolume(mixed)
	if len(vols) != 4 {
		t.Fatalf("Volumes 组数 = %d, want 4: %v", len(vols), vols)
	}
	type g struct {
		name string
		ids  []int64
	}
	var groups []g
	for _, v := range vols {
		name, _ := v["name"].(string)
		chs, _ := v["chapters"].([]map[string]any)
		var ids []int64
		for _, c := range chs {
			id, _ := c["id"].(int64)
			ids = append(ids, id)
		}
		groups = append(groups, g{name: name, ids: ids})
	}
	// 连续同卷分块（渲染序=平铺 idx 序插卷头）：序章在前、番外在后 → 两个独立「未分卷」块
	if groups[0].name != "" || len(groups[0].ids) != 1 || groups[0].ids[0] != 1 {
		t.Fatalf("组0 = %+v, want 未分卷[1]", groups[0])
	}
	if groups[1].name != "第一卷" || len(groups[1].ids) != 2 {
		t.Fatalf("组1 = %+v, want 第一卷[2 3]", groups[1])
	}
	if groups[2].name != "" || groups[2].ids[0] != 4 {
		t.Fatalf("组2 = %+v, want 未分卷[4]", groups[2])
	}
	if groups[3].name != "第二卷" || groups[3].ids[0] != 5 {
		t.Fatalf("组3 = %+v, want 第二卷[5]", groups[3])
	}
}

func TestChapterVolumesEndpoint(t *testing.T) {
	db, err := getDB()
	if err != nil {
		t.Fatalf("getDB: %v", err)
	}
	cleanup := func() {
		_, _ = db.Exec(`DELETE FROM "Chapter"`)
		_, _ = db.Exec(`DELETE FROM "Novel"`)
		_, _ = db.Exec(`DELETE FROM "Category"`)
	}
	cleanup()
	t.Cleanup(cleanup)

	nid := seedVolumeNovel(t, []struct {
		idx   int64
		title string
		vol   string
	}{
		{1, "第1章", "第一卷"},
		{2, "第2章", "第一卷"},
		{3, "番外", ""},
		{4, "第3章", "第二卷"},
	})

	req := httptest.NewRequest(http.MethodGet, "/api/chapters/volumes?novelId="+itoa(int(nid)), nil)
	rec := httptest.NewRecorder()
	handleChapterVolumesGet(rec, req, nil)
	if rec.Code != 200 {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var m map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("json: %v", err)
	}
	if m["volumeCount"].(float64) != 2 {
		t.Fatalf("volumeCount = %v, want 2", m["volumeCount"])
	}
	if m["ungrouped"].(float64) != 1 {
		t.Fatalf("ungrouped = %v, want 1", m["ungrouped"])
	}
	if m["total"].(float64) != 4 {
		t.Fatalf("total = %v, want 4", m["total"])
	}
	vols, _ := m["volumes"].([]any)
	if len(vols) != 3 { // 连续同卷分块：第一卷[1,2] + 未分卷[3] + 第二卷[4]
		t.Fatalf("volumes 组数 = %d, want 3: %v", len(vols), m["volumes"])
	}
	g0, _ := vols[0].(map[string]any)
	if g0["name"].(string) != "第一卷" || g0["chapters"].(float64) != 2 || g0["firstIdx"].(float64) != 1 || g0["lastIdx"].(float64) != 2 {
		t.Fatalf("组0 = %v, want {name:第一卷,chapters:2,firstIdx:1,lastIdx:2}", g0)
	}
	g1, _ := vols[1].(map[string]any)
	if g1["name"].(string) != "" || g1["chapters"].(float64) != 1 || g1["firstIdx"].(float64) != 3 {
		t.Fatalf("未分卷组 = %v, want {name:'',chapters:1,firstIdx:3}", g1)
	}
	// 非法 novelId → 400
	req2 := httptest.NewRequest(http.MethodGet, "/api/chapters/volumes?novelId=abc", nil)
	rec2 := httptest.NewRecorder()
	handleChapterVolumesGet(rec2, req2, nil)
	if rec2.Code != 400 {
		t.Fatalf("非法 novelId status = %d, want 400", rec2.Code)
	}
	// 不存在的书 → 404
	req3 := httptest.NewRequest(http.MethodGet, "/api/chapters/volumes?novelId=999999", nil)
	rec3 := httptest.NewRecorder()
	handleChapterVolumesGet(rec3, req3, nil)
	if rec3.Code != 404 {
		t.Fatalf("不存在书 status = %d, want 404", rec3.Code)
	}
}
