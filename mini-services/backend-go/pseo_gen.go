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
	"log"
	"math"
	"strconv"
	"strings"
	"sync/atomic"
	"unicode"
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

// kwNormalize 关键词归一形（Task 40 书籍页「相关标签」鲁棒匹配的基座）：
//  1. 全角 ASCII 变体（U+FF01–U+FF5E）折叠为半角（？→?，：→:，Ａ→A…）——搜索引擎
//     返回的下拉词与站内书名在标点宽度上不一致是常态（书 293 实证：书名「二次元画风？」
//     全角问号 vs 下拉词「二次元画风?笔趣阁」半角问号，严格子串 LIKE 全量漏配）
//  2. 去除全部空白（unicode.White_Space，含全角空格/Tab/NBSP）——「捡个总裁老婆 小说」
//     vs 「捡个总裁老婆小说」等空格形态差异同样导致漏配；对标签匹配语义而言召回优先
//  3. 小写化（Latin 字母场景）
//
// 写入侧（insertKeywords/enqueuePseoBookSeed/存量回填）与查询侧（novelPseoTags）共用，
// 保证归一形口径全局一致。仅用于匹配，不改变 keyword 原文展示。
func kwNormalize(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if unicode.IsSpace(r) {
			continue
		}
		if r >= 0xFF01 && r <= 0xFF5E {
			r -= 0xFEE0
		}
		b.WriteRune(r)
	}
	return strings.ToLower(b.String())
}

// backfillPseoKeywordNorm 存量词一次性归一回填（Task 40，幂等）：kwNorm 列引入前入库的
// 词全部为空串，补算归一形；只扫 kwNorm=” 行，回填完成后重复调用零开销（空库零开销）。
// 在 getDB once 回调内用传入的局部 *sql.DB 调用（Task 30 P1 死锁教训）。
// 前提：kwNorm 列已由 ensureColumn 保证存在（kwNormalize 不可能产出空串——keyword
// 入库前已 sanitize 去空白，归一后再去空白不会变空，空串只可能是未回填标记）。
func backfillPseoKeywordNorm(db *sql.DB) error {
	type kwRow struct {
		id      int64
		keyword string
	}
	rows := make([]kwRow, 0, 256)
	if err := func() error {
		rs, err := db.Query(`SELECT "id","keyword" FROM "PseoKeyword" WHERE "kwNorm" = ''`)
		if err != nil {
			return err
		}
		defer rs.Close()
		for rs.Next() {
			var r kwRow
			if err := rs.Scan(&r.id, &r.keyword); err != nil {
				return err
			}
			rows = append(rows, r)
		}
		return rs.Err()
	}(); err != nil {
		return err
	}
	if len(rows) == 0 {
		return nil
	}
	for _, r := range rows {
		if _, err := db.Exec(`UPDATE "PseoKeyword" SET "kwNorm" = ? WHERE "id" = ?`, kwNormalize(r.keyword), r.id); err != nil {
			return err
		}
	}
	log.Printf("[db] PseoKeyword.kwNorm 存量回填完成（%d 行）", len(rows))
	return nil
}

// insertKeywords 关键词按序入库（跳过已存在 + 唯一冲突竞态容错），返回新增数。
// entries 先截断到 cap 再批内去重；source 取该词首次出现时的引擎标记。
// seed（Task 40）：血缘种子（产词来源关键词，如书名种子富集传书名），空串=无血缘
// （管理端手工添加等）；同时落 kwNorm 归一形供书籍页归一匹配（调用方保证 Word 已 sanitize）。
func insertKeywords(entries []kwEntry, capLimit int, seed string) (int, error) {
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
		// TS .catch(() => false)：任何入库错误（含并发撞 UNIQUE）均视为已存在，不中断批次；
		// Task 40: 非 UNIQUE 类错误（如占位符/列数不匹配）补日志——静默吞错会掩盖真实缺陷
		// （本次开发中 7 占位符 vs 6 参数曾致整批静默丢失，added=0 无任何痕迹）
		// Task 40: kwNorm 归一形 + seed 血缘同步落库
		if _, err := exec(
			`INSERT INTO "PseoKeyword" ("keyword","source","status","createdAt","updatedAt","kwNorm","seed") VALUES (?,?,'pending',?,?,?,?)`,
			kw, engineOf[kw], now, now, kwNormalize(kw), seed,
		); err == nil {
			added++
		} else if !isUniqueConflict(err) {
			log.Printf("[backend-go-pseo] 关键词入库失败（非唯一冲突）keyword=%q: %v", truncateRunes(kw, 40), err)
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

// ==================== pSEO 文本句式变体（Task 45-a 伪原创） ====================
//
// 聚合页为程序生成内容，默认模板下全部页面共用同一句式骨架（「{keyword}小说推荐_关于
// {keyword}的小说 - {siteName}」× N 页），属典型同质化信号。句式变体池让同类页面文本
// 结构互不相同（伪原创），同时保留关键词与站点信息（SEO 语义不变）。
//
// 选择机制：base = FNV-1a(keyword)，salt = 全局单调 tick + 当前毫秒 ——
//   - 同词不同次生成：tick/时间不同 → 变体必然轮换；
//   - 同批相邻页：lastIdx 错位强制相邻页变体下标不同（双保险）。
// 仅当后台配置仍为内置默认模板时启用变体（pool[0] 即内置默认句式；pseoDescTplDefaultAlt
// 为 admin TDK 预设保存的直引号孪生形态，同视为默认）；用户自定义模板原样保留，绝不覆盖
// 后台配置意图。pageData 结构契约（novelIds/title/description/keywords）零变更。

var pseoTitleVariants = []string{
	defaultSeo["pseoTitle"], // 与出厂默认一致（保底句式保留在池中）
	"{keyword}相关小说大全_{keyword}热门小说推荐 - {siteName}",
	"精选{keyword}题材小说合集_{count}本热门作品 - {siteName}",
	"{keyword}小说哪里看？{siteName}收录{count}本热门作品免费阅读",
	"{keyword}小说排行榜_必看{keyword}小说推荐 - {siteName}",
	"关于{keyword}的小说免费阅读_{siteName}全本精选",
	"{keyword}小说免费在线阅读_今日精选{count}本 - {siteName}",
	"{keyword}完结小说大全_{siteName}热门{keyword}作品集",
}

var pseoDescVariants = []string{
	defaultSeo["pseoDescription"], // 与出厂默认一致
	"关于{keyword}的小说大全：{siteName}共收录{count}本相关作品，《{novelTitle}》等热门佳作免费在线阅读，每日更新。",
	"本站汇集{count}本{keyword}题材小说，《{novelTitle}》领衔，{keyword}相关作品持续更新，欢迎免费阅读。",
	"{keyword}小说推荐专区——{siteName}精选{count}部相关小说，涵盖热门完结与连载新作，全本免费畅读。",
	"想找{keyword}相关的小说？{siteName}聚合{count}本人气作品，《{novelTitle}》等佳作随时在线阅读。",
	"{siteName}整理{keyword}主题书单：{count}本高分小说一键直达，支持全本免费在线阅读。",
	"精选{keyword}相关小说{count}本，《{novelTitle}》等热门作品收录其中，全站免费在线阅读。",
	"{siteName}为书友推荐{keyword}题材佳作{count}本，《{novelTitle}》领衔热榜，免费在线阅读。",
}

var pseoKeywordsVariants = []string{
	defaultSeo["pseoKeywords"], // 与出厂默认一致
	"{keyword},{keyword}小说大全,{keyword}免费阅读",
	"{keyword}小说,{keyword}推荐,{keyword}排行榜",
	"{keyword}小说推荐,{keyword}热门小说,{keyword}合集",
}

// pseoDescTplDefaultAlt admin「TDK 预设」保存的描述模板（直引号形态，与出厂默认弯引号
// 孪生）——命中同样启用变体池，避免预设保存后伪原创失效
const pseoDescTplDefaultAlt = `{siteName}为您精选与"{keyword}"相关的小说合集，包含 {count} 本热门作品，在线免费阅读。`

// pseoVariantTick 全局单调计数（原子）：同批相邻页 tick 连续 → 变体必然错开
var pseoVariantTick uint64

// fnv1a64 FNV-1a 64 位哈希（keyword → 稳定基底，跨重启一致）
func fnv1a64(s string) uint64 {
	h := uint64(14695981039346656037)
	for i := 0; i < len(s); i++ {
		h ^= uint64(s[i])
		h *= 1099511628211
	}
	return h
}

// pseoVariantPick 纯函数：(base + salt) mod n —— 测试可注入盐值确定性验证
func pseoVariantPick(base, salt uint64, n int) int {
	if n <= 0 {
		return 0
	}
	return int((base + salt) % uint64(n))
}

// pseoVariantIndex 关键词变体下标。盐 = 关键词|tick 联合哈希（FNV 雪崩）^ 当前毫秒：
// 直用小整数 tick 作盐会与基底哈希的奇偶分量共振（(base+tick)%n 在同毫秒批量生成时
// 塌缩为 2 句式交替——生产实证），联合哈希充分打散后同批相邻页错开、同词跨批次轮换。
func pseoVariantIndex(keyword string, n int) int {
	tick := atomic.AddUint64(&pseoVariantTick, 1)
	salt := fnv1a64(keyword+"|"+strconv.FormatUint(tick, 10)) ^ uint64(nowMillis())
	return pseoVariantPick(fnv1a64(keyword), salt, n)
}

// pseoTplIsDefault 配置模板是否仍为内置默认形态（pool[0] 或附加孪生形态）
func pseoTplIsDefault(configured string, pool []string, alts []string) bool {
	if configured == pool[0] {
		return true
	}
	for _, a := range alts {
		if configured == a {
			return true
		}
	}
	return false
}

// pickPseoTpl 配置模板为内置默认 → 从变体池按 keyword 选取（伪原创）；自定义模板原样保留。
// lastIdx 记录同批上一页下标，强制相邻页错开（可 nil）。
func pickPseoTpl(configured string, pool []string, alts []string, keyword string, lastIdx *int) string {
	if !pseoTplIsDefault(configured, pool, alts) {
		return configured
	}
	idx := pseoVariantIndex(keyword, len(pool))
	if lastIdx != nil && idx == *lastIdx {
		idx = (idx + 1) % len(pool)
	}
	if lastIdx != nil {
		*lastIdx = idx
	}
	return pool[idx]
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
	// Task 45-a: 句式变体轮转游标（同批相邻页变体下标强制错开）
	lastTitleIdx, lastDescIdx, lastKwIdx := -1, -1, -1
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
			// Task 45-a 伪原创：内置默认模板时从变体池按 keyword 选取（相邻页游标错开），
			// 自定义模板原样保留（pickPseoTpl 内部判定）
			"novelIds":    novelIDs,
			"title":       renderTpl(pickPseoTpl(seoTitle, pseoTitleVariants, nil, row.keyword, &lastTitleIdx), vars),
			"description": renderTpl(pickPseoTpl(seoDesc, pseoDescVariants, []string{pseoDescTplDefaultAlt}, row.keyword, &lastDescIdx), vars),
			"keywords":    renderTpl(pickPseoTpl(seoKeywords, pseoKeywordsVariants, nil, row.keyword, &lastKwIdx), vars),
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
