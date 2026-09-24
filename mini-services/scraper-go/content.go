/**
 * 正文容器级清洗（逐行移植自 extract/content.ts）：去 script/style/广告链接/站点水印行、
 * 段落规范化、去重连续重复行。
 *
 * 与 cleanx.go 的分工：本文件是「容器级」清洗（DOM 结构层），cleanx.go 是「行级」噪声统一清洗
 * （与主应用 src/lib/content-clean.ts 同源实现，改行级规则必须三边同步）。
 */
package main

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/PuerkitoBio/goquery"
)

const noiseSelector = "script,style,noscript,iframe,svg,template,ins,object,embed,form,button,input,select,textarea,link,meta,video,audio"

// class/id 白名单级广告/导航标记（整词匹配，避免误伤 egg/class 这类普通词）
var reADToken = regexp.MustCompile(
	`(?i)^(ad|ads|adv|adsid|adsbygoogle|advert|advertisement|banner|gg|gg2|ggx|ggxx|ggtop|baidu-?ad|google-?ads?|推广|广告|promotion|promo|popup|mask|modal|download-?app|app-?guide|copyright|recommend|related|comment|comments|rating|score|share|sidebar|side-?nav|crumb|breadcrumb|footer-?nav|header-?nav|toc|catalog|bookshelf|notice|tip|tips|announce|logo|site-?logo|site-?name|brand|top-?links|top-?float|search|search-?box|searchbar)$`)

// 纯导航/运营链接文本
// Task 28-a: 补终章按钮文案「没有了/没有更多」——部分站点（实测 huangjinwu.org）把无下一章的
// 禁用按钮文字放在正文容器内（<a id="nextChapter" disabled>没有了</a>），照旧会混入正文尾行；
// 仅限链接文本全等匹配（对话叙事「没有了。」带标点/引号不会命中，误杀面为零）。
var reADLinkText = regexp.MustCompile(
	`(?i)^(加入书架|加入收藏|收藏本书|收藏|书架|推荐本书|求收藏|求月票|求推荐票?|求订阅|上一页|上一章|返回目录|返回书页|返回列表|目录|章节目录|书签|举报|分享|点击举报|继续阅读|阅读全部章节|查看全部章节|下载本书|下载txt|手机阅读|手机版|app阅读|展开全部|收起|点击下一页|广告|关闭广告|登录|注册|充值|打赏|没有了|没有更多)$`)

// 站点水印/SEO 垃圾行（整行匹配才剔除，且限短行）
var reWatermarkLine = regexp.MustCompile(
	`(?i)本书来自|首发(?:网址|域名|时间)|天才一?秒?记(?:住|得)|请记住本书|记住本站|最新章节|章节错误|点此举报|求收藏|求推荐票?|求月票|无弹窗|手机(?:版|用户)?(?:阅读|访问|看)|app下载|下载app|笔趣阁|顶点小说|吾爱文学|站内搜索|快速找到你想要的|TXT(?:电子书|下载|全集|全本|免费下载)|全本TXT|电子书免费下载|(?:www|wap|m|mip)\.[a-z0-9-]{2,}\.(?:com|net|cc|org|la|info|xyz|top|vip|site|icu|club)|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}`)

var reHasLorN = regexp.MustCompile(`[\p{L}\p{N}]`)

// Task 31-c: 残留实体再解码。全库审计（Task 31-c，3193 实质正文章节）发现两类站点
// 输出「双重/三重转义」正文：goquery Text() 只解码一层后仍残留字面实体——
//
//	① ggd66.com（实测 novel 24，live 采集 6/112 章脏）对话引号为 &amp;quot;（三重转义，
//	   Text() 后残两层）；② ddyueshu/77shuku 系（novel 1/20，导入存量）作者注为
//	   &amp;amp; / &amp;lt;…&amp;gt;（双重转义，残一层）；③ ixdzs8 系简介分隔符 &amp;amp;&amp;amp;。
//
// 残留实体不是叙事内容而是技术水印，解码属归一化不删正文（「宁可多留」原则不受影响）；
// 只解码白名单命名实体 + 数字/十六进制字符实体，最多 3 轮（覆盖三重转义），无实体即停。
// 位置必须在 Text() 之后、reWatermarkLine 行级闸之前——实体串会虚增行长（如 &amp;quot;
// 8 字符）使超 100 字闸漏判水印行，先解码再判闸。
var reResidualEntity = regexp.MustCompile(`&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);`)

// decodeEntityOne 解码单个实体；&nbsp; 归一为半角空格（与 reJSWhitespace 折叠口径一致）
func decodeEntityOne(raw string) string {
	switch raw {
	case "&amp;":
		return "&"
	case "&lt;":
		return "<"
	case "&gt;":
		return ">"
	case "&quot;":
		return "\""
	case "&apos;", "&#39;", "&#x27;":
		return "'"
	case "&nbsp;":
		return " "
	}
	if strings.HasPrefix(raw, "&#x") || strings.HasPrefix(raw, "&#X") {
		if n, err := strconv.ParseInt(raw[3:len(raw)-1], 16, 32); err == nil {
			return string(rune(n))
		}
		return raw
	}
	if strings.HasPrefix(raw, "&#") {
		if n, err := strconv.Atoi(raw[2 : len(raw)-1]); err == nil {
			return string(rune(n))
		}
	}
	return raw
}

// decodeResidualEntities 对文本做最多 3 轮白名单实体解码，直到无残留实体（幂等上限防环）。
func decodeResidualEntities(s string) string {
	for i := 0; i < 3 && reResidualEntity.MatchString(s); i++ {
		s = reResidualEntity.ReplaceAllStringFunc(s, decodeEntityOne)
	}
	return s
}

// cleanedContent 清洗后的正文（段落 + 拼接文本）
type cleanedContent struct {
	paragraphs []string
	text       string
}

// cleanContainer 清洗单个正文容器并收割段落
func cleanContainer(el *goquery.Selection) cleanedContent {
	clone := el.Clone()
	clone.Find(noiseSelector).Remove()
	// 隐藏元素（display:none / hidden 属性）多为广告占位
	clone.Find(`[hidden],[style*="display:none"],[style*="display: none"],[style*="display:inherit"][class*="ad"]`).Remove()

	// 1) class/id 命中广告 token 的元素块
	clone.Find("[class],[id]").Each(func(_ int, n *goquery.Selection) {
		tokens := splitJSSpace(n.AttrOr("class", "") + " " + n.AttrOr("id", ""))
		for _, t := range tokens {
			if t != "" && reADToken.MatchString(t) {
				n.Remove()
				return
			}
		}
	})

	// 2) 广告/导航/空锚点链接
	clone.Find("a").Each(func(_ int, a *goquery.Selection) {
		txt := collapse(a.Text())
		href := a.AttrOr("href", "")
		if reADLinkText.MatchString(txt) || strings.HasPrefix(strings.ToLower(href), "javascript:") || href == "#" {
			a.Remove()
		}
	})

	// 3) 短小的水印文本节点
	clone.Find("div,p,span,font,center,strong,em,b").Each(func(_ int, n *goquery.Selection) {
		if n.Children().Length() == 0 {
			t := collapse(n.Text())
			if t != "" && runeLen(t) <= 80 && reWatermarkLine.MatchString(t) {
				n.Remove()
			}
		}
	})

	// 4) 段落收割：<br> 与块级元素边界 → \n
	// Task 30-b 修复：边界表缺 td/th/tr/center——表格布局正文容器（老式杰奇/书站 CMS
	// 常见 <table><tr><td>段落…）里相邻单元格文本经 Text() 直接粘连成一行（实测探针：
	// 三段并一段），且粘连行超 100 字后同时绕过 reWatermarkLine 节点级(≤80)与行级(≤100)
	// 短行闸——水印行与正文粘连后无法被行级清洗剔除，直接污染入库正文。center 为旧站
	// 常用块级容器（HTML4 deprecated 但仍是块级语义），一并补齐。
	// Task 31-d 补齐（同类粘连实测探针复现）：
	//   ①边界表补 h5/h6/table/thead/tbody/tfoot/caption/ul/ol/dl/dt/blockquote/pre/
	//     figure/figcaption/hr/address 全套块级语义——h5/h6 与正文粘连、dl 的 dt 与首个
	//     dd 粘连均实测复现（header/footer/nav/aside 多为整块导航/运营容器，已在上方
	//     广告 token 步骤整块移除，不重复加入）；
	//   ②旧实现边界只加在块级元素之后（AfterHtml）——块前裸文本节点依旧成段粘连：
	//     `<div>引言<p>正文` → 「引言正文」；table 直下裸文本经 foster parenting 前移后
	//     与首格粘连（`表尾裸文本A段`）。同一选择器对称补 BeforeHtml（块前也断行）。
	//     双 \n 产生的空行由下方收割循环跳过，零副作用。
	clone.Find("br").ReplaceWithHtml("\n")
	blockBoundarySel := "p,div,dd,li,section,article,h1,h2,h3,h4,h5,h6,td,th,tr,center," +
		"table,thead,tbody,tfoot,caption,ul,ol,dl,dt,blockquote,pre,figure,figcaption,hr,address"
	clone.Find(blockBoundarySel).BeforeHtml("\n")
	clone.Find(blockBoundarySel).AfterHtml("\n")
	// Task 31-c: 残留实体再解码（见 decodeResidualEntities 注）——必须在行长敏感的
	// 水印行闸（runeLen<=100 && reWatermarkLine）之前执行，防实体串虚增行长漏判。
	raw := decodeResidualEntities(clone.Text())

	paragraphs := []string{}
	for _, line0 := range splitLines(raw) {
		line := trimJSSpace(reJSWhitespace.ReplaceAllString(strings.ReplaceAll(line0, "\u3000", " "), " "))
		if line == "" {
			continue
		}
		if !reHasLorN.MatchString(line) {
			continue // 纯符号/装饰线
		}
		if runeLen(line) <= 100 && reWatermarkLine.MatchString(line) {
			continue
		}
		if len(paragraphs) > 0 && paragraphs[len(paragraphs)-1] == line {
			continue // 连续重复
		}
		paragraphs = append(paragraphs, line)
	}
	return cleanedContent{paragraphs: paragraphs, text: joinLines(paragraphs)}
}
