/**
 * goquery 规则提取器（逐行移植自 extract/extract.ts）：把 ListRule / BookRule / ChapterRule
 * 应用到已解码的 HTML 上。
 *
 * 约定：
 * - 规则缺失时使用内置启发式候选，并在 warnings 中明确标注；
 * - 正文清洗：容器级去 script/style/广告链接/站点水印行（content.go）、行级噪声统一清洗（cleanx.go），
 *   噪声行占比过高时向 warnings 提示 contentSelector 可能命中了导航/广告容器；
 * - 链接按 URL+标题去重（去重忽略锚点）；同 URL 重复时保留后出现者（最新章节跳转链接
 *   先于真实目录出现，保留后位避免目录首行被跳转链接占据——novel#147-158 章序错乱修复语义）。
 */
package main

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/PuerkitoBio/goquery"
)

const maxListItems = 500

// 单次目录提取的章节引用上限（对齐 worker 单本上限 10000；引擎层不得先于 worker 静默丢章）
const maxChapterRefs = 10000

// 目录页噪声按钮/导航文案（trim 后全等才算）：源站书页顶部常有「立即阅读」等按钮指向第一章 URL、
// 「第N章」形式的最新章节跳转链接指向末章 URL。只用精确全等不用子串，避免误伤真实章节标题。
var noiseTocTitles = map[string]bool{
	"立即阅读": true, "开始阅读": true, "点击阅读": true, "进入阅读": true, "继续阅读": true, "全文阅读": true, "免费阅读": true,
	"无弹窗阅读": true, "最新章节": true, "最新章节列表": true, "查看目录": true, "章节目录": true, "全部目录": true, "目录": true,
	"书签": true, "加入书签": true, "上一章": true, "下一章": true, "上一页": true, "下一页": true, "推荐票": true, "投推荐票": true,
}

func isNoiseTocTitle(title string) bool {
	return noiseTocTitles[trimJSSpace(title)]
}

const maxDescriptionChars = 2000
const maxTitleChars = 200

// 站标/全站样板文本：出现在标题候选中即视为命中站标而非真实标题
var reBoilerplateTitle = regexp.MustCompile(`站内搜索|快速找到你想要的|TXT电子书|TXT下载|全本TXT|电子书免费下载|电子书下载地址`)

// pickTitle 标题选择器逐个尝试，跳过命中站标样板的候选
func pickTitle(s *goquery.Selection, selectors []string) string {
	for _, raw := range selectors {
		t := pickText(s, []string{raw})
		if t != "" && !reBoilerplateTitle.MatchString(t) {
			return t
		}
	}
	return ""
}

var (
	reTxtDownload   = regexp.MustCompile(`(?i)txt下载|全本txt|电子书下载`)
	reStripDownload = regexp.MustCompile(`(?i)txt下载|全本txt|电子书下载|最新章节`)
	// 杰奇系 h1 样板后缀（整词后缀且剥后仍非空才生效）
	reSeoSuffix  = regexp.MustCompile(`(?i)(?:\s*(?:最新章节(?:列表)?|全文阅读|全本阅读|免费阅读|无弹窗(?:广告)?(?:全文|免费)?阅读|无广告阅读|笔趣阁|顶点小说|无错小说|txt下载|全本txt))+$`)
	reAuthorTail = regexp.MustCompile(`(?i)作者[:：][^《》]{1,30}$`)
	reBookTitle  = regexp.MustCompile(`^《(.+?)》$`)
)

// cleanBookTitle 清理书籍标题：剥《》书名号、下载站样板、SEO 后缀、作者尾巴
func cleanBookTitle(t string) string {
	s := trimJSSpace(t)
	if s == "" {
		return ""
	}
	if reTxtDownload.MatchString(s) {
		// 仅当存在下载站样板词时才按分隔符拆段，避免误伤含「_/-」的正常书名
		seg := strings.SplitN(s, "_", 2)[0]
		if idx := strings.IndexAny(seg, "|｜"); idx >= 0 {
			seg = seg[:idx]
		}
		seg = trimJSSpace(seg)
		if seg != "" {
			s = seg
		}
		s = trimJSSpace(reStripDownload.ReplaceAllString(s, ""))
	}
	// 剥杰奇系 h1 常见样板后缀（如「葬神棺全文阅读」「XX最新章节列表」）；剥后仍非空才生效
	stripped := trimJSSpace(reSeoSuffix.ReplaceAllString(s, ""))
	if stripped != "" && runeLen(stripped) >= 2 {
		s = stripped
	}
	// 新模板 h1 内嵌作者行（如 trxsw：h1.f21h 文本 = 「书名作者:某某」）→ 剥「作者:某某」尾巴
	noAuthor := trimJSSpace(reAuthorTail.ReplaceAllString(s, ""))
	if noAuthor != "" && runeLen(noAuthor) >= 2 {
		s = noAuthor
	}
	if m := reBookTitle.FindStringSubmatch(s); m != nil {
		s = m[1]
	}
	return s
}

// cleanDescription 简介清洗：剥模板前缀「关于《书名》：/内容简介：/简介：」与首尾空白
var reDescPrefix = regexp.MustCompile(`^(?:关于[《〈]?.{1,40}?[》〉]?|内容简介|内容提要|作品简介|简介)[:：]\s*`)

// Task 28-a: 尾部 SEO 样板清洗——部分站点（实测 ggd66.com）在简介末尾拼接
// 「《书名》是某某作者精心创作的某某分类，某某站实时更新《书名》最新章节……」固定模板段，
// 长度 60-200 字且总在末尾；命中「《X》是Y精心创作」锚点即截断到末尾（锚点要求书名号+是+人名+精心创作，
// 正常叙事文本几乎不可能命中）。不加 (?s)：pickText 已 collapse 为单行文本，无需跨行匹配。
var reDescBoilerplate = regexp.MustCompile(`《[^》]{1,50}》是.{1,25}精心创作.{0,300}$`)

// Task 41: 简介基础噪声修复（引擎侧第一道；「相关小说：」尾块等**不在引擎侧截断**——
// 编排侧 introx.go 需要完整尾块提取长尾词转 pSEO，引擎先截断则转换无从谈起）：
//   - reDescEntityFix 全角分号实体归一「&#091；」→「&#091;」（源站模板收尾写成全角「；」，
//     decodeResidualEntities 等任何实体解码器都不认，书 67 实证「&#091；轻松军旅&#093；」原样入库）
//   - reDescFFFD 解码残损字符「�」剥除（「【」残臂实证）
//   - reDescBrTag 换行语义标签 <br> → 空格、其余 HTML 标签剥除（书 46 实证「<br />」残留）
var reDescEntityFix = regexp.MustCompile(`&#([xX]?)([0-9a-fA-F]+)[；﹔]`)
var reDescFFFD = regexp.MustCompile(`\x{FFFD}+`)
var reDescBr = regexp.MustCompile(`(?i)<br\s*/?>`)
var reDescTag = regexp.MustCompile(`(?i)</?[a-z][^>]{0,80}>`)

func cleanDescription(t string) string {
	// Task 31-c: 简介残留实体再解码——与正文 cleanContainer 同源缺口（实测 ixdzs8 系
	// 简介以双重转义的 &amp;amp;&amp;amp; 作分隔符，全库 3 本 Novel.description 命中）。
	t = reDescEntityFix.ReplaceAllString(t, `&#${1}${2};`)
	t = decodeResidualEntities(t)
	t = reDescFFFD.ReplaceAllString(t, "")
	t = reDescBr.ReplaceAllString(t, " ")
	t = reDescTag.ReplaceAllString(t, "")
	t = trimJSSpace(reDescPrefix.ReplaceAllString(t, ""))
	return trimJSSpace(reDescBoilerplate.ReplaceAllString(t, ""))
}

// stripFieldLabel 分类/状态字段清洗：剥「小说分类：/书籍分类：/分类：/类型：/频道：」等标签前缀
// Task 28-a: 补「书籍」前缀（实测 aijjxs.com 书页输出「书籍分类：穿越小说」，旧正则剥不掉）
var reFieldLabel = regexp.MustCompile(`^(?:(?:小说|书籍))?(?:分类|类型|频道|状态)[:：]\s*`)

func stripFieldLabel(t string) string { return trimJSSpace(reFieldLabel.ReplaceAllString(t, "")) }

// stripAuthorLabel 作者字段清洗：剥「作者：/作 者：/书籍作者：」等标签前缀
var reAuthorLabel = regexp.MustCompile(`(?i)^(?:(?:书籍)?作\s*者\s*[:：]?\s*|(?:author|writer)\s*[:：]?\s*)`)

func stripAuthorLabel(t string) string { return trimJSSpace(reAuthorLabel.ReplaceAllString(t, "")) }

// Task 28-a: 占位封面 URL 特征（URL 任意段含这些 token 即视为占位图，不做网络探测）
var rePlaceholderCover = regexp.MustCompile(`(?i)(?:nocover|no_cover|nopic|no-img|noimage|no_image|placeholder|zanwu|wufengmian)`)

// removeExcluded 规则级排除：提取前从 DOM 移除命中节点（站标/搜索框等全站样板容器），
// 多备用逗号分隔。extractBook 与 extractChapter 各自的入口只调一次。
func removeExcluded(root *goquery.Selection, excludeSel string, warnings *[]string) {
	if excludeSel == "" {
		return
	}
	removed := 0
	for _, sel := range splitAlternatives(excludeSel) {
		if m := compileSel(sel); m != nil {
			hit := root.FindMatcher(m)
			if hit.Length() > 0 {
				removed += hit.Length()
				hit.Remove()
			}
		} else {
			*warnings = append(*warnings, "excludeSelector 含非法选择器已跳过: \""+sel+"\"")
		}
	}
	if removed == 0 {
		*warnings = append(*warnings, "excludeSelector 无命中: \""+excludeSel+"\"")
	}
}

// ==================== List 提取 ====================

var defaultItemSelectors = []string{
	".novel-item", ".book-item", ".bookbox", ".item", ".lirow",
	"ul.list li", ".book-list li", ".grid li", "table tr", "li",
}

func extractList(doc *goquery.Document, rule map[string]string, baseURL string, warnings *[]string) ListData {
	root := doc.Selection
	itemSel := ""
	var itemEls *goquery.Selection

	if sel, ok := rule["itemSelector"]; ok && sel != "" {
		for _, s := range splitAlternatives(sel) {
			if found := findSafe(root, s); found != nil && found.Length() > 0 {
				itemSel = s
				itemEls = found
				break
			}
		}
		if itemSel == "" {
			*warnings = append(*warnings, "itemSelector 在页面中无命中: \""+sel+"\"")
		}
	} else {
		for _, s := range defaultItemSelectors {
			if found := findSafe(root, s); found != nil && found.Length() >= 3 {
				itemSel = s
				itemEls = found
				break
			}
		}
		if itemSel != "" {
			*warnings = append(*warnings, "未提供 itemSelector，使用内置候选 \""+itemSel+"\"（建议在规则中显式配置）")
		}
	}

	items := []ListItem{}
	seen := map[string]bool{}

	if itemEls != nil {
		sliceSel(itemEls, maxListItems).Each(func(_ int, it *goquery.Selection) {
			linkSels := []string{"a[href]"}
			if ls, ok := rule["linkSelector"]; ok && ls != "" {
				linkSels = splitAlternatives(ls)
			}
			linkEl := firstMatch(it, linkSels)
			title := ""
			if ts, ok := rule["titleSelector"]; ok && ts != "" {
				title = pickText(it, splitAlternatives(ts))
			}
			if title == "" && linkEl != nil {
				title = collapse(linkEl.Text())
			}
			if title == "" {
				if _, has := rule["titleSelector"]; !has {
					anyA := it.Find("a").First()
					if anyA.Length() > 0 {
						title = collapse(anyA.Text())
					}
				}
			}
			// 链接统一走 pickHref：支持 linkSelector 的 @attr 后缀与备选语义
			url := pickHref(it, linkSels, baseURL)
			author := ""
			if as, ok := rule["authorSelector"]; ok && as != "" {
				author = pickText(it, splitAlternatives(as))
			}
			category := ""
			if cs, ok := rule["categorySelector"]; ok && cs != "" {
				category = pickText(it, splitAlternatives(cs))
			}
			if title == "" && url == "" {
				return
			}
			key := title + "|" + url
			if seen[key] {
				return
			}
			seen[key] = true
			items = append(items, ListItem{Title: title, Url: strPtr(url), Author: author, Category: category})
		})
	}

	return ListData{Type: "list", Count: len(items), ItemSelector: itemSel, Items: items}
}

// ==================== Book 提取 ====================

// 杰奇 CMS 等老牌小说站普遍输出 og:novel:* meta，是高价值的默认回退
// Task 28-a: og:description 插到 meta[name=description] 之前——小说站 meta[name=description]
// 多为 SEO 样板（实测 x2552.com 目录页 name=description=「书名最新章节及全本内容…」而
// og:description 是真实简介）；og:description 走开放图谱协议、内容向，作为回退质量更稳。
var bookFieldFallbacks = map[string][]string{
	"title": {"meta[property=\"og:novel:book_name\"]@content", "h1", "#title", ".book-title", ".bookTitle", "title"},
	"author": {
		"meta[property=\"og:novel:author\"]@content", "#author", ".author", ".book-author",
		"#info p:nth-of-type(1)", "span:contains(作者：)", "p:contains(作者：)",
	},
	"description": {
		"meta[property=\"og:novel:description\"]@content", "meta[property=\"og:description\"]@content",
		"meta[name=\"description\"]@content", "#intro", ".intro", ".book-desc", ".description", "#content dd", ".bookintro",
	},
	"cover": {
		"meta[property=\"og:image\"]@content", "#fmimg img@src", ".book-img img@src",
		".cover img@src", ".book-cover img@src", "img.cover@src",
	},
	"status":   {"meta[property=\"og:novel:status\"]@content", "#status", ".book-status", ".status", ".book-state"},
	"category": {"meta[property=\"og:novel:category\"]@content", "#category", ".book-category", ".category", ".book-cat"},
}

var (
	reChapterText = regexp.MustCompile(`^第\s*[0-9〇零一二两三四五六七八九十百千万]+\s*[章节卷回（(]`)
	reChapterURL  = regexp.MustCompile(`(?i)/\d+[_\d]*\.html?$`)
)

// chapterLike 判断一个链接是否"章节样式"（标题正则或 /123.html 型 URL）
func chapterLike(a *goquery.Selection) bool {
	t := collapse(a.Text())
	if t == "" || runeLen(t) > 60 {
		return false
	}
	return reChapterText.MatchString(t) || reChapterURL.MatchString(a.AttrOr("href", ""))
}

func extractChapterRefs(doc *goquery.Document, rule map[string]string, baseURL string, warnings *[]string) []BookChapterRef {
	// chapterLinkSelector=none：显式跳过章节列表提取（元数据站/下载站，避免误判串书）
	if cls, ok := rule["chapterLinkSelector"]; ok && strings.ToLower(strings.TrimSpace(cls)) == "none" {
		*warnings = append(*warnings, "chapterLinkSelector=none：按配置跳过章节列表提取（元数据/下载站）")
		return []BookChapterRef{}
	}
	root := doc.Selection
	var linkEls *goquery.Selection
	usedRule := false

	if cls, ok := rule["chapterLinkSelector"]; ok && cls != "" {
		for _, sel := range splitAlternatives(cls) {
			if found := findSafe(root, sel); found != nil && found.Length() > 0 {
				linkEls = found
				usedRule = true
				break
			}
		}
		if linkEls == nil {
			*warnings = append(*warnings, "chapterLinkSelector 在页面中无命中: \""+cls+"\"")
		}
	}

	if linkEls == nil {
		// 启发式：在常见目录容器中挑选"章节样式链接"最多者；全局兜底按标题正则筛
		containerSelectors := []string{"#list", ".listmain", "#chapterList", ".chapter-list", "#chapters", ".catalog", ".book-list", "dl"}
		var best *goquery.Selection
		bestCount := 0
		bestSel := ""
		for _, sel := range containerSelectors {
			container := findSafe(root, sel)
			if container == nil || container.Length() == 0 {
				continue
			}
			container = container.First() // 与 TS 一致：只统计首个命中容器
			n := container.FindMatcher(compileSel("a[href]")).FilterFunction(func(_ int, a *goquery.Selection) bool {
				return chapterLike(a)
			}).Length()
			if n > bestCount {
				bestCount = n
				best = container
				bestSel = sel
			}
		}
		if best != nil && bestCount > 0 {
			// 启发式路径只保留"章节样式"链接，避免容器内导航/推荐链接混入
			linkEls = best.Find("a[href]").FilterFunction(func(_ int, a *goquery.Selection) bool {
				return chapterLike(a)
			})
			*warnings = append(*warnings, "章节链接由内置启发式获得（容器 \""+bestSel+"\"，命中 "+strconv.Itoa(bestCount)+" 条章节样式链接），建议在规则中显式配置 chapterLinkSelector")
		} else {
			global := root.Find("a[href]").FilterFunction(func(_ int, a *goquery.Selection) bool {
				t := collapse(a.Text())
				return t != "" && runeLen(t) <= 60 && reChapterText.MatchString(t)
			})
			if global.Length() > 0 {
				linkEls = global
				*warnings = append(*warnings, "章节链接由全局\"第N章\"标题正则启发式获得")
			}
		}
	}

	refs := []BookChapterRef{}
	// URL → refs 数组下标；同 URL 重复时保留后出现者（删除前位再追加）
	seen := map[string]int{}
	selfURL := toAbs(baseURL, baseURL)
	stripHash := func(u string) string {
		if idx := strings.Index(u, "#"); idx >= 0 {
			return u[:idx]
		}
		return u
	}
	selfURLNoHash := ""
	if selfURL != "" {
		selfURLNoHash = stripHash(selfURL)
	}
	if linkEls != nil {
		sliceSel(linkEls, maxChapterRefs).Each(func(_ int, a *goquery.Selection) {
			title := ""
			if usedRule {
				if cts, ok := rule["chapterTitleSelector"]; ok && cts != "" {
					title = pickText(a, splitAlternatives(cts))
				}
			}
			if title == "" {
				title = collapse(a.Text())
			}
			url := toAbs(a.AttrOr("href", ""), baseURL)
			// 无 URL 的引用无法被采集（下游 worker 也会过滤），直接跳过
			if url == "" {
				return
			}
			if isNoiseTocTitle(title) {
				return // 目录页按钮/导航文案（立即阅读/最新章节跳转等）
			}
			if title != "" && runeLen(title) > 80 {
				return // 明显不是章节链接
			}
			if stripHash(url) == selfURLNoHash {
				return // 跳过指向当前页的自链接（含锚点变体）
			}
			key := stripHash(url) // 去重忽略锚点，避免同章多锚点重复
			if prevIdx, exists := seen[key]; exists {
				// 同 URL 重复：后出现者胜（更可能来自真实目录列表），原位删除后按当前 DOM 顺序追加
				refs = append(refs[:prevIdx], refs[prevIdx+1:]...)
				for k, idx := range seen {
					if idx > prevIdx {
						seen[k] = idx - 1
					}
				}
			}
			seen[key] = len(refs)
			refs = append(refs, BookChapterRef{Title: title, Url: strPtr(url)})
		})
	}

	// 最后兜底：杰奇 meta 最新章（噪声文案过滤后才启用）
	if len(refs) == 0 {
		url := pickHref(root, []string{"meta[property=\"og:novel:latest_chapter_url\"]@content"}, baseURL)
		latestTitle := pickText(root, []string{"meta[property=\"og:novel:latest_chapter_name\"]@content"})
		if url != "" && latestTitle != "" && !isNoiseTocTitle(latestTitle) {
			refs = append(refs, BookChapterRef{Title: latestTitle, Url: strPtr(url)})
			*warnings = append(*warnings, "未找到章节列表，回退 og:novel:latest_chapter_* meta（仅最新一章）")
		}
	}
	return refs
}

func extractBook(doc *goquery.Document, rule map[string]string, baseURL string, warnings *[]string) BookData {
	root := doc.Selection
	removeExcluded(root, rule["excludeSelector"], warnings)

	field := func(ruleKey string, fallbacks []string) string {
		sels := []string{}
		if v, ok := rule[ruleKey]; ok && v != "" {
			sels = append(sels, splitAlternatives(v)...)
		}
		sels = append(sels, fallbacks...)
		return pickText(root, sels)
	}

	titleSels := []string{}
	if ts, ok := rule["titleSelector"]; ok && ts != "" {
		titleSels = append(titleSels, splitAlternatives(ts)...)
	}
	titleSels = append(titleSels, bookFieldFallbacks["title"]...)
	title := cleanBookTitle(truncateStr(pickTitle(root, titleSels), maxTitleChars))
	author := stripAuthorLabel(truncateStr(field("authorSelector", bookFieldFallbacks["author"]), maxTitleChars))
	description := cleanDescription(truncateStr(field("descriptionSelector", bookFieldFallbacks["description"]), maxDescriptionChars))
	status := stripFieldLabel(truncateStr(field("statusSelector", bookFieldFallbacks["status"]), 50))
	category := stripFieldLabel(truncateStr(field("categorySelector", bookFieldFallbacks["category"]), 50))

	coverSels := []string{}
	if cs, ok := rule["coverSelector"]; ok && cs != "" {
		coverSels = append(coverSels, splitAlternatives(cs)...)
	}
	coverSels = append(coverSels, bookFieldFallbacks["cover"]...)
	// Task 28-a: 占位封面过滤——部分站点给所有无封面的书统一返回 nocover.svg 类占位图
	// （实测 huangjinwu.org /public/nocover.svg）。照单全收会把占位图当真封面入库；
	// 逐候选跳过占位 URL，全部占位时返回空串，由主站落「确定性渐变封面」兜底。
	cover := ""
	for _, sel := range coverSels {
		if u := pickHref(root, []string{sel}, baseURL); u != "" && !rePlaceholderCover.MatchString(u) {
			cover = u
			break
		}
	}

	chapters := extractChapterRefs(doc, rule, baseURL, warnings)

	// JSON 目录接口（bookRule.chapterListApi）：书页无完整 HTML 目录、完整目录由同源 AJAX
	// 端点提供的现代 CMS（实测 ixdzs8.com POST /novel/clist/）。
	// 仅当解析出的条目多于书页 HTML 内嵌章节时才采用（避免接口异常时反而丢失已有目录）。
	if api, ok := rule["chapterListApi"]; ok && api != "" {
		cfg, cfgErr := parseChapterListApi(api)
		if cfgErr != "" {
			*warnings = append(*warnings, "chapterListApi 配置无效："+cfgErr)
		} else {
			apiRefs := extractJsonToc(root, cfg, baseURL, warnings)
			if len(apiRefs) > len(chapters) {
				*warnings = append(*warnings, "chapterListApi：JSON 目录 "+strconv.Itoa(len(apiRefs))+" 条优于书页内嵌 "+strconv.Itoa(len(chapters))+" 条，已采用")
				chapters = apiRefs
			}
		}
	}

	// 目录页链接（可选）：书页仅含最新几章时指向完整目录页，供 worker 二次抓取
	var catalogURL *string
	if cls, ok := rule["catalogLinkSelector"]; ok && cls != "" {
		if u := pickHref(root, splitAlternatives(cls), baseURL); u != "" {
			catalogURL = &u
		}
	}

	if title == "" {
		*warnings = append(*warnings, "书籍标题未提取到（规则与内置回退均未命中）")
	}

	return BookData{
		Type: "book", Title: title, Author: author, Description: description,
		Cover: strPtr(cover), Status: status, Category: category,
		ChapterCount: len(chapters), Chapters: chapters, CatalogUrl: catalogURL,
	}
}

// ==================== Chapter 提取 ====================

var defaultContentSelectors = []string{
	"#contenttxt", "#content", "#booktxt", "#htmlContent", "#chaptercontent",
	"#txtContent", "#txtcontent", "#nr1", "#nr", "#conts", "#contents",
	".showtxt", ".read-content", ".readcontent", "#BookText", "#book_text",
	".txtnav", "article", ".article-content", ".content", "#txt", "#text",
}

var defaultChapterTitleSelectors = []string{"h1", ".bookname h1", "#nr_title", ".read-title", ".title", "h2"}

var heuristicNextSelectors = []string{
	"a[rel=\"next\"]", "a:contains(下一页)", "a:contains(下一章)", "a:contains(下一頁)", "a:contains(下页)",
}

// 上一页/上一章链接文本：部分站点把上一章锚点误标 rel="next"（实测 huangjinwu.org），
// 启发式若不校验文本会把 prev 当 next 返回，导致分页/下一章判定倒退
var rePrevLinkText = regexp.MustCompile(`(?i)上一[页章頁]|前一[页章頁]|^prev$`)

// 内联脚本翻页变量兜底：部分站点把翻页地址藏进脚本变量、可见锚点是 javascript:;。
// 从 <script> 文本中按「next_page/next_url 类变量名 = '字面量'」提取第一个可解析为绝对 URL 的值。
var reNextPageVar = regexp.MustCompile(`(?i)(?:var|const|let)\s+(?:next_?page|next_?url|nextChapterUrl|nextChapter)\s*=\s*["']([^"']+)["']|["']?(?:next_?page|next_?url)["']?\s*:\s*["']([^"']+)["']`)

func nextUrlFromScripts(doc *goquery.Document, baseURL string) string {
	var texts []string
	doc.Find("script").Each(func(_ int, el *goquery.Selection) {
		t := el.Text()
		if t != "" && runeLen(t) < 20_000 {
			texts = append(texts, t)
		}
	})
	for _, text := range texts {
		for _, m := range reNextPageVar.FindAllStringSubmatch(text, -1) {
			v := m[1]
			if v == "" {
				v = m[2]
			}
			if abs := toAbs(v, baseURL); abs != "" {
				return abs
			}
		}
	}
	return ""
}

// 剥 CMS 分页样式后缀（如「第1章 合欢宗(第1/2页)」「（3/5）」）
var reDePage = regexp.MustCompile(`\s*[（(]\s*第?\s*\d+\s*/\s*\d+\s*[页頁]?\s*[)）]\s*$`)

func extractChapter(doc *goquery.Document, rule map[string]string, baseURL string, warnings *[]string) ChapterData {
	root := doc.Selection
	removeExcluded(root, rule["excludeSelector"], warnings)

	// ---- 标题 ----
	titleSels := []string{}
	if ts, ok := rule["titleSelector"]; ok && ts != "" {
		titleSels = append(titleSels, splitAlternatives(ts)...)
	}
	titleSels = append(titleSels, defaultChapterTitleSelectors...)
	title := truncateStr(pickTitle(root, titleSels), maxTitleChars)
	if title != "" {
		// 剥分页样式后缀：分页信息属元数据，翻页由 nextSelector/worker 负责
		dePaged := trimJSSpace(reDePage.ReplaceAllString(title, ""))
		if dePaged != "" && runeLen(dePaged) >= 2 {
			title = dePaged
		}
	}
	if title == "" {
		t := truncateStr(collapse(doc.Find("title").First().Text()), maxTitleChars)
		// <title> 兜底同样要过站标样板过滤
		if t != "" && !reBoilerplateTitle.MatchString(t) {
			title = t
			*warnings = append(*warnings, "章节标题未命中规则选择器，回退 <title> 标签（可能含站名后缀，建议显式配置 titleSelector）")
		}
	}

	// ---- 正文 ----
	contentSels := defaultContentSelectors
	if cs, ok := rule["contentSelector"]; ok && cs != "" {
		contentSels = splitAlternatives(cs)
	} else {
		*warnings = append(*warnings, "未提供 contentSelector，使用内置候选选择器匹配正文（结果仅供参考）")
	}

	var best cleanedContent
	bestLen := -1
	for _, raw := range contentSels {
		selector, _ := parseSel(raw)
		if selector == "" {
			continue
		}
		m := compileSel(selector)
		if m == nil {
			continue
		}
		el := root.FindMatcher(m).First()
		if el.Length() == 0 {
			continue
		}
		cleaned := cleanContainer(el)
		if len(cleaned.text) > bestLen {
			bestLen = len(cleaned.text)
			best = cleaned
		}
		// 规则选择器按备选顺序取第一个"足够长"的命中（>=80 字），避免被小预览框截胡
		if _, hasRule := rule["contentSelector"]; hasRule && runeLen(cleaned.text) >= 80 { // Task 34 (P3-20): rune 计（字节计对 CJK 宽 3 倍，首个备选易截胡）
			break
		}
	}

	if bestLen <= 0 {
		*warnings = append(*warnings, "正文提取为空：所有选择器（含内置候选）均未命中或内容为空")
		best = cleanedContent{paragraphs: []string{}, text: ""}
	}

	// ---- 行级噪声统一清洗（cleanx.go 与主应用 src/lib/content-clean.ts 同源）----
	if best.text != "" {
		stats := cleanChapterText(best.text)
		if stats.Removed > 0 && stats.Total >= 10 && float64(stats.Removed)/float64(stats.Total) > 0.5 {
			*warnings = append(*warnings, "清洗移除了 "+strconv.Itoa(stats.Removed)+"/"+strconv.Itoa(stats.Total)+" 行，请检查 contentSelector 是否命中了导航/广告容器")
		}
		if stats.Text != "" {
			best = cleanedContent{paragraphs: splitLines(stats.Text), text: stats.Text}
		} else {
			best = cleanedContent{paragraphs: []string{}, text: ""}
		}
	}

	// Task 28-a: 首段=章题去重——部分 CMS（实测 ggd66.com / 101kks.com）把章节标题
	// 作为正文第一段重复输出（#rtext 内首行 <p>第N章 标题</p>）。与标题去空白后全等、
	// 且段落多于 1 段（防止单段章节被清空）时丢弃首段。
	if title != "" && len(best.paragraphs) > 1 {
		compactTitle := reJSWhitespace.ReplaceAllString(title, "")
		first := reJSWhitespace.ReplaceAllString(best.paragraphs[0], "")
		if first != "" && first == compactTitle {
			best.paragraphs = best.paragraphs[1:]
			best.text = joinLines(best.paragraphs)
		}
	}

	// ---- 下一页 ----
	nextURL := ""
	if ns, ok := rule["nextSelector"]; ok && ns != "" {
		nextURL = pickHref(root, splitAlternatives(ns), baseURL)
		if nextURL == "" {
			*warnings = append(*warnings, "nextSelector 无命中: \""+ns+"\"")
		}
	}
	if nextURL == "" {
		// 启发式逐个候选尝试：跳过文本呈「上一页/上一章」的锚点（站点误标 rel="next" 场景）
		for _, raw := range heuristicNextSelectors {
			selector, _ := parseSel(raw)
			if selector == "" {
				continue
			}
			m := compileSel(selector)
			if m == nil {
				continue
			}
			el := root.FindMatcher(m).First()
			if el.Length() == 0 {
				continue
			}
			if rePrevLinkText.MatchString(collapse(el.Text())) {
				continue
			}
			if abs := toAbs(el.AttrOr("href", ""), baseURL); abs != "" {
				nextURL = abs
				break
			}
		}
		if nextURL != "" && nextURL == toAbs(baseURL, baseURL) {
			nextURL = "" // 启发式命中自链接视为无下一页
		}
		if nextURL != "" {
			*warnings = append(*warnings, "nextUrl 由启发式匹配（\"下一页/下一章\"链接）获得")
		}
	}
	if nextURL == "" {
		// 锚点启发式全部落空：尝试内联脚本翻页变量（锚点为 javascript:; 的站点）
		nextURL = nextUrlFromScripts(doc, baseURL)
		if nextURL != "" && nextURL == toAbs(baseURL, baseURL) {
			nextURL = ""
		}
		if nextURL != "" {
			*warnings = append(*warnings, "nextUrl 由内联脚本翻页变量兜底获得（可见锚点为 JS 跳转）")
		}
	}

	// wordCount：去空白后字符数（对齐 TS text.replace(/\s/g,'').length）
	compact := reJSWhitespace.ReplaceAllString(best.text, "")
	// TS 的 \s 不含全角空格？实际 JS \s 含 \u3000；reJSWhitespace 已覆盖
	wordCount := runeLen(compact)
	var nextPtr *string
	if nextURL != "" {
		nextPtr = &nextURL
	}
	if best.paragraphs == nil {
		best.paragraphs = []string{}
	}
	return ChapterData{
		Type: "chapter", Title: title, Content: best.text,
		Paragraphs: best.paragraphs, WordCount: wordCount, NextUrl: nextPtr,
	}
}
