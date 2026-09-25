/**
 * seed.go —— 初始库种子固化（Task 27）。
 *
 * 背景：沙箱整机回收会重置 db/custom.db（表结构在、数据全空）。历史上发生过两次，
 * 每次都要从 git 快照人工找回 15 条精心校准的采集规则。本机制把规则/分类/首页区块
 * 配置固化为仓库内种子（go:embed，随二进制分发），启动时对应表为空即自动导入：
 *   - ScrapeRule 空 → 导入 15 条规则（11 老站校准版 + 4 新站，含 fetch-curl/chapterListApi 等增强标注）
 *   - Category  空 → 导入 9 分类（8 核心类 + 「其他」id=9999 sort=9999 恒末位）
 *   - SiteSetting.homeConfig 为空 → 写入默认三区块（小编精选 featured 上移契约位 + 热门 + 最新上架）
 *
 * 幂等语义：只在「表为空」时导入（COUNT==0），绝不覆盖用户已编辑的规则/分类；
 * SiteSetting 行本身由 api_settings.go 的兜底 INSERT 负责，此处只补 homeConfig。
 * 手动重置：清空对应表后重启服务即可重新播种（seed 为 go:embed 随二进制分发，无需外部脚本）。
 */
package main

import (
        "database/sql"
        _ "embed"
        "encoding/json"
        "log"
        "strings"
)

//go:embed seed/seed.json
var seedBlob []byte

// seedRule/seedCategory 种子行结构（与 DB 列一一对应）
type seedRule struct {
        ID          int64  `json:"id"`
        Name        string `json:"name"`
        SiteURL     string `json:"siteUrl"`
        Enabled     bool   `json:"enabled"`
        Charset     string `json:"charset"`
        Proxy       string `json:"proxy"`
        InsecureTLS bool   `json:"insecureTLS"`
        ListRule    string `json:"listRule"`
        BookRule    string `json:"bookRule"`
        ChapterRule string `json:"chapterRule"`
        Notes       string `json:"notes"`
}

type seedCategory struct {
        ID   int64  `json:"id"`
        Name string `json:"name"`
        Sort int64  `json:"sort"`
}

type seedHomeBlock struct {
        ID     string `json:"id"`
        Title  string `json:"title"`
        Source string `json:"source"`
        Count  int    `json:"count"`
}

type seedDoc struct {
        Rules      []seedRule     `json:"rules"`
        Categories []seedCategory `json:"categories"`
        Site       struct {
                SiteName     string `json:"siteName"`
                ActiveTheme  string `json:"activeTheme"`
                Notice       string `json:"notice"`
                SeoConfig    string `json:"seoConfig"`
                FooterConfig string `json:"footerConfig"`
        } `json:"site"`
        HomeBlocks []seedHomeBlock `json:"homeBlocks"`
}

// startSeedIfEmpty 启动时播种（main 在 DB 初始化成功后调用；失败仅告警不阻断启动）
func startSeedIfEmpty() {
        go func() {
                if err := seedIfEmpty(); err != nil {
                        log.Printf("[seed] 播种失败（不影响启动）: %v", err)
                }
        }()
}

// repairRuleCorruption 存量规则选择器损坏自愈（Task 34，幂等）：
// 历史外部操作在 DB 中吃掉了规则值里的 "[h" 片段（实测 5 条规则同模式损坏：
// a[href^="/read/"] → aref^="/read/"]、a.tag-link[href*=...] → a.tag-linkref*=...]、
// a[href*="/author/"] → aref*="/author/"] 等），损坏选择器失效后三字段提取被迫
// 全部走内置 og:novel:* 回退。判定精确：仅当「DB 值 == seed 值删除所有 "[h"」时
// 回写 seed 值——误伤面为零（该损坏模式唯一），用户手工编辑过的其他键一律不动。
// 与播种解耦：表非空时也执行；无损坏时零写入。
func repairRuleCorruption(doc *seedDoc) {
        type ruleJSONs struct {
                id                      int64
                listRule, bookRule, chapterRule string
        }
        repaired := 0
        for _, sr := range doc.Rules {
                var row ruleJSONs
                row.id = sr.ID
                err := queryOne(`SELECT "listRule","bookRule","chapterRule" FROM "ScrapeRule" WHERE "id" = ?`,
                        []any{&row.listRule, &row.bookRule, &row.chapterRule}, sr.ID)
                if err != nil {
                        continue // 规则不存在/瞬时锁：跳过（幂等，下次启动再试）
                }
                newList, n1 := repairCorruptJSON(row.listRule, sr.ListRule)
                newBook, n2 := repairCorruptJSON(row.bookRule, sr.BookRule)
                newChap, n3 := repairCorruptJSON(row.chapterRule, sr.ChapterRule)
                if n1+n2+n3 == 0 {
                        continue
                }
                if _, uerr := execRetry(`UPDATE "ScrapeRule" SET "listRule"=?,"bookRule"=?,"chapterRule"=? WHERE "id" = ?`,
                        newList, newBook, newChap, sr.ID); uerr == nil {
                        repaired += n1 + n2 + n3
                }
        }
        if repaired > 0 {
                log.Printf("[seed] 规则选择器损坏自愈：修复 %d 个键值（\"[h\" 片段缺失，Task 34）", repaired)
        }
}

// repairCorruptJSON 对单个规则 JSON 列逐键比对：db 值 == seed 值去 "[h" 时判定损坏，
// 用 seed 键值替换（保留 seed 未配置的键不动——用户自定义扩展不丢失）。返回 (新 JSON, 修复键数)。
func repairCorruptJSON(dbJSON, seedJSON string) (string, int) {
        if trimSpaceStr(dbJSON) == "" || trimSpaceStr(seedJSON) == "" {
                return dbJSON, 0
        }
        var dbMap, seedMap map[string]string
        if json.Unmarshal([]byte(dbJSON), &dbMap) != nil || json.Unmarshal([]byte(seedJSON), &seedMap) != nil {
                return dbJSON, 0 // 结构异常不动（nonEmptyJSON 语义兜底）
        }
        fixed := 0
        for k, seedVal := range seedMap {
                dbVal, ok := dbMap[k]
                if !ok || dbVal == seedVal {
                        continue
                }
                if dbVal == strings.ReplaceAll(seedVal, "[h", "") {
                        dbMap[k] = seedVal
                        fixed++
                }
        }
        if fixed == 0 {
                return dbJSON, 0
        }
        out, err := json.Marshal(dbMap)
        if err != nil {
                return dbJSON, 0
        }
        return string(out), fixed
}

// normalizeLegacyRuleTimestamps 存量 ScrapeRule TEXT 时间戳归一（Task 33-b，幂等）：
// 历史种子与外部工具写入的 'YYYY-MM-DD HH:MM:SS' 文本行（本库 updatedAt 实证存在），
// SQLite 比较规则下 TEXT 恒 > INTEGER、Go 侧 int64 Scan 直接报错——统一归一为 epoch 毫秒
// 整数。只处理 typeof != 'integer' 的行；无法解析的值按 nowMillis() 兜底（宁归一勿悬挂）。
func normalizeLegacyRuleTimestamps() {
        type tsRow struct {
                id                   int64
                createdAt, updatedAt any // TEXT / INTEGER 双存储类（recoverStaleTasks 同口径）
        }
        var rows []tsRow
        if err := queryList(
                `SELECT "id","createdAt","updatedAt" FROM "ScrapeRule" WHERE typeof("createdAt") != 'integer' OR typeof("updatedAt") != 'integer'`,
                func(rs *sql.Rows) error {
                        var r tsRow
                        if err := rs.Scan(&r.id, &r.createdAt, &r.updatedAt); err != nil {
                                return err
                        }
                        rows = append(rows, r)
                        return nil
                }); err != nil {
                return // 表不存在/瞬时锁：下次启动再归一（幂等）
        }
        for _, r := range rows {
                msC := nowMillis()
                if ms, ok := normalizeMillis(r.createdAt); ok {
                        msC = ms
                }
                msU := msC
                if ms, ok := normalizeMillis(r.updatedAt); ok {
                        msU = ms
                }
                if _, err := execRetry(`UPDATE "ScrapeRule" SET "createdAt" = ?, "updatedAt" = ? WHERE "id" = ?`, msC, msU, r.id); err != nil {
                        continue
                }
        }
        if len(rows) > 0 {
                log.Printf("[seed] ScrapeRule TEXT 时间戳归一 %d 行（CURRENT_TIMESTAMP 历史遗留，Task 33-b）", len(rows))
        }
}

func seedIfEmpty() error {
        var doc seedDoc
        if err := json.Unmarshal(seedBlob, &doc); err != nil {
                return err
        }

        // Task 33-b: 先归一存量 TEXT 时间戳（与播种解耦：表非空时也执行）
        normalizeLegacyRuleTimestamps()

        // Task 34: 存量规则选择器损坏自愈（与播种解耦：表非空时也执行，幂等）
        repairRuleCorruption(&doc)

        // ---------- ScrapeRule：空表才导入 ----------
        var ruleCount int
        if err := queryOne(`SELECT COUNT(*) FROM "ScrapeRule"`, []any{&ruleCount}); err != nil {
                return err
        }
        if ruleCount == 0 && len(doc.Rules) > 0 {
                for _, r := range doc.Rules {
                        // Task 33-b: 旧版写 CURRENT_TIMESTAMP（SQLite TEXT 存储类）——违反 Task 31
                        // 落档口径「任何 DB 写 updatedAt 必须用 Go nowMillis()，禁用 SQL
                        // CURRENT_TIMESTAMP」（TEXT > INTEGER 比较错位 + int64 Scan 炸 500，
                        // 本库 ScrapeRule.updatedAt 文本行实证即源于此处）。改为显式毫秒参数。
                        _, err := exec(`INSERT INTO "ScrapeRule"
                                ("id","name","siteUrl","enabled","charset","proxy","insecureTLS","listRule","bookRule","chapterRule","notes","createdAt","updatedAt")
                                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                                r.ID, r.Name, r.SiteURL, boolInt(r.Enabled), r.Charset, r.Proxy, boolInt(r.InsecureTLS),
                                r.ListRule, r.BookRule, r.ChapterRule, r.Notes, nowMillis(), nowMillis())
                        if err != nil {
                                return err
                        }
                }
                log.Printf("[seed] ScrapeRule 空表 → 已播种 %d 条校准规则", len(doc.Rules))
        }

        // ---------- Category：空表才导入 ----------
        var catCount int
        if err := queryOne(`SELECT COUNT(*) FROM "Category"`, []any{&catCount}); err != nil {
                return err
        }
        if catCount == 0 && len(doc.Categories) > 0 {
                for _, c := range doc.Categories {
                        if _, err := exec(`INSERT INTO "Category" ("id","name","sort") VALUES (?,?,?)`,
                                c.ID, c.Name, c.Sort); err != nil {
                                return err
                        }
                }
                log.Printf("[seed] Category 空表 → 已播种 %d 个分类（其他 id=9999 恒末位）", len(doc.Categories))
        }

        // ---------- SiteSetting：先兜底建行（与 api_settings.go 同语句），再补空 homeConfig ----------
        if _, err := exec(`INSERT INTO "SiteSetting" ("id","siteName","activeTheme","notice","seoConfig","footerConfig")
                VALUES (1,?,?,?,?,?) ON CONFLICT("id") DO NOTHING`,
                doc.Site.SiteName, doc.Site.ActiveTheme, doc.Site.Notice, doc.Site.SeoConfig, doc.Site.FooterConfig); err != nil {
                return err
        }
        var hc sql.NullString
        if err := queryOne(`SELECT "homeConfig" FROM "SiteSetting" WHERE "id" = 1`, []any{&hc}); err != nil {
                return err
        }
        blobEmpty := !hc.Valid || trimSpaceStr(hc.String) == "" || trimSpaceStr(hc.String) == "{}"
        if blobEmpty && len(doc.HomeBlocks) > 0 {
                blocks := make([]map[string]any, 0, len(doc.HomeBlocks))
                for _, b := range doc.HomeBlocks {
                        blocks = append(blocks, map[string]any{
                                "id": b.ID, "title": b.Title, "source": b.Source, "count": b.Count,
                        })
                }
                blob, err := json.Marshal(map[string]any{"blocks": blocks})
                if err != nil {
                        return err
                }
                if _, err := exec(`UPDATE "SiteSetting" SET "homeConfig" = ? WHERE "id" = 1`, string(blob)); err != nil {
                        return err
                }
                log.Printf("[seed] homeConfig 空 → 已写入默认 %d 区块（小编精选上移契约位）", len(blocks))
        }
        return nil
}

func boolInt(b bool) int {
        if b {
                return 1
        }
        return 0
}
