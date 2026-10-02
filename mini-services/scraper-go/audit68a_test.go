/**
 * audit68a_test.go —— Task 68 封面-书籍错位根修回归锁定（scraper-go 侧）。
 *
 * 用户报告：「封面图和书籍不对应。」根因：书详情页封面回退选择器（.cover img 等
 * 通用类）是页面级搜索且逐选择器取首个命中——「推荐书籍/排行/相关书」侧栏的 img
 * 与主封面同形且可能先出现在 DOM 序，推荐位书籍的封面被误配给本书。
 *
 * 修复语义（本文件锁定）：
 * ① pickCoverHref——推荐位容器（coverNoiseContainers）祖先链内的候选被跳过，
 *    同选择器内取首个干净命中；
 * ② 全部候选被排除 → 返回空串（渐变 token 兜底），绝不回退被污染候选；
 * ③ rePlaceholderCover 追加 logo 形态——og:image 恒为全站 logo 的站点不再全库同图。
 */
package main

import (
	"strings"
	"testing"

	"github.com/PuerkitoBio/goquery"
)

func docFromHTML68(t *testing.T, html string) *goquery.Document {
	t.Helper()
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(html))
	if err != nil {
		t.Fatalf("goquery doc: %v", err)
	}
	return doc
}

// ① 推荐位图片在 DOM 序先于主封面：旧 pickHref 逐选择器取首个命中会误取推荐位封面
func TestPickCoverHrefSkipsRecommendationPanels(t *testing.T) {
	doc := docFromHTML68(t, `<!doctype html><html><body>
<div class="ranking"><div class="cover"><img src="/img/rec1.jpg"></div></div>
<div class="recommend"><img class="cover" src="/img/rec2.jpg"></div>
<div class="book-info">
  <h1>测试书名</h1>
  <div class="cover"><img src="/img/real.jpg"></div>
</div>
</body></html>`)

	warnings := []string{}
	book := extractBook(doc, map[string]string{}, "http://example.com/book/1.html", &warnings)
	if book.Cover == nil {
		t.Fatalf("Cover 为 nil")
	}
	if *book.Cover != "http://example.com/img/real.jpg" {
		t.Fatalf("推荐位封面未被排除: got %q want http://example.com/img/real.jpg（封面-书籍错位回归）", *book.Cover)
	}
}

// ② 主封面缺失、封面候选全部位于推荐位容器 → 返回空串（渐变兜底），绝不误配
func TestPickCoverHrefAllExcludedReturnsEmpty(t *testing.T) {
	doc := docFromHTML68(t, `<!doctype html><html><body>
<div class="rank-list"><div class="cover"><img src="/img/rec-a.jpg"></div></div>
<div class="related"><img class="cover" src="/img/rec-b.jpg"></div>
<h1>无封面书</h1>
</body></html>`)

	warnings := []string{}
	book := extractBook(doc, map[string]string{}, "http://example.com/book/2.html", &warnings)
	// strPtr("") 返回 nil（Cover *string 空=无封面，渐变 token 兑底由上游落库）
	if book.Cover != nil && *book.Cover != "" {
		t.Fatalf("候选全被排除时应返回空: got %v", *book.Cover)
	}
}

// ③ 规则显式 coverSelector 同样走推荐位排除
func TestPickCoverHrefRuleSelectorFiltered(t *testing.T) {
	doc := docFromHTML68(t, `<!doctype html><html><body>
<div class="tuijian"><div id="fmimg"><img src="/img/rec.jpg"></div></div>
<div id="main"><div id="fmimg"><img src="/img/main.jpg"></div></div>
</body></html>`)

	warnings := []string{}
	book := extractBook(doc, map[string]string{"coverSelector": "#fmimg img@src"}, "http://example.com/book/3.html", &warnings)
	if book.Cover == nil || *book.Cover != "http://example.com/img/main.jpg" {
		got := ""
		if book.Cover != nil {
			got = *book.Cover
		}
		t.Fatalf("规则选择器推荐位排除失效: got %q want http://example.com/img/main.jpg", got)
	}
}

// ④ og:image 缺失但页面干净：主封面正常提取（基线不回归）
func TestPickCoverHrefBaselineUnchanged(t *testing.T) {
	doc := docFromHTML68(t, `<!doctype html><html><body>
<h1>正常书</h1>
<div class="book-img"><img src="/img/normal.jpg"></div>
</body></html>`)

	warnings := []string{}
	book := extractBook(doc, map[string]string{}, "http://example.com/book/4.html", &warnings)
	if book.Cover == nil || *book.Cover != "http://example.com/img/normal.jpg" {
		t.Fatalf("基线封面提取回归: got %v", book.Cover)
	}
}

// ⑤ logo 形态占位过滤：og:image 恒为全站 logo 的站点不再全库同图
func TestPlaceholderCoverLogoPatterns(t *testing.T) {
	hits := []string{
		"http://example.com/logo.png",
		"http://example.com/images/logo_1.jpg",
		"http://example.com/logo.jpg",
		"https://cdn.example.com/site-logo-v2.png",
	}
	for _, u := range hits {
		if !rePlaceholderCover.MatchString(u) {
			t.Fatalf("logo 占位应被过滤: %s", u)
		}
	}
	fine := []string{
		"http://example.com/covers/12345.jpg",
		"http://example.com/img/Logan.jpg", // 词中缀 Logan 不含 logo 分隔形态
		"http://example.com/img/cover123.jpg",
	}
	for _, u := range fine {
		if rePlaceholderCover.MatchString(u) {
			t.Fatalf("正常封面被误伤: %s", u)
		}
	}
}

// ⑥ inCoverNoiseContainer 直测：祖先链命中即 true
func TestInCoverNoiseContainer(t *testing.T) {
	doc := docFromHTML68(t, `<div class="sidebar"><div class="bookbox"><img id="in" src="/x.jpg"></div></div><div><img id="out" src="/y.jpg"></div>`)
	if !inCoverNoiseContainer(doc.Find("#in")) {
		t.Fatalf("sidebar .bookbox 内候选应被识别为推荐位")
	}
	if inCoverNoiseContainer(doc.Find("#out")) {
		t.Fatalf("正常候选不应被误判")
	}
}
