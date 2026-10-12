/**
 * orphanskeleton_test.go —— R113 回归锁定（/api/novels/orphan-skeletons 审计+清理）：
 * ①审计分桶：零填充三态（no-rows / stale-skeleton / active）+ 有填充书不入清单
 * ②minAgeHours 书龄下限保护（新书不入候选）
 * ③POST 逐本复验：has-content / fill-in-flight（30min 保护窗）/ 正常删除 + TXT 清理
 * ④幂等：同 ids 重复提交第二次全 skipped
 * 复用 recover_test.go 的 TestMain 临时库 + api_chapters_audit_test.go 的建表助手
 * （绝不触碰生产库/文件）。
 */
package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestOrphanSkeletonsAuditBuckets(t *testing.T) {
	mustInitAuditTables(t)
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	now := nowMillis()
	old := now - 48*3600*1000  // 48h 前（超过 staleHours 24h）
	recent := now - 10*60*1000 // 10 分钟前（active 桶）

	if _, err := db.Exec(`INSERT OR IGNORE INTO "Category" ("id","name") VALUES (9100,'孤儿测试分类')`); err != nil {
		t.Fatalf("insert category: %v", err)
	}

	seed := []struct {
		id      int64
		title   string
		created int64
		chaps   []struct{ idx, wc, at int64 }
	}{
		// no-rows：零行 + 书龄 48h → 候选
		{9101, "坏扫描孤儿", old, nil},
		// stale-skeleton：只有骨架行（wordCount=0）且最后活动 48h 前 → 候选
		{9102, "停滞骨架书", old, []struct{ idx, wc, at int64 }{{1, 0, old}, {2, 0, old}}},
		// active：骨架行 10 分钟前还在写 → 仅计数不入候选
		{9103, "填充中新书", old, []struct{ idx, wc, at int64 }{{1, 0, recent}}},
		// 有填充（wordCount>0）→ 完全不入统计
		{9104, "正常书", old, []struct{ idx, wc, at int64 }{{1, 3000, recent}}},
		// 零填充但书龄 1h（< minAgeHours 24）→ 不入候选（书龄下限保护）
		{9105, "刚入库新书", now - 3600*1000, nil},
	}
	for _, s := range seed {
		if _, err := db.Exec(`INSERT INTO "Novel" ("id","title","author","categoryId","createdAt","updatedAt") VALUES (?,?,?,?,?,?)`,
			s.id, s.title, "作者", 9100, s.created, s.created); err != nil {
			t.Fatalf("insert novel %d: %v", s.id, err)
		}
		for _, ch := range s.chaps {
			if _, err := db.Exec(`INSERT INTO "Chapter" ("novelId","idx","title","content","wordCount","createdAt") VALUES (?,?,?,?,?,?)`,
				s.id, ch.idx, fmt.Sprintf("第%d章", ch.idx), "", ch.wc, ch.at); err != nil {
				t.Fatalf("insert chapter novel=%d: %v", s.id, err)
			}
		}
	}

	req := httptest.NewRequest(http.MethodGet, "/api/novels/orphan-skeletons", nil)
	rec := httptest.NewRecorder()
	handleOrphanSkeletonsGet(rec, req, nil)
	if rec.Code != 200 {
		t.Fatalf("audit 应 200，got %d（%s）", rec.Code, rec.Body.String())
	}
	var rep struct {
		MinAgeHours int `json:"minAgeHours"`
		ZeroFilled  int `json:"zeroFilled"`
		Active      int `json:"active"`
		Candidates  []struct {
			ID     int64  `json:"id"`
			Bucket string `json:"bucket"`
			Rows   int64  `json:"rows"`
		} `json:"candidates"`
		Buckets map[string]int `json:"buckets"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &rep); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if rep.MinAgeHours != 24 {
		t.Fatalf("minAgeHours 缺省应 24，got %d", rep.MinAgeHours)
	}
	// 零填充：9101/9102/9103/9105（9104 有填充不计）
	if rep.ZeroFilled != 4 {
		t.Fatalf("zeroFilled = %d, want 4", rep.ZeroFilled)
	}
	if rep.Active != 1 {
		t.Fatalf("active = %d, want 1（9103 在途填充）", rep.Active)
	}
	if len(rep.Candidates) != 2 {
		t.Fatalf("candidates = %d, want 2（9101+9102；9105 书龄保护）", len(rep.Candidates))
	}
	byID := map[int64]string{}
	for _, c := range rep.Candidates {
		byID[c.ID] = c.Bucket
	}
	if byID[9101] != "no-rows" {
		t.Fatalf("9101 bucket = %q, want no-rows", byID[9101])
	}
	if byID[9102] != "stale-skeleton" {
		t.Fatalf("9102 bucket = %q, want stale-skeleton", byID[9102])
	}
	if rep.Buckets["noRows"] != 1 || rep.Buckets["staleSkeleton"] != 1 {
		t.Fatalf("buckets = %v, want noRows:1 staleSkeleton:1", rep.Buckets)
	}

	// —— POST：候选 ids 逐本复验删除（9102 有 48h 前的骨架行，不在 30min 保护窗 → 可删）——
	purge := httptest.NewRequest(http.MethodPost, "/api/novels/orphan-skeletons",
		strings.NewReader(`{"ids":[9101,9102,9103,9104]}`))
	prec := httptest.NewRecorder()
	handleOrphanSkeletonsPost(prec, purge, nil)
	if prec.Code != 200 {
		t.Fatalf("purge 应 200，got %d（%s）", prec.Code, prec.Body.String())
	}
	var res struct {
		Requested int `json:"requested"`
		Deleted   int `json:"deleted"`
		Skipped   []struct {
			ID     int64  `json:"id"`
			Reason string `json:"reason"`
		} `json:"skipped"`
	}
	if err := json.Unmarshal(prec.Body.Bytes(), &res); err != nil {
		t.Fatalf("decode purge: %v", err)
	}
	if res.Requested != 4 || res.Deleted != 2 {
		t.Fatalf("requested/deleted = %d/%d, want 4/2", res.Requested, res.Deleted)
	}
	skipReason := map[int64]string{}
	for _, s := range res.Skipped {
		skipReason[s.ID] = s.Reason
	}
	// 9103 在途填充保护（行活动 10min 前 < 30min 窗）；9104 有正文转正
	if skipReason[9103] != "fill-in-flight" {
		t.Fatalf("9103 reason = %q, want fill-in-flight", skipReason[9103])
	}
	if skipReason[9104] != "has-content" {
		t.Fatalf("9104 reason = %q, want has-content", skipReason[9104])
	}
	// 删除落库断言：9101/9102 连同章节行（FK 级联）消失；9103/9104 存留
	for id, want := range map[int64]bool{9101: false, 9102: false, 9103: true, 9104: true} {
		var n int
		if err := db.QueryRow(`SELECT COUNT(*) FROM "Novel" WHERE "id"=?`, id).Scan(&n); err != nil {
			t.Fatalf("count novel %d: %v", id, err)
		}
		if (n > 0) != want {
			t.Fatalf("novel %d 存留=%v, want %v", id, n > 0, want)
		}
	}
	var chN int
	if err := db.QueryRow(`SELECT COUNT(*) FROM "Chapter" WHERE "novelId"=9102`).Scan(&chN); err != nil {
		t.Fatalf("count chapters: %v", err)
	}
	if chN != 0 {
		t.Fatalf("9102 章节应级联删除，got %d 行", chN)
	}

	// —— 幂等：同 ids 二次提交全 skipped ——
	prec2 := httptest.NewRecorder()
	handleOrphanSkeletonsPost(prec2, httptest.NewRequest(http.MethodPost, "/api/novels/orphan-skeletons",
		strings.NewReader(`{"ids":[9101,9102]}`)), nil)
	var res2 struct {
		Deleted int `json:"deleted"`
		Skipped []struct {
			Reason string `json:"reason"`
		}
	}
	if err := json.Unmarshal(prec2.Body.Bytes(), &res2); err != nil {
		t.Fatalf("decode repurchase: %v", err)
	}
	if res2.Deleted != 0 || len(res2.Skipped) != 2 {
		t.Fatalf("二次提交 deleted/skipped = %d/%d, want 0/2", res2.Deleted, len(res2.Skipped))
	}
}

func TestOrphanSkeletonsGuardRails(t *testing.T) {
	mustInitAuditTables(t)
	// POST 空 ids → 400
	rec := httptest.NewRecorder()
	handleOrphanSkeletonsPost(rec, httptest.NewRequest(http.MethodPost, "/api/novels/orphan-skeletons",
		strings.NewReader(`{}`)), nil)
	if rec.Code != 400 {
		t.Fatalf("空 ids 应 400，got %d", rec.Code)
	}
	// POST 非法 ids（负数/小数）→ 400
	rec2 := httptest.NewRecorder()
	handleOrphanSkeletonsPost(rec2, httptest.NewRequest(http.MethodPost, "/api/novels/orphan-skeletons",
		strings.NewReader(`{"ids":[-1,1.5]}`)), nil)
	if rec2.Code != 400 {
		t.Fatalf("非法 ids 应 400，got %d", rec2.Code)
	}
	// minAgeHours 越界回落缺省 24
	req := httptest.NewRequest(http.MethodGet, "/api/novels/orphan-skeletons?minAgeHours=99999", nil)
	rec3 := httptest.NewRecorder()
	handleOrphanSkeletonsGet(rec3, req, nil)
	var rep map[string]any
	if err := json.Unmarshal(rec3.Body.Bytes(), &rep); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if rep["minAgeHours"].(float64) != 24 {
		t.Fatalf("越界 minAgeHours 应回落 24，got %v", rep["minAgeHours"])
	}
}
