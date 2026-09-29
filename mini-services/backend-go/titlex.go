/**
 * titlex.go —— 章节名分卷前缀识别（Task 42-6 分卷；Task 45-b 落库全链）。
 *
 * 职责收敛（Task 46-b 精简）：标题族噪声清洗的执行方是 scraper-go 引擎侧（Task 42 同步
 * 的同规则基础清洗，正文页/目录页提取时已完成）；编排侧历史上预留的第二道清洗函数
 * （cleanChapterTitle/cleanNovelTitle/stripBookTitlePrefix）从未接线，随死代码清理移除，
 * 本文件只保留 detectVolume 分卷识别（storex 入库链 + db.go 存量回填共用权威实现）。
 *
 * 幂等：volume 识别只对「第X卷」前缀生效，剥前缀后二次识别不再命中（volume_test.go 锁定）。
 */
package main

import (
	"regexp"
	"strconv"
	"strings"
)

var (
	// titleVolumeRE 分卷前缀：「第一卷 第1章 宝宝满月」「第六卷·嬗变者」「第3卷：风起」
	titleVolumeRE = newTitlePattern(`^(第[0-9〇零一二三四五六七八九十百千两]+卷)(?:[·．.\s_\-—：:]|(?:[·．.\s_\-—：:]+))(.*)$`)
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
