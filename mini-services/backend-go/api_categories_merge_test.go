/**
 * api_categories_merge_test.go —— Task 39-b 回归锁定（POST /api/categories/merge ID 严格校验）：
 * 旧版 toId 经 optIntField 对非整数（如 1.5）静默截断为 1 —— 破坏性合并进错误目标分类
 * 并删除源分类。修复后 toId 必须为安全正整数（Number.isInteger + 2^53 上界），否则 400
 * 且源分类/书籍归属原样不动；整数 toId 正常路径行为不变。
 * 复用 recover_test.go 的 TestMain 临时库（基础 schema 由 getDB 自动建表）。
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

func mergeCategoryFixture(t *testing.T, tag string) (fromID, toID, novelID int64) {
	t.Helper()
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	fromName, toName := "合并源"+tag, "合并目标"+tag
	res, err := db.Exec(`INSERT INTO "Category" ("name","sort") VALUES (?,99)`, fromName)
	if err != nil {
		t.Fatalf("insert source category: %v", err)
	}
	fromID, _ = res.LastInsertId()
	res, err = db.Exec(`INSERT INTO "Category" ("name","sort") VALUES (?,100)`, toName)
	if err != nil {
		t.Fatalf("insert target category: %v", err)
	}
	toID, _ = res.LastInsertId()
	// 书籍直接挂在源分类下：正向用例验证迁书 moved=1；拒绝用例验证归属不动
	res, err = db.Exec(`INSERT INTO "Novel" ("title","author","categoryId","updatedAt") VALUES (?,?,?,?)`,
		"合并测试书"+tag, "测试作者", fromID, nowMillis())
	if err != nil {
		t.Fatalf("insert novel: %v", err)
	}
	novelID, _ = res.LastInsertId()
	t.Cleanup(func() {
		_, _ = db.Exec(`DELETE FROM "Novel" WHERE "id" = ?`, novelID)
		_, _ = db.Exec(`DELETE FROM "Category" WHERE "id" IN (?,?)`, fromID, toID)
	})
	return fromID, toID, novelID
}

func postCategoriesMerge(t *testing.T, body string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/categories/merge", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handleCategoriesMergePost(rec, req, nil)
	var m map[string]any
	if b := rec.Body.Bytes(); len(b) > 0 {
		_ = json.Unmarshal(b, &m)
	}
	return rec.Code, m
}

func categoryExists(t *testing.T, id int64) bool {
	t.Helper()
	var n int
	if err := queryOne(`SELECT COUNT(*) FROM "Category" WHERE "id" = ?`, []any{&n}, id); err != nil {
		t.Fatalf("query category: %v", err)
	}
	return n > 0
}

func novelCategoryID(t *testing.T, novelID int64) int64 {
	t.Helper()
	var cid int64
	if err := queryOne(`SELECT "categoryId" FROM "Novel" WHERE "id" = ?`, []any{&cid}, novelID); err != nil {
		t.Fatalf("query novel: %v", err)
	}
	return cid
}

// TestCategoriesMergeNonIntegerToIdRejected toId=1.5 旧版截断为 1 → 错误目标合并+删源分类。
// 修复后必须 400 且数据原样不动（源分类在、书籍归属不变）。
func TestCategoriesMergeNonIntegerToIdRejected(t *testing.T) {
	fromID, toID, novelID := mergeCategoryFixture(t, "39b-非整数")
	before := novelCategoryID(t, novelID)

	code, resp := postCategoriesMerge(t, fmt.Sprintf(`{"fromId":%d,"toId":1.5}`, fromID))
	if code != 400 {
		t.Fatalf("toId=1.5 应 400，got %d（%v）", code, resp)
	}
	if msg, _ := resp["error"].(string); !strings.Contains(msg, "无效的目标分类") {
		t.Fatalf("错误文案应提示无效目标分类，got %v", resp["error"])
	}
	if !categoryExists(t, fromID) {
		t.Fatalf("被拒请求不得删除源分类（旧版破坏性合并根因）")
	}
	if got := novelCategoryID(t, novelID); got != before {
		t.Fatalf("被拒请求不得迁移书籍归属：got %d, want %d", got, before)
	}
	// toId 越界（1e20 > 2^53）同口径拒绝
	code, _ = postCategoriesMerge(t, `{"fromId":`+fmt.Sprint(fromID)+`,"toId":1e20}`)
	if code != 400 {
		t.Fatalf("toId=1e20 应 400，got %d", code)
	}
	// toId=null / '' 视为未提供（回到 toName 分支判定，语义与 taskRuleIDParam 对齐）
	code, _ = postCategoriesMerge(t, fmt.Sprintf(`{"fromId":%d,"toId":null}`, fromID))
	if code != 400 || !categoryExists(t, fromID) {
		t.Fatalf("toId=null 且无 toName 应 400 缺目标且不动数据，got %d", code)
	}
	_ = toID // 正向路径在下一用例独立验证
}

// TestCategoriesMergeIntegerToIdWorks 整数 toId 正常路径回归：迁书+删源分类，行为不变。
func TestCategoriesMergeIntegerToIdWorks(t *testing.T) {
	fromID, toID, novelID := mergeCategoryFixture(t, "39b-整数")

	code, resp := postCategoriesMerge(t, fmt.Sprintf(`{"fromId":%d,"toId":%d}`, fromID, toID))
	if code != 200 {
		t.Fatalf("整数 toId 应 200，got %d（%v）", code, resp)
	}
	if moved, _ := resp["moved"].(float64); int(moved) != 1 {
		t.Fatalf("moved = %v, want 1", resp["moved"])
	}
	if got := novelCategoryID(t, novelID); got != toID {
		t.Fatalf("书籍应迁入目标分类：got %d, want %d", got, toID)
	}
	if categoryExists(t, fromID) {
		t.Fatalf("源分类应被删除")
	}
}

// TestPositiveIntIDField 严格整数 ID 工具的边界向量（含旧版两类转换事故形态）。
func TestPositiveIntIDField(t *testing.T) {
	cases := []struct {
		in any
		ok bool
	}{
		{float64(5), true},
		{float64(9007199254740992), true}, // 2^53 上界内
		{float64(1.5), false},             // 非整数（旧版截断事故源）
		{float64(0), false},
		{float64(-3), false},
		{float64(1e20), false}, // 越界（旧版 amd64 溢出 MinInt64）
		{"5", false},
		{nil, false},
		{true, false},
	}
	for _, c := range cases {
		got, ok := positiveIntIDField(c.in)
		if ok != c.ok {
			t.Fatalf("positiveIntIDField(%v) ok = %v, want %v", c.in, ok, c.ok)
		}
		if ok && got != int64(c.in.(float64)) {
			t.Fatalf("positiveIntIDField(%v) = %d", c.in, got)
		}
	}
}
