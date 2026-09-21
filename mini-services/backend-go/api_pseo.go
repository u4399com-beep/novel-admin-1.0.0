/**
 * api_pseo.go —— 业务 API：PSEO 关键词管理 / 下拉词试取 / 生成 / 批量 / 聚合页 / 配置。
 *
 * 对应 TS 源（逐行移植）：
 *   - src/app/api/pseo/route.ts          → handlePseoList / handlePseoAdd / handlePseoDelete
 *   - src/app/api/pseo/suggest/route.ts  → handlePseoSuggest
 *   - src/app/api/pseo/generate/route.ts → handlePseoGenerate
 *   - src/app/api/pseo/batch/route.ts    → handlePseoBatch（globalThis 锁 → 包级锁 + TTL）
 *   - src/app/api/pseo/[kw]/route.ts     → handlePseoKeywordPage（聚合页数据）
 *   - src/app/api/pseo/config/route.ts   → handlePseoConfigGet / handlePseoConfigPatch
 * 依赖库：pseo_suggest.go（多引擎下拉词）/ pseo_gen.go（配置与生成）/ api_settings.go（renderTpl 等）
 *
 * 契约要点：
 * - 列表项：{id, keyword, source, status, updatedAt(ISO)}，orderBy updatedAt desc take 200
 * - suggest 返回 {results:[{engine,ok,count,error?}], words(≤40)}；error 键按 TS
 *   JSON.stringify 语义在无错时省略
 * - generate 返回 {added, generated, suggestions}；batch 返回 {added, generated,
 *   level2Seeds, level2Words, report}
 * - [kw] 聚合页：generated 行优先用已存 pageData（novelIds 重查、clicks desc），
 *   否则实时计算（OR contains 命中 <3 回退热门 12 本）
 *
 * 移植语义差异：
 * 1. Next 动态段 params 为原始编码值 + decodeURIComponent；Go net/http 已解码一次，
 *    再做 url.PathUnescape（畸形 % 序列回退原值）等价还原；%2F 段会被 Go 拆段（404），
 *    而关键词入库前已剔除 /，无法命中合法查询，实际不可达
 * 2. Prisma orderBy 未定义并列序 → 统一追加 id DESC（[kw] 书单/列表/回退查询同）
 * 3. body 病理分支（JSON null/原始类型/数组）逐一对齐 TS typeof 判定
 */
package main

import (
	"database/sql"
	"encoding/json"
	"math"
	"net/http"
	"net/url"
	"strings"
	"sync"
)

func init() {
	register("GET", "/api/pseo", handlePseoList)
	register("POST", "/api/pseo", handlePseoAdd)
	register("DELETE", "/api/pseo", handlePseoDelete)
	register("POST", "/api/pseo/suggest", handlePseoSuggest)
	register("POST", "/api/pseo/generate", handlePseoGenerate)
	register("POST", "/api/pseo/batch", handlePseoBatch)
	register("GET", "/api/pseo/config", handlePseoConfigGet)
	register("PATCH", "/api/pseo/config", handlePseoConfigPatch)
	register("GET", "/api/pseo/{kw}", handlePseoKeywordPage)
}

// ==================== GET /api/pseo（关键词列表，管理端） ====================

func handlePseoList(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	rows := make([]map[string]any, 0)
	err := queryList(
		`SELECT "id","keyword","source","status","updatedAt" FROM "PseoKeyword" ORDER BY "updatedAt" DESC, "id" DESC LIMIT 200`,
		func(rs *sql.Rows) error {
			var id int64
			var keyword, source, status string
			var updatedAt int64
			if err := rs.Scan(&id, &keyword, &source, &status, &updatedAt); err != nil {
				return err
			}
			rows = append(rows, map[string]any{
				"id":        id,
				"keyword":   keyword,
				"source":    source,
				"status":    status,
				"updatedAt": isoFromMillis(updatedAt),
			})
			return nil
		})
	if err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	writeJSON(w, 200, rows)
}

// ==================== POST /api/pseo（手工添加关键词） ====================

func handlePseoAdd(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	v, ok := readBodyValue(r)
	m := bodyMap(v)
	var rawKeywords []any
	if ok && m != nil {
		rawKeywords, _ = m["keywords"].([]any)
	}
	if len(rawKeywords) == 0 {
		writeJSON(w, 400, map[string]string{"error": "keywords 不能为空"})
		return
	}
	if len(rawKeywords) > 500 {
		writeJSON(w, 400, map[string]string{"error": "keywords 数量超过上限（≤500）"})
		return
	}
	// 清洗 + 批内去重
	cleaned := []string{}
	seen := map[string]bool{}
	for _, k := range rawKeywords {
		c := sanitizeKeyword(k)
		if c == "" || seen[c] {
			continue
		}
		seen[c] = true
		cleaned = append(cleaned, c)
	}
	if len(cleaned) == 0 {
		writeJSON(w, 400, map[string]string{
			"error":  "清洗后无有效关键词",
			"detail": "关键词须为 1-60 个可见字符，不允许控制字符与 <>{}[]$%|\\\\/\"'`^*#&~;= 等",
		})
		return
	}
	entries := make([]kwEntry, 0, len(cleaned))
	for _, kw := range cleaned {
		entries = append(entries, kwEntry{Word: kw, Engine: "manual"})
	}
	added, err := insertKeywords(entries, 500)
	if err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	writeJSON(w, 200, map[string]any{"added": added})
}

// ==================== DELETE /api/pseo?id= ====================

func handlePseoDelete(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	// TS Number(searchParams.get('id'))：缺失(null)/非数字 → 0/NaN → 校验拒绝
	f, okF := jsParseFloat(parseQueryStr(r, "id"))
	id := 0.0
	if okF {
		id = f
	}
	if !numIsInt(id) || id <= 0 {
		writeJSON(w, 400, map[string]string{"error": "无效 id"})
		return
	}
	// TS .catch(() => {})：删除失败（含不存在）一律 ok:true
	_, _ = exec(`DELETE FROM "PseoKeyword" WHERE "id" = ?`, int64(id))
	writeJSON(w, 200, map[string]any{"ok": true})
}

// ==================== sources 白名单校验（suggest/generate 共用） ====================

// pseoSourcesParam 提取并校验 sources；返回 (sources, 是否非法)
func pseoSourcesParam(m map[string]any) ([]string, []string) {
	rawSources := []string{}
	if arr, ok := m["sources"].([]any); ok {
		for _, s := range arr {
			if sv, isStr := s.(string); isStr {
				rawSources = append(rawSources, sv)
			}
		}
	}
	invalid := []string{}
	for _, s := range rawSources {
		if !supportedEngineSet[s] {
			invalid = append(invalid, s)
		}
	}
	return rawSources, invalid
}

func sourcesInvalidResponse(w http.ResponseWriter, invalid []string) {
	writeJSON(w, 400, map[string]string{
		"error":  "sources 含不支持的引擎",
		"detail": "不支持的引擎: " + strings.Join(invalid, ", ") + "；可用: " + strings.Join(supportedEngines, ", "),
	})
}

// ==================== POST /api/pseo/suggest（试取预览，不入库） ====================

func handlePseoSuggest(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	v, _ := readBodyValue(r) // TS req.json().catch(() => ({}))
	m := bodyMap(v)
	keyword := sanitizeKeyword(m["keyword"])
	if keyword == "" {
		writeJSON(w, 400, map[string]string{"error": "keyword 必填", "detail": "关键词须为 1-60 个可见字符"})
		return
	}
	rawSources, invalid := pseoSourcesParam(m)
	if len(invalid) > 0 {
		sourcesInvalidResponse(w, invalid)
		return
	}
	sources := rawSources
	if len(sources) == 0 {
		sources = supportedEngines
	}
	agg := fetchSuggestionsMulti(keyword, sources, 4000)
	writeJSON(w, 200, map[string]any{
		"results": suggestResultsDTO(agg.Results),
		"words":   aggWordsDTO(agg.Words, 40),
	})
}

// suggestResultsDTO 引擎结果 → 契约 DTO（error 无错时省略，对齐 JSON.stringify 丢弃 undefined）
func suggestResultsDTO(results []suggestResult) []map[string]any {
	out := make([]map[string]any, 0, len(results))
	for _, r := range results {
		item := map[string]any{
			"engine": r.Engine,
			"ok":     r.OK,
			"count":  len(r.Words),
		}
		if r.Error != "" {
			item["error"] = r.Error
		}
		out = append(out, item)
	}
	return out
}

func aggWordsDTO(words []kwEntry, limit int) []kwEntry {
	if len(words) > limit {
		words = words[:limit]
	}
	if words == nil {
		words = []kwEntry{}
	}
	return words
}

// ==================== POST /api/pseo/generate（单种子快捷生成） ====================

func handlePseoGenerate(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	v, _ := readBodyValue(r)
	m := bodyMap(v)

	keyword := sanitizeKeyword(m["keyword"])
	useSuggest := true
	if b, ok := m["useSuggest"].(bool); ok && !b {
		useSuggest = false
	}
	if useSuggest && keyword == "" {
		writeJSON(w, 400, map[string]string{
			"error":  "keyword 必填",
			"detail": "关键词须为 1-60 个可见字符，不允许控制字符与 <>{}[]$%|\\\\/\"'`^*#&~;= 等",
		})
		return
	}
	rawSources, invalid := pseoSourcesParam(m)
	if len(invalid) > 0 {
		sourcesInvalidResponse(w, invalid)
		return
	}
	sources := rawSources
	if len(sources) == 0 {
		sources = supportedEngines
	}

	// 1) 搜索引擎下拉词（失败隔离 + 限并发 3 + 跨引擎去重）
	agg := suggestionsAggregate{}
	if useSuggest {
		agg = fetchSuggestionsMulti(keyword, sources, 4000)
	}

	// 2) 关键词入库（基础词最优先，来源标记 manual；去重与竞态容错在 lib 内）
	entries := []kwEntry{}
	if keyword != "" {
		entries = append(entries, kwEntry{Word: keyword, Engine: "manual"})
	}
	entries = append(entries, agg.Words...)
	added, err := insertKeywords(entries, 200)
	if err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}

	// 3) pending 关键词生成聚合页（Math.min(50, Math.max(1, Number(limit)||20))）
	lf := jsNumber(m["limit"])
	lfClamped := 20.0
	if !math.IsNaN(lf) && lf != 0 {
		lfClamped = lf
	}
	if lfClamped < 1 {
		lfClamped = 1
	}
	if lfClamped > 50 {
		lfClamped = 50
	}
	limit := int(lfClamped)
	generated, err := generatePendingPages(limit)
	if err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}

	writeJSON(w, 200, map[string]any{
		"added":       added,
		"generated":   generated,
		"suggestions": suggestResultsDTO(agg.Results),
	})
}

// ==================== POST /api/pseo/batch（种子批量获取） ====================

const (
	pseoBatchLockKey     = "pseoBatchStartedAt"
	pseoBatchLockTTLMS   = 180_000 // 仅防僵尸锁：正常完成/异常都在 finally 主动释放
	pseoBatchConcurrency = 2       // 种子级并发（引擎聚合内部再限 3）
)

var (
	pseoBatchMu        sync.Mutex
	pseoBatchStartedAt int64
)

func pseoBatchAcquire() bool {
	pseoBatchMu.Lock()
	defer pseoBatchMu.Unlock()
	now := nowMillis()
	if pseoBatchStartedAt != 0 && now-pseoBatchStartedAt < pseoBatchLockTTLMS {
		return false
	}
	pseoBatchStartedAt = now
	return true
}

func pseoBatchRelease() {
	pseoBatchMu.Lock()
	pseoBatchStartedAt = 0
	pseoBatchMu.Unlock()
}

// seedOutcome 单种子结果（TS SeedOutcome）
type seedOutcome struct {
	seed    string
	level   int
	words   []kwEntry
	engines []map[string]any
}

// runSeedBatch 一批种子并发跑（限并发 2），结果保持输入顺序
func runSeedBatch(seeds []string, cfg pseoRunnerConfig, level int) []seedOutcome {
	results := make([]seedOutcome, len(seeds))
	if len(seeds) == 0 {
		return results
	}
	var mu sync.Mutex
	cursor := 0
	lanes := pseoBatchConcurrency
	if lanes > len(seeds) {
		lanes = len(seeds)
	}
	var wg sync.WaitGroup
	for lane := 0; lane < lanes; lane++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				mu.Lock()
				i := cursor
				cursor++
				mu.Unlock()
				if i >= len(seeds) {
					return
				}
				seed := seeds[i]
				// 批量场景种子/引擎叠加并发更高，引擎超时放宽到 6s（单发 suggest 仍为 4s）
				agg := fetchSuggestionsMulti(seed, cfg.Sources, 6000)
				words := agg.Words
				if len(words) > cfg.PerSeedLimit {
					words = words[:cfg.PerSeedLimit]
				}
				results[i] = seedOutcome{seed: seed, level: level, words: words, engines: suggestResultsDTO(agg.Results)}
			}
		}()
	}
	wg.Wait()
	return results
}

func handlePseoBatch(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	if !pseoBatchAcquire() {
		writeJSON(w, 409, map[string]string{"error": "批量获取正在进行中，请稍后再试"})
		return
	}
	defer pseoBatchRelease()

	v, _ := readBodyValue(r)
	m := bodyMap(v)

	var cfg pseoRunnerConfig
	if m != nil {
		if _, present := m["config"]; present {
			saved, err := savePseoConfig(m["config"])
			if err != nil {
				failJSON(w, "服务器错误", firstLineErr(err), 500)
				return
			}
			cfg = saved
		} else {
			got, err := getPseoConfig()
			if err != nil {
				failJSON(w, "服务器错误", firstLineErr(err), 500)
				return
			}
			cfg = got
		}
	} else {
		got, err := getPseoConfig()
		if err != nil {
			failJSON(w, "服务器错误", firstLineErr(err), 500)
			return
		}
		cfg = got
	}

	if len(cfg.Seeds) == 0 {
		writeJSON(w, 400, map[string]string{"error": "请先在 PSEO 设置中填写种子关键词"})
		return
	}

	outcomes := runSeedBatch(cfg.Seeds, cfg, 1)

	// 二级挖掘：一级下拉词（引擎优先序、去重并排除一级种子）取前 8 个作为新种子再挖一轮
	level2Seeds := []string{}
	level2Words := 0
	if cfg.Expand {
		seen := map[string]bool{}
		for _, s := range cfg.Seeds {
			seen[s] = true
		}
		for _, o := range outcomes {
			for _, w := range o.words {
				if len(level2Seeds) >= 8 {
					break
				}
				if seen[w.Word] {
					continue
				}
				seen[w.Word] = true
				level2Seeds = append(level2Seeds, w.Word)
			}
		}
		level2Outcomes := runSeedBatch(level2Seeds, cfg, 2)
		outcomes = append(outcomes, level2Outcomes...)
		for _, o := range level2Outcomes {
			level2Words += len(o.words)
		}
	}

	entries := []kwEntry{}
	for _, o := range outcomes {
		entries = append(entries, o.words...)
	}
	added, err := insertKeywords(entries, cfg.MaxKeywords)
	if err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	generated := 0
	if cfg.AutoGenerate {
		generated, err = generatePendingPages(50)
		if err != nil {
			failJSON(w, "服务器错误", firstLineErr(err), 500)
			return
		}
	}

	report := make([]map[string]any, 0, len(outcomes))
	for _, o := range outcomes {
		report = append(report, map[string]any{
			"seed":    o.seed,
			"level":   o.level,
			"engines": o.engines,
			"words":   len(o.words),
		})
	}
	writeJSON(w, 200, map[string]any{
		"added":       added,
		"generated":   generated,
		"level2Seeds": len(level2Seeds),
		"level2Words": level2Words,
		"report":      report,
	})
}

// ==================== GET/POST /api/pseo/config ====================

func handlePseoConfigGet(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	cfg, err := getPseoConfig()
	if err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	writeJSON(w, 200, cfg)
}

func handlePseoConfigPatch(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	v, ok := readBodyValue(r)
	m := bodyMap(v)
	// TS: !body || typeof body !== 'object' || !('config' in body)
	if !ok || v == nil || m == nil {
		writeJSON(w, 400, map[string]string{"error": "缺少 config 字段"})
		return
	}
	if _, present := m["config"]; !present {
		writeJSON(w, 400, map[string]string{"error": "缺少 config 字段"})
		return
	}
	saved, err := savePseoConfig(m["config"])
	if err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	writeJSON(w, 200, saved)
}

// ==================== GET /api/pseo/{kw}（聚合页数据） ====================

func handlePseoKeywordPage(w http.ResponseWriter, r *http.Request, ps map[string]string) {
	rawKw := ps["kw"]
	// Next params 为原始编码段 + decodeURIComponent（畸形转义回退原值）；Go 已解码一次，
	// 二次尝试解码仅对残留 % 序列生效，畸形时保留原值（见文件头差异 1）
	if decoded, err := url.PathUnescape(rawKw); err == nil {
		rawKw = decoded
	}
	keyword := sanitizeKeyword(rawKw)
	if keyword == "" {
		writeJSON(w, 400, map[string]string{"error": "关键词不能为空"})
		return
	}

	var status string
	var pageData sql.NullString
	err := queryOne(`SELECT "status","pageData" FROM "PseoKeyword" WHERE "keyword" = ?`, []any{&status, &pageData}, keyword)
	if err != nil && !isNoRows(err) {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}

	// 优先使用已生成的聚合数据
	if status == "generated" && pageData.Valid && pageData.String != "" {
		var saved struct {
			NovelIDs    []float64 `json:"novelIds"`
			Title       string    `json:"title"`
			Description string    `json:"description"`
			Keywords    string    `json:"keywords"`
		}
		if json.Unmarshal([]byte(pageData.String), &saved) == nil {
			novels, qerr := novelsByIDs(saved.NovelIDs)
			if qerr == nil {
				writeJSON(w, 200, map[string]any{
					"keyword":              keyword,
					"novels":               novels,
					"generatedTitle":       saved.Title,
					"generatedDescription": saved.Description,
					"generatedKeywords":    saved.Keywords,
				})
				return
			}
			// 查询失败 → 落入实时计算（TS catch 语义）
		}
	}

	// 实时计算
	novels, err := matchNovels(keyword)
	if err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	siteName := "青阅文学" // TS setting?.siteName ?? '青阅文学'：无行时回退默认，行存在时空串原样保留
	_ = queryOne(`SELECT "siteName" FROM "SiteSetting" WHERE "id" = 1`, []any{&siteName})
	writeJSON(w, 200, map[string]any{
		"keyword":              keyword,
		"novels":               novels,
		"generatedTitle":       keyword + "小说推荐_关于" + keyword + "的小说 - " + siteName,
		"generatedDescription": siteName + "为您精选与“" + keyword + "”相关的小说合集，包含 " + itoa(len(novels)) + " 本热门作品，在线免费阅读。",
		"generatedKeywords":    keyword + "," + keyword + "小说," + keyword + "推荐",
	})
}

func novelsByIDs(ids []float64) ([]map[string]any, error) {
	if len(ids) == 0 {
		return []map[string]any{}, nil
	}
	ph := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	args := make([]any, 0, len(ids))
	for _, idv := range ids {
		args = append(args, int64(idv))
	}
	out := make([]map[string]any, 0)
	err := queryList("SELECT "+novelListCols+novelListFrom+` WHERE n."id" IN (`+ph+`) ORDER BY n."clicks" DESC, n."id" DESC`,
		func(rows *sql.Rows) error {
			item, err := scanNovelListItem(rows)
			if err != nil {
				return err
			}
			out = append(out, item)
			return nil
		}, args...)
	if err != nil {
		return nil, err
	}
	return out, nil
}
