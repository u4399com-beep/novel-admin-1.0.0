/**
 * orphanskeleton.go —— 业务 API：孤儿骨架审计 + 清理（R113）。
 *
 * 背景（worklog R112 遗留移交）：历史坏扫描会产出「孤儿骨架」——Novel 行存在但永不
 * 产生正文的书籍（标题抽取坏片/目录行匹配失败），长期滞留污染书籍管理、搜索与前台
 * 列表。本工具给 admin 一键审计+清理能力（与「目录体检」「智能补全」同族：GET 只读
 * 审计 → 确认 → POST 有界执行）。
 *
 * 判定语义（全部以「零填充」为前提）：
 *   零填充 := NOT EXISTS(Chapter.novelId=id AND wordCount>0)
 *   候选分桶：
 *     no-rows        —— 零填充且 0 章节行（骨架从未建立，坏扫描产物）→ 可清理
 *     stale-skeleton —— 零填充且有骨架行，但最近行活动早于 staleHours（默认 24h）。
 *                        正常舰队分钟级触达零填充书（R112 填充顺序「零填充书优先」），
 *                        停滞 24h+ 即目录匹配失败/规则死亡等不可自愈形态 → 可清理
 *     active         —— 零填充但 24h 内仍有骨架行写入（舰队正在填充）→ 仅展示计数，
 *                        不可清理（误删会打断在途任务对该书的填充）
 *
 * GET  /api/novels/orphan-skeletons?minAgeHours=24
 *      → { minAgeHours, zeroFilled, active, candidates:[...≤500], buckets:{noRows,staleSkeleton}, truncated }
 *      minAgeHours 为书龄下限（保护刚入库还未填充的新书），钳制 1..8760，缺省 24。
 *
 * POST /api/novels/orphan-skeletons {"ids":[...]}
 *      逐本复验（审计与执行间隔内状态可能变化）：仍为零填充 且（无行 或 最近行早于
 *      30min）才删除；删除走 FK 级联章节 + removeNovelTxtAll 磁盘清理（与单书删除
 *      DELETE /api/novels/{id} 同源）。上限 500/次。
 *      → { requested, deleted, skipped:[{id,reason}] }
 */
package main

import (
	"database/sql"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

func init() {
	register("GET", "/api/novels/orphan-skeletons", handleOrphanSkeletonsGet)
	register("POST", "/api/novels/orphan-skeletons", handleOrphanSkeletonsPost)
}

const (
	// orphanAuditMax 候选清单输出上限（防止极端脏库把响应撑爆；POST 执行上限与其对齐）
	orphanAuditMax = 500
	// orphanStaleHours 骨架行停滞判定阈值（小时）
	orphanStaleHours = 24
	// orphanPostFreshGuardMs POST 复验「最近行活动」保护窗：30 分钟内有骨架行写入视为
	// 在途填充，跳过本轮（下轮审计自然归位 active 桶）
	orphanPostFreshGuardMs = 30 * 60 * 1000
)

// orphanMinAgeHoursParam 解析校验 minAgeHours（缺省 24，钳制 1..8760；非数字/越界回落缺省）
func orphanMinAgeHoursParam(r *http.Request) int {
	v := strings.TrimSpace(r.URL.Query().Get("minAgeHours"))
	n, err := strconv.Atoi(v)
	if err != nil || n < 1 || n > 8760 {
		return 24
	}
	return n
}

type orphanCandidate struct {
	ID          int64   `json:"id"`
	Title       string  `json:"title"`
	Author      string  `json:"author"`
	SourceURL   string  `json:"sourceUrl"`
	Rows        int64   `json:"rows"`
	Bucket      string  `json:"bucket"` // no-rows | stale-skeleton
	LastRowAgeH float64 `json:"lastRowAgeHours"`
	BookAgeH    float64 `json:"bookAgeHours"`
	CreatedAt   int64   `json:"createdAt"`
	LastRowAt   int64   `json:"lastRowAt"`
}

// handleOrphanSkeletonsGet GET /api/novels/orphan-skeletons：只读审计，不写库
func handleOrphanSkeletonsGet(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	minAgeH := orphanMinAgeHoursParam(r)
	now := nowMillis()
	minAgeMs := int64(minAgeH) * 3600 * 1000
	staleMs := int64(orphanStaleHours) * 3600 * 1000

	zeroFilled := 0
	active := 0
	noRows := 0
	staleSkeleton := 0
	truncated := false
	cands := make([]orphanCandidate, 0)

	// 零填充全集扫描（不加书龄过滤——zeroFilled 口径=全部零填充书，与 admin 提示语一致）；
	// 书龄下限只在分桶时生效：书龄不足 minAgeHours 的零行书视为「尚未轮到填充」不入候选
	err := queryList(`SELECT n."id", n."title", n."author", n."sourceUrl", n."createdAt",
                        (SELECT COUNT(*) FROM "Chapter" ch WHERE ch."novelId" = n."id") AS rows,
                        (SELECT IFNULL(MAX(ch."createdAt"), 0) FROM "Chapter" ch WHERE ch."novelId" = n."id") AS lastRow
                FROM "Novel" n
                WHERE NOT EXISTS (SELECT 1 FROM "Chapter" ch WHERE ch."novelId" = n."id" AND ch."wordCount" > 0)
                ORDER BY n."id" ASC`,
		func(rs *sql.Rows) error {
			var c orphanCandidate
			var rows int64
			var lastRow int64
			if err := rs.Scan(&c.ID, &c.Title, &c.Author, &c.SourceURL, &c.CreatedAt, &rows, &lastRow); err != nil {
				return err
			}
			zeroFilled++
			c.Rows = rows
			c.LastRowAt = lastRow
			c.BookAgeH = float64(now-c.CreatedAt) / 3600000
			switch {
			case rows == 0 && c.CreatedAt > now-minAgeMs:
				// 书龄不足下限：刚入库还未轮到填充，仅计数
				return nil
			case rows == 0:
				noRows++
				c.Bucket = "no-rows"
			case lastRow > 0 && now-lastRow < staleMs:
				// 最近 24h 内仍有骨架行写入：舰队正在填充，仅计数展示
				active++
				return nil
			default:
				staleSkeleton++
				c.Bucket = "stale-skeleton"
				if lastRow > 0 {
					c.LastRowAgeH = float64(now-lastRow) / 3600000
				}
			}
			if len(cands) < orphanAuditMax {
				cands = append(cands, c)
			} else {
				truncated = true
			}
			return nil
		})
	if err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}

	writeJSON(w, 200, map[string]any{
		"minAgeHours": minAgeH,
		"zeroFilled":  zeroFilled,
		"active":      active,
		"candidates":  cands,
		"buckets":     map[string]int{"noRows": noRows, "staleSkeleton": staleSkeleton},
		"truncated":   truncated,
	})
}

// handleOrphanSkeletonsPost POST /api/novels/orphan-skeletons {"ids":[...]}
// 逐本复验后删除：零填充 且（无行 或 最近行早于 30min 保护窗）。逐本独立事务，
// 单本失败不阻断批次（最终以 deleted/skipped 汇总回报）。
func handleOrphanSkeletonsPost(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	var body map[string]any
	if v, ok := readBodyValue(r); ok {
		body = bodyMap(v)
	}
	rawIDs, _ := body["ids"].([]any)
	if len(rawIDs) == 0 {
		failJSON(w, "ids 不能为空", "先 GET 审计再按候选清单提交", 400)
		return
	}
	if len(rawIDs) > orphanAuditMax {
		failJSON(w, "单次至多清理 500 本", "分批提交", 400)
		return
	}
	ids := make([]int64, 0, len(rawIDs))
	for _, rv := range rawIDs {
		f, isNum := rv.(float64)
		if !isNum || !numIsInt(f) || f <= 0 {
			failJSON(w, "ids 含非法值", "须为正整数数组", 400)
			return
		}
		ids = append(ids, int64(f))
	}
	// 去重 + 升序（幂等；审计清单本就有序，防御重复提交）
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	ids = dedupeInt64(ids)

	now := nowMillis()
	db, err := getDB()
	if err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	deleted := 0
	skipped := make([]map[string]any, 0)
	for _, id := range ids {
		var rows, maxRow int64
		var filled int64
		err := db.QueryRow(`SELECT
                                (SELECT COUNT(*) FROM "Chapter" ch WHERE ch."novelId" = ?),
                                (SELECT IFNULL(MAX(ch."createdAt"), 0) FROM "Chapter" ch WHERE ch."novelId" = ?),
                                (SELECT IFNULL(SUM(ch."wordCount"), 0) FROM "Chapter" ch WHERE ch."novelId" = ?)`,
			id, id, id).Scan(&rows, &maxRow, &filled)
		if err == sql.ErrNoRows {
			skipped = append(skipped, map[string]any{"id": id, "reason": "not-found"})
			continue
		}
		if err != nil {
			skipped = append(skipped, map[string]any{"id": id, "reason": "query-error"})
			continue
		}
		// 复验 1：仍为零填充（审计后有正文落库 → 已转正）
		if filled > 0 {
			skipped = append(skipped, map[string]any{"id": id, "reason": "has-content"})
			continue
		}
		// 复验 2：30 分钟内有骨架行写入 → 在途填充保护
		if rows > 0 && now-maxRow < orphanPostFreshGuardMs {
			skipped = append(skipped, map[string]any{"id": id, "reason": "fill-in-flight"})
			continue
		}
		res, err := exec(`DELETE FROM "Novel" WHERE "id" = ?`, id)
		if err != nil {
			skipped = append(skipped, map[string]any{"id": id, "reason": "delete-error"})
			continue
		}
		if n, _ := res.RowsAffected(); n == 0 {
			skipped = append(skipped, map[string]any{"id": id, "reason": "not-found"})
			continue
		}
		// 章节行经 FK ON DELETE CASCADE 级联删除；磁盘 TXT 分章/合并导出随书清理
		// （与 handleNovelDelete 同源，防同 id 重采串入旧书正文）
		removeNovelTxtAll(id)
		deleted++
	}

	writeJSON(w, 200, map[string]any{
		"requested": len(ids),
		"deleted":   deleted,
		"skipped":   skipped,
	})
}

// dedupeInt64 有序切片去重（调用方保证已升序）
func dedupeInt64(xs []int64) []int64 {
	out := xs[:0]
	var prev int64 = -1
	for _, x := range xs {
		if x != prev {
			out = append(out, x)
			prev = x
		}
	}
	return out
}
