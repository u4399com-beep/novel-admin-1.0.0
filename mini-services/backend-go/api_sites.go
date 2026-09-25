/**
 * api_sites.go —— 业务 API：站群站点档案 CRUD（Task 30-a「站群模式」）。
 *
 * 一库多站语义（详见 web_data.go resolveSite）：
 *   - SiteSite 按 host 精确匹配（enabled=1），命中后前台以站点档案覆盖 siteName/activeTheme/
 *     notice/seoConfig/footerConfig/homeConfig 渲染；未命中走 SiteSetting 单例（默认站点行为不变）；
 *   - 空表 = 纯默认站点（seed 不预置站点行）；host 不支持通配/后缀匹配，兜底即默认站点。
 *
 * 清洗复用 api_settings.go 现有函数（不复制逻辑）：
 *   seo → sanitizeSeoConfig（白名单 + 默认模板填充 + pseo 运行配置透传）
 *   footer → sanitizeFooterConfig / parseFooterConfig
 *   home → sanitizeHomeConfig / parseHomeConfig
 * GET 对齐 settings GET 语义（读回也过白名单）；PUT seo 为「读旧 JSON → 合并 → 写回」，
 * 与 settings PATCH 同款（部分更新语义：未提供字段不动）。
 */
package main

import (
	"database/sql"
	"net/http"
	"regexp"
	"strings"
	"sync"
)

func init() {
	register("GET", "/api/sites", handleSitesGet)
	register("POST", "/api/sites", handleSitesPost)
	register("PUT", "/api/sites/{id}", handleSitesUpdate)
	register("DELETE", "/api/sites/{id}", handleSitesDelete)
}

// sitesWriteMu 站点写操作串行锁（读-查重-写竞态防护；行间独立，粒度全站级足够）
var sitesWriteMu sync.Mutex

// siteHostRe 站点 host 校验：纯域名（≥两段标签，每段字母数字/连字符，不以连字符开头结尾）。
// 协议（://）、路径（/）、端口（:）、下划线、通配符（*）均不在字符集内 → 直接 400。
var siteHostRe = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$`)

const (
	siteHostMax    = 253
	siteNoticeMax  = 500
	siteEnabledMax = 500 // 站点数量上限（站群规模护栏，防 API 批量灌库）
)

// normalizeSiteHost host 归一化（trim + 小写）与校验；非法返回错误文案。
// 与 web_data.go requestHost 读取口径一致（去端口后的 Host 即此形态）。
func normalizeSiteHost(raw any) (string, string) {
	s, _ := raw.(string)
	h := strings.ToLower(trimSpaceStr(s))
	if h == "" {
		return "", "host 不能为空（纯域名，如 novel.example.com，不带协议/路径/端口）"
	}
	if len(h) > siteHostMax {
		return "", "host 过长（≤253 字符）"
	}
	if !siteHostRe.MatchString(h) {
		return "", "host 格式无效：需为纯域名（如 novel.example.com），不允许协议/路径/端口/通配符"
	}
	return h, ""
}

// siteRow SiteSite 行扫描结构
type siteRow struct {
	ID          int64
	Host        string
	SiteName    string
	ActiveTheme string
	Notice      string
	SeoBlob     sql.NullString
	FooterBlob  sql.NullString
	HomeBlob    sql.NullString
	Enabled     int64
	CreatedAt   int64
	UpdatedAt   int64
}

const siteRowCols = `"id","host","siteName","activeTheme","notice","seoConfig","footerConfig","homeConfig","enabled","createdAt","updatedAt"`

func scanSiteRow(rows *sql.Rows) (siteRow, error) {
	var r siteRow
	err := rows.Scan(&r.ID, &r.Host, &r.SiteName, &r.ActiveTheme, &r.Notice,
		&r.SeoBlob, &r.FooterBlob, &r.HomeBlob, &r.Enabled, &r.CreatedAt, &r.UpdatedAt)
	return r, err
}

// serializeSiteRow 行 → API 输出（seo/footer/home 读回过白名单，对齐 settings GET 语义）
func serializeSiteRow(r siteRow) map[string]any {
	return map[string]any{
		"id":          r.ID,
		"host":        r.Host,
		"siteName":    r.SiteName,
		"activeTheme": r.ActiveTheme,
		"notice":      r.Notice,
		"seo":         sanitizeSeoConfig(safeParseJSONBlob(r.SeoBlob)),
		"footer":      parseFooterConfig(r.FooterBlob),
		"home":        parseHomeConfig(r.HomeBlob),
		"enabled":     r.Enabled == 1,
		"createdAt":   r.CreatedAt,
		"updatedAt":   r.UpdatedAt,
	}
}

// getSiteRow 按 id 查单行（isNoRows 判定由调用方做）
func getSiteRow(id int64) (siteRow, error) {
	var r siteRow
	err := queryOne(`SELECT `+siteRowCols+` FROM "SiteSite" WHERE "id" = ?`,
		[]any{&r.ID, &r.Host, &r.SiteName, &r.ActiveTheme, &r.Notice,
			&r.SeoBlob, &r.FooterBlob, &r.HomeBlob, &r.Enabled, &r.CreatedAt, &r.UpdatedAt}, id)
	return r, err
}

// ==================== GET /api/sites ====================

func handleSitesGet(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	out := make([]map[string]any, 0)
	err := queryList(`SELECT `+siteRowCols+` FROM "SiteSite" ORDER BY "id" ASC`, func(rows *sql.Rows) error {
		row, err := scanSiteRow(rows)
		if err == nil {
			out = append(out, serializeSiteRow(row))
		}
		return nil
	})
	if err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	writeJSON(w, 200, out)
}

// ==================== POST /api/sites ====================

// validateSiteCore host/siteName/activeTheme 公共校验（POST 全量必填语义 + PUT 白名单同款）
func validateSiteCore(body map[string]any, requireAll bool) (host, siteName, theme, notice string, errMsg string) {
	host, errMsg = normalizeSiteHost(body["host"])
	if errMsg != "" {
		return "", "", "", "", errMsg
	}
	s, _ := body["siteName"].(string)
	siteName = truncateRunes(trimSpaceStr(s), 50)
	if siteName == "" {
		return "", "", "", "", "siteName 不能为空（≤50 字）"
	}
	t, _ := body["activeTheme"].(string)
	theme = trimSpaceStr(t)
	if theme == "" {
		if requireAll {
			theme = themeNames[0] // 未提供 → 默认首主题（白名单内）
		}
	} else if !isKnownTheme(theme) {
		return "", "", "", "", "activeTheme 不在主题白名单内"
	}
	n, _ := body["notice"].(string)
	notice = truncateRunes(n, siteNoticeMax)
	return host, siteName, theme, notice, ""
}

// siteJSONCols POST/PUT 共用的 seo/footer/home 清洗落库片段（字段白名单清洗，病理输入对齐 settings PATCH）
func siteJSONCols(body map[string]any, curSeoBlob sql.NullString) (sets []string, args []any) {
	if patchSeo, ok := body["seo"].(map[string]any); ok {
		// 读旧 JSON → 合并 → 白名单清洗写回（settings PATCH 同款；pseo 运行配置经 sanitize 透传保留）
		current := safeParseJSONBlob(curSeoBlob)
		merged := map[string]any{}
		for k, v := range current {
			merged[k] = v
		}
		for k, v := range patchSeo {
			merged[k] = v
		}
		sets = append(sets, `"seoConfig" = ?`)
		args = append(args, marshalCompact(sanitizeSeoConfig(merged)))
	}
	if f, exists := body["footer"]; exists {
		if _, isObj := f.(map[string]any); isObj {
			sets = append(sets, `"footerConfig" = ?`)
			args = append(args, marshalCompact(sanitizeFooterConfig(f)))
		} else if _, isArr := f.([]any); isArr {
			// 病理输入（数组）：TS typeof [] === 'object' → sanitize 丢弃全部字段 → 空对象
			sets = append(sets, `"footerConfig" = ?`)
			args = append(args, marshalCompact(map[string]any{}))
		}
	}
	if h, exists := body["home"]; exists {
		if _, isObj := h.(map[string]any); isObj {
			sets = append(sets, `"homeConfig" = ?`)
			args = append(args, marshalCompact(sanitizeHomeConfig(h)))
		} else {
			sets = append(sets, `"homeConfig" = ?`)
			args = append(args, marshalCompact(map[string]any{"blocks": []any{}}))
		}
	}
	return sets, args
}

func handleSitesPost(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	v, ok := readBodyValue(r)
	if !ok {
		writeJSON(w, 400, map[string]string{"error": "请求体不是合法 JSON"})
		return
	}
	body := bodyMap(v)
	host, siteName, theme, notice, errMsg := validateSiteCore(body, true)
	if errMsg != "" {
		writeJSON(w, 400, map[string]string{"error": errMsg})
		return
	}
	enabled := 1
	if b, ok2 := body["enabled"].(bool); ok2 && !b {
		enabled = 0
	}

	sitesWriteMu.Lock()
	defer sitesWriteMu.Unlock()

	var existsID int64
	if err := queryOne(`SELECT "id" FROM "SiteSite" WHERE "host" = ?`, []any{&existsID}, host); err == nil {
		writeJSON(w, 409, map[string]string{"error": "该 host 已存在站点档案"})
		return
	} else if !isNoRows(err) {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	var cnt int64
	if err := queryOne(`SELECT COUNT(*) FROM "SiteSite"`, []any{&cnt}); err == nil && cnt >= siteEnabledMax {
		writeJSON(w, 400, map[string]string{"error": "站点数量已达上限"})
		return
	}

	now := nowMillis()
	id, err := execReturningID(
		`INSERT INTO "SiteSite" ("host","siteName","activeTheme","notice","seoConfig","footerConfig","homeConfig","enabled","createdAt","updatedAt")
		 VALUES (?,?,?,?,?,?,?,?,?,?)`,
		host, siteName, theme, notice, "{}", "{}", "{}", enabled, now, now)
	if err != nil {
		if isUniqueConflict(err) {
			// 并发同 host POST 的输家：回读既有行按幂等创建返回（200，对齐 categories POST 语义）
			if row, err2 := getSiteRowByHost(host); err2 == nil {
				writeJSON(w, 200, serializeSiteRow(row))
				return
			}
			writeJSON(w, 409, map[string]string{"error": "站点创建失败（并发冲突且未找到既有站点）"})
			return
		}
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	// seo/footer/home 建行后补写（siteJSONCols 复用 PUT 同款清洗路径）
	sets, args := siteJSONCols(body, sql.NullString{})
	if len(sets) > 0 {
		sets = append(sets, `"updatedAt" = ?`)
		args = append(args, nowMillis())
		if _, err := exec(`UPDATE "SiteSite" SET `+strings.Join(sets, ", ")+` WHERE "id" = ?`, append(args, id)...); err != nil {
			failJSON(w, "服务器错误", firstLineErr(err), 500)
			return
		}
	}
	row, err := getSiteRow(id)
	if err != nil {
		writeJSON(w, 201, map[string]any{"id": id, "host": host, "siteName": siteName, "activeTheme": theme, "notice": notice, "enabled": enabled == 1})
		return
	}
	writeJSON(w, 201, serializeSiteRow(row))
}

// getSiteRowByHost host 查单行（并发撞唯一约束回读用）
func getSiteRowByHost(host string) (siteRow, error) {
	var r siteRow
	err := queryOne(`SELECT `+siteRowCols+` FROM "SiteSite" WHERE "host" = ?`,
		[]any{&r.ID, &r.Host, &r.SiteName, &r.ActiveTheme, &r.Notice,
			&r.SeoBlob, &r.FooterBlob, &r.HomeBlob, &r.Enabled, &r.CreatedAt, &r.UpdatedAt}, host)
	return r, err
}

// ==================== PUT /api/sites/{id} ====================

func handleSitesUpdate(w http.ResponseWriter, r *http.Request, ps map[string]string) {
	id, ok := routePosIntID(w, ps["id"], "无效 ID")
	if !ok {
		return
	}
	v, ok := readBodyValue(r)
	if !ok {
		writeJSON(w, 400, map[string]string{"error": "请求体不是合法 JSON"})
		return
	}
	body := bodyMap(v)

	sitesWriteMu.Lock()
	defer sitesWriteMu.Unlock()

	cur, err := getSiteRow(int64(id))
	if err != nil {
		if isNoRows(err) {
			writeJSON(w, 404, map[string]string{"error": "站点不存在"})
			return
		}
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}

	sets := []string{}
	args := []any{}
	// host 改名：白名单校验 + 查重（排除自身）
	if _, exists := body["host"]; exists {
		host, errMsg := normalizeSiteHost(body["host"])
		if errMsg != "" {
			writeJSON(w, 400, map[string]string{"error": errMsg})
			return
		}
		if host != cur.Host {
			var dupID int64
			if err := queryOne(`SELECT "id" FROM "SiteSite" WHERE "host" = ? AND "id" != ?`, []any{&dupID}, host, id); err == nil {
				writeJSON(w, 409, map[string]string{"error": "该 host 已被其他站点占用"})
				return
			} else if !isNoRows(err) {
				failJSON(w, "服务器错误", firstLineErr(err), 500)
				return
			}
			sets = append(sets, `"host" = ?`)
			args = append(args, host)
		}
	}
	if s, exists := body["siteName"].(string); exists {
		t := truncateRunes(trimSpaceStr(s), 50)
		if t == "" {
			writeJSON(w, 400, map[string]string{"error": "siteName 不能为空（≤50 字）"})
			return
		}
		sets = append(sets, `"siteName" = ?`)
		args = append(args, t)
	}
	if t, exists := body["activeTheme"].(string); exists && trimSpaceStr(t) != "" {
		if !isKnownTheme(trimSpaceStr(t)) {
			writeJSON(w, 400, map[string]string{"error": "activeTheme 不在主题白名单内"})
			return
		}
		sets = append(sets, `"activeTheme" = ?`)
		args = append(args, trimSpaceStr(t))
	}
	if n, exists := body["notice"].(string); exists {
		sets = append(sets, `"notice" = ?`)
		args = append(args, truncateRunes(n, siteNoticeMax))
	}
	if b, exists := body["enabled"].(bool); exists {
		if b {
			sets = append(sets, `"enabled" = 1`)
		} else {
			sets = append(sets, `"enabled" = 0`)
		}
	}
	// seo/footer/home：与 POST 同一份白名单清洗（seo 合并旧值，footer/home 整体替换）
	jsonSets, jsonArgs := siteJSONCols(body, cur.SeoBlob)
	sets = append(sets, jsonSets...)
	args = append(args, jsonArgs...)

	if len(sets) > 0 {
		sets = append(sets, `"updatedAt" = ?`)
		args = append(args, nowMillis())
		if _, err := exec(`UPDATE "SiteSite" SET `+strings.Join(sets, ", ")+` WHERE "id" = ?`, append(args, int64(id))...); err != nil {
			failJSON(w, "服务器错误", firstLineErr(err), 500)
			return
		}
	}
	row, err := getSiteRow(int64(id))
	if err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	writeJSON(w, 200, serializeSiteRow(row))
}

// ==================== DELETE /api/sites/{id} ====================

func handleSitesDelete(w http.ResponseWriter, r *http.Request, ps map[string]string) {
	id, ok := routePosIntID(w, ps["id"], "无效 ID")
	if !ok {
		return
	}
	sitesWriteMu.Lock()
	defer sitesWriteMu.Unlock()

	res, err := exec(`DELETE FROM "SiteSite" WHERE "id" = ?`, int64(id))
	if err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeJSON(w, 404, map[string]string{"error": "站点不存在"})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}
