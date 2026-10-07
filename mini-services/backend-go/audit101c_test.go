/**
 * audit101c_test.go —— R101 乱序重排完善回归锁定：
 * 1) volumeSegmentReorder / splitVolumeSegments 纯函数：分卷各自编号（每卷从第1章重计）
 *    书的卷内分段重排（旧版 hasDup 只能保守放弃或仅修头部倒序块）；
 * 2) POST /api/novels/resort-chapters：在途采集任务（pending/running）不再 409 全库拒绝
 *    （旧闸使 FleetKeeper 无人值守模式下重排永远不可用）——安全性由同书骨架分片锁保证；
 * 3) force 单书快路径：低于 20% 审计阈值的低错位书常规口径不动、强制口径修复（R86 语义
 *    在 R101 统一路径下不回归）。
 * 复用 recover_test.go TestMain 临时库 + mustInitAuditTables/mustInitScrapeTaskTable
 * （绝不触碰生产库/文件）。
 */
package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// ---------- 纯函数：splitVolumeSegments ----------

func TestSplitVolumeSegments(t *testing.T) {
	cases := []struct {
		name string
		vols []string
		want string // 每段长度逗号分隔，如 "3,3"
	}{
		{"全空卷=单段", []string{"", "", ""}, "3"},
		{"前导空卷归属首个非空卷", []string{"", "第一卷", "第一卷", "第二卷"}, "3,1"},
		{"卷变化即分段", []string{"第一卷", "第一卷", "第二卷", "第二卷", "第一卷"}, "2,2,1"},
		{"段内空卷随当前卷", []string{"第一卷", "", "第二卷"}, "2,1"},
	}
	for _, c := range cases {
		segs := splitVolumeSegments(c.vols)
		got := make([]string, len(segs))
		for i, s := range segs {
			got[i] = fmt.Sprint(len(s))
		}
		if got := strings.Join(got, ","); got != c.want {
			t.Fatalf("%s: segments=%v (len %s), want %s", c.name, segs, got, c.want)
		}
	}
}

// ---------- 纯函数：volumeSegmentReorder ----------

func refsFromTitles(titles []string) []ChapterRef {
	refs := make([]ChapterRef, len(titles))
	for i, s := range titles {
		refs[i] = ChapterRef{Title: s, URL: fmt.Sprint(i + 1)}
	}
	return refs
}

func titlesFromRefs(refs []ChapterRef) []string {
	out := make([]string, len(refs))
	for i, r := range refs {
		out[i] = r.Title
	}
	return out
}

func TestVolumeSegmentReorderWithinSegments(t *testing.T) {
	// 三卷各 3 章（9 条编号 ≥NUMBERED_MIN），每卷内部乱序：期望段内各自升序、段序不变
	titles := []string{"第3章", "第1章", "第2章", "第2章", "第3章", "第1章", "第2章", "第1章", "第3章"}
	vols := []string{"第一卷", "第一卷", "第一卷", "第二卷", "第二卷", "第二卷", "第三卷", "第三卷", "第三卷"}
	refs := refsFromTitles(titles)
	rr := reorderChapterRefsVols(refs, vols, DISORDER_RATIO)
	if !rr.reordered {
		t.Fatalf("应触发卷内重排，note=%q", rr.note)
	}
	if !strings.Contains(rr.note, "分卷重复编号") {
		t.Fatalf("note 应说明分卷重排，got %q", rr.note)
	}
	got := titlesFromRefs(rr.refs)
	want := []string{"第1章", "第2章", "第3章", "第1章", "第2章", "第3章", "第1章", "第2章", "第3章"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("位置 %d = %q, want %q（全序 %v）", i, got[i], want[i], got)
		}
	}
}

func TestVolumeSegmentReorderPreconditions(t *testing.T) {
	// 单卷重复编号（<2 卷）→ 不启用分段重排
	titles := []string{"第3章", "第1章", "第2章", "第3章", "第1章", "第2章", "第3章", "第1章", "第2章"}
	vols := []string{"第一卷", "第一卷", "第一卷", "第一卷", "第一卷", "第一卷", "第一卷", "第一卷", "第一卷"}
	if rr := reorderChapterRefsVols(refsFromTitles(titles), vols, DISORDER_RATIO); rr.reordered {
		t.Fatalf("单卷重复编号不应重排（回退保守路径），note=%q", rr.note)
	}
	// 编号章节过半无卷归属（>10%）→ 卷字段不可信，不启用
	titles2 := []string{"第1章", "第2章", "第3章", "第1章", "第2章", "第3章", "第1章", "第2章", "第3章", "第4章"}
	vols2 := []string{"", "第一卷", "第一卷", "", "第二卷", "第二卷", "", "第三卷", "第三卷", ""}
	if rr := reorderChapterRefsVols(refsFromTitles(titles2), vols2, DISORDER_RATIO); rr.reordered {
		t.Fatalf("空卷编号占比超限不应重排，note=%q", rr.note)
	}
	// 卷内全有序 → engaged 但无事可做
	titles3 := []string{"第1章", "第2章", "第1章", "第2章", "第1章", "第2章", "第1章", "第2章"}
	vols3 := []string{"第一卷", "第一卷", "第二卷", "第二卷", "第三卷", "第三卷", "第四卷", "第四卷"}
	if rr := reorderChapterRefsVols(refsFromTitles(titles3), vols3, DISORDER_RATIO); rr.reordered {
		t.Fatalf("卷内全有序不应重排，note=%q", rr.note)
	}
}

func TestVolumeSegmentReorderKeepsUnnumberedAnchor(t *testing.T) {
	// 未编号章节锚定段内前一编号章之后（sortKeys 段内独立语义）；编号章节须 ≥NUMBERED_MIN(8)
	titles := []string{
		"第2章", "番外一", "第1章", "第3章",
		"第2章", "番外二", "第1章", "第3章", "第4章",
		"第2章", "第1章", "番外三", "第3章",
	}
	vols := []string{
		"第一卷", "第一卷", "第一卷", "第一卷",
		"第二卷", "第二卷", "第二卷", "第二卷", "第二卷",
		"第三卷", "第三卷", "第三卷", "第三卷",
	}
	rr := reorderChapterRefsVols(refsFromTitles(titles), vols, DISORDER_RATIO)
	if !rr.reordered {
		t.Fatalf("应触发卷内重排，note=%q", rr.note)
	}
	got := titlesFromRefs(rr.refs)
	want := []string{
		"第1章", "第2章", "番外一", "第3章",
		"第1章", "第2章", "番外二", "第3章", "第4章",
		"第1章", "番外三", "第2章", "第3章",
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("位置 %d = %q, want %q（全序 %v）", i, got[i], want[i], got)
		}
	}
}

// ---------- API：在途任务下重排（旧 409 全库闸移除） ----------

func TestResortWithActiveTasksAllowed(t *testing.T) {
	mustInitAuditTables(t)
	mustInitScrapeTaskTable(t)
	t.Setenv("TXT_ROOT", t.TempDir())
	insertTask(t, "running", nowMillis())
	insertTask(t, "pending", nowMillis())
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	if _, err := db.Exec(`INSERT OR IGNORE INTO "Category" ("id","name") VALUES (9003,'测试分类3')`); err != nil {
		t.Fatalf("insert category: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO "Novel" ("id","title","author","categoryId","updatedAt") VALUES (7,'在途任务书','作者',9003,?)`, nowMillis()); err != nil {
		t.Fatalf("insert novel: %v", err)
	}
	for i := 1; i <= 9; i++ {
		if _, err := db.Exec(`INSERT INTO "Chapter" ("novelId","idx","title","content","wordCount","createdAt") VALUES (7,?,?,'',10,?)`,
			i, fmt.Sprintf("第%d章", 10-i), nowMillis()); err != nil {
			t.Fatalf("insert chapter: %v", err)
		}
	}
	req := httptest.NewRequest(http.MethodPost, "/api/novels/resort-chapters", strings.NewReader(`{"novelId":7}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handleNovelsResortChaptersPost(rec, req, nil)
	if rec.Code != 200 {
		t.Fatalf("在途任务下重排应 200（旧版 409 全库闸已移除），got %d（%s）", rec.Code, rec.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode resp: %v", err)
	}
	if reordered, _ := resp["reordered"].(float64); int(reordered) != 1 {
		t.Fatalf("reordered = %v, want 1", resp["reordered"])
	}
	if at, _ := resp["activeTasks"].(float64); int(at) < 2 {
		t.Fatalf("activeTasks 应如实上报在途任务数，got %v", resp["activeTasks"])
	}
	got := chapterIdxByTitle(t, 7)
	for n := 1; n <= 9; n++ {
		if got[fmt.Sprintf("第%d章", n)] != int64(n) {
			t.Fatalf("第%d章 idx = %d（全表 %v）", n, got[fmt.Sprintf("第%d章", n)], got)
		}
	}
}

// ---------- API：force 单书快路径（低错位书） ----------

func TestResortForceLowDisorder(t *testing.T) {
	mustInitAuditTables(t)
	mustInitScrapeTaskTable(t)
	t.Setenv("TXT_ROOT", t.TempDir())
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	if _, err := db.Exec(`INSERT OR IGNORE INTO "Category" ("id","name") VALUES (9003,'测试分类3')`); err != nil {
		t.Fatalf("insert category: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO "Novel" ("id","title","author","categoryId","updatedAt") VALUES (8,'低错位书','作者',9003,?)`, nowMillis()); err != nil {
		t.Fatalf("insert novel: %v", err)
	}
	// 50 章 1..50，仅中间残留一对倒序（第26章在 第25章 前）→ 错乱占比 2/50=4% < 20% 审计阈值
	// （R86 场景：追加式目录补全后旧「最新章节块」残留在中间，审计永不命中，须 force）
	for i := 1; i <= 50; i++ {
		n := i
		if i == 25 {
			n = 26
		} else if i == 26 {
			n = 25
		}
		if _, err := db.Exec(`INSERT INTO "Chapter" ("novelId","idx","title","content","wordCount","createdAt") VALUES (8,?,?,'',10,?)`,
			i, fmt.Sprintf("第%d章", n), nowMillis()); err != nil {
			t.Fatalf("insert chapter: %v", err)
		}
	}
	post := func(body string) (int, map[string]any) {
		req := httptest.NewRequest(http.MethodPost, "/api/novels/resort-chapters", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		handleNovelsResortChaptersPost(rec, req, nil)
		var m map[string]any
		if b := rec.Body.Bytes(); len(b) > 0 {
			_ = json.Unmarshal(b, &m)
		}
		return rec.Code, m
	}
	// 常规口径：阈值内不动
	code, resp := post(`{"novelId":8}`)
	if code != 200 {
		t.Fatalf("常规口径应 200, got %d", code)
	}
	if reordered, _ := resp["reordered"].(float64); int(reordered) != 0 {
		t.Fatalf("4%% 错乱低于 20%% 阈值不应常规重排，resp=%v", resp)
	}
	if msg, _ := resp["message"].(string); msg == "" {
		t.Fatalf("无需重排应回传 message 说明")
	}
	// 强制口径：单书快路径直接修复
	code, resp = post(`{"novelId":8,"force":true}`)
	if code != 200 {
		t.Fatalf("force 应 200, got %d（%v）", code, resp)
	}
	if reordered, _ := resp["reordered"].(float64); int(reordered) != 1 {
		t.Fatalf("force 应重排，resp=%v", resp)
	}
	results, _ := resp["results"].([]any)
	if len(results) != 1 {
		t.Fatalf("results 应 1 本，got %v", resp["results"])
	}
	r0, _ := results[0].(map[string]any)
	if force, _ := r0["force"].(bool); !force {
		t.Fatalf("results[0].force 应为 true")
	}
	got := chapterIdxByTitle(t, 8)
	for n := 1; n <= 50; n++ {
		if got[fmt.Sprintf("第%d章", n)] != int64(n) {
			t.Fatalf("force 后 第%d章 idx = %d", n, got[fmt.Sprintf("第%d章", n)])
		}
	}
}

// ---------- API：分卷书端到端（落库 volume 列 → 卷内重排落位） ----------

func TestResortVolumeSegmentsAPI(t *testing.T) {
	mustInitAuditTables(t)
	mustInitScrapeTaskTable(t)
	t.Setenv("TXT_ROOT", t.TempDir())
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	if _, err := db.Exec(`INSERT OR IGNORE INTO "Category" ("id","name") VALUES (9003,'测试分类3')`); err != nil {
		t.Fatalf("insert category: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO "Novel" ("id","title","author","categoryId","updatedAt") VALUES (9,'分卷重编号书','作者',9003,?)`, nowMillis()); err != nil {
		t.Fatalf("insert novel: %v", err)
	}
	// 三卷各 3 章、卷内倒序落库（volume 列按 Task 45-b detectVolume 口径落库）
	layout := []struct {
		vol, title string
	}{
		{"第一卷", "第3章"}, {"第一卷", "第1章"}, {"第一卷", "第2章"},
		{"第二卷", "第2章"}, {"第二卷", "第3章"}, {"第二卷", "第1章"},
		{"第三卷", "第1章"}, {"第三卷", "第3章"}, {"第三卷", "第2章"},
	}
	for i, row := range layout {
		if _, err := db.Exec(`INSERT INTO "Chapter" ("novelId","idx","title","volume","content","wordCount","createdAt") VALUES (9,?,?,?,'',10,?)`,
			i+1, row.title, row.vol, nowMillis()); err != nil {
			t.Fatalf("insert chapter: %v", err)
		}
	}
	req := httptest.NewRequest(http.MethodPost, "/api/novels/resort-chapters", strings.NewReader(`{"novelId":9}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handleNovelsResortChaptersPost(rec, req, nil)
	if rec.Code != 200 {
		t.Fatalf("分卷重排应 200，got %d（%s）", rec.Code, rec.Body.String())
	}
	var resp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if reordered, _ := resp["reordered"].(float64); int(reordered) != 1 {
		t.Fatalf("reordered = %v, want 1（resp=%v）", resp["reordered"], resp)
	}
	// 校验：卷序不变，卷内按章号升序
	type vrow struct {
		idx    int64
		title  string
		volume string
	}
	rows := []vrow{}
	if err := queryList(`SELECT "idx","title","volume" FROM "Chapter" WHERE "novelId" = 9 ORDER BY "idx" ASC`, func(rs *sql.Rows) error {
		var x vrow
		if err := rs.Scan(&x.idx, &x.title, &x.volume); err != nil {
			return err
		}
		rows = append(rows, x)
		return nil
	}); err != nil {
		t.Fatalf("query: %v", err)
	}
	wantVols := []string{"第一卷", "第一卷", "第一卷", "第二卷", "第二卷", "第二卷", "第三卷", "第三卷", "第三卷"}
	wantTitles := []string{"第1章", "第2章", "第3章", "第1章", "第2章", "第3章", "第1章", "第2章", "第3章"}
	for i := range wantTitles {
		if rows[i].volume != wantVols[i] || rows[i].title != wantTitles[i] {
			t.Fatalf("位置 %d = (%s,%s), want (%s,%s)", i, rows[i].volume, rows[i].title, wantVols[i], wantTitles[i])
		}
	}
}
