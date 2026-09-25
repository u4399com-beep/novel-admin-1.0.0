/**
 * api_export.go —— TXT 全书导出 API（Task 32-b：除 DB 外的文件存储面）。
 *
 *   POST /api/novels/{id}/export-txt   全书合并导出（幂等重建单文件）
 *   GET  /api/export-txt/list          已导出合并文件清单
 *
 * 合并文件 = {TXT_ROOT}/{novelId}_{safeBookTitle}.txt（txtdir.go exportTxtPath）：
 *   头部：书名/作者/分类/状态/简介 + 分隔行
 *   正文：按 idx 升序「第{idx}章 {标题}\n{正文}\n\n」
 * 正文三级回落读取（loadChapterContent）：分表 → Chapter.content 存量 → TXT 分章文件，
 * db/txt/both 三种存储模式的书都能导出。路由经 init() 注册（api_scrape.go 先例）。
 */
package main

import (
	"database/sql"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strings"
)

func init() {
	register("POST", "/api/novels/{id}/export-txt", handleNovelExportTxt)
	register("GET", "/api/export-txt/list", handleExportTxtList)
}

// handleNovelExportTxt POST /api/novels/{id}/export-txt
func handleNovelExportTxt(w http.ResponseWriter, r *http.Request, ps map[string]string) {
	novelID, ok := routePosIntID(w, ps["id"], "无效 ID")
	if !ok {
		return
	}
	nid := int64(novelID)
	var title, author, desc, status string
	var categoryID int64
	err := queryOne(`SELECT n."title", n."author", n."description", n."status", n."categoryId"
                FROM "Novel" n WHERE n."id" = ?`, []any{&title, &author, &desc, &status, &categoryID}, nid)
	if err != nil {
		writeJSON(w, 404, map[string]string{"error": "小说不存在"})
		return
	}
	categoryName := ""
	_ = queryOne(`SELECT "name" FROM "Category" WHERE "id" = ?`, []any{&categoryName}, categoryID)
	// 全部章节按 idx 升序（同 idx 稳定按 id）；正文三级回落逐章读取
	type chRow struct {
		id, idx, wc int64
		title       string
	}
	chapters := []chRow{}
	if err := queryList(`SELECT "id", "idx", "wordCount", "title" FROM "Chapter"
                WHERE "novelId" = ? ORDER BY "idx" ASC, "id" ASC`,
		func(rows *sql.Rows) error {
			var c chRow
			if err := rows.Scan(&c.id, &c.idx, &c.wc, &c.title); err != nil {
				return err
			}
			chapters = append(chapters, c)
			return nil
		}, nid); err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}

	var b strings.Builder
	b.WriteString(title + "\n")
	b.WriteString("作者：" + author + "\n")
	if categoryName != "" {
		b.WriteString("分类：" + categoryName + "\n")
	}
	statusText := "连载中"
	if status == "finished" {
		statusText = "已完本"
	}
	b.WriteString("状态：" + statusText + "\n")
	if desc != "" {
		b.WriteString("\n简介：" + desc + "\n")
	}
	b.WriteString(strings.Repeat("=", 32) + "\n\n")

	filled := 0
	for _, c := range chapters {
		var legacy string
		_ = queryOne(`SELECT "content" FROM "Chapter" WHERE "id" = ?`, []any{&legacy}, c.id)
		content := loadChapterContent(c.id, nid, c.idx, legacy, c.wc)
		if strings.TrimSpace(content) != "" {
			filled++
		}
		fmt.Fprintf(&b, "第%d章 %s\n\n%s\n\n", c.idx, strings.TrimSpace(c.title), content)
	}

	outPath := exportTxtPath(int(nid), title)
	if err := os.WriteFile(outPath, []byte(b.String()), 0o644); err != nil {
		failJSON(w, "导出失败", firstLineErr(err), 500)
		return
	}
	writeJSON(w, 200, map[string]any{
		"ok":       true,
		"file":     outPath,
		"chapters": len(chapters),
		"filled":   filled,
		"bytes":    len(b.String()),
	})
}

// handleExportTxtList GET /api/export-txt/list
func handleExportTxtList(w http.ResponseWriter, r *http.Request, _ map[string]string) {
	items := listExportedTxt()
	sort.Slice(items, func(i, j int) bool { return items[i].novelID < items[j].novelID })
	out := make([]map[string]any, 0, len(items))
	for _, it := range items {
		out = append(out, map[string]any{
			"novelId": it.novelID,
			"title":   it.title,
			"size":    it.size,
			"mtime":   it.mtimeMS,
			"path":    it.path,
		})
	}
	writeJSON(w, 200, map[string]any{"list": out, "total": len(out)})
}
