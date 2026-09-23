/**
 * recover_test.go —— Task 26-d 恢复语义回归：
 * 1) recoverStaleTasks 僵尸任务回收：integer/TEXT createdAt 双存储类都能被正确转 paused
 *    （旧版 SQL 内 `createdAt < ?(int64)` 对 TEXT 行永不命中——SQLite 比较规则 TEXT 恒 > INTEGER，
 *     僵尸任务被静默跳过，实证缺陷复现并修复）；
 * 2) normalizeMillis/parseMillisText 多格式归一化单测。
 * 运行：cd mini-services/backend-go && go test -run TestRecover -run TestParseMillis ./...
 * （TestMain 把 DB_PATH 指向临时库，绝不触碰生产 db/custom.db）
 */
package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	// 必须在任何 getDB() 之前切库：临时文件 + 最小 ScrapeTask 表
	tmp := filepath.Join(os.TempDir(), "t26d-recover-test.db")
	_ = os.Remove(tmp)
	_ = os.Setenv("DB_PATH", tmp)
	code := m.Run()
	_ = os.Remove(tmp)
	os.Exit(code)
}

func mustInitScrapeTaskTable(t *testing.T) {
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS ScrapeTask (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		status TEXT NOT NULL DEFAULT 'pending',
		message TEXT NOT NULL DEFAULT '',
		log TEXT NOT NULL DEFAULT '',
		createdAt INTEGER,
		updatedAt INTEGER
	)`); err != nil {
		t.Fatalf("create table: %v", err)
	}
	t.Cleanup(func() {
		_, _ = db.Exec("DELETE FROM ScrapeTask")
	})
}

func insertTask(t *testing.T, status string, createdAt any) int64 {
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	res, err := db.Exec(`INSERT INTO ScrapeTask (status, message, log, createdAt, updatedAt) VALUES (?, '', '', ?, ?)`,
		status, createdAt, createdAt)
	if err != nil {
		t.Fatalf("insert: %v", err)
	}
	id, _ := res.LastInsertId()
	return id
}

func taskStatus(t *testing.T, id int64) string {
	var status string
	if err := queryOne(`SELECT status FROM ScrapeTask WHERE id = ?`, []any{&status}, id); err != nil {
		t.Fatalf("query status: %v", err)
	}
	return status
}

func TestRecoverStaleTasksMixedStorage(t *testing.T) {
	mustInitScrapeTaskTable(t)
	now := nowMillis()
	past := now - 3600_000
	future := now + 3600_000
	// 历史文本形态（本库 ScrapeRule.updatedAt 实证存在该存储类）
	textPast := time.UnixMilli(past).Format("2006-01-02 15:04:05")

	idIntPast := insertTask(t, "running", past)             // integer 过去 → 应转 paused
	idIntFuture := insertTask(t, "running", future)         // integer 未来（本进程后创建）→ 保持 running
	idTextPast := insertTask(t, "running", textPast)        // TEXT 过去（旧版永不命中）→ 应转 paused
	idTextGarbage := insertTask(t, "running", "not-a-date") // 无法解析 → 按僵尸处理（宁暂停勿悬挂）
	idPending := insertTask(t, "pending", past)             // pending 不动

	recoverStaleTasks()

	if got := taskStatus(t, idIntPast); got != "paused" {
		t.Fatalf("integer 过去 running 应转 paused，got %s", got)
	}
	if got := taskStatus(t, idTextPast); got != "paused" {
		t.Fatalf("TEXT 过去 running 应转 paused（旧版 SQLite TEXT>INTEGER 比较永不命中的回归），got %s", got)
	}
	if got := taskStatus(t, idTextGarbage); got != "paused" {
		t.Fatalf("createdAt 无法解析的 running 应按僵尸转 paused，got %s", got)
	}
	if got := taskStatus(t, idIntFuture); got != "running" {
		t.Fatalf("本进程启动后创建的 running 不应被恢复触碰，got %s", got)
	}
	if got := taskStatus(t, idPending); got != "pending" {
		t.Fatalf("pending 不应被恢复触碰，got %s", got)
	}
}

func TestParseMillisText(t *testing.T) {
	cases := []struct {
		in   string
		ok   bool
		want int64 // ok 时校验（容差 ±1s 由调用方不做，这里用确定值）
	}{
		{"1790165051137", true, 1790165051137},
		{" 1790165051137 ", true, 1790165051137},
		{"2026-09-23 12:04:11", true, 0}, // 形态命中即可（时区随环境，不校验绝对值）
		{"2026-09-23T12:04:11.137Z", true, 0},
		{"2026-09-23T12:04:11.137+08:00", true, 0},
		{"2026/09/23 12:04:05", true, 0},
		{"", false, 0},
		{"not-a-date", false, 0},
		{"0", false, 0},
		{"-5", false, 0},
	}
	for _, c := range cases {
		got, ok := parseMillisText(c.in)
		if ok != c.ok {
			t.Fatalf("parseMillisText(%q) ok = %v, want %v（got %d）", c.in, ok, c.ok, got)
		}
		if ok && c.want != 0 && got != c.want {
			t.Fatalf("parseMillisText(%q) = %d, want %d", c.in, got, c.want)
		}
	}
	// any 包装形态（DB scan 实际返回类型）
	if ms, ok := normalizeMillis(int64(1790165051137)); !ok || ms != 1790165051137 {
		t.Fatalf("normalizeMillis(int64) 失败")
	}
	if ms, ok := normalizeMillis(float64(1790165051137)); !ok || ms != 1790165051137 {
		t.Fatalf("normalizeMillis(float64) 失败")
	}
	if _, ok := normalizeMillis(nil); ok {
		t.Fatalf("normalizeMillis(nil) 应失败")
	}
	if _, ok := normalizeMillis([]byte("2026-09-23 12:04:11")); !ok {
		t.Fatalf("normalizeMillis([]byte TEXT) 应命中文本解析")
	}
}
