/**
 * backend-go —— 正文噪声清洗器。
 *
 * TS 源：src/lib/content-clean.ts（逐行移植；scraper-go 引擎侧有同源实现，本文件为
 * 编排侧入库前第二道清洗，与 TS worker→storeChapter 的调用时序一致）
 *
 * 存储契约：清洗后的 content 为「无空行、无行首缩进」的纯文本行，以单个 \n 连接。
 *
 * 移植差异（Go regexp RE2 vs JS）：
 * - JS \s 全集（含 \u00a0/\u3000/\ufeff 等）与 Go \s（仅 [\t\n\f\r ]）不同 → 统一用
 *   jsWhitespaceClass 显式字符类对齐
 * - URL_LINE 的 (?![a-z]) 负向先行断言 RE2 不支持 → 改写为等价的 (?:[^a-z]|$)
 *   （(?i) 使 [^a-z] 同时排除大写，与 JS /i 下 lookahead 行为一致）
 * - \uXXXX 转义 Go regexp 需写 \x{XXXX}
 * - 行长判定 JS .length 为 UTF-16 码元数；Go 用 rune 数（仅 astral 平面字符有差，
 *   中文正文 BMP 内一致）
 */
package main

import (
	"regexp"
	"strings"
)

// jsWhitespaceClass JS \s 的精确等价字符类（\f\n\r\t\v\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff）
const jsWhitespaceClass = `[\t\n\v\f\r \x{0085}\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`

// CleanResult 清洗结果
type CleanResult struct {
	// Text 清洗后的正文（无空行、无行首缩进，行间单个 \n）
	Text string
	// RemovedLines 被判定为噪声而丢弃的行数（不含空行）
	RemovedLines int
}

const (
	// SHORT_LINE_MAX 噪声行规则的行长度上限（字符数）
	SHORT_LINE_MAX = 30
	// TAIL_LINE_MAX TAIL_HINT 的行长度上限（断章提示句常超 SHORT_LINE_MAX，单独放宽）
	TAIL_LINE_MAX = 80
)

var (
	cleanLeadingIndentRE = regexp.MustCompile(`^[ \t\x{3000}\x{00a0}\x{feff}\x{200b}\x{200c}\x{200d}]+`)
	cleanHasTextRE       = regexp.MustCompile(`[\p{L}\p{N}]`)
	cleanURLLineRE       = regexp.MustCompile(`(?i)(?:www\.|https?://|\.(?:com|net|cc|org|info|xyz|top|vip)(?:[^a-z]|$)|^[a-z0-9-]+(?:\.[a-z0-9-]+)+$)`)
	cleanSitePromoRE     = regexp.MustCompile(`笔趣阁|顶点小说|飞卢|起点中文|纵横中文|天才一?秒?记住|一秒记住|本章未完|点击下一页|继续阅读请|最新章节|手机阅读|无弹窗|全本小说|请记住本书|首发域名|记得收藏|请收藏本站|收藏网址|求收藏|求推荐票|求月票|投推荐票|加入书签|书迷交流|站内搜索|快速找到你想要的|TXT电子书|电子书下载|全本TXT|TXT全集|TXT下载|最快更新|第一时间更新|本站网址|备用域名|备用网址|看书神器|阅读神器|免费阅读网|小说网址|提供无错|精校版|无错版`)
	cleanNavExactRE      = regexp.MustCompile(`^(?:上一章|上一页|下一章|下一页|上一頁|下一頁|目录|章节目录|章节列表|返回|返回目录|返回书页|返回列表|返回首页|返回书架|回到书架|返回顶部|回顶部|去底部|首页|书页|书签|加入书签|加入收藏|加入书架|放到书架|收藏本站|收藏本书|收藏|推荐票|点击进入|点击收藏|第一页|末页|搜索|搜索全站|正文|封面|书评|打卡|签到|赞|踩|分享)$`)
	cleanPageNumberRE    = regexp.MustCompile(`^[0-9]{1,4}$`)
	cleanTailHintRE      = regexp.MustCompile(`本章未完|未完待续|本章完|请点击下一[页章頁]继续阅读|转载请注明(?:来源|出处)|章节错误.{0,6}点此举报|手机用户请(?:浏览|阅读|访问)|关注公众号|微信公众号|(?:天才|一秒)记住本站最新网址|章节内容(?:错误|缺失)|看不到(?:结尾|结局)`)
	cleanJSResidueRE     = regexp.MustCompile(`(?i)(?:javascript:|function` + jsWhitespaceClass + `*\(|document\.|window\.|\{.*\})`)
	cleanCRRE            = regexp.MustCompile(`\r\n?`)
	cleanWSFoldRE        = regexp.MustCompile(jsWhitespaceClass + `+`)
)

// runeLen rune 数（对齐 JS 短行判定的字符数口径，BMP 内一致）
func runeLen(s string) int { return len([]rune(s)) }

// isNoiseLine 判断一行（已规范化：trim 后）是否为噪声行。
// 空字符串返回 false——空行由调用方直接丢弃，不计入噪声统计。
func isNoiseLine(line string) bool {
	t := strings.TrimSpace(line)
	if t == "" {
		return false
	}
	// 纯符号行（仅标点/符号/装饰线，无任何文字）——不含文字不可能是叙事，不限长度
	if !cleanHasTextRE.MatchString(t) {
		return true
	}
	// 以下规则仅对短行生效，避免误杀含关键词的正常叙事长句
	if runeLen(t) > SHORT_LINE_MAX {
		// 断章提示例外：句式固定且属元信息，放宽到 TAIL_LINE_MAX
		if runeLen(t) > TAIL_LINE_MAX {
			return false
		}
		return cleanTailHintRE.MatchString(t)
	}
	if cleanURLLineRE.MatchString(t) {
		return true
	}
	if cleanSitePromoRE.MatchString(t) {
		return true
	}
	if cleanNavExactRE.MatchString(t) {
		return true
	}
	if cleanPageNumberRE.MatchString(t) {
		return true
	}
	// 断章/水印提示同样适用于短行（「（本章完）」「章节错误(点此举报)」常在 30 字内）
	if cleanTailHintRE.MatchString(t) {
		return true
	}
	if cleanJSResidueRE.MatchString(t) {
		return true
	}
	return false
}

// cleanChapterContent 清洗一章正文：
// - 归一化换行符与空白（\r\n|\r → \n、去行首缩进、行内空白折叠、去空行）
// - 过滤噪声行（URL/推广/导航/JS 残留/纯符号）
// - 输出满足存储契约：无空行、无行首缩进，行间单个 \n
func cleanChapterContent(raw string) CleanResult {
	if raw == "" {
		return CleanResult{}
	}
	normalized := cleanCRRE.ReplaceAllString(raw, "\n")
	kept := []string{}
	removed := 0
	for _, rawLine := range strings.Split(normalized, "\n") {
		// 去行首全角空格/NBSP/半角空白 → 行内连续空白折叠为单空格 → 去首尾空白
		line := strings.TrimSpace(cleanWSFoldRE.ReplaceAllString(cleanLeadingIndentRE.ReplaceAllString(rawLine, ""), " "))
		if line == "" {
			continue // 空行直接丢弃（不计入噪声行）
		}
		if isNoiseLine(line) {
			removed++
			continue
		}
		kept = append(kept, line)
	}
	return CleanResult{Text: strings.Join(kept, "\n"), RemovedLines: removed}
}
