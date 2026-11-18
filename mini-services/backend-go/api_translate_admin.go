/**
 * api_translate_admin.go —— 翻译缓存管理 API（R139，管理面任务⑤延续）。
 *
 * 定位：admin 后台「翻译缓存」页签的数据面。TranslationCache 是读者侧翻译的持久
 * 结果层（key=sha256(text)+"|"+target），随书快照进备份体系；管理诉求：
 *   - 可观测：总量/占用估算/语种分布/按书归属 Top（含未归属桶 novelId=0）
 *   - 可清理：按书（novelId）/按语种（target）定向删除——DELETE 属写操作，
 *     经 dispatch adminauth 非 GET 拦截（ADMIN_TOKEN 启用态必需 X-Admin-Token）
 *
 * R139 前置修复：reader 只发 chapterId → api_translate.go 已单点反查 novelId 落库，
 * 本文件的按书统计/清理自此才有数据面意义（历史 novelId=0 行进入「未归属」桶）。
 *
 * API：
 *   GET  /api/admin/translate-cache/stats
 *        → {"ok":true,"total":n,"approxBytes":n,"newest":ms,"oldest":ms,
 *           "byTarget":[{"target":"zh-Hant","rows":n}],"
 *           "byNovel":[{"novelId":4,"novelTitle":"...","rows":n}]}   （Top 20，含未归属）
 *   POST /api/admin/translate-cache/clear {"novelId":0,"target":""}
 *        二选一必填（novelId>0 或 target 非空；防止误传空体全表清空——
 *        全清属高危操作，如需全清由备份/重建流程承担）
 *        → {"ok":true,"deleted":n}
 */
package main

import (
	"database/sql"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

func init() {
	register("GET", "/api/admin/translate-cache/stats", handleTranslateCacheStats)
	register("POST", "/api/admin/translate-cache/clear", handleTranslateCacheClear)
	register("POST", "/api/admin/translate-cache/enqueue", handleTranslateCacheEnqueue)
}

// handleTranslateCacheStats GET /api/admin/translate-cache/stats
func handleTranslateCacheStats(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	var total, approxBytes, oldest, newest int64
	err := queryOne(
		`SELECT COUNT(*), COALESCE(SUM(LENGTH("content")),0), COALESCE(MIN("createdAt"),0), COALESCE(MAX("createdAt"),0)
                 FROM "TranslationCache"`,
		[]any{&total, &approxBytes, &oldest, &newest})
	if err != nil {
		failJSON(w, "统计失败", firstLineErr(err), 500)
		return
	}

	byTarget := []map[string]any{}
	_ = queryList(
		`SELECT "target", COUNT(*) FROM "TranslationCache" GROUP BY "target" ORDER BY COUNT(*) DESC`,
		func(rows *sql.Rows) error {
			var t string
			var n int64
			if err := rows.Scan(&t, &n); err == nil {
				byTarget = append(byTarget, map[string]any{"target": t, "rows": n})
			}
			return nil
		})

	// 按书归属 Top 20（LEFT JOIN Novel 取标题；novelId=0 →「（未归属）」桶显式可见）
	byNovel := []map[string]any{}
	_ = queryList(
		`SELECT tc."novelId", COALESCE(n."title",''), COUNT(*) AS c
                 FROM "TranslationCache" tc LEFT JOIN "Novel" n ON n."id" = tc."novelId"
                 GROUP BY tc."novelId" ORDER BY c DESC LIMIT 20`,
		func(rows *sql.Rows) error {
			var nid, n int64
			var title string
			if err := rows.Scan(&nid, &title, &n); err == nil {
				if title == "" {
					title = "（书籍已删除）"
				}
				if nid == 0 {
					title = "（未归属）"
				}
				byNovel = append(byNovel, map[string]any{"novelId": nid, "novelTitle": title, "rows": n})
			}
			return nil
		})

	// 上游侧车能力快照（opencc/llm 可用性直达管理页，排障不用另开 health 透传）
	upstream := map[string]any{"ok": false}
	if raw, err := translateUpstreamGetHealth(); err == nil {
		upstream = raw
	}

	writeJSON(w, 200, map[string]any{
		"ok": true, "total": total, "approxBytes": approxBytes,
		"oldest": oldest, "newest": newest,
		"byTarget": byTarget, "byNovel": byNovel,
		"upstream": upstream,
	})
}

// translateUpstreamGetHealth 侧车 /api/health 快照（2s 超时，失败降级 ok:false 不阻塞统计）
func translateUpstreamGetHealth() (map[string]any, error) {
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(translateServiceBaseURL + "/api/health")
	if err != nil {
		return map[string]any{"ok": false}, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return map[string]any{"ok": false}, err
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return map[string]any{"ok": false}, err
	}
	return m, nil
}

// handleTranslateCacheClear POST /api/admin/translate-cache/clear
func handleTranslateCacheClear(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	var body struct {
		NovelId int64  `json:"novelId"`
		Target  string `json:"target"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10))
	if err := dec.Decode(&body); err != nil {
		failJSON(w, "请求体无效", err.Error(), 400)
		return
	}
	body.Target = strings.TrimSpace(body.Target)
	if body.Target != "" && !translateTargets[body.Target] {
		failJSON(w, "不支持的语种", "supported: "+translateTargetsSupported(), 400)
		return
	}
	if body.NovelId <= 0 && body.Target == "" {
		// 双空 = 意外全清防护；如确需全清走备份/重建流程（管理页不留全清入口）
		failJSON(w, "缺少清理条件", "novelId 与 target 至少提供一个（防误传空体全表清空）", 400)
		return
	}

	where := []string{}
	args := []any{}
	if body.NovelId > 0 {
		where = append(where, `"novelId" = ?`)
		args = append(args, body.NovelId)
	}
	if body.Target != "" {
		where = append(where, `"target" = ?`)
		args = append(args, body.Target)
	}
	res, err := execRetry(`DELETE FROM "TranslationCache" WHERE `+strings.Join(where, " AND "), args...)
	if err != nil {
		failJSON(w, "清理失败", firstLineErr(err), 500)
		return
	}
	deleted, _ := res.RowsAffected()
	log.Printf("[translate-admin] cache cleared novelId=%d target=%q deleted=%d", body.NovelId, body.Target, deleted)
	writeJSON(w, 200, map[string]any{"ok": true, "deleted": deleted})
}

// handleTranslateCacheEnqueue POST /api/admin/translate-cache/enqueue
// 按书手动预热（管理面唯一 LLM 外的批量入口；targets 仅接受 OpenCC 语种，成本闸同 worker）。
// body: {"novelId":4,"targets":["zh-Hant","zh-HK"]}（targets 缺省 = translateWarmTargets 默认）
// → {"ok":true,"enqueued":n,"chapters":m}
func handleTranslateCacheEnqueue(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	var body struct {
		NovelId int64    `json:"novelId"`
		Targets []string `json:"targets"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10))
	if err := dec.Decode(&body); err != nil {
		failJSON(w, "请求体无效", err.Error(), 400)
		return
	}
	if body.NovelId <= 0 {
		failJSON(w, "缺少 novelId", "按书预热需提供有效 novelId", 400)
		return
	}
	targets := body.Targets
	if len(targets) == 0 {
		targets = translateWarmTargets()
	}
	// 成本闸：只接受 OpenCC 语种（LLM 语种批量预热一律拒绝——按章手动翻译已够用）
	clean := []string{}
	for _, t := range targets {
		t = strings.TrimSpace(t)
		if t == "" {
			continue
		}
		if !translateTargets[t] {
			failJSON(w, "不支持的语种", "supported: "+translateTargetsSupported(), 400)
			return
		}
		if t != "zh-Hant" && t != "zh-HK" {
			failJSON(w, "该语种不允许批量预热", t+" 为 LLM 语种（成本闸）：仅 zh-Hant/zh-HK 可整书预热；LLM 语种请在阅读页按章翻译（结果同样持久缓存）", 400)
			return
		}
		clean = append(clean, t)
	}
	if len(clean) == 0 {
		failJSON(w, "缺少预热语种", "targets 为空且默认预热语种被禁用（TRANSLATE_WARM_TARGETS）", 400)
		return
	}
	// 书存在性校验（防误传 ID 静默 0 入队）
	var exists int64
	if err := queryOne(`SELECT COUNT(*) FROM "Novel" WHERE "id"=?`, []any{&exists}, body.NovelId); err != nil || exists == 0 {
		failJSON(w, "书籍不存在", "novelId 无对应在库书籍", 404)
		return
	}
	// 全章入队（INSERT OR REPLACE 幂等重置 pending；UNIQUE(chapterId,target) 防重复）
	var chapters int64
	_ = queryOne(`SELECT COUNT(*) FROM "Chapter" WHERE "novelId"=?`, []any{&chapters}, body.NovelId)
	now := nowMillis()
	enqueued := int64(0)
	err := txRetry(func(tx *sql.Tx) error {
		for _, t := range clean {
			res, err := tx.Exec(
				`INSERT OR REPLACE INTO "TranslationQueue" ("novelId","chapterId","target","state","attempts","updatedAt")
                                 SELECT ?, "id", ?, 'pending', 0, ? FROM "Chapter" WHERE "novelId"=?`,
				body.NovelId, t, now, body.NovelId)
			if err != nil {
				return err
			}
			n, _ := res.RowsAffected()
			enqueued += n
		}
		return nil
	})
	if err != nil {
		failJSON(w, "入队失败", firstLineErr(err), 500)
		return
	}
	log.Printf("[translate-admin] book warm enqueued novelId=%d targets=%v chapters=%d", body.NovelId, clean, enqueued/int64(max(len(clean), 1)))
	writeJSON(w, 200, map[string]any{"ok": true, "enqueued": enqueued, "chapters": chapters})
}
