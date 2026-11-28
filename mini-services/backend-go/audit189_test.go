/**
 * audit189_test.go —— R189「POST 新建规则 createdAt 被 notes 文本污染」根修回归锁。
 *
 * 缺陷（R150 世代潜伏，R186 规则 35 实证）：handleScrapeRulesSaveBody 新建路径的
 * INSERT 实参把 truncateRunes(notes,1000) 绑定两次（第 14 参本应 createdAt）——
 * placeholders 15 个而实参 16 个，modernc.org/sqlite 静默吞掉多余实参不报错，
 * SQLite 动态类型接受非数值文本落进 INTEGER 亲和列 → 该行 createdAt = notes 全文。
 *
 * 锁定：POST 创建带专属 notes 的规则 → 直查 DB 断言 createdAt/updatedAt 均为可解析
 * 的毫秒纪元整数（sqlite3 typeof=integer），且 createdAt != notes 文本。
 * 夹具 id 自清（mustCleanupRule 同 audit53b 口径），绝不触碰生产 db/custom.db。
 */
package main

import (
        "encoding/json"
        "net/http/httptest"
        "strconv"
        "testing"
)

func TestScrapeRulesCreatedAtNumeric_R189(t *testing.T) {
        const fixtureNotes = "R189-audit-notes-sentinel-1795851234123：此文本绝不允许出现在 createdAt 列"
        createBody := map[string]any{
                "name":    "r189-createdAt-numeric",
                "siteUrl": "https://r189-numeric.example/",
                "notes":   fixtureNotes,
                "enabled": true,
        }
        rec := httptest.NewRecorder()
        handleScrapeRulesSaveBody(rec, createBody)
        if rec.Code != 201 {
                t.Fatalf("创建应 201，got %d body=%s", rec.Code, rec.Body.String())
        }
        var created struct {
                ID int64 `json:"id"`
        }
        if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil || created.ID <= 0 {
                t.Fatalf("创建响应应含正 id，got %s（err=%v）", rec.Body.String(), err)
        }
        mustCleanupRule(t, created.ID)

        db, err := getDB()
        if err != nil {
                t.Fatalf("getDB: %v", err)
        }
        var createdAtType, updatedAtType, createdAtVal string
        if err := db.QueryRow(
                `SELECT typeof("createdAt"), typeof("updatedAt"), CAST("createdAt" AS TEXT) FROM "ScrapeRule" WHERE "id" = ?`,
                created.ID).Scan(&createdAtType, &updatedAtType, &createdAtVal); err != nil {
                t.Fatalf("回读创建行失败: %v", err)
        }
        if createdAtType != "integer" {
                prefix := createdAtVal
                if len(prefix) > 40 {
                        prefix = prefix[:40]
                }
                t.Fatalf("createdAt 存储类应 integer，got %s（值前缀 %q）——notes 双绑定缺陷复发", createdAtType, prefix)
        }
        if updatedAtType != "integer" {
                t.Fatalf("updatedAt 存储类应 integer，got %s", updatedAtType)
        }
        ms, err := strconv.ParseInt(createdAtVal, 10, 64)
        if err != nil || ms <= 0 {
                t.Fatalf("createdAt 应为正毫秒纪元，got %q（err=%v）", createdAtVal, err)
        }
        if createdAtVal == fixtureNotes {
                t.Fatalf("createdAt 等于 notes 文本——notes 双绑定缺陷直接复发")
        }
}
