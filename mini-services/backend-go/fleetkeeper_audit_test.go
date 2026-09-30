/**
 * fleetkeeper_audit_test.go —— Task 51-a 深审回归锁定（E26 舰队自持冷却判定的存储类容错）：
 *
 * 实证根因（Task 26-d 同族）：fleetKeepOnce 的冷却判定 `COALESCE(MAX("updatedAt"),0)`
 * 曾以 int64 直扫——SQLite 混合存储类下 MAX 返回 TEXT（TEXT 恒 > INTEGER），历史工具
 * 写入的 DateTime 文本行会让 Scan 报错 → 该规则每轮在 err 分支被静默跳过，E26 对该
 * 规则永不补建（填充断流且无任何日志线索）。修复为 any 读出 + normalizeMillis 归一。
 *
 * 锁定三条语义：
 * ① TEXT 存储类且已过冷却窗（2h 前）→ 必须补建（修复前：Scan 失败永久跳过）；
 * ② TEXT 存储类且在冷却窗内（刚刚）→ 不得补建（归一化后冷却语义对 TEXT 同样生效）；
 * ③ 无任务（MAX=NULL）→ 补建（「首轮即建」语义保留）。
 *
 * 复用 recover_test.go 的 TestMain 临时库（ensureBaseSchema 已建全量表，绝不触碰生产
 * db/custom.db）；规则 id 用 964xx 段避让其他测试夹具，t.Cleanup 自清。
 */
package main

import (
	"testing"
	"time"
)

func fleetKeepFixtureRule(t *testing.T, id int64, name string) {
	t.Helper()
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO "ScrapeRule" ("id","name","siteUrl","enabled") VALUES (?,?,'https://fleetkeep-audit.example',1)`,
		id, name); err != nil {
		t.Fatalf("insert rule #%d: %v", id, err)
	}
}

func fleetKeepFixtureTask(t *testing.T, ruleID int64, status string, updatedAt any) {
	t.Helper()
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO "ScrapeTask" ("mode","targetUrl","ruleId","pages","storageMode","status","createdAt","updatedAt")
			VALUES ('list','https://fleetkeep-audit.example',?,10,'db',?,?,?)`,
		ruleID, status, updatedAt, updatedAt); err != nil {
		t.Fatalf("insert task for rule #%d: %v", ruleID, err)
	}
}

func fleetKeepTaskCount(t *testing.T, ruleID int64) int {
	t.Helper()
	var n int
	if err := queryOne(`SELECT COUNT(*) FROM "ScrapeTask" WHERE "ruleId" = ?`, []any{&n}, ruleID); err != nil {
		t.Fatalf("count tasks: %v", err)
	}
	return n
}

func setupFleetKeepAudit(t *testing.T) {
	t.Helper()
	t.Setenv("FLEETKEEPER_OFF", "") // 直接调 fleetKeepOnce，不依赖循环；停用开关保持中性
	db, err := getDB()
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	t.Cleanup(func() {
		_, _ = db.Exec(`DELETE FROM "ScrapeTask" WHERE "ruleId" >= 96400 AND "ruleId" < 96500`)
		_, _ = db.Exec(`DELETE FROM "ScrapeRule" WHERE "id" >= 96400 AND "id" < 96500`)
	})
}

func TestFleetKeepCooldownTextStorageClass(t *testing.T) {
	setupFleetKeepAudit(t)
	now := nowMillis()
	// 历史文本形态（Task 26-d 实证 ScrapeTask 存在过该存储类）
	textOld := time.UnixMilli(now - 2*fleetKeepCooldownMs).Format("2006-01-02 15:04:05")
	textFresh := time.UnixMilli(now).Format("2006-01-02 15:04:05")

	const (
		ruleOld   = int64(96401) // TEXT 且已过冷却 → 必须补建
		ruleFresh = int64(96402) // TEXT 且冷却中 → 不得补建
		ruleNone  = int64(96403) // 无任务 → 首轮即建
	)
	fleetKeepFixtureRule(t, ruleOld, "audit-fk-old-text")
	fleetKeepFixtureRule(t, ruleFresh, "audit-fk-fresh-text")
	fleetKeepFixtureRule(t, ruleNone, "audit-fk-none")
	fleetKeepFixtureTask(t, ruleOld, "failed", textOld)
	fleetKeepFixtureTask(t, ruleFresh, "failed", textFresh)

	fleetKeepOnce()

	if got := fleetKeepTaskCount(t, ruleOld); got != 2 {
		t.Fatalf("规则 #%d（TEXT 已过冷却）：任务数 = %d，want 2（原任务 + E26 补建）；修复前 int64 直扫 TEXT 会 Scan 报错并永久跳过该规则", ruleOld, got)
	}
	if got := fleetKeepTaskCount(t, ruleFresh); got != 1 {
		t.Fatalf("规则 #%d（TEXT 冷却中）：任务数 = %d，want 1（冷却语义须对 TEXT 存储类同样生效，不得重建）", ruleFresh, got)
	}
	if got := fleetKeepTaskCount(t, ruleNone); got != 1 {
		t.Fatalf("规则 #%d（无任务）：任务数 = %d，want 1（「首轮即建」语义丢失）", ruleNone, got)
	}

	// 补建行形态抽查：pending list 任务、pages=10（与生产 INSERT 同构）
	var mode, status string
	var pages int64
	if err := queryOne(`SELECT "mode","status","pages" FROM "ScrapeTask" WHERE "ruleId" = ? AND "status" = 'pending'`,
		[]any{&mode, &status, &pages}, ruleOld); err != nil {
		t.Fatalf("补建任务行缺失: %v", err)
	}
	if mode != "list" || pages != int64(fleetKeepPageLimit) {
		t.Fatalf("补建任务形态异常: mode=%s pages=%d, want list/%d", mode, pages, fleetKeepPageLimit)
	}
}

func TestFleetKeepActiveTaskBlocksRebuild(t *testing.T) {
	setupFleetKeepAudit(t)
	const ruleActive = int64(96404)
	fleetKeepFixtureRule(t, ruleActive, "audit-fk-active")
	// 活跃任务（running）在册 → 无论冷却与否都不得补建（E26 与活跃任务互斥的核心语义）
	fleetKeepFixtureTask(t, ruleActive, "running", nowMillis()-2*fleetKeepCooldownMs)

	fleetKeepOnce()

	if got := fleetKeepTaskCount(t, ruleActive); got != 1 {
		t.Fatalf("规则 #%d（running 在册）：任务数 = %d，want 1（活跃任务存在时禁止补建）", ruleActive, got)
	}
}
