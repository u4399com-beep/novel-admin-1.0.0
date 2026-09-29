/**
 * 正文噪声清洗器（引擎侧实现，提取章节正文时调用）—— Go 移植自 scraper-service/src/clean.ts。
 *
 * ⚠ 历史上本文件与主应用 src/lib/content-clean.ts / TS 引擎 clean.ts 三边同源；Task 27 Next.js
 *   拆除后两处 TS 实现已删除，本文件是唯一权威实现（Task 28-a 注）。
 *   修改噪声规则时同步更新 cleanx_test.go 回归用例。
 *
 * 语义约定（与 TS 版一致）：
 * - total   = 规范化后进入噪声过滤的非空行数（候选行）
 * - removed = 被判定为噪声而丢弃的行数（不含空行）
 * - kept    = total - removed，以单个 \n 连接输出
 *
 * 已知移植差异：URL_LINE 的负向前瞻 (?![a-z]) 在 Go RE2 不支持，改写为
 * (?:[^a-z]|$) 等价布尔判定（本模式仅用于行级布尔测试，多消费一个字符不影响结果）。
 */
package main

import "regexp"

const (
	shortLineMax = 30
	tailLineMax  = 80
	// Task 28-a: 域名样板行的长度上界——覆盖 31-120 字的中长样板尾注。
	// 实测 xinjianpan.com 章末版权条 85 字（含变体选择符 emoji）：《书名》转载请注明来源：
	// 新键盘小说网xinjianpan.com，若浏览器…谢谢！——旧规则 31-80 字段只查 reTailHint（无域名项）、
	// >80 字直接放行，两层都没接住。全库 92627 章实测含域名行仅 20 章且全部是此类样板，
	// 正常叙事几乎不会整句含 .com/.net 等域名，误杀面可忽略。
	boilerLineMax = 120
)

// 行首缩进/空白：全角空格、NBSP、BOM、零宽字符（U+200B-200D）、半角空白（不含换行符）
var reLeadingIndent = regexp.MustCompile(`^[ \t\x{3000}\x{00a0}\x{feff}\x{200b}\x{200c}\x{200d}]+`)

// 是否含文字（字母/数字，含 CJK）——不含任何文字的行视为纯符号行
var reHasText = regexp.MustCompile(`[\p{L}\p{N}]`)

// URL/域名类：含 www. / http、常见 TLD 后缀，或整行像域名
var reURLLine = regexp.MustCompile(`(?i)www\.|https?://|\.(?:com|net|cc|org|info|xyz|top|vip)(?:[^a-z]|$)|^[a-z0-9-]+(?:\.[a-z0-9-]+)+$`)

// 站点推广/SEO 水印类（短行含任一关键词即判噪声）
var reSitePromo = regexp.MustCompile(
	`笔趣阁|顶点小说|飞卢|起点中文|纵横中文|天才一?秒?记住|一秒记住|本章未完|点击下一页|继续阅读请|最新章节|手机阅读|无弹窗|全本小说|请记住本书|首发域名|记得收藏|请收藏本站|收藏网址|求收藏|求推荐票|求月票|投推荐票|加入书签|书迷交流|站内搜索|快速找到你想要的|TXT电子书|电子书下载|全本TXT|TXT全集|TXT下载|最快更新|第一时间更新|本站网址|备用域名|备用网址|看书神器|阅读神器|免费阅读网|小说网址|提供无错|精校版|无错版`)

// 导航/UI 残留：整行基本等于这些词（精确匹配，避免误伤叙事）
var reNavExact = regexp.MustCompile(`^(?:上一章|上一页|下一章|下一页|上一頁|下一頁|目录|章节目录|章节列表|返回|返回目录|返回书页|返回列表|返回首页|返回书架|回到书架|返回顶部|回顶部|去底部|首页|书页|书签|加入书签|加入收藏|加入书架|放到书架|收藏本站|收藏本书|收藏|推荐票|点击进入|点击收藏|第一页|末页|搜索|搜索全站|正文|封面|书评|打卡|签到|赞|踩|分享)$`)

// 页码残留行：纯 1-4 位数字（分页标记），章正文中不可能单独成段
var rePageNumber = regexp.MustCompile(`^[0-9]{1,4}$`)

// 「本章未完」类断章提示：CMS 分页尾部样板
var reTailHint = regexp.MustCompile(
	`本章未完|未完待续|本章完|请点击下一[页章頁]继续阅读|转载请注明(?:来源|出处)|章节错误.{0,6}点此举报|手机用户请(?:浏览|阅读|访问)|关注公众号|微信公众号|(?:天才|一秒)记住本站最新网址|章节内容(?:错误|缺失)|看不到(?:结尾|结局)`)

// JS/CSS 残留：伪协议/函数定义/DOM 访问/花括号成对出现的短行
var reJSResidue = regexp.MustCompile(`(?i)javascript:|function\s*\(|document\.|window\.|\{.*\}`)

// Task 31-c: 行尾 JS 残留 token 剥离。全库审计（Task 31-c）实测两类源站把内联脚本尾巴
// 拼在叙事行末：novel 1「……也没自己什么事了。javascript:」（大概率 href 注入残迹）、
// novel 4「……她就立马关了手机。 hf();」（源站字体/脚本的函数调用残迹）。
// 这类 token 不可能出现在任何叙事句尾（无叙事语义、纯代码形态），只劧行尾（$ 锥定）、
// 只剥 token 本身，不整行删除也不动行首正文——比 isNoiseLine 整行判定更保守，
// 避免长叙事行因粘了残留 token 而被整行丢弃（违反「宁可多留」）。
var reTrailingJSArtifact = regexp.MustCompile(`(?i)(?:javascript:;?|hf\(\);)+$`)

// Task 28-a: 独立 HTML 标签残行——部分站点正文里混有转义过的字面标签文本
// （实测 huangjinwu.org 章末段落含 &lt;/div，解码后成独行 "</div"），容器级清洗后残留为独立行。
// 整行（去除空白后）呈单个标签形态（可缺右尖括号）即判噪声：叙事文本不可能整行只是一个标签。
var reTagResidue = regexp.MustCompile(`(?i)^</?[a-zA-Z][a-zA-Z0-9]*(?:\s[^<>]*)?/?>?$`)

// isNoiseLine 判断一行（已规范化：trim 后）是否为噪声行。
// 空字符串返回 false——空行由调用方直接丢弃，不计入噪声统计。
func isNoiseLine(line string) bool {
	t := trimJSSpace(line)
	if t == "" {
		return false
	}
	// 纯符号行（仅标点/符号/装饰线，无任何文字）——不含文字不可能是叙事，不限长度
	if !reHasText.MatchString(t) {
		return true
	}
	// Task 28-a: 独立 HTML 标签残行（任意长度，整行标签形态不可能是叙事）
	if reTagResidue.MatchString(t) {
		return true
	}
	// 以下规则仅对短行生效，避免误杀含关键词的正常叙事长句
	if runeLen(t) > shortLineMax {
		// Task 28-a: 31-120 字含域名/URL 行——站点样板尾注（xinjianpan 85 字版权条实测，见 boilerLineMax 注）
		if runeLen(t) <= boilerLineMax && reURLLine.MatchString(t) {
			return true
		}
		// 断章提示例外：句式固定且属元信息，放宽到 TAIL_LINE_MAX（不在此列的长句照旧放行）
		if runeLen(t) > tailLineMax {
			return false
		}
		return reTailHint.MatchString(t)
	}
	if reURLLine.MatchString(t) {
		return true
	}
	if reSitePromo.MatchString(t) {
		return true
	}
	if reNavExact.MatchString(t) {
		return true
	}
	if rePageNumber.MatchString(t) {
		return true
	}
	// 断章/水印提示同样适用于短行（「（本章完）」「章节错误(点此举报)」常在 30 字内）
	if reTailHint.MatchString(t) {
		return true
	}
	if reJSResidue.MatchString(t) {
		return true
	}
	return false
}

// cleanStats 与 TS CleanStats 同构
type cleanStats struct {
	Text    string
	Removed int
	Total   int
}

// cleanChapterText 清洗一章正文文本（行级归一化 + 噪声行过滤）。
// 输出契约：无空行、无行首缩进，行间单个 \n。
func cleanChapterText(raw string) cleanStats {
	if raw == "" {
		return cleanStats{}
	}
	normalized := normalizeNewlines(raw)
	kept := []string{}
	removed := 0
	total := 0
	for _, rawLine := range splitLines(normalized) {
		// 去行首全角空格/NBSP/半角空白 → 行内连续空白折叠为单空格 → 去首尾空白
		line := trimJSSpace(reJSWhitespace.ReplaceAllString(reLeadingIndent.ReplaceAllString(rawLine, ""), " "))
		// Task 31-c: 行尾 JS 残留 token 剥离（见 reTrailingJSArtifact 注）——归一化后
		// 行尾已无空白，直接锥定 $；剥完再 trim 一次去可能残留的行尾空格。
		if trimmed := reTrailingJSArtifact.ReplaceAllString(line, ""); trimmed != line {
			line = trimJSSpace(trimmed)
		}
		if line == "" {
			continue // 空行直接丢弃（不计入 total/removed）
		}
		total++
		if isNoiseLine(line) {
			removed++
			continue
		}
		kept = append(kept, line)
	}
	return cleanStats{Text: joinLines(kept), Removed: removed, Total: total}
}
