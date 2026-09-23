/**
 * api_categories_merge.go —— 业务 API：智能分类同类合并（存量修复）。
 *
 * TS 源：src/app/api/categories/merge/route.ts（逐行移植）
 *
 * GET  /api/categories/merge
 *   返回建议合并对列表（规则引擎计算：归一化+同义词+规范词包含，必要时 LLM 兜底）。
 *   每项：{ sourceId, source, target, targetId, reason, bookCount }
 *   targetId=null 表示目标分类尚不存在（前端提供「新建并合并」选项）。
 *
 * POST /api/categories/merge   body: { fromId: number, toId?: number, toName?: string }
 *   执行合并：源分类下所有书籍迁移到目标分类 → 删除空的源分类（事务式，失败整体回滚）。
 *   目标优先用 toId（必须已存在）；传 toName 且不存在时自动创建（对应建议中的未建目标）。
 *
 * 移植语义差异：
 * 1. Prisma $transaction(async) → Go sql.Tx（迁书 → 删空源分类，任一步失败 Rollback）；
 *    P2003 外键冲突（合并窗口期又有书归入源分类，SQLite 消息 FOREIGN KEY constraint failed）
 *    → 同款 409 提示
 * 2. Prisma updateMany 自动触碰 @updatedAt → UPDATE 显式 set updatedAt=nowMillis()
 * 3. GET 归并建议复用 categoryx.go canonicalCategory（L1 同义词/L2 关键词/L3 LLM 全流水线，
 *    与 TS 22-a 修复后实现一致）；兜底类「其他」（原「未分类」）永不作为合并源
 */
package main

import (
	"database/sql"
	"math"
	"net/http"
)

func init() {
	register("GET", "/api/categories/merge", handleCategoriesMergeGet)
	register("POST", "/api/categories/merge", handleCategoriesMergePost)
}

// ==================== GET /api/categories/merge ====================

func handleCategoriesMergeGet(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	type catRow struct {
		id    int64
		name  string
		count int64
	}
	cats := []catRow{}
	err := queryList(
		`SELECT c."id", c."name", (SELECT COUNT(*) FROM "Novel" n WHERE n."categoryId" = c."id") FROM "Category" c ORDER BY c."sort" ASC, c."id" ASC`,
		func(rows *sql.Rows) error {
			var c catRow
			if err := rows.Scan(&c.id, &c.name, &c.count); err != nil {
				return err
			}
			cats = append(cats, c)
			return nil
		})
	if err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}
	byName := map[string]int64{}
	for _, c := range cats {
		byName[c.name] = c.id
	}
	suggestions := []map[string]any{}
	for _, c := range cats {
		// 保留分类（兜底类「其他」）永不作为合并源（系统兜底去处）
		if c.name == FALLBACK_CATEGORY {
			continue
		}
		// 归一化+同义词+关键词包含（必要时 LLM 兜底）：返回规范分类名
		canon := canonicalCategory(c.name)
		// 归并失败（归兜底类，需人工判断）或目标与自身同名（已归类到位）→ 不进建议
		if canon == c.name || canon == FALLBACK_CATEGORY {
			continue
		}
		var targetID any
		if tid, ok := byName[canon]; ok {
			targetID = tid
		}
		suggestions = append(suggestions, map[string]any{
			"sourceId":  c.id,
			"source":    c.name,
			"target":    canon,
			"targetId":  targetID,
			"reason":    "归一化归并：「" + c.name + "」可并入规范分类「" + canon + "」",
			"bookCount": c.count,
		})
	}
	writeJSON(w, 200, suggestions)
}

// ==================== POST /api/categories/merge ====================

func handleCategoriesMergePost(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	v, ok := readBodyValue(r)
	if !ok {
		writeJSON(w, 400, map[string]string{"error": "请求体不是合法 JSON"})
		return
	}
	body := bodyMap(v)

	// TS Number.isInteger(fromId) && fromId > 0：非数字/非整数（如 1.5）→ 400
	var fromID int64
	if f, isNum := body["fromId"].(float64); isNum && f == math.Trunc(f) {
		fromID = int64(f)
	}
	if fromID <= 0 {
		writeJSON(w, 400, map[string]string{"error": "无效的源分类 ID"})
		return
	}
	toID, hasToID := optIntField(body["toId"])
	// toName 仅供目标分类尚不存在的建议对使用（如 N次元 → 同人 的「同人」）
	toName := ""
	if s, isStr := body["toName"].(string); isStr {
		toName = truncateRunes(trimSpaceStr(s), 50)
	}
	if !hasToID && toName == "" {
		writeJSON(w, 400, map[string]string{"error": "缺少目标分类（toId 或 toName）"})
		return
	}

	var fromIDDB int64
	var fromName string
	var fromSort int64
	if err := queryOne(`SELECT "id","name","sort" FROM "Category" WHERE "id" = ?`, []any{&fromIDDB, &fromName, &fromSort}, fromID); err != nil {
		if isNoRows(err) {
			writeJSON(w, 404, map[string]string{"error": "源分类不存在"})
			return
		}
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}

	// 目标定位/创建放在事务外：创建目标分类是幂等友好的独立动作（即使后续迁移失败回滚，
	// 留下的也是规范分类空壳，ensureCategory 之后会复用，无害）
	// Task 25-b: 兜底类「其他」禁止作为合并源——与 GET 建议口径对齐。此前 POST 漏防，
	// 可把「其他」下全部书迁走并删除兜底分类，破坏「其他恒在/导航最后」的不变量。
	if fromName == FALLBACK_CATEGORY {
		writeJSON(w, 400, map[string]string{"error": "兜底分类「其他」不能作为合并源"})
		return
	}
	var targetID int64
	var targetName string
	if hasToID {
		if int64(toID) == fromID {
			writeJSON(w, 400, map[string]string{"error": "源分类与目标分类相同"})
			return
		}
		if err := queryOne(`SELECT "id","name" FROM "Category" WHERE "id" = ?`, []any{&targetID, &targetName}, toID); err != nil {
			if isNoRows(err) {
				writeJSON(w, 404, map[string]string{"error": "目标分类不存在"})
				return
			}
			failJSON(w, "服务器错误", firstLineErr(err), 500)
			return
		}
	} else {
		if toName == fromName {
			writeJSON(w, 400, map[string]string{"error": "源分类与目标分类相同"})
			return
		}
		if err := queryOne(`SELECT "id","name" FROM "Category" WHERE "name" = ?`, []any{&targetID, &targetName}, toName); err != nil {
			if !isNoRows(err) {
				failJSON(w, "服务器错误", firstLineErr(err), 500)
				return
			}
			// 不存在 → 创建（sort 继承源分类，对齐 TS db.category.create）；并发撞唯一约束 → 回读
			newID, ierr := execRetryReturningID(`INSERT INTO "Category" ("name","sort") VALUES (?,?)`, toName, fromSort)
			if ierr != nil {
				if isUniqueConflict(ierr) {
					if qerr := queryOne(`SELECT "id","name" FROM "Category" WHERE "name" = ?`, []any{&targetID, &targetName}, toName); qerr != nil {
						writeJSON(w, 400, map[string]string{"error": "目标分类创建失败"})
						return
					}
				} else {
					writeJSON(w, 400, map[string]string{"error": "目标分类创建失败"})
					return
				}
			} else {
				targetID = newID
				targetName = toName
			}
		}
	}

	// 事务式合并：迁书 → 删空源分类。任一步失败整体回滚，不会出现「书已迁移但源分类还在」的中间态
	db, derr := getDB()
	if derr != nil {
		failJSON(w, "服务器错误", firstLineErr(derr), 500)
		return
	}
	tx, terr := db.Begin()
	if terr != nil {
		failJSON(w, "服务器错误", firstLineErr(terr), 500)
		return
	}
	moved := int64(0)
	var mergeTxErr error
	committed := false
	func() {
		defer func() {
			if !committed {
				_ = tx.Rollback()
			}
		}()
		res, err := tx.Exec(`UPDATE "Novel" SET "categoryId" = ?, "updatedAt" = ? WHERE "categoryId" = ?`, targetID, nowMillis(), fromID)
		if err != nil {
			mergeTxErr = err
			return
		}
		moved, _ = res.RowsAffected()
		if _, err = tx.Exec(`DELETE FROM "Category" WHERE "id" = ?`, fromID); err != nil {
			mergeTxErr = err
			return
		}
		if err = tx.Commit(); err != nil {
			mergeTxErr = err
			return
		}
		committed = true
	}()
	if !committed {
		if mergeTxErr != nil && containsFoldStr(mergeTxErr.Error(), "foreign key") {
			// 外键约束冲突（合并窗口期又有书归入源分类）→ 409 提示重试（对齐 TS P2003 分支）
			writeJSON(w, 409, map[string]string{"error": "合并冲突（源分类在合并期间又有书籍归入），请重试"})
			return
		}
		detail := "未知错误"
		if mergeTxErr != nil {
			detail = truncateRunes(firstLineErr(mergeTxErr), 120)
		}
		writeJSON(w, 500, map[string]string{"error": "合并失败：" + detail})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "moved": moved, "from": fromName, "to": targetName})
}
