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

func seedIfEmpty() error {
        var doc seedDoc
        if err := json.Unmarshal(seedBlob, &doc); err != nil {
                return err
        }

        // ---------- ScrapeRule：空表才导入 ----------
        var ruleCount int
        if err := queryOne(`SELECT COUNT(*) FROM "ScrapeRule"`, []any{&ruleCount}); err != nil {
                return err
        }
        if ruleCount == 0 && len(doc.Rules) > 0 {
                for _, r := range doc.Rules {
                        _, err := exec(`INSERT INTO "ScrapeRule"
                                ("id","name","siteUrl","enabled","charset","proxy","insecureTLS","listRule","bookRule","chapterRule","notes","createdAt","updatedAt")
                                VALUES (?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
                                r.ID, r.Name, r.SiteURL, boolInt(r.Enabled), r.Charset, r.Proxy, boolInt(r.InsecureTLS),
                                r.ListRule, r.BookRule, r.ChapterRule, r.Notes)
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
