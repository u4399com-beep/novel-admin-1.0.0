/**
 * api_scrape_tasks.go —— 业务 API：采集任务列表/创建/详情/编辑/取消/删除。
 *
 * 对应 TS 源：
 *   - src/app/api/scrape-tasks/route.ts        → handleScrapeTasksList / handleScrapeTasksCreate
 *   - src/app/api/scrape-tasks/[id]/route.ts   → handleScrapeTaskDetail / handleScrapeTaskUpdate /
 *                                                handleScrapeTaskCancel / handleScrapeTaskDelete
 *   - src/lib/scrape/api-utils.ts              → parseHttpUrl（parsePositiveInt 已在 api_novels.go）
 *
 * 契约要点：
 * - 列表字段（LIST_SELECT，不含 log）：id/ruleId/mode/targetUrl/pages/status/total/done/
 *   created/updated/chapters/message/createdAt/updatedAt/chaptersDone/chaptersTotal
 * - 详情含完整 log 与嵌套 rule:{id,name,charset}（ruleId 为空 → rule:null）
 * - POST 创建后不做 inline 执行（runner 2s 轮询领取），返回 runner 心跳状态
 *   /tmp/scrape-runner-heartbeat（10s 内视为存活；不在线附 note 文案）
 * - PUT 仅 pending 可编辑；PATCH 仅支持 action=cancel 的条件更新（与 worker 竞态安全）
 *
 * 移植语义差异：
 * 1. Prisma @updatedAt：UPDATE（含 updateMany/PATCH 取消）显式 set updatedAt=nowMillis()
 * 2. JS new URL() 规范化（空路径补 "/"、拒绝空主机/越界端口）在 parseHttpURL 内等价还原
 * 3. body 类型病理分支逐一对齐：JSON null/非法 → 400「请求体必须是 JSON 对象」；
 *    数组 body 按 TS typeof 'object' 语义继续走 mode 校验失败路径
 */
package main

import (
	"database/sql"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
)

const runnerHeartbeatPath = "/tmp/scrape-runner-heartbeat"

var (
	scrapeTaskModes    = map[string]bool{"single": true, "list": true}
	scrapeTaskStatuses = map[string]bool{"pending": true, "running": true, "success": true, "partial": true, "failed": true, "canceled": true}
)

func init() {
	register("GET", "/api/scrape-tasks", handleScrapeTasksList)
	register("POST", "/api/scrape-tasks", handleScrapeTasksCreate)
	register("GET", "/api/scrape-tasks/{id}", handleScrapeTaskDetail)
	register("PUT", "/api/scrape-tasks/{id}", handleScrapeTaskUpdate)
	register("PATCH", "/api/scrape-tasks/{id}", handleScrapeTaskCancel)
	register("DELETE", "/api/scrape-tasks/{id}", handleScrapeTaskDelete)
}

// ==================== 共用：URL/心跳/行映射 ====================

// parsedURLResult parseHttpUrl 的移植返回形态
type parsedURLResult struct {
	ok      bool
	value   string
	message string
}

// parseHttpURL 移植 src/lib/scrape/api-utils.ts parseHttpUrl：
// http/https 白名单 + JS new URL().toString() 规范化 + 限长截断。
func parseHttpURL(raw any, field string, maxLen int) parsedURLResult {
	s, isStr := raw.(string)
	if !isStr || trimSpaceStr(s) == "" {
		return parsedURLResult{message: field + " 必填"}
	}
	u, err := url.Parse(trimSpaceStr(s))
	invalidMsg := field + " 无法解析: " + truncateRunes(jsStringify(raw), 100)
	if err != nil || u.Host == "" {
		return parsedURLResult{message: invalidMsg}
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		// JS u.protocol 形如 "ftp:"（带冒号）
		return parsedURLResult{message: field + " 仅支持 http/https（收到 " + u.Scheme + ":）"}
	}
	if p := u.Port(); p != "" {
		if n, perr := strconv.Atoi(p); perr != nil || n < 0 || n > 65535 {
			// WHATWG URL 对非法/越界端口抛 Invalid URL → catch 分支文案
			return parsedURLResult{message: invalidMsg}
		}
	}
	// JS toString() 空路径补 "/"（https://x.com → https://x.com/）
	if u.Path == "" {
		u2 := *u
		u2.Path = "/"
		u = &u2
	}
	return parsedURLResult{ok: true, value: truncateRunes(u.String(), maxLen)}
}

// runnerAliveRecent runner 心跳文件 10s 内视为存活（TS statSync mtimeMs 语义）
func runnerAliveRecent() bool {
	fi, err := os.Stat(runnerHeartbeatPath)
	if err != nil {
		return false
	}
	return nowMillis()-fi.ModTime().UnixMilli() < 10_000
}

// scrapeTaskListCols 列表字段（顺序即 Scan 顺序）
const scrapeTaskListCols = `"id","ruleId","mode","targetUrl","pages","status","total","done","created","updated","chapters","message","createdAt","updatedAt","chaptersDone","chaptersTotal"`

// scanTaskListItem 一行 → LIST_SELECT 形状 map（字段名与 TS 完全一致）
func scanTaskListItem(rows *sql.Rows) (map[string]any, error) {
	var id, pages, total, done, created, updated, chapters, chaptersDone, chaptersTotal int64
	var ruleID sql.NullInt64
	var mode, targetURL, status, message string
	var createdAt, updatedAt int64
	if err := rows.Scan(&id, &ruleID, &mode, &targetURL, &pages, &status, &total, &done,
		&created, &updated, &chapters, &message, &createdAt, &updatedAt, &chaptersDone, &chaptersTotal); err != nil {
		return nil, err
	}
	var rid any
	if ruleID.Valid {
		rid = ruleID.Int64
	}
	return map[string]any{
		"id":            id,
		"ruleId":        rid,
		"mode":          mode,
		"targetUrl":     targetURL,
		"pages":         pages,
		"status":        status,
		"total":         total,
		"done":          done,
		"created":       created,
		"updated":       updated,
		"chapters":      chapters,
		"message":       message,
		"createdAt":     isoFromMillis(createdAt),
		"updatedAt":     isoFromMillis(updatedAt),
		"chaptersDone":  chaptersDone,
		"chaptersTotal": chaptersTotal,
	}, nil
}

// bodyObjectOK 复刻 TS `if (!body || typeof body !== 'object')` 判定：
// 非法 JSON/JSON null/原始类型 → false（数组是 object → true）
func bodyObjectOK(v any, ok bool) bool {
	if !ok || v == nil {
		return false
	}
	switch v.(type) {
	case map[string]any, []any:
		return true
	}
	return false
}

// taskRuleIDParam 提取可选 ruleId（undefined/null/” 均视为未提供）
func taskRuleIDParam(body map[string]any) (int64, bool, bool) {
	val, present := body["ruleId"]
	if !present || val == nil {
		return 0, false, true
	}
	if s, isStr := val.(string); isStr && s == "" {
		return 0, false, true
	}
	rid, ok := parsePositiveInt(val)
	if !ok {
		return 0, false, false
	}
	return rid, true, true
}

// taskPagesParam 提取可选 pages（undefined/null/” 视为未提供）
func taskPagesParam(body map[string]any) (int, bool, bool) {
	val, present := body["pages"]
	if !present || val == nil {
		return 0, false, true
	}
	if s, isStr := val.(string); isStr && s == "" {
		return 0, false, true
	}
	p, ok := parsePositiveInt(val)
	if !ok || p > 999 {
		return 0, false, false
	}
	return int(p), true, true
}

// ruleExists 校验采集规则存在
func ruleExists(rid int64) (bool, error) {
	var id int64
	err := queryOne(`SELECT "id" FROM "ScrapeRule" WHERE "id" = ?`, []any{&id}, rid)
	if isNoRows(err) {
		return false, nil
	}
	return err == nil, err
}

// ==================== GET /api/scrape-tasks ====================

func handleScrapeTasksList(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	sp := r.URL.Query()
	page := clampInt(pageParamFloor(sp.Get("page"), 1), 1, 1000)
	pageSize := clampInt(pageParamFloor(sp.Get("pageSize"), 20), 1, 50)
	status := sp.Get("status")

	whereSQL := ""
	args := []any{}
	if scrapeTaskStatuses[status] {
		whereSQL = ` WHERE "status" = ?`
		args = append(args, status)
	}

	var total int64
	if err := queryOne(`SELECT COUNT(*) FROM "ScrapeTask"`+whereSQL, []any{&total}, args...); err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	list := make([]map[string]any, 0)
	q := `SELECT ` + scrapeTaskListCols + ` FROM "ScrapeTask"` + whereSQL + ` ORDER BY "id" DESC LIMIT ? OFFSET ?`
	err := queryList(q, func(rows *sql.Rows) error {
		item, serr := scanTaskListItem(rows)
		if serr != nil {
			return serr
		}
		list = append(list, item)
		return nil
	}, append(args, pageSize, (page-1)*pageSize)...)
	if err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	writeJSON(w, 200, map[string]any{"list": list, "total": total, "page": page, "pageSize": pageSize})
}

// ==================== POST /api/scrape-tasks ====================

func handleScrapeTasksCreate(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	v, ok := readBodyValue(r)
	if !bodyObjectOK(v, ok) {
		writeJSON(w, 400, map[string]string{"error": "请求体必须是 JSON 对象"})
		return
	}
	body := bodyMap(v)

	mode := ""
	if body["mode"] != nil {
		mode = jsStringify(body["mode"])
	}
	if !scrapeTaskModes[mode] {
		writeJSON(w, 400, map[string]string{"error": "mode 必须是 single 或 list"})
		return
	}
	target := parseHttpURL(body["targetUrl"], "targetUrl", 500)
	if !target.ok {
		writeJSON(w, 400, map[string]string{"error": target.message})
		return
	}
	ruleID, hasRule, ruleOK := taskRuleIDParam(body)
	if !ruleOK {
		writeJSON(w, 400, map[string]string{"error": "无效 ruleId"})
		return
	}
	if hasRule {
		exists, derr := ruleExists(ruleID)
		if derr != nil {
			failJSON(w, "服务器错误", firstLineErr(derr), 500)
			return
		}
		if !exists {
			writeJSON(w, 400, map[string]string{"error": "采集规则不存在"})
			return
		}
	}
	pages, hasPages, pagesOK := taskPagesParam(body)
	if !pagesOK {
		writeJSON(w, 400, map[string]string{"error": "pages 需为 1-999 的整数"})
		return
	}
	if !hasPages {
		pages = 1
	}

	var ridArg any
	if hasRule {
		ridArg = ruleID
	}
	now := nowMillis()
	newID, err := execReturningID(
		`INSERT INTO "ScrapeTask" ("mode","targetUrl","ruleId","pages","status","total","done","chaptersDone","chaptersTotal","created","updated","chapters","message","log","createdAt","updatedAt")
                 VALUES (?,?,?,?, 'pending',0,0,0,0,0,0,0,'','',?,?)`,
		mode, target.value, ridArg, pages, now, now,
	)
	if err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}

	// 回读创建行（Prisma create 返回完整 LIST_SELECT 行）
	var task map[string]any
	if err := queryOneRowTask(scrapeTaskListCols+` FROM "ScrapeTask" WHERE "id" = ?`, &task, newID); err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}

	runner := "watchdog-pending"
	if runnerAliveRecent() {
		runner = "runner"
	}
	out := map[string]any{"ok": true, "task": task, "runner": runner}
	if runner == "watchdog-pending" {
		out["note"] = "runner 暂不在线，任务已入库待执行（看护进程会在 1 分钟内拉起 runner 自动领取）"
	}
	writeJSON(w, 201, out)
}

// queryOneRowTask 查单行任务 → map（args 为 WHERE 参数）
func queryOneRowTask(selectSQL string, out *map[string]any, args ...any) error {
	return queryList(`SELECT `+selectSQL, func(rows *sql.Rows) error {
		item, err := scanTaskListItem(rows)
		if err != nil {
			return err
		}
		*out = item
		return nil
	}, args...)
}

// ==================== GET /api/scrape-tasks/{id} ====================

func handleScrapeTaskDetail(w http.ResponseWriter, r *http.Request, ps map[string]string) {
	id, okID := parsePositiveInt(ps["id"])
	if !okID {
		writeJSON(w, 400, map[string]string{"error": "无效任务 ID"})
		return
	}
	var idv, pages, total, done, created, updated, chapters, chaptersDone, chaptersTotal int64
	var ruleID sql.NullInt64
	var mode, targetURL, status, message, logv string
	var createdAt, updatedAt int64
	var ruleRowID sql.NullInt64
	var ruleName, ruleCharset sql.NullString
	err := queryOne(
		`SELECT t."id", t."ruleId", t."mode", t."targetUrl", t."pages", t."status", t."total", t."done", t."created", t."updated", t."chapters", t."message", t."log", t."createdAt", t."updatedAt", t."chaptersDone", t."chaptersTotal", r."id", r."name", r."charset"
                 FROM "ScrapeTask" t LEFT JOIN "ScrapeRule" r ON r."id" = t."ruleId" WHERE t."id" = ?`,
		[]any{&idv, &ruleID, &mode, &targetURL, &pages, &status, &total, &done, &created, &updated,
			&chapters, &message, &logv, &createdAt, &updatedAt, &chaptersDone, &chaptersTotal,
			&ruleRowID, &ruleName, &ruleCharset},
		id,
	)
	if err != nil {
		if isNoRows(err) {
			writeJSON(w, 404, map[string]string{"error": "任务不存在"})
			return
		}
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	var rid any
	if ruleID.Valid {
		rid = ruleID.Int64
	}
	var rule any
	if ruleRowID.Valid {
		rule = map[string]any{"id": ruleRowID.Int64, "name": ruleName.String, "charset": ruleCharset.String}
	}
	writeJSON(w, 200, map[string]any{
		"task": map[string]any{
			"id":            idv,
			"ruleId":        rid,
			"mode":          mode,
			"targetUrl":     targetURL,
			"pages":         pages,
			"status":        status,
			"total":         total,
			"done":          done,
			"created":       created,
			"updated":       updated,
			"chapters":      chapters,
			"message":       message,
			"log":           logv,
			"createdAt":     isoFromMillis(createdAt),
			"updatedAt":     isoFromMillis(updatedAt),
			"chaptersDone":  chaptersDone,
			"chaptersTotal": chaptersTotal,
			"rule":          rule,
		},
	})
}

// ==================== PUT /api/scrape-tasks/{id}（编辑待执行任务） ====================

func handleScrapeTaskUpdate(w http.ResponseWriter, r *http.Request, ps map[string]string) {
	id, okID := parsePositiveInt(ps["id"])
	if !okID {
		writeJSON(w, 400, map[string]string{"error": "无效任务 ID"})
		return
	}
	v, ok := readBodyValue(r)
	if !bodyObjectOK(v, ok) {
		writeJSON(w, 400, map[string]string{"error": "请求体必须是 JSON 对象"})
		return
	}
	body := bodyMap(v)

	var status string
	if err := queryOne(`SELECT "status" FROM "ScrapeTask" WHERE "id" = ?`, []any{&status}, id); err != nil {
		writeJSON(w, 404, map[string]string{"error": "任务不存在"})
		return
	}
	if status == "running" {
		writeJSON(w, 409, map[string]string{"error": "任务执行中不可编辑，请先取消"})
		return
	}
	if status != "pending" {
		writeJSON(w, 409, map[string]string{"error": "任务已结束（" + status + "），请新建任务"})
		return
	}

	sets := []string{}
	args := []any{}
	if _, present := body["mode"]; present {
		mode := jsStringify(body["mode"])
		if !scrapeTaskModes[mode] {
			writeJSON(w, 400, map[string]string{"error": "mode 必须是 single 或 list"})
			return
		}
		sets = append(sets, `"mode" = ?`)
		args = append(args, mode)
	}
	if _, present := body["targetUrl"]; present {
		target := parseHttpURL(body["targetUrl"], "targetUrl", 500)
		if !target.ok {
			writeJSON(w, 400, map[string]string{"error": target.message})
			return
		}
		sets = append(sets, `"targetUrl" = ?`)
		args = append(args, target.value)
	}
	if _, present := body["ruleId"]; present {
		rid, hasRule, ruleOK := taskRuleIDParam(map[string]any{"ruleId": body["ruleId"]})
		if !ruleOK {
			writeJSON(w, 400, map[string]string{"error": "无效 ruleId"})
			return
		}
		if hasRule {
			exists, derr := ruleExists(rid)
			if derr != nil {
				failJSON(w, "服务器错误", firstLineErr(derr), 500)
				return
			}
			if !exists {
				writeJSON(w, 400, map[string]string{"error": "采集规则不存在"})
				return
			}
			sets = append(sets, `"ruleId" = ?`)
			args = append(args, rid)
		} else {
			sets = append(sets, `"ruleId" = NULL`)
		}
	}
	if _, present := body["pages"]; present {
		p, _, pagesOK := taskPagesParam(map[string]any{"pages": body["pages"]})
		if !pagesOK {
			writeJSON(w, 400, map[string]string{"error": "pages 需为 1-999 的整数"})
			return
		}
		sets = append(sets, `"pages" = ?`)
		args = append(args, p)
	}
	if len(sets) == 0 {
		writeJSON(w, 400, map[string]string{"error": "没有可更新的字段"})
		return
	}
	// Prisma update 自动触碰 @updatedAt → 显式 set
	sets = append(sets, `"updatedAt" = ?`)
	args = append(args, nowMillis())

	res, err := exec(`UPDATE "ScrapeTask" SET `+strings.Join(sets, ", ")+` WHERE "id" = ?`, append(args, id)...)
	if err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeJSON(w, 404, map[string]string{"error": "任务不存在"})
		return
	}

	var idv int64
	var mode, targetURL string
	var pages int64
	var rid sql.NullInt64
	var statusNow string
	_ = queryOne(`SELECT "id","mode","targetUrl","ruleId","pages","status" FROM "ScrapeTask" WHERE "id" = ?`,
		[]any{&idv, &mode, &targetURL, &rid, &pages, &statusNow}, id)
	var ridAny any
	if rid.Valid {
		ridAny = rid.Int64
	}
	writeJSON(w, 200, map[string]any{
		"ok": true,
		"task": map[string]any{
			"id": idv, "mode": mode, "targetUrl": targetURL, "ruleId": ridAny, "pages": pages, "status": statusNow,
		},
	})
}

// ==================== PATCH /api/scrape-tasks/{id}（取消） ====================

func handleScrapeTaskCancel(w http.ResponseWriter, r *http.Request, ps map[string]string) {
	id, okID := parsePositiveInt(ps["id"])
	if !okID {
		writeJSON(w, 400, map[string]string{"error": "无效任务 ID"})
		return
	}
	v, ok := readBodyValue(r)
	m := bodyMap(v)
	if !ok || m == nil || strField(m["action"], 0) != "cancel" {
		writeJSON(w, 400, map[string]string{"error": "action 必须为 'cancel'"})
		return
	}

	var status string
	if err := queryOne(`SELECT "status" FROM "ScrapeTask" WHERE "id" = ?`, []any{&status}, id); err != nil {
		writeJSON(w, 404, map[string]string{"error": "任务不存在"})
		return
	}
	if status != "pending" && status != "running" {
		writeJSON(w, 400, map[string]string{"error": "当前状态 " + status + " 不可取消"})
		return
	}

	// 条件更新防与 worker 终态写入竞态：count=0 时回读如实反馈（Prisma updateMany 触碰 @updatedAt）
	res, err := exec(
		`UPDATE "ScrapeTask" SET "status" = 'canceled', "message" = '已手动取消', "updatedAt" = ? WHERE "id" = ? AND "status" IN ('pending','running')`,
		nowMillis(), id,
	)
	if err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		var fresh string
		if err := queryOne(`SELECT "status" FROM "ScrapeTask" WHERE "id" = ?`, []any{&fresh}, id); err != nil {
			writeJSON(w, 404, map[string]string{"error": "任务不存在"})
			return
		}
		writeJSON(w, 400, map[string]string{"error": "当前状态 " + fresh + " 不可取消"})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// ==================== DELETE /api/scrape-tasks/{id} ====================

func handleScrapeTaskDelete(w http.ResponseWriter, r *http.Request, ps map[string]string) {
	id, okID := parsePositiveInt(ps["id"])
	if !okID {
		writeJSON(w, 400, map[string]string{"error": "无效任务 ID"})
		return
	}
	var status string
	if err := queryOne(`SELECT "status" FROM "ScrapeTask" WHERE "id" = ?`, []any{&status}, id); err != nil {
		writeJSON(w, 404, map[string]string{"error": "任务不存在"})
		return
	}
	if status == "running" {
		writeJSON(w, 409, map[string]string{"error": "任务执行中，请先取消再删除"})
		return
	}
	// pending 允许删：即便 worker 恰在启动，其 pending→running 条件更新必然 count=0，安全退出
	res, err := exec(`DELETE FROM "ScrapeTask" WHERE "id" = ?`, id)
	if err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeJSON(w, 404, map[string]string{"error": "任务不存在"})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}
