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
        "strings"

        "github.com/PuerkitoBio/goquery"
)

const noiseSelector = "script,style,noscript,iframe,svg,template,ins,object,embed,form,button,input,select,textarea,link,meta,video,audio"

// class/id 白名单级广告/导航标记（整词匹配，避免误伤 egg/class 这类普通词）
var reADToken = regexp.MustCompile(
        `(?i)^(ad|ads|adv|adsid|adsbygoogle|advert|advertisement|banner|gg|gg2|ggx|ggxx|ggtop|baidu-?ad|google-?ads?|推广|广告|promotion|promo|popup|mask|modal|download-?app|app-?guide|copyright|recommend|related|comment|comments|rating|score|share|sidebar|side-?nav|crumb|breadcrumb|footer-?nav|header-?nav|toc|catalog|bookshelf|notice|tip|tips|announce|logo|site-?logo|site-?name|brand|top-?links|top-?float|search|search-?box|searchbar)$`)

// 纯导航/运营链接文本
var reADLinkText = regexp.MustCompile(
        `(?i)^(加入书架|加入收藏|收藏本书|收藏|书架|推荐本书|求收藏|求月票|求推荐票?|求订阅|上一页|上一章|返回目录|返回书页|返回列表|目录|章节目录|书签|举报|分享|点击举报|继续阅读|阅读全部章节|查看全部章节|下载本书|下载txt|手机阅读|手机版|app阅读|展开全部|收起|点击下一页|广告|关闭广告|登录|注册|充值|打赏)$`)

// 站点水印/SEO 垃圾行（整行匹配才剔除，且限短行）
var reWatermarkLine = regexp.MustCompile(
        `(?i)本书来自|首发(?:网址|域名|时间)|天才一?秒?记(?:住|得)|请记住本书|记住本站|最新章节|章节错误|点此举报|求收藏|求推荐票?|求月票|无弹窗|手机(?:版|用户)?(?:阅读|访问|看)|app下载|下载app|笔趣阁|顶点小说|吾爱文学|站内搜索|快速找到你想要的|TXT(?:电子书|下载|全集|全本|免费下载)|全本TXT|电子书免费下载|(?:www|wap|m|mip)\.[a-z0-9-]{2,}\.(?:com|net|cc|org|la|info|xyz|top|vip|site|icu|club)|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}`)

var reHasLorN = regexp.MustCompile(`[\p{L}\p{N}]`)

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
        clone.Find("br").ReplaceWithHtml("\n")
        clone.Find("p,div,dd,li,section,article,h1,h2,h3,h4").AfterHtml("\n")
        raw := clone.Text()

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
