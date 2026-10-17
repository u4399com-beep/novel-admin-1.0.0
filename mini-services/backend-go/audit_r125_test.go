package main

// R125 审计测试：loadRule 规则 ID=0 边界修复回归。
//
// 缺陷图谱：seed 固化 biqiuge8（R123）时漏写 id 字段 → seedRule.ID 零值 0 播种 →
// SQLite INTEGER PRIMARY KEY 合法持有 rowid 0 → loadRule 旧版 `*ruleID == 0` 短路
// 返回全空规则（与 nil「未使用规则」语义混淆）→ 任务「未提供任何提取规则」failed。
// 修复后仅 ruleID==nil 语义为未使用；0 走正常查询路径（查不到自然走 err→empty 分支，
// 语义无损）。测试用 id=0 fixture 自足验证（生产库已迁移 0→32 与 seed 对齐，id=0
// 段位空闲可占用）。

import (
        "encoding/json"
        "testing"
)

func TestLoadRuleZeroIDLoadsRuleR125(t *testing.T) {
        db, err := getDB()
        if err != nil {
                t.Fatalf("getDB: %v", err)
        }
        if _, err := db.Exec(`DELETE FROM "ScrapeRule" WHERE "id" = 0`); err != nil {
                t.Fatalf("pre-clean id=0: %v", err)
        }
        if _, err := db.Exec(`INSERT INTO "ScrapeRule" ("id","name","siteUrl","enabled","charset","listRule","bookRule","chapterRule","createdAt","updatedAt")
                VALUES (0,'loadrule-zero-r125','https://zero.example/',1,'gbk','{"itemSelector":".it a"}','{"titleSelector":"h1"}','',1,1)`); err != nil {
                t.Fatalf("insert fixture id=0: %v", err)
        }
        t.Cleanup(func() { _, _ = db.Exec(`DELETE FROM "ScrapeRule" WHERE "id" = 0 AND "name" = 'loadrule-zero-r125'`) })

        zero := 0
        r := loadRule(&zero)
        if r.Name != "loadrule-zero-r125" {
                t.Fatalf("id=0 是合法规则 ID，loadRule 必须正常装载（R125 修复回归），got name=%q listRule=%v", r.Name, r.ListRule)
        }
        if len(r.ListRule) == 0 || r.ListRule["itemSelector"] != ".it a" {
                t.Fatalf("id=0 规则 listRule 应装载: %v", r.ListRule)
        }
        if r.Charset != "gbk" {
                t.Fatalf("id=0 规则 charset 应装载: %q", r.Charset)
        }

        // nil 语义不变：未使用规则 → 全空
        if r2 := loadRule(nil); r2.Name != "" || len(r2.ListRule) != 0 {
                t.Fatalf("nil ruleID 仍应全空: %+v", r2)
        }

        // 不存在的高段位 ID 语义不变：err 分支 → 全空
        missing := 95126
        if r3 := loadRule(&missing); r3.Name != "" || len(r3.BookRule) != 0 {
                t.Fatalf("不存在 ruleID 应全空: %+v", r3)
        }
}

func TestSeedJSONAllRulesHaveIDR125(t *testing.T) {
        // seed 固化完整性：所有规则必须携带显式 id（缺 id 字段 → 零值 0 播种 →
        // 与「未使用规则」历史语义混淆，且 repairRuleCorruption 按 id 匹配失配）
        var doc seedDoc
        if err := json.Unmarshal(seedBlob, &doc); err != nil {
                t.Fatalf("seed.json 解析: %v", err)
        }
        rules := doc.Rules
        if len(rules) == 0 {
                t.Fatalf("seed.json 规则为空")
        }
        seen := map[int64]bool{}
        for _, r := range rules {
                if r.ID <= 0 {
                        t.Fatalf("规则 %q 缺显式 id（零值 0 播种即 R125 缺陷源）", r.Name)
                }
                if seen[r.ID] {
                        t.Fatalf("规则 id 重复: %d", r.ID)
                }
                seen[r.ID] = true
        }
}
