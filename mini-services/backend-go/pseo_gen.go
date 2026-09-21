/**
 * pseo_gen.go —— PSEO 共享逻辑：运行配置存取 / 关键词入库 / pending 聚合页生成。
 *
 * TS 源：src/lib/pseo.ts（逐行移植）
 *   - DEFAULT_PSEO_CONFIG / sanitizePseoConfig / getPseoConfig / savePseoConfig
 *   - insertKeywords（批内去重 + 存在跳过 + 唯一冲突竞态容错）
 *   - matchNovels / generatePendingPages（自动 TDK 模板）
 * 依赖：renderTpl/sanitizeSeoConfig（api_settings.go）、serializeSettingsWrite
 * （进程内串行锁 → withSettingsLock）、sanitizeKeyword（pseo_suggest.go）
 *
 * 存储契约：PseoRunnerConfig 持久化于 SiteSetting.seoConfig JSON 的 pseo 字段
 * （免 schema 变更）；savePseoConfig 只动 pseo 字段，不影响 TDK 模板。
 *
 * 移植语义差异：
 * 1. Math.round 半上取整（4.5→5、-4.5→-4）→ jsRound；Number(x)||default 的
 *    NaN/0 回落语义逐一对齐
 * 2. PseoKeyword 无 updatedAt 默认值可用（Prisma @updatedAt）→ INSERT/UPDATE 显式写 ms 时间戳
 * 3. savePseoConfig 的 JS 展开合并 → 显式 map 合并（数组 patch 无键可合，语义等价）
 * 4. TS 未捕获 DB 异常 → 调用方路由统一返回 500 {error,detail}（TS 为 Next HTML 500）
 */
package main

import (
	"database/sql"
	"math"
	"strings"
)

// pseoRunnerConfig 运行配置（字段名与 TS PseoRunnerConfig 一致）
type pseoRunnerConfig struct {
	Sources      []string `json:"sources"`
	Seeds        []string `json:"seeds"`
	PerSeedLimit int      `json:"perSeedLimit"`
	MaxKeywords  int      `json:"maxKeywords"`
	Expand       bool     `json:"expand"`
	AutoGenerate bool     `json:"autoGenerate"`
}

// defaultPseoConfig TS DEFAULT_PSEO_CONFIG
func defaultPseoConfig() pseoRunnerConfig {
	return pseoRunnerConfig{
		Sources:      append([]string(nil), supportedEngines...),
		Seeds:        []string{},
		PerSeedLimit: 12,
		MaxKeywords:  200,
		Expand:       false,
		AutoGenerate: true,
	}
}

// jsRound JS Math.round（半上取整，含负数语义）
func jsRound(f float64) float64 {
	return math.Floor(f + 0.5)
}

// dedupTrim 去空 + 去重保序
func dedupTrim(words []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(words))
	for _, w := range words {
		if w == "" || seen[w] {
			continue
		}
		seen[w] = true
		out = append(out, w)
	}
	return out
}

// sanitizePseoConfig 任意来源的配置对象 → 合法 PseoRunnerConfig
// （引擎白名单、种子清洗限 20、数值夹取、布尔归一）
func sanitizePseoConfig(raw any) pseoRunnerConfig {
	def := defaultPseoConfig()
	r, _ := raw.(map[string]any)
	if r == nil {
		r = map[string]any{}
	}

	sources := []string{}
	if arr, ok := r["sources"].([]any); ok {
		for _, s := range arr {
			if sv, ok := s.(string); ok && supportedEngineSet[sv] {
				sources = append(sources, sv)
			}
		}
	}
	sources = dedupTrim(sources)
	if len(sources) == 0 {
		sources = def.Sources
	}

	// seeds 兼容数组（API）与多行字符串（调试直传）两种形态
	seedsRaw := []any{}
	switch v := r["seeds"].(type) {
	case []any:
		seedsRaw = v
	case string:
		for _, line := range strings.Split(v, "\n") {
			seedsRaw = append(seedsRaw, line)
		}
	}
	seeds := []string{}
	for _, s := range seedsRaw {
		if c := sanitizeKeyword(s); c != "" {
			seeds = append(seeds, c)
		}
	}
	seeds = dedupTrim(seeds)
	if len(seeds) > 20 {
		seeds = seeds[:20]
	}

	num := jsNumber(r["perSeedLimit"])
	perSeedLimit := def.PerSeedLimit
	if !math.IsNaN(num) && num != 0 {
		perSeedLimit = clampInt(int(jsRound(num)), 3, 20)
	}
	num = jsNumber(r["maxKeywords"])
	maxKeywords := def.MaxKeywords
	if !math.IsNaN(num) && num != 0 {
		maxKeywords = clampInt(int(jsRound(num)), 10, 500)
	}

	expand := false
	if b, ok := r["expand"].(bool); ok {
		expand = b
	}
	autoGenerate := true
	if b, ok := r["autoGenerate"].(bool); ok && !b {
		autoGenerate = false // TS r.autoGenerate !== false：仅显式 false 为 false
	}

	return pseoRunnerConfig{
		Sources:      sources,
		Seeds:        seeds,
		PerSeedLimit: perSeedLimit,
		MaxKeywords:  maxKeywords,
		Expand:       expand,
		AutoGenerate: autoGenerate,
	}
}

// parseSeoConfigBlob 安全解析 seoConfig JSON（损坏 → {}）
func parseSeoConfigBlob(blob sql.NullString) map[string]any {
	return safeParseJSONBlob(blob)
}

// getPseoConfig 读取站点设置中的 PSEO 运行配置（缺失/损坏回退默认值）
func getPseoConfig() (pseoRunnerConfig, error) {
	var blob sql.NullString
	err := queryOne(`SELECT "seoConfig" FROM "SiteSetting" WHERE "id" = 1`, []any{&blob})
	if err != nil {
		if isNoRows(err) {
			return sanitizePseoConfig(nil), nil
		}
		return defaultPseoConfig(), err
	}
	parsed := parseSeoConfigBlob(blob)
	return sanitizePseoConfig(parsed["pseo"]), nil
}

// configToMap 配置 → map（用于展开合并）
func configToMap(c pseoRunnerConfig) map[string]any {
	src := make([]any, 0, len(c.Sources))
	for _, s := range c.Sources {
		src = append(src, s)
	}
	seeds := make([]any, 0, len(c.Seeds))
	for _, s := range c.Seeds {
		seeds = append(seeds, s)
	}
	return map[string]any{
		"sources":      src,
		"seeds":        seeds,
		"perSeedLimit": c.PerSeedLimit,
		"maxKeywords":  c.MaxKeywords,
		"expand":       c.Expand,
		"autoGenerate": c.AutoGenerate,
	}
}

// savePseoConfig 合并写入 PSEO 运行配置（seoConfig JSON 读改写，串行锁防互覆），
// 返回保存后的完整配置。
func savePseoConfig(patch any) (pseoRunnerConfig, error) {
	var out pseoRunnerConfig
	var saveErr error
	withSettingsLock(func() {
		if err := ensureSettingRow(); err != nil {
			saveErr = err
			return
		}
		var blob sql.NullString
		if err := queryOne(`SELECT "seoConfig" FROM "SiteSetting" WHERE "id" = 1`, []any{&blob}); err != nil {
			saveErr = err
			return
		}
		parsed := parseSeoConfigBlob(blob)
		current := sanitizePseoConfig(parsed["pseo"])
		merged := configToMap(current)
		if pm, ok := patch.(map[string]any); ok {
			for k, v := range pm {
				merged[k] = v
			}
		}
		saved := sanitizePseoConfig(merged)
		parsed["pseo"] = configToMap(saved)
		if _, err := exec(`UPDATE "SiteSetting" SET "seoConfig" = ? WHERE "id" = 1`, marshalCompact(parsed)); err != nil {
			saveErr = err
			return
		}
		out = saved
	})
	return out, saveErr
}

// insertKeywords 关键词按序入库（跳过已存在 + 唯一冲突竞态容错），返回新增数。
// entries 先截断到 cap 再批内去重；source 取该词首次出现时的引擎标记。
func insertKeywords(entries []kwEntry, capLimit int) (int, error) {
	engineOf := map[string]string{}
	ordered := make([]string, 0)
	for i, e := range entries {
		if i >= capLimit {
			break
		}
		if e.Word == "" {
			continue
		}
		if _, exists := engineOf[e.Word]; !exists {
			engineOf[e.Word] = e.Engine
			ordered = append(ordered, e.Word)
		}
	}
	if len(ordered) == 0 {
		return 0, nil
	}
	// 批内已去重，ordered ≤ cap ≤ 500，单条 IN 查询安全（SQLite 变量上限兜底）
	existingSet := map[string]bool{}
	ph := strings.TrimSuffix(strings.Repeat("?,", len(ordered)), ",")
	args := make([]any, 0, len(ordered))
	for _, kw := range ordered {
		args = append(args, kw)
	}
	err := queryList(`SELECT "keyword" FROM "PseoKeyword" WHERE "keyword" IN (`+ph+`)`,
		func(rows *sql.Rows) error {
			var kw string
			if err := rows.Scan(&kw); err != nil {
				return err
			}
			existingSet[kw] = true
			return nil
		}, args...)
	if err != nil {
		return 0, err
	}
	added := 0
	now := nowMillis()
	for _, kw := range ordered {
		if existingSet[kw] {
			continue
		}
		// TS .catch(() => false)：任何入库错误（含并发撞 UNIQUE）均视为已存在，不中断批次
		if _, err := exec(
			`INSERT INTO "PseoKeyword" ("keyword","source","status","createdAt","updatedAt") VALUES (?,?,'pending',?,?)`,
			kw, engineOf[kw], now, now,
		); err == nil {
			added++
		}
	}
	return added, nil
}

// matchNovels 关键词 → 命中书籍聚合（标题/作者/分类/简介包含关键词，命中不足回退热门书）
func matchNovels(keyword string) ([]map[string]any, error) {
	parts := splitJSSpace(keyword)
	var novels []map[string]any
	var err error
	if len(parts) > 0 {
		conds := make([]string, 0, len(parts))
		args := make([]any, 0, len(parts)*4)
		for _, p := range parts {
			conds = append(conds, `(n."title" LIKE ? OR n."author" LIKE ? OR n."description" LIKE ? OR c."name" LIKE ?)`)
			like := likeWrap(p)
			args = append(args, like, like, like, like)
		}
		whereSQL := " WHERE " + strings.Join(conds, " OR ")
		novels, err = queryNovelList(whereSQL, ` ORDER BY n."clicks" DESC, n."id" DESC`, args, 12, 0)
		if err != nil {
			return nil, err
		}
	}
	if len(novels) < 3 {
		fallback, ferr := queryNovelList("", ` ORDER BY n."clicks" DESC, n."id" DESC`, nil, 12, 0)
		if ferr != nil {
			return nil, ferr
		}
		novels = fallback
	}
	return novels, nil
}

// generatePendingPages 为 pending 关键词生成 PSEO 聚合页数据（自动 TDK 模板），返回生成数
func generatePendingPages(limit int) (int, error) {
	take := limit
	if take > 50 {
		take = 50
	}
	if take < 1 {
		take = 1
	}
	type pendingRow struct {
		id      int64
		keyword string
	}
	pending := make([]pendingRow, 0)
	if err := queryList(`SELECT "id","keyword" FROM "PseoKeyword" WHERE "status" = 'pending' ORDER BY "id" ASC LIMIT ?`,
		func(rows *sql.Rows) error {
			var p pendingRow
			if err := rows.Scan(&p.id, &p.keyword); err != nil {
				return err
			}
			pending = append(pending, p)
			return nil
		}, take); err != nil {
		return 0, err
	}

	siteName := "青阅文学" // TS setting?.siteName ?? '青阅文学'：无行时回退默认，行存在时空串原样保留
	var seoBlob sql.NullString
	if err := queryOne(`SELECT "siteName","seoConfig" FROM "SiteSetting" WHERE "id" = 1`, []any{&siteName, &seoBlob}); err != nil && !isNoRows(err) {
		return 0, err
	}
	// 白名单清洗：seoConfig 可能含非字符串模板（历史脏数据），renderTpl 需拿到可靠字符串
	seo := sanitizeSeoConfig(parseSeoConfigBlob(seoBlob))
	seoTitle, _ := seo["pseoTitle"].(string)
	seoDesc, _ := seo["pseoDescription"].(string)
	seoKeywords, _ := seo["pseoKeywords"].(string)

	generated := 0
	now := nowMillis()
	for _, row := range pending {
		novels, err := matchNovels(row.keyword)
		if err != nil {
			_, _ = exec(`UPDATE "PseoKeyword" SET "status" = 'failed', "updatedAt" = ? WHERE "id" = ?`, nowMillis(), row.id)
			continue
		}
		novelTitle, author := "", ""
		if len(novels) > 0 {
			novelTitle, _ = novels[0]["title"].(string)
			author, _ = novels[0]["author"].(string)
		}
		novelIDs := make([]any, 0, len(novels))
		for _, n := range novels {
			if idv, ok := n["id"].(int64); ok {
				novelIDs = append(novelIDs, idv)
			}
		}
		vars := map[string]string{
			"siteName":   siteName,
			"keyword":    row.keyword,
			"count":      itoa(len(novels)),
			"novelTitle": novelTitle,
			"author":     author,
		}
		pageData := map[string]any{
			"novelIds":    novelIDs,
			"title":       renderTpl(seoTitle, vars),
			"description": renderTpl(seoDesc, vars),
			"keywords":    renderTpl(seoKeywords, vars),
		}
		if _, err := exec(
			`UPDATE "PseoKeyword" SET "status" = 'generated', "pageData" = ?, "updatedAt" = ? WHERE "id" = ?`,
			marshalCompact(pageData), now, row.id,
		); err == nil {
			generated++
		} else {
			_, _ = exec(`UPDATE "PseoKeyword" SET "status" = 'failed', "updatedAt" = ? WHERE "id" = ?`, nowMillis(), row.id)
		}
	}
	return generated, nil
}
