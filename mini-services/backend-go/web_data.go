/**
 * web_data.go —— 页面数据装配（模板数据契约的唯一权威来源）。
 *
 * 模板数据 map key 契约（html/template 大小写敏感，均以此为准）：
 *
 * 通用（webCommon，所有页面共享）：
 *   .Site  → {siteName, notice, activeTheme, seoTitle, seoDescription, footerText,
 *             footerExtra, footerLinks[]{label,url}}
 *   .Nav   → [{id,name,sort,novelCount}]（导航分类，其他=9999 天然最后）
 *   .Path  → 当前请求路径（导航高亮）
 *
 * novel 条目字段（queryNovelList 输出，与 novelListCols 一致）：
 *   id,title,author,description,cover,categoryId,categoryName,status,
 *   isFeatured,isHot,wordCount,clicks,updatedAt,chapterCount,lastChapterTitle
 *
 * home:      .Featured[12] .Hot[10] .Latest[14] .RankClicks[10] .RankUpdates[10]
 *            .RankFinished[10] .Stats{novelCount,chapterCount,totalWordCount,todayUpdates}
 *            .HomeBlocks[{id,title,source,count,novels[]}]（后台自定义图文区块，小编精选等）
 * category:  .Category{id,name} .Novels[]（全量，无分页） .FeaturedBlock[6] .HotBlock[8] .Stats
 * book:      .Novel{...同上+updatedAt} .Tags[]（书名+作者+pseo 下拉词）
 *            .Chapters[12]（预览） .ChaptersTotal .LastChapter{idx,title} .Related[6]（同分类）
 * toc:       .Novel .Chapters[]（全量 {id,idx,title,wordCount}）
 * chapter:   .Chapter{id,idx,title,wordCount,Paragraphs[]} .Novel{id,title,author,cover}
 *            .Prev{id,idx,title} .Next{id,idx,title}（可空 → 模板 {{if}}）
 * search:    .Q .Novels[] .Total
 * pseo:      .Keyword .Description .Novels[]
 * admin:     .Rules[] .Tasks[] .Categories[] .Novels[]（前 50） .Settings .Pseo[] .Themes[] .Stats{...}
 */
package main

import (
        "database/sql"
        "encoding/json"
        "net/http"
        "strconv"
        "strings"
)

// ---------- 站点设置 ----------

type webSettings struct {
        SiteName      string
        ActiveTheme   string
        Notice        string
        SeoConfig     map[string]any
        FooterConfig  map[string]any
        HomeConfigRaw sql.NullString
}

// loadWebSettings 读取 SiteSetting 单例行（不存在时返回 nil）
func loadWebSettings() *webSettings {
        var s webSettings
        var seoBlob, footerBlob sql.NullString
        err := queryOne(
                `SELECT "siteName","activeTheme","notice","seoConfig","footerConfig","homeConfig" FROM "SiteSetting" WHERE "id" = 1`,
                []any{&s.SiteName, &s.ActiveTheme, &s.Notice, &seoBlob, &footerBlob, &s.HomeConfigRaw},
        )
        if err != nil {
                return nil
        }
        s.SeoConfig = map[string]any{}
        s.FooterConfig = map[string]any{}
        if seoBlob.Valid && seoBlob.String != "" {
                _ = json.Unmarshal([]byte(seoBlob.String), &s.SeoConfig)
        }
        if footerBlob.Valid && footerBlob.String != "" {
                _ = json.Unmarshal([]byte(footerBlob.String), &s.FooterConfig)
        }
        return &s
}

// webCommon 组装所有页面共享的 Site/Nav/Path 数据块
func webCommon(r *http.Request) map[string]any {
        s := loadWebSettings()
        if s == nil {
                s = &webSettings{SiteName: "青阅文学", ActiveTheme: fallbackTheme, Notice: ""}
        }
        nav := []map[string]any{}
        _ = queryList(
                `SELECT c."id", c."name", c."sort", (SELECT COUNT(*) FROM "Novel" n WHERE n."categoryId" = c."id") FROM "Category" c ORDER BY c."sort" ASC, c."id" ASC`,
                func(rows *sql.Rows) error {
                        var id, sort_, count int64
                        var name string
                        if err := rows.Scan(&id, &name, &sort_, &count); err == nil {
                                nav = append(nav, map[string]any{"id": id, "name": name, "sort": sort_, "novelCount": count})
                        }
                        return nil
                },
        )

        seoTitle, _ := s.SeoConfig["title"].(string)
        seoDescription, _ := s.SeoConfig["description"].(string)
        footerText, _ := s.FooterConfig["text"].(string)
        footerExtra, _ := s.FooterConfig["extra"].(string)
        footerLinks := []map[string]any{}
        if rawLinks, ok := s.FooterConfig["links"].([]any); ok {
                for _, l := range rawLinks {
                        if m, ok := l.(map[string]any); ok {
                                label, _ := m["label"].(string)
                                u, _ := m["url"].(string)
                                if label != "" && u != "" {
                                        footerLinks = append(footerLinks, map[string]any{"label": label, "url": u})
                                }
                        }
                }
        }

        return map[string]any{
                "Site": map[string]any{
                        "siteName":       s.SiteName,
                        "notice":         s.Notice,
                        "activeTheme":    s.ActiveTheme,
                        "seoTitle":       seoTitle,
                        "seoDescription": seoDescription,
                        "footerText":     footerText,
                        "footerExtra":    footerExtra,
                        "footerLinks":    footerLinks,
                },
                "Nav":  nav,
                "Path": r.URL.Path,
        }
}

// gatherHomeStats 首页/分类页共用的统计块
func gatherHomeStats() map[string]any {
        var novelCount, chapterCount, totalWordCount, todayUpdates int64
        dayAgo := nowMillis() - 24*3600*1000
        _ = queryOne(`SELECT COUNT(*) FROM "Novel"`, []any{&novelCount})
        _ = queryOne(`SELECT COUNT(*) FROM "Chapter"`, []any{&chapterCount})
        var sumWC sql.NullInt64
        _ = queryOne(`SELECT SUM("wordCount") FROM "Novel"`, []any{&sumWC})
        totalWordCount = sumWC.Int64
        _ = queryOne(`SELECT COUNT(*) FROM "Chapter" WHERE "createdAt" >= ?`, []any{&todayUpdates}, dayAgo)
        return map[string]any{
                "novelCount":     novelCount,
                "chapterCount":   chapterCount,
                "totalWordCount": totalWordCount,
                "todayUpdates":   todayUpdates,
        }
}

// ---------- 首页 ----------

func handleWebHome(w http.ResponseWriter, r *http.Request) {
        data := webCommon(r)
        featured, _ := queryNovelList(` WHERE n."isFeatured" = 1`, ` ORDER BY n."updatedAt" DESC, n."id" DESC`, nil, 12, 0)
        hot, _ := queryNovelList(` WHERE n."isHot" = 1`, ` ORDER BY n."clicks" DESC, n."id" DESC`, nil, 10, 0)
        latest, _ := queryNovelList("", ` ORDER BY n."updatedAt" DESC, n."id" DESC`, nil, 14, 0)
        rankClicks, _ := queryNovelList("", ` ORDER BY n."clicks" DESC, n."id" DESC`, nil, 10, 0)
        rankUpdates, _ := queryNovelList("", ` ORDER BY n."updatedAt" DESC, n."id" DESC`, nil, 10, 0)
        rankFinished, _ := queryNovelList(` WHERE n."status" = 'finished'`, ` ORDER BY n."clicks" DESC, n."id" DESC`, nil, 10, 0)
        data["Featured"] = featured
        data["Hot"] = hot
        data["Latest"] = latest
        data["RankClicks"] = rankClicks
        data["RankUpdates"] = rankUpdates
        data["RankFinished"] = rankFinished
        data["Stats"] = gatherHomeStats()
        data["HomeBlocks"] = gatherHomeBlocks()

        s := loadWebSettings()
        siteName := "青阅文学"
        if s != nil && s.SiteName != "" {
                siteName = s.SiteName
        }
        data["siteName"] = siteName
        data["pageTitle"] = siteName + " - 免费小说阅读"
        data["pageDescription"] = "最新热门小说免费在线阅读"
        renderPage(w, r, "home", data)
}

// gatherHomeBlocks 按后台 homeConfig 渲染自定义图文区块（小编精选等）。
// 白名单语义与 home-blocks.ts / api_settings.go sanitizeHomeConfig 一致。
func gatherHomeBlocks() []map[string]any {
        s := loadWebSettings()
        if s == nil || !s.HomeConfigRaw.Valid || s.HomeConfigRaw.String == "" {
                return []map[string]any{}
        }
        cfg := parseHomeConfig(s.HomeConfigRaw)
        rawBlocks, _ := cfg["blocks"].([]any)
        out := []map[string]any{}
        for _, rb := range rawBlocks {
                b, ok := rb.(map[string]any)
                if !ok {
                        continue
                }
                id, _ := b["id"].(string)
                title, _ := b["title"].(string)
                source, _ := b["source"].(string)
                count := int(toInt64(b["count"]))
                if count < 4 {
                        count = 4
                }
                if count > 24 {
                        count = 24
                }
                if title == "" || source == "" {
                        continue
                }
                novels := homeBlockNovels(source, count)
                out = append(out, map[string]any{
                        "id": id, "title": title, "source": source, "count": count, "novels": novels,
                })
        }
        return out
}

// homeBlockNovels 按来源取书：latest | hot | featured | cat:<id>
func homeBlockNovels(source string, count int) []map[string]any {
        switch {
        case source == "latest":
                v, _ := queryNovelList("", ` ORDER BY n."updatedAt" DESC, n."id" DESC`, nil, count, 0)
                return v
        case source == "hot":
                v, _ := queryNovelList(` WHERE n."isHot" = 1`, ` ORDER BY n."clicks" DESC, n."id" DESC`, nil, count, 0)
                return v
        case source == "featured":
                v, _ := queryNovelList(` WHERE n."isFeatured" = 1`, ` ORDER BY n."updatedAt" DESC, n."id" DESC`, nil, count, 0)
                return v
        case strings.HasPrefix(source, "cat:"):
                cid, err := strconv.Atoi(strings.TrimPrefix(source, "cat:"))
                if err != nil || cid <= 0 {
                        return []map[string]any{}
                }
                v, _ := queryNovelList(` WHERE n."categoryId" = ?`, ` ORDER BY n."updatedAt" DESC, n."id" DESC`, []any{int64(cid)}, count, 0)
                return v
        }
        return []map[string]any{}
}

// ---------- 分类页 ----------

func handleWebCategory(w http.ResponseWriter, r *http.Request, ps map[string]string) {
        data := webCommon(r)
        cid, err := strconv.ParseInt(ps["id"], 10, 64)
        if err != nil || cid <= 0 {
                web404(w, r, "分类不存在")
                return
        }
        var catName string
        if err := queryOne(`SELECT "name" FROM "Category" WHERE "id" = ?`, []any{&catName}, cid); err != nil {
                web404(w, r, "分类不存在")
                return
        }
        novels, _ := queryNovelList(` WHERE n."categoryId" = ?`, ` ORDER BY n."updatedAt" DESC, n."id" DESC`, []any{cid}, 500, 0)
        featuredBlock, _ := queryNovelList(` WHERE n."categoryId" = ? AND n."isFeatured" = 1`, ` ORDER BY n."updatedAt" DESC, n."id" DESC`, []any{cid}, 6, 0)
        hotBlock, _ := queryNovelList(` WHERE n."categoryId" = ?`, ` ORDER BY n."clicks" DESC, n."id" DESC`, []any{cid}, 8, 0)
        data["Category"] = map[string]any{"id": cid, "name": catName}
        data["Novels"] = novels
        data["FeaturedBlock"] = featuredBlock
        data["HotBlock"] = hotBlock
        data["Stats"] = gatherHomeStats()
        data["siteName"] = data["Site"].(map[string]any)["siteName"]
        data["pageTitle"] = catName + "分类小说列表"
        data["pageDescription"] = catName + "分类热门小说免费在线阅读"
        renderPage(w, r, "category", data)
}

// ---------- 书籍页 ----------

func handleWebBook(w http.ResponseWriter, r *http.Request, ps map[string]string) {
        data := webCommon(r)
        nid, err := strconv.ParseInt(ps["id"], 10, 64)
        if err != nil || nid <= 0 {
                web404(w, r, "书籍不存在")
                return
        }
        novel, err := webNovelFull(nid)
        if err != nil {
                web404(w, r, "书籍不存在")
                return
        }
        data["Novel"] = novel
        title, _ := novel["title"].(string)
        author, _ := novel["author"].(string)
        data["Tags"] = novelPseoTags(title, author)

        chapters := []map[string]any{}
        var chaptersTotal int64
        _ = queryOne(`SELECT COUNT(*) FROM "Chapter" WHERE "novelId" = ?`, []any{&chaptersTotal}, nid)
        _ = queryList(
                `SELECT "id","idx","title","wordCount" FROM "Chapter" WHERE "novelId" = ? ORDER BY "idx" ASC LIMIT 12`,
                func(rows *sql.Rows) error {
                        var id, idx, wc int64
                        var t string
                        if err := rows.Scan(&id, &idx, &t, &wc); err == nil {
                                chapters = append(chapters, map[string]any{"id": id, "idx": idx, "title": t, "wordCount": wc})
                        }
                        return nil
                }, nid)
        data["Chapters"] = chapters
        data["ChaptersTotal"] = chaptersTotal

        var lastID, lastIdx int64
        var lastTitle string
        if err := queryOne(`SELECT "id","idx","title" FROM "Chapter" WHERE "novelId" = ? ORDER BY "idx" DESC LIMIT 1`, []any{&lastID, &lastIdx, &lastTitle}, nid); err == nil {
                data["LastChapter"] = map[string]any{"id": lastID, "idx": lastIdx, "title": lastTitle}
        }

        related, _ := queryNovelList(
                ` WHERE n."categoryId" = (SELECT "categoryId" FROM "Novel" WHERE "id" = ?) AND n."id" != ?`,
                ` ORDER BY n."clicks" DESC, n."id" DESC`, []any{nid, nid}, 6, 0)
        data["Related"] = related

        s := data["Site"].(map[string]any)
        siteName, _ := s["siteName"].(string)
        data["siteName"] = siteName
        data["pageTitle"] = title + "（" + author + "）最新章节列表 - " + siteName
        desc, _ := novel["description"].(string)
        data["pageDescription"] = excerptN(desc, 100)
        renderPage(w, r, "book", data)
}

// webNovelFull 书籍完整行（含 description；novelListCols 不含部分字段，这里单独查全）。
// 查无此书返回 sql.ErrNoRows（调用方据 err 走 404，绝不以 nil,nil 落入渲染分支）
func webNovelFull(nid int64) (map[string]any, error) {
        v, err := queryNovelList(` WHERE n."id" = ?`, ``, []any{nid}, 1, 0)
        if err != nil {
                return nil, err
        }
        if len(v) == 0 {
                return nil, sql.ErrNoRows
        }
        return v[0], nil
}

// ---------- 目录页 ----------

func handleWebToc(w http.ResponseWriter, r *http.Request, ps map[string]string) {
        data := webCommon(r)
        nid, err := strconv.ParseInt(ps["id"], 10, 64)
        if err != nil || nid <= 0 {
                web404(w, r, "书籍不存在")
                return
        }
        novel, err := webNovelFull(nid)
        if err != nil {
                web404(w, r, "书籍不存在")
                return
        }
        data["Novel"] = novel
        chapters := []map[string]any{}
        _ = queryList(
                `SELECT "id","idx","title","wordCount" FROM "Chapter" WHERE "novelId" = ? ORDER BY "idx" ASC`,
                func(rows *sql.Rows) error {
                        var id, idx, wc int64
                        var t string
                        if err := rows.Scan(&id, &idx, &t, &wc); err == nil {
                                chapters = append(chapters, map[string]any{"id": id, "idx": idx, "title": t, "wordCount": wc})
                        }
                        return nil
                }, nid)
        data["Chapters"] = chapters
        title, _ := novel["title"].(string)
        s := data["Site"].(map[string]any)
        siteName, _ := s["siteName"].(string)
        data["siteName"] = siteName
        data["pageTitle"] = title + " 全部章节目录 - " + siteName
        renderPage(w, r, "toc", data)
}

// ---------- 阅读页 ----------

func handleWebChapter(w http.ResponseWriter, r *http.Request, ps map[string]string) {
        data := webCommon(r)
        chid, err := strconv.ParseInt(ps["id"], 10, 64)
        if err != nil || chid <= 0 {
                web404(w, r, "章节不存在")
                return
        }
        var chID, chNovelID, chIdx, chWC int64
        var chTitle, chContent string
        if err := queryOne(
                `SELECT "id","novelId","idx","title","content","wordCount" FROM "Chapter" WHERE "id" = ?`,
                []any{&chID, &chNovelID, &chIdx, &chTitle, &chContent, &chWC}, chid); err != nil {
                web404(w, r, "章节不存在")
                return
        }
        novel, err := webNovelFull(chNovelID)
        if err != nil {
                web404(w, r, "书籍不存在")
                return
        }
        paras := []string{}
        for _, p := range strings.Split(chContent, "\n") {
                p = strings.TrimSpace(p)
                if p != "" {
                        paras = append(paras, p)
                }
        }
        data["Chapter"] = map[string]any{
                "id": chID, "idx": chIdx, "title": chTitle, "wordCount": chWC, "Paragraphs": paras,
        }
        // Paragraphs 顶层副本：主题模板存在 {{range .Paragraphs}} 顶层用法（双挂载兼容两种路径）
        data["Paragraphs"] = paras
        data["Novel"] = novel

        // 上一章/下一章（按 idx 相邻）
        fetchAdj := func(idx int64) map[string]any {
                var id, aidx int64
                var t string
                if err := queryOne(
                        `SELECT "id","idx","title" FROM "Chapter" WHERE "novelId" = ? AND "idx" = ? LIMIT 1`,
                        []any{&id, &aidx, &t}, chNovelID, idx); err != nil {
                        return nil
                }
                return map[string]any{"id": id, "idx": aidx, "title": t}
        }
        data["Prev"] = fetchAdj(chIdx - 1)
        data["Next"] = fetchAdj(chIdx + 1)

        title, _ := novel["title"].(string)
        s := data["Site"].(map[string]any)
        siteName, _ := s["siteName"].(string)
        data["siteName"] = siteName
        data["pageTitle"] = title + " " + chTitle + " - " + siteName
        renderPage(w, r, "chapter", data)
}

// ---------- 搜索页 ----------

func handleWebSearch(w http.ResponseWriter, r *http.Request) {
        data := webCommon(r)
        q := strings.TrimSpace(r.URL.Query().Get("q"))
        if len([]rune(q)) > 60 {
                q = string([]rune(q)[:60])
        }
        data["Q"] = q
        novels := []map[string]any{}
        if q != "" {
                like := "%" + strings.NewReplacer("%", `\%`, "_", `\_`).Replace(q) + `%`
                var total int64
                _ = queryOne(
                        `SELECT COUNT(*) FROM "Novel" n WHERE n."title" LIKE ? ESCAPE '\' OR n."author" LIKE ? ESCAPE '\'`,
                        []any{&total}, like, like)
                novels, _ = queryNovelList(
                        ` WHERE n."title" LIKE ? ESCAPE '\' OR n."author" LIKE ? ESCAPE '\'`,
                        ` ORDER BY n."clicks" DESC, n."id" DESC`, []any{like, like}, 100, 0)
                data["Total"] = total
        } else {
                data["Total"] = int64(0)
        }
        data["Novels"] = novels
        s := data["Site"].(map[string]any)
        siteName, _ := s["siteName"].(string)
        data["siteName"] = siteName
        data["pageTitle"] = "搜索：" + q + " - " + siteName
        renderPage(w, r, "search", data)
}

// ---------- pseo 聚合页 ----------

func handleWebPseo(w http.ResponseWriter, r *http.Request, ps map[string]string) {
        kw := ps["kw"]
        if kw == "" {
                web404(w, r, "聚合页不存在")
                return
        }
        data := webCommon(r)
        var status string
        var pageData sql.NullString
        err := queryOne(`SELECT "status","pageData" FROM "PseoKeyword" WHERE "keyword" = ?`, []any{&status, &pageData}, kw)
        if err != nil || status != "generated" || !pageData.Valid || pageData.String == "" {
                web404(w, r, "聚合页不存在")
                return
        }
        var saved struct {
                Description string    `json:"generatedDescription"`
                NovelIDs    []float64 `json:"novelIds"`
        }
        if err := json.Unmarshal([]byte(pageData.String), &saved); err != nil {
                web404(w, r, "聚合页数据损坏")
                return
        }
        // 按 novelIds 原序取书（绑定书置顶=最佳匹配语义，与 api_pseo 一致）
        novels := []map[string]any{}
        seen := map[int64]bool{}
        for _, fid := range saved.NovelIDs {
                id := int64(fid)
                if id <= 0 || seen[id] {
                        continue
                }
                seen[id] = true
                v, err := webNovelFull(id)
                if err == nil {
                        novels = append(novels, v)
                }
        }
        desc := saved.Description
        if desc == "" {
                s := data["Site"].(map[string]any)
                siteName, _ := s["siteName"].(string)
                desc = siteName + "为您精选与“" + kw + "”相关的小说合集，在线免费阅读。"
        }
        data["Keyword"] = kw
        data["Description"] = desc
        data["Novels"] = novels
        s := data["Site"].(map[string]any)
        siteName, _ := s["siteName"].(string)
        data["siteName"] = siteName
        data["pageTitle"] = "关于“" + kw + "”的小说推荐 - " + siteName
        data["pageDescription"] = excerptN(desc, 100)
        renderPage(w, r, "pseo", data)
}

// ---------- 管理后台 ----------

func handleWebAdmin(w http.ResponseWriter, r *http.Request) {
        data := webCommon(r)
        // admin 页面固定用 templates/admin/admin.html（自包含 layout，不随前台主题切换）
        data["theme"] = "admin"

        rules := []map[string]any{}
        _ = queryList(
                `SELECT "id","name","siteUrl","enabled","charset","proxy","insecureTLS","notes","updatedAt" FROM "ScrapeRule" ORDER BY "id" ASC`,
                func(rows *sql.Rows) error {
                        var id int64
                        var name, siteUrl, charset, proxy, notes string
                        var enabled, insecure bool
                        var updated any
                        if err := rows.Scan(&id, &name, &siteUrl, &enabled, &charset, &proxy, &insecure, &notes, &updated); err == nil {
                                rules = append(rules, map[string]any{
                                        "id": id, "name": name, "siteUrl": siteUrl, "enabled": enabled,
                                        "charset": charset, "proxy": proxy, "insecureTLS": insecure,
                                        "notes": notes, "updatedAt": updated,
                                })
                        }
                        return nil
                })
        data["Rules"] = rules

        tasks := []map[string]any{}
        _ = queryList(
                `SELECT t."id", COALESCE(t."ruleId",0), COALESCE(r."name",''), t."mode", t."targetUrl", t."pages", t."status", t."total", t."done", t."created", t."updated", t."chapters", t."message", t."updatedAt" FROM "ScrapeTask" t LEFT JOIN "ScrapeRule" r ON r."id" = t."ruleId" ORDER BY t."id" DESC LIMIT 100`,
                func(rows *sql.Rows) error {
                        var id, ruleID, pages, total, done, created, updatedN, chapters int64
                        var ruleName, mode, targetUrl, status, message string
                        var updatedAt any
                        if err := rows.Scan(&id, &ruleID, &ruleName, &mode, &targetUrl, &pages, &status, &total, &done, &created, &updatedN, &chapters, &message, &updatedAt); err == nil {
                                tasks = append(tasks, map[string]any{
                                        "id": id, "ruleId": ruleID, "ruleName": ruleName, "mode": mode,
                                        "targetUrl": targetUrl, "pages": pages, "status": status,
                                        "total": total, "done": done, "created": created, "updated": updatedN,
                                        "chapters": chapters, "message": message, "updatedAt": updatedAt,
                                })
                        }
                        return nil
                })
        data["Tasks"] = tasks
        data["Categories"] = navCategoriesAll()
        data["Pseo"] = pseoList(50)
        data["Themes"] = themeNames
        data["Settings"] = adminSettings()

        novels, _ := queryNovelList("", ` ORDER BY n."updatedAt" DESC, n."id" DESC`, nil, 50, 0)
        data["Novels"] = novels
        data["Stats"] = adminStats()

        s := data["Site"].(map[string]any)
        siteName, _ := s["siteName"].(string)
        data["siteName"] = siteName
        data["pageTitle"] = "站点管理后台"
        renderPage(w, r, "admin", data)
}

func navCategoriesAll() []map[string]any {
        out := []map[string]any{}
        _ = queryList(
                `SELECT c."id", c."name", c."sort", (SELECT COUNT(*) FROM "Novel" n WHERE n."categoryId" = c."id") FROM "Category" c ORDER BY c."sort" ASC, c."id" ASC`,
                func(rows *sql.Rows) error {
                        var id, sort_, count int64
                        var name string
                        if err := rows.Scan(&id, &name, &sort_, &count); err == nil {
                                out = append(out, map[string]any{"id": id, "name": name, "sort": sort_, "novelCount": count})
                        }
                        return nil
                })
        return out
}

func pseoList(limit int) []map[string]any {
        out := []map[string]any{}
        _ = queryList(
                `SELECT "id","keyword","source","status","createdAt" FROM "PseoKeyword" ORDER BY "id" DESC LIMIT ?`,
                func(rows *sql.Rows) error {
                        var id int64
                        var kw, source, status string
                        var createdAt any
                        if err := rows.Scan(&id, &kw, &source, &status, &createdAt); err == nil {
                                out = append(out, map[string]any{"id": id, "keyword": kw, "source": source, "status": status, "createdAt": createdAt})
                        }
                        return nil
                }, limit)
        return out
}

func adminSettings() map[string]any {
        s := loadWebSettings()
        if s == nil {
                return map[string]any{}
        }
        return map[string]any{
                "siteName":    s.SiteName,
                "activeTheme": s.ActiveTheme,
                "notice":      s.Notice,
        }
}

func adminStats() map[string]any {
        var novelCount, chapterCount, taskCount, ruleCount, pseoCount int64
        _ = queryOne(`SELECT COUNT(*) FROM "Novel"`, []any{&novelCount})
        _ = queryOne(`SELECT COUNT(*) FROM "Chapter"`, []any{&chapterCount})
        _ = queryOne(`SELECT COUNT(*) FROM "ScrapeTask"`, []any{&taskCount})
        _ = queryOne(`SELECT COUNT(*) FROM "ScrapeRule"`, []any{&ruleCount})
        _ = queryOne(`SELECT COUNT(*) FROM "PseoKeyword"`, []any{&pseoCount})
        return map[string]any{
                "novelCount": novelCount, "chapterCount": chapterCount,
                "taskCount": taskCount, "ruleCount": ruleCount, "pseoCount": pseoCount,
        }
}

// ---------- 404 ----------

// web404 极简 404 页（不走主题模板，避免主题缺页时二次失败）
func web404(w http.ResponseWriter, r *http.Request, msg string) {
        w.Header().Set("Content-Type", "text/html; charset=utf-8")
        w.WriteHeader(404)
        s := loadWebSettings()
        name := "青阅文学"
        if s != nil && s.SiteName != "" {
                name = s.SiteName
        }
        _, _ = w.Write([]byte(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>404 - ` + name + `</title></head>` +
                `<body style="margin:0;font-family:system-ui,sans-serif;background:#fafafa"><div style="max-width:480px;margin:12vh auto;text-align:center;padding:0 16px">` +
                `<p style="font-size:64px;margin:0;color:#d4d4d4;font-weight:700">404</p>` +
                `<p style="color:#525252;margin:16px 0">` + msg + `</p>` +
                `<a href="/" style="display:inline-block;padding:10px 24px;background:#171717;color:#fff;border-radius:8px;text-decoration:none">返回首页</a>` +
                `</div></body></html>`))
}
