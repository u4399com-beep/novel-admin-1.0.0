/**
 * api_categories.go —— 业务 API：分类管理。
 *
 * 对应 TS 源：
 *   - src/app/api/categories/route.ts      → handleCategoriesList / handleCategoriesCreate
 *   - src/app/api/categories/[id]/route.ts → handleCategoryUpdate / handleCategoryDelete
 *
 * 移植语义差异：
 *   1. 分类名截断上限沿用 TS 内联值 30（TS route.ts 为 slice(0,30)；limits.go 的
 *      50 上限常量已随死代码清理移除，此处以 TS 源为准）
 *   2. 列表 ORDER BY sort 并列时 TS 顺序未定义，Go 追加 id ASC 兜底（与 SQLite rowid 扫描序一致）
 *   3. PUT 空 data 时 TS 为 Prisma 空更新（返回原行），Go 直接 SELECT 原行等价返回
 */
package main

import (
	"database/sql"
	"net/http"
	"strings"
)

func init() {
	register("GET", "/api/categories", handleCategoriesList)
	register("POST", "/api/categories", handleCategoriesCreate)
	// /api/categories/{id} 方法分发 mux（骨架 dispatch 参数路由方法盲，见 api_novels.go 注）；
	// TS 只导出 PUT/DELETE，其余方法（含 GET）→ 405
	register("PUT", "/api/categories/{id}", handleCategoryByID)
	register("DELETE", "/api/categories/{id}", handleCategoryByID)
}

// handleCategoryByID /api/categories/{id} 方法分发（PUT/DELETE）
func handleCategoryByID(w http.ResponseWriter, r *http.Request, ps map[string]string) {
	switch r.Method {
	case http.MethodPut:
		handleCategoryUpdate(w, r, ps)
	case http.MethodDelete:
		handleCategoryDelete(w, r, ps)
	default:
		methodNotAllowed(w, r)
	}
}

const categoryNameMaxTS = 30 // src/app/api/categories/route.ts 内联 slice(0,30)

// ==================== GET /api/categories ====================

func handleCategoriesList(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	cats := make([]map[string]any, 0)
	err := queryList(
		`SELECT c."id", c."name", c."sort", (SELECT COUNT(*) FROM "Novel" n WHERE n."categoryId" = c."id") FROM "Category" c ORDER BY c."sort" ASC, c."id" ASC`,
		func(rows *sql.Rows) error {
			var id, sort, count int64
			var name string
			if err := rows.Scan(&id, &name, &sort, &count); err != nil {
				return err
			}
			cats = append(cats, map[string]any{"id": id, "name": name, "sort": sort, "novelCount": count})
			return nil
		})
	if err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	writeJSON(w, 200, cats)
}

// ==================== POST /api/categories ====================

func handleCategoriesCreate(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	v, ok := readBodyValue(r)
	if !ok {
		writeJSON(w, 400, map[string]string{"error": "请求体不是合法 JSON"})
		return
	}
	body := bodyMap(v)
	name := strField(body["name"], 0)
	if trimSpaceStr(name) == "" {
		writeJSON(w, 400, map[string]string{"error": "分类名不能为空"})
		return
	}
	// 预检查与创建统一用截断后的名字（对齐 TS 注释：超 30 字重复 POST 不再 500）
	trimmed := truncateRunes(trimSpaceStr(name), categoryNameMaxTS)

	var existsID int64
	if err := queryOne(`SELECT "id" FROM "Category" WHERE "name" = ?`, []any{&existsID}, trimmed); err == nil {
		writeJSON(w, 409, map[string]string{"error": "分类已存在"})
		return
	} else if !isNoRows(err) {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}

	var maxSort sql.NullInt64
	if err := queryOne(`SELECT MAX("sort") FROM "Category"`, []any{&maxSort}); err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	newSort := maxSort.Int64 + 1
	id, err := execReturningID(`INSERT INTO "Category" ("name","sort") VALUES (?,?)`, trimmed, newSort)
	if err != nil {
		if isUniqueConflict(err) {
			// 并发同名 POST 的输家撞唯一约束：回读既有行按幂等创建返回（200 + 既有行）
			var fid, fsort, fcount int64
			var fname string
			if err2 := queryOne(
				`SELECT c."id", c."name", c."sort", (SELECT COUNT(*) FROM "Novel" n WHERE n."categoryId" = c."id") FROM "Category" c WHERE c."name" = ?`,
				[]any{&fid, &fname, &fsort, &fcount}, trimmed,
			); err2 != nil {
				writeJSON(w, 409, map[string]string{"error": "分类创建失败（并发冲突且未找到既有分类）"})
				return
			}
			writeJSON(w, 200, map[string]any{"id": fid, "name": fname, "sort": fsort, "novelCount": fcount})
			return
		}
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	writeJSON(w, 201, map[string]any{"id": id, "name": trimmed, "sort": newSort, "novelCount": 0})
}

// ==================== PUT /api/categories/{id} ====================

func handleCategoryUpdate(w http.ResponseWriter, r *http.Request, ps map[string]string) {
	cid, ok := routePosIntID(w, ps["id"], "无效 ID")
	if !ok {
		return
	}
	v, ok := readBodyValue(r)
	if !ok {
		writeJSON(w, 400, map[string]string{"error": "请求体不是合法 JSON"})
		return
	}
	body := bodyMap(v)

	sets := []string{}
	args := []any{}
	if s, ok2 := body["name"].(string); ok2 {
		if t := trimSpaceStr(s); t != "" {
			sets = append(sets, `"name" = ?`)
			args = append(args, truncateRunes(t, categoryNameMaxTS))
		}
	}
	if n, ok2 := intFieldStrict(body["sort"]); ok2 {
		sets = append(sets, `"sort" = ?`)
		args = append(args, n)
	}

	if len(sets) > 0 {
		res, err := exec(`UPDATE "Category" SET `+strings.Join(sets, ", ")+` WHERE "id" = ?`, append(args, cid)...)
		if err != nil {
			if isUniqueConflict(err) {
				writeJSON(w, 409, map[string]string{"error": "分类名称已存在"})
				return
			}
			writeJSON(w, 400, map[string]string{"error": "更新失败"})
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			writeJSON(w, 404, map[string]string{"error": "分类不存在"})
			return
		}
	}
	var id, sort int64
	var name string
	if err := queryOne(`SELECT "id", "name", "sort" FROM "Category" WHERE "id" = ?`, []any{&id, &name, &sort}, cid); err != nil {
		if isNoRows(err) {
			writeJSON(w, 404, map[string]string{"error": "分类不存在"})
			return
		}
		writeJSON(w, 400, map[string]string{"error": "更新失败"})
		return
	}
	writeJSON(w, 200, map[string]any{"id": id, "name": name, "sort": sort})
}

// ==================== DELETE /api/categories/{id} ====================

func handleCategoryDelete(w http.ResponseWriter, r *http.Request, ps map[string]string) {
	cid, ok := routePosIntID(w, ps["id"], "无效 ID")
	if !ok {
		return
	}
	var count int64
	if err := queryOne(`SELECT COUNT(*) FROM "Novel" WHERE "categoryId" = ?`, []any{&count}, cid); err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	if count > 0 {
		writeJSON(w, 400, map[string]string{"error": "该分类下还有 " + itoa(int(count)) + " 本小说，无法删除"})
		return
	}
	res, err := exec(`DELETE FROM "Category" WHERE "id" = ?`, cid)
	if err != nil {
		writeJSON(w, 404, map[string]string{"error": "分类不存在"})
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeJSON(w, 404, map[string]string{"error": "分类不存在"})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}
