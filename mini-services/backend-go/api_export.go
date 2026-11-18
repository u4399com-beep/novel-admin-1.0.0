/**
 * api_export.go —— TXT 全书导出 API（Task 32-b：除 DB 外的文件存储面）。
 *
 *   POST /api/novels/{id}/export-txt[?lang=zh-Hant|zh-HK|en|ja|ko]  全书合并导出（幂等重建单文件）
 *   GET  /api/export-txt/list                                       已导出合并文件清单
 *
 * R139：lang 参数——导出译文版。逐段查 TranslationCache（key=sha256(text)+"|"+lang），
 * 命中段替换、未命中段保留原文（**cache-only：绝不触发上游 LLM**——整书数千段若
 * 走实时翻译是成本爆炸器；覆盖率在响应 translatedParas/paras 与文件头中明示，
 * 未覆盖段可先在阅读页翻过一遍预热缓存再导出）。段落切分与渲染层同口径
 * （\n split + trim + 跳空，web_data.go handleWebChapter 同款）。
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

// handleNovelExportTxt POST /api/novels/{id}/export-txt[?lang=]
func handleNovelExportTxt(w http.ResponseWriter, r *http.Request, ps map[string]string) {
	novelID, ok := routePosIntID(w, ps["id"], "无效 ID")
	if !ok {
		return
	}
	nid := int64(novelID)
	// R139：lang 可选——合法目标语种时启用译文导出（cache-only，不触发上游）
	lang := strings.TrimSpace(r.URL.Query().Get("lang"))
	if lang != "" && !translateTargets[lang] {
		failJSON(w, "不支持的译文语种", "supported: "+translateTargetsSupported(), 400)
		return
	}
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

	// R139：译文导出头部（覆盖率在导出完成后回填语义由响应字段承担，文件头先声明语种）
	if lang != "" {
		b.WriteString("译文语种：" + lang + "（逐段取自翻译缓存；未缓存段保留原文，可在阅读页预热后再导）\n\n")
	}

	// 全部章节按 idx 升序（同 idx 稳定按 id）。Task 38-b：legacy content 并入同一查询、
	// 回调内流式构建（旧版逐章 SELECT content 是 35-a 留档的 N+1——每章一次额外往返；
	// 边读边写 builder 不整表驻留内存，峰值与旧版一致；正文读取仍统一走 loadChapterContent
	// 三级回落，不直读分表）
	filled, chapterCount := 0, 0
	totalParas, translatedParas := 0, 0
	if err := queryList(`SELECT "id", "idx", "wordCount", "title", "content" FROM "Chapter"
                WHERE "novelId" = ? ORDER BY "idx" ASC, "id" ASC`,
		func(rows *sql.Rows) error {
			var id, idx, wc int64
			var title, legacy string
			if err := rows.Scan(&id, &idx, &wc, &title, &legacy); err != nil {
				return err
			}
			chapterCount++
			content := loadChapterContent(id, nid, idx, legacy, wc)
			if strings.TrimSpace(content) != "" {
				filled++
			}
			// R139：译文替换（cache-only）——与渲染层同口径切段后逐段查缓存
			if lang != "" && strings.TrimSpace(content) != "" {
				content, totalParas, translatedParas = translateExportSubstitute(content, lang, nid, totalParas, translatedParas)
			}
			fmt.Fprintf(&b, "第%d章 %s\n\n%s\n\n", idx, strings.TrimSpace(title), content)
			return nil
		}, nid); err != nil {
		failJSON(w, "服务器错误", firstLineErr(err), 500)
		return
	}

	outPath := exportTxtPath(int(nid), title)
	// Task 32 修复：TXT 根目录不存在时（全新部署/清库后从未写过分章文件）导出必失败——
	// MkdirAll 幂等建目录（与 writeChapterTxt 同语义），补齐首个使用场景的目录保障
	if err := os.MkdirAll(txtNovelsRoot(), 0o755); err != nil {
		failJSON(w, "导出失败", firstLineErr(err), 500)
		return
	}
	if err := os.WriteFile(outPath, []byte(b.String()), 0o644); err != nil {
		failJSON(w, "导出失败", firstLineErr(err), 500)
		return
	}
	writeJSON(w, 200, map[string]any{
		"ok":              true,
		"file":            outPath,
		"chapters":        chapterCount,
		"filled":          filled,
		"bytes":           len(b.String()),
		"lang":            lang,
		"paras":           totalParas,
		"translatedParas": translatedParas,
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

// translateExportSubstitute 逐段缓存替换（R139）：\n split 同渲染层口径；命中替换、
// 未命中保留原文。返回（新正文, 累计段数, 累计已译段数）。每章批量 IN 查缓存（复用
// translateCacheGet 90/批），零上游调用。nid 仅备用（当前 key 全文寻址不含书维度）。
func translateExportSubstitute(content, lang string, nid int64, totalParas, translatedParas int) (string, int, int) {
	lines := strings.Split(content, "\n")
	keys := make([]string, 0, len(lines))
	keyFor := make([]string, len(lines)) // 空串=非段落行
	for i, ln := range lines {
		p := strings.TrimSpace(ln)
		if p == "" || len([]rune(p)) < 2 {
			keyFor[i] = ""
			continue
		}
		keyFor[i] = translateCacheKey(p, lang)
		keys = append(keys, keyFor[i])
	}
	if len(keys) == 0 {
		return content, totalParas, translatedParas
	}
	hits := translateCacheGet(keys)
	out := make([]string, len(lines))
	for i, ln := range lines {
		if keyFor[i] == "" {
			out[i] = ln
			continue
		}
		totalParas++
		if c, ok := hits[keyFor[i]]; ok && c != "" {
			translatedParas++
			out[i] = c
		} else {
			out[i] = ln // 未命中保留原文（cache-only 契约，绝不触发上游）
		}
	}
	return strings.Join(out, "\n"), totalParas, translatedParas
}
