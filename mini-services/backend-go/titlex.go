/**
 * titlex.go —— 采集数据标题族噪声清洗 + 分卷识别（用户指令 Task 42-1「章节目录中的
 * 章节名、正文处的章节名、书籍名等所有获取到的数据都要做噪声清洗/过滤」+ 42-6 分卷）。
 *
 * 全库实证病灶：
 *  - 章节名「第1章 贵妃(2/4)」分页尾标（同章分页 h1 残留）
 *  - 章节名「第1章 [1]奴婢知错了:雍和宫式许愿」序号方括号残留
 *  - 章节名「第一卷 第1章 宝宝满月」卷前缀压在章节名内（分卷信息混入标题，书 360 行含卷）
 *  - 章节名/书名 SEO 尾巴（笔趣阁/最新章节/全文阅读/TXT下载 等）
 *  - 书名《》包裹、收尾分隔符残留
 *
 * 双侧分工：scraper-go 引擎侧同规则基础清洗（Task 42 同步，不含书名前缀剥离与分卷
 * 识别——分卷列由编排侧落库）；本文件为编排侧入库前第二道 + 存量回填（幂等契约）。
 *
 * 幂等：clean(clean(x)) == clean(x)；volume 识别只对「第X卷」前缀生效，剥前缀后
 * 二次识别不再命中。
 */
package main

import (
	"regexp"
	"strconv"
	"strings"
)

var (
	// titleLeadingRE 章节名前缀样板：正文/正文卷/VIP章节/最新章节/章节目录
	titleLeadingRE = newTitlePattern(`^(?:正文(?:卷)?|VIP章节|VIP正文|最新章节|章节目录|作品正文)[:：\s]*`)
	// titlePageMarkRE 分页尾标：「(2/4)」「（2/4）」（reDePage 引擎侧同源）
	titlePageMarkRE = newTitlePattern(`[\(（]\s*\d{1,4}\s*[／/]\s*\d{1,4}\s*[\)）]\s*$`)
	// titleBracketIdxRE 章节序号后的序号方括号：「第1章 [1]xxx」→「第1章 xxx」
	// （仅限紧跟 第X章/回/节 前缀之后，防误伤正文含 [2019] 等合法年份标记的标题）
	titleBracketIdxRE = newTitlePattern(`^(第[0-9〇零一二三四五六七八九十百千两]+[章回节][\s：:]*)[\[【〔]\d{1,4}[\]】〕]\s*`)
	// titlePromoTailRE 标题尾 SEO 样板（可重复、可带分隔符；书籍名/章节名共用）
	titlePromoTailRE = newTitlePattern(`(?i)(?:\s*[-_|·～~]?\s*(?:笔趣阁|顶点小说|飞卢小说网?|无弹窗|全文阅读|全本阅读|在线阅读|最新章节(?:列表)?|txt下载|全本txt|无错小说|手机阅读|免费阅读|章节目录))+$`)
	// titleVolumeRE 分卷前缀：「第一卷 第1章 宝宝满月」「第六卷·嬗变者」「第3卷：风起」
	titleVolumeRE = newTitlePattern(`^(第[0-9〇零一二三四五六七八九十百千两]+卷)(?:[·．.\s_\-—：:]|(?:[·．.\s_\-—：:]+))(.*)$`)
	// titleAuthorTailRE 引擎侧同源作者尾巴（防御性二次剥）
	titleAuthorTailRE = newTitlePattern(`(?i)作者[:：][^《》]{1,30}$`)
	// titleBookWrapRE 书名《》整包裹
	titleBookWrapRE = newTitlePattern(`^《(.+?)》$`)
	// titleSepCut 标题首尾分隔符集合（trailing 剥离用）
	titleSepCut = "-_|·：:～~ \t\u00a0\u3000"
	// titleCJKSpaceRE 连续空白折叠
	titleCJKSpaceRE = newTitlePattern(`[\s\u00a0\u3000]+`)
)

// titlePattern 标题族正则类型别名（= regexp.Regexp，方法集一致）。
type titlePattern = regexp.Regexp

// titleUnicodeEscRE 识别 \uXXXX 转义：Go regexp（RE2）不支持 \u，需先展开为实际字符。
var titleUnicodeEscRE = regexp.MustCompile(`\\u([0-9a-fA-F]{4})`)

// newTitlePattern 编译标题族正则：先展开 \uXXXX 转义（如 \u00a0/\u3000）再交 MustCompile。
func newTitlePattern(expr string) *titlePattern {
	expanded := titleUnicodeEscRE.ReplaceAllStringFunc(expr, func(m string) string {
		code, err := strconv.ParseUint(m[2:], 16, 32)
		if err != nil {
			return m // 非法转义原样保留，交 MustCompile 报错
		}
		return string(rune(code))
	})
	return (*titlePattern)(regexp.MustCompile(expanded))
}

// detectVolume 从章节名识别并剥分卷前缀，返回（卷名, 剥前缀后的标题）。
// 纯卷标题行（剥前缀后为空）返回原标题（卷名仍识别，供 TOC 分组；标题不动防空题）。
// 幂等：剥前缀后的标题不再命中「第X卷」开头（前缀已移除）。
func detectVolume(title string) (vol, rest string) {
	m := titleVolumeRE.FindStringSubmatch(title)
	if m == nil {
		return "", title
	}
	vol = m[1]
	rest = strings.TrimSpace(m[2])
	if rest == "" {
		return vol, title // 纯卷标题行：卷名识别，标题原样保留
	}
	return vol, rest
}

// cleanChapterTitle 章节名清洗（TOC 与正文页共用同一 Chapter.title，一处清洗两处受益）。
// bookTitle 非空时额外剥「《书名》/书名」前缀（正文页 h1 常见「书名 第X章 …」形态；
// 引擎侧无书名上下文，此步仅编排侧执行）。幂等。
func cleanChapterTitle(title, bookTitle string) string {
	s := titleCJKSpaceRE.ReplaceAllString(strings.TrimSpace(title), " ")
	if s == "" {
		return ""
	}
	s = titleLeadingRE.ReplaceAllString(s, "")
	s = titleBracketIdxRE.ReplaceAllString(s, "${1}")
	if bookTitle != "" {
		s = stripBookTitlePrefix(s, bookTitle)
	}
	for i := 0; i < 4; i++ { // 可重复尾标：剥到稳定（有界防意外死循环）
		next := titlePromoTailRE.ReplaceAllString(s, "")
		next = titlePageMarkRE.ReplaceAllString(next, "")
		next = titleAuthorTailRE.ReplaceAllString(next, "")
		next = strings.TrimRight(strings.TrimSpace(next), titleSepCut)
		if next == s {
			break
		}
		s = next
	}
	s = strings.TrimSpace(s)
	if w := titleBookWrapRE.FindStringSubmatch(s); w != nil && runeLen(w[1]) >= 2 {
		// 章节名整被《》包裹（源站标题选择器命中书名）→ 剥包裹
		s = w[1]
	}
	if s == "" || runeLen(s) < 2 && runeLen(title) >= 2 {
		// 剥后过短（<2 rune）但原标题有内容 → 保留原标题防误杀（如章节名就叫「1」）
		return titleCJKSpaceRE.ReplaceAllString(strings.TrimSpace(title), " ")
	}
	return s
}

// cleanNovelTitle 书名清洗（保守：不动「（出书版）」等有意义的版本限定词；
// 只剥 SEO 尾巴/包裹书名号/收尾分隔符）。幂等。
func cleanNovelTitle(title string) string {
	s := titleCJKSpaceRE.ReplaceAllString(strings.TrimSpace(title), " ")
	if s == "" {
		return ""
	}
	if w := titleBookWrapRE.FindStringSubmatch(s); w != nil && runeLen(w[1]) >= 2 {
		s = w[1]
	}
	for i := 0; i < 4; i++ {
		next := titlePromoTailRE.ReplaceAllString(s, "")
		next = strings.TrimRight(strings.TrimSpace(next), titleSepCut)
		if next == s {
			break
		}
		s = next
	}
	s = strings.TrimSpace(s)
	if s == "" {
		return strings.TrimSpace(title) // 全剥空 → 保留原值（书名宁脏勿空）
	}
	return s
}

// stripBookTitlePrefix 剥「《书名》/书名」前缀（章节名携带书名样板时），剥后须剩 ≥2 rune。
func stripBookTitlePrefix(title, bookTitle string) string {
	bt := strings.TrimSpace(bookTitle)
	if bt == "" {
		return title
	}
	rest := title
	for _, pat := range []string{"《" + bt + "》", bt} {
		if strings.HasPrefix(rest, pat) {
			cand := strings.TrimLeft(strings.TrimSpace(rest[len(pat):]), titleSepCut)
			if runeLen(cand) >= 2 {
				return cand
			}
		}
	}
	return rest
}
