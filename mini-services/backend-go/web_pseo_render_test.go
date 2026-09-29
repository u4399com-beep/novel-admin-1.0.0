/**
 * web_pseo_render_test.go —— Task 50-① 回归锁定：pseo 聚合页主打书区块
 * （书籍页前两区块语义复刻：封面属性盒 + 简介/相关标签）渲染契约。
 * trxsw 与 _fallback 双主题：有 Featured 数据 → 区块在位；无 Featured（空聚合结果）→
 * 区块零渲染不破版；既有「相关小说」表在两种形态下均保留。
 */
package main

import (
	"bytes"
	"html/template"
	"path/filepath"
	"strings"
	"testing"
)

func renderPseoTemplate(t *testing.T, theme string, data map[string]any) string {
	t.Helper()
	shared := filepath.Join(templatesRoot, theme, "_shared.html")
	page := filepath.Join(templatesRoot, theme, "pseo.html")
	tpl, err := template.New("t").Funcs(webFuncMap()).ParseFiles(shared, page)
	if err != nil {
		t.Fatalf("%s pseo 布局解析失败: %v", theme, err)
	}
	var b bytes.Buffer
	if err := tpl.ExecuteTemplate(&b, "layout", data); err != nil {
		t.Fatalf("%s pseo 渲染失败: %v", theme, err)
	}
	return b.String()
}

func pseoRenderBaseData() map[string]any {
	return map[string]any{
		"Site":      map[string]any{"siteName": "测试站", "notice": "", "activeTheme": "trxsw", "footerText": "", "footerExtra": ""},
		"Nav":       []map[string]any{{"id": int64(1), "name": "玄幻", "sort": int64(0), "novelCount": int64(0)}},
		"Path":      "/pseo/test",
		"Q":         "",
		"pageTitle": "测试页", "pageDescription": "", "pageKeywords": "",
		"Keyword":     "剑来",
		"Description": "关于“剑来”的小说推荐",
		"Novels": []map[string]any{
			{"id": int64(7), "title": "剑来", "author": "烽火戏诸侯", "cover": "g3", "status": "serial",
				"categoryName": "玄幻奇幻", "wordCount": int64(0), "clicks": int64(5), "updatedAt": "2026-09-27T08:00:00Z",
				"description": "大千世界，无奇不有。", "lastChapterTitle": "第10章 试炼"},
		},
	}
}

func pseoFeaturedData() map[string]any {
	return map[string]any{
		"id": int64(7), "title": "剑来", "author": "烽火戏诸侯", "cover": "g3", "status": "serial",
		"categoryName": "玄幻奇幻", "wordCount": int64(1234567), "clicks": int64(5),
		"updatedAt": "2026-09-27T08:00:00Z", "description": "大千世界，无奇不有。",
	}
}

func TestTrxswPseoFeaturedRender(t *testing.T) {
	data := pseoRenderBaseData()
	data["Featured"] = pseoFeaturedData()
	data["FeaturedTags"] = []string{"剑来", "玄幻"}
	data["FeaturedChapters"] = []map[string]any{{"id": int64(71), "idx": int64(1), "title": "第1章 惊蛰", "wordCount": int64(2100)}}
	data["FeaturedChaptersTotal"] = int64(10)
	data["FeaturedLastChapter"] = map[string]any{"id": int64(80), "idx": int64(10), "title": "第10章 试炼"}
	out := renderPseoTemplate(t, "trxsw", data)

	for _, want := range []string{
		"主打推荐",                     // 区块一标识
		"/book/7",                  // 主打书内链
		"最新章节：",                    // 区块一末章行
		"共 10 章",                   // 区块一总章数
		"全文阅读",                     // 区块一按钮行
		"《剑来》简介",                   // 区块二标题
		"大千世界，无奇不有。",               // 区块二简介
		"/pseo/%E5%89%91%E6%9D%A5", // 相关标签 chips 内链（pseoURL PathEscape「剑来」）
		"相关小说",                     // 既有相关小说区块保留
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("trxsw pseo 主打书区块应含 %q", want)
		}
	}
}

func TestTrxswPseoFeaturedAbsent(t *testing.T) {
	data := pseoRenderBaseData()
	data["Featured"] = nil
	out := renderPseoTemplate(t, "trxsw", data)
	for _, gone := range []string{"主打推荐", "《剑来》简介", "全文阅读"} {
		if strings.Contains(out, gone) {
			t.Fatalf("trxsw pseo 无主打书时不应渲染 %q", gone)
		}
	}
	if !strings.Contains(out, "相关小说") {
		t.Fatal("trxsw pseo 无主打书时相关小说区块仍应在位")
	}
}

func TestFallbackPseoFeaturedRender(t *testing.T) {
	data := pseoRenderBaseData()
	data["Featured"] = pseoFeaturedData()
	data["FeaturedTags"] = []string{"剑来"}
	data["FeaturedChapters"] = []map[string]any{{"id": int64(71), "idx": int64(1), "title": "第1章 惊蛰", "wordCount": int64(2100)}}
	data["FeaturedChaptersTotal"] = int64(10)
	data["FeaturedLastChapter"] = map[string]any{"id": int64(80), "idx": int64(10), "title": "第10章 试炼"}
	out := renderPseoTemplate(t, "_fallback", data)
	for _, want := range []string{"/book/7", "开始阅读", "查看目录", "大千世界，无奇不有。", "暂无匹配书籍"} {
		if want == "暂无匹配书籍" {
			continue // 有 Novels 数据时才不出现空态；此处 Novels 非空
		}
		if !strings.Contains(out, want) {
			t.Fatalf("_fallback pseo 主打书区块应含 %q", want)
		}
	}
	// 无 Featured：区块整体缺席
	data2 := pseoRenderBaseData()
	data2["Featured"] = nil
	out2 := renderPseoTemplate(t, "_fallback", data2)
	if strings.Contains(out2, "开始阅读") || strings.Contains(out2, "查看目录") {
		t.Fatal("_fallback pseo 无主打书时不应渲染阅读按钮")
	}
}
