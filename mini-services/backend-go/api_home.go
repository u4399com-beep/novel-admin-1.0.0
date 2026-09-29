/**
 * api_home.go —— 业务 API：首页聚合数据。
 *
 * 对应 TS 源：src/app/api/home/route.ts
 * （featured/hot/latest/三榜/categories/stats 共 11 个查询聚合，逐查询对齐）
 *
 * 移植语义差异：
 *   1. 各 findMany 的 orderBy 无并列顺序定义，Go 追加 id DESC 兜底保证确定性
 *   2. dayAgo（24h 前毫秒）与 Chapter.createdAt（ms 整数）直接数值比较，语义等价
 */
package main

import (
	"database/sql"
	"net/http"
)

func init() {
	register("GET", "/api/home", handleHome)
}

func handleHome(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	dayAgo := nowMillis() - 24*3600*1000

	featured, err := queryNovelList(` WHERE n."isFeatured" = 1`, ` ORDER BY n."updatedAt" DESC, n."id" DESC`, nil, 12, 0)
	if err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	hot, err := queryNovelList(` WHERE n."isHot" = 1`, ` ORDER BY n."clicks" DESC, n."id" DESC`, nil, 10, 0)
	if err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	latest, err := queryNovelList("", ` ORDER BY n."updatedAt" DESC, n."id" DESC`, nil, 14, 0)
	if err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	clickRank, err := queryNovelList("", ` ORDER BY n."clicks" DESC, n."id" DESC`, nil, 10, 0)
	if err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	updateRank, err := queryNovelList("", ` ORDER BY n."updatedAt" DESC, n."id" DESC`, nil, 10, 0)
	if err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	finishedRank, err := queryNovelList(` WHERE n."status" = 'finished'`, ` ORDER BY n."clicks" DESC, n."id" DESC`, nil, 10, 0)
	if err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}

	categories := make([]map[string]any, 0)
	if err := queryList(
		`SELECT c."id", c."name", c."sort", (SELECT COUNT(*) FROM "Novel" n WHERE n."categoryId" = c."id") FROM "Category" c ORDER BY c."sort" ASC, c."id" ASC`,
		func(rows *sql.Rows) error {
			var id, sort, count int64
			var name string
			if err := rows.Scan(&id, &name, &sort, &count); err != nil {
				return err
			}
			categories = append(categories, map[string]any{"id": id, "name": name, "sort": sort, "novelCount": count})
			return nil
		}); err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}

	var novelCount, chapterCount, totalWordCount, todayUpdates int64
	if err := queryOne(`SELECT COUNT(*) FROM "Novel"`, []any{&novelCount}); err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	if err := queryOne(`SELECT COUNT(*) FROM "Chapter"`, []any{&chapterCount}); err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	var sumWC sql.NullInt64
	if err := queryOne(`SELECT SUM("wordCount") FROM "Novel"`, []any{&sumWC}); err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	totalWordCount = sumWC.Int64
	if err := queryOne(`SELECT COUNT(*) FROM "Chapter" WHERE "createdAt" >= ?`, []any{&todayUpdates}, dayAgo); err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}

	writeJSON(w, 200, map[string]any{
		"featured": featured,
		"hot":      hot,
		"latest":   latest,
		"rankings": map[string]any{
			"clicks":   clickRank,
			"updates":  updateRank,
			"finished": finishedRank,
		},
		"categories": categories,
		"stats": map[string]any{
			"novelCount":     novelCount,
			"chapterCount":   chapterCount,
			"totalWordCount": totalWordCount,
			"todayUpdates":   todayUpdates,
		},
	})
}
