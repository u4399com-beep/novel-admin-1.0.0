/**
 * web_seo_test.go —— Task 47 sitemap/robots 规范化回归锁定：
 * <loc> 与 robots Sitemap: 指令必须为绝对 URL（sitemaps.org 规范，Task 36-b 相对形态
 * 会被搜索引擎整文件拒收）；书籍行携带 lastmod；pseo 关键词 XML 转义保持（Task 36-b）。
 */
package main

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSitemapAbsoluteURLs(t *testing.T) {
	db, err := getDB()
	if err != nil {
		t.Fatalf("getDB: %v", err)
	}
	cleanup := func() {
		_, _ = db.Exec(`DELETE FROM "PseoKeyword"`)
		_, _ = db.Exec(`DELETE FROM "Chapter"`)
		_, _ = db.Exec(`DELETE FROM "Novel"`)
		_, _ = db.Exec(`DELETE FROM "Category"`)
	}
	cleanup()
	t.Cleanup(cleanup)

	if _, err := db.Exec(`INSERT INTO "Category" ("name","sort") VALUES ('测试分类SEO', 1)`); err != nil {
		t.Fatalf("seed category: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO "Novel" ("title","author","categoryId","createdAt","updatedAt") VALUES ('sitemap测试书','作者',(SELECT "id" FROM "Category" WHERE "name" = '测试分类SEO'),?,?)`,
		nowMillis(), nowMillis()); err != nil {
		t.Fatalf("seed novel: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO "PseoKeyword" ("keyword","source","status","createdAt","updatedAt") VALUES ('seo测试词&x','manual','generated',1,1)`); err != nil {
		t.Fatalf("seed keyword: %v", err)
	}
	// Task 47-a 深审：TEXT 存储类时间戳行（Task 33-b 实证形态）不得令书籍 URL 整行
	// 丢失——updatedAt 容错扫描后仅缺 lastmod，<loc> 照常输出
	resText, err := db.Exec(`INSERT INTO "Novel" ("title","author","categoryId","createdAt","updatedAt") VALUES ('sitemap文本时间书','作者',(SELECT "id" FROM "Category" WHERE "name" = '测试分类SEO'),'not-a-time','not-a-time')`)
	if err != nil {
		t.Fatalf("seed text-time novel: %v", err)
	}
	textTimeID, _ := resText.LastInsertId()

	req := httptest.NewRequest("GET", "https://seo.example.com/sitemap.xml", nil)
	rec := httptest.NewRecorder()
	handleSitemap(rec, req)
	body := rec.Body.String()
	if rec.Code != 200 {
		t.Fatalf("sitemap status = %d", rec.Code)
	}
	for _, want := range []string{
		"<loc>https://seo.example.com/</loc>",
		"<loc>https://seo.example.com/category/",
		"<loc>https://seo.example.com/book/",
		"<lastmod>",
		"<loc>https://seo.example.com/pseo/",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("sitemap 缺 %q", want)
		}
	}
	// & 在 path 段由 xmlEscape 转义为 &amp;（Task 36-b 契约保持）
	if !strings.Contains(body, "&amp;x") {
		t.Errorf("pseo 关键词 XML 转义缺失（& 必须为 &amp;）")
	}
	if strings.Contains(body, "<loc>/") {
		t.Errorf("sitemap 残留相对 <loc>（规范违规，搜索引擎整文件拒收）")
	}
	// TEXT 时间戳行 URL 仍在（仅无 lastmod——不因扫描容错丢整行）
	var textTimeLines []string
	for _, line := range strings.Split(body, "\n") {
		if strings.Contains(line, "<loc>https://seo.example.com/book/"+itoa(int(textTimeID))+"</loc>") {
			textTimeLines = append(textTimeLines, line)
			if strings.Contains(line, "<lastmod>") {
				t.Errorf("TEXT 时间戳行不应产出 lastmod: %s", line)
			}
		}
	}
	if len(textTimeLines) != 1 {
		t.Errorf("TEXT 时间戳行书籍 URL 应出现 1 次，实际 %d 次（整行丢失=容错回归）", len(textTimeLines))
	}
	if !strings.HasSuffix(strings.TrimSpace(body), "</urlset>") {
		t.Errorf("xml 未闭合")
	}

	// robots：Sitemap 指令绝对 URL
	rec2 := httptest.NewRecorder()
	handleRobots(rec2, req)
	robots := rec2.Body.String()
	if !strings.Contains(robots, "Sitemap: https://seo.example.com/sitemap.xml") {
		t.Errorf("robots Sitemap 指令非绝对 URL: %q", robots)
	}

	// Task 47-a 深审：畸形 Host（含 & < > "）下 sitemap 仍须合法 XML——base 一次性
	// xmlEscape，分类/书籍/pseo 行与首页行转义口径一致（原实现仅首页行点态转义）
	req2 := httptest.NewRequest("GET", "http://backend-internal/sitemap.xml", nil)
	req2.Host = `h&amp;<x>"y`
	rec4 := httptest.NewRecorder()
	handleSitemap(rec4, req2)
	body2 := rec4.Body.String()
	for _, want := range []string{
		"<loc>http://h&amp;amp;&lt;x&gt;&quot;y/</loc>",
		"<loc>http://h&amp;amp;&lt;x&gt;&quot;y/category/",
		"<loc>http://h&amp;amp;&lt;x&gt;&quot;y/book/",
	} {
		if !strings.Contains(body2, want) {
			t.Errorf("畸形 Host 未统一 XML 转义，缺 %q", want)
		}
	}

	// X-Forwarded-Proto 反代场景 scheme 识别
	req3 := httptest.NewRequest("GET", "http://backend-internal/sitemap.xml", nil)
	req3.Header.Set("X-Forwarded-Proto", "https")
	rec3 := httptest.NewRecorder()
	handleRobots(rec3, req3)
	if !strings.Contains(rec3.Body.String(), "Sitemap: https://backend-internal/sitemap.xml") {
		t.Errorf("X-Forwarded-Proto 未生效: %q", rec3.Body.String())
	}
}
