/**
 * t2s.go —— 繁体→简体中文转换（Task 32-b）。
 *
 * 用途：繁体采集源（101kks 等繁体站）入库前统一转简体，落库即简体，
 *       避免前台搜索/分类归一/智能填充在繁简混排下失配。
 *
 * 策略：
 *   1. 词条最长匹配优先（t2sPhrases，最长 8 字窗口，处理 皇后/面條/乾淨 等语境一对多）
 *   2. 未命中词条 → 单字表兜底（t2sChars）
 *   3. 其余字符原样保留（标点/英文/数字不受影响；「」『』等繁体引号映射为 “”‘’）
 *
 * 映射表见 t2stable.go（zhconv 1.4.3 MIT 生成，勿手工编辑）。
 */
package main

import (
	"strings"
	"sync"
)

var (
	t2sOnce   sync.Once
	t2sMaxLen int
)

func t2sInit() {
	t2sOnce.Do(func() {
		t2sMaxLen = 0
		for k := range t2sPhrases {
			if l := len([]rune(k)); l > t2sMaxLen {
				t2sMaxLen = l
			}
		}
	})
}

// isTradRune 启发式判定单 rune 是否繁体特征字符（在简体集之外的 CJK）。
// 判定口径：rune 在 t2sChars 表中即为繁体特征字符。
func isTradRune(r rune) bool {
	_, ok := t2sChars[r]
	return ok
}

// tradRatio 估算文本繁体特征字符占比（0~1）。
// 规则：遍历前 limitRunes 个 CJK 字符，繁体特征字 / CJK 总数。
// 文本过短（CJK < 8）不参与判定，返回 0。
func tradRatio(s string, limitRunes int) float64 {
	if strings.TrimSpace(s) == "" {
		return 0
	}
	runes := []rune(s)
	if limitRunes > 0 && len(runes) > limitRunes {
		runes = runes[:limitRunes]
	}
	cjk, trad := 0, 0
	for _, r := range runes {
		if r >= 0x3400 && r <= 0x9FFF { // CJK 扩展A + 基本区
			cjk++
			if isTradRune(r) {
				trad++
			}
		}
	}
	if cjk < 8 {
		return 0
	}
	return float64(trad) / float64(cjk)
}

// needsT2S 判断文本是否需要繁转简：繁体特征字符占比 ≥ 阈值。
// threshold=0 时用默认 0.06（正文里 6% 以上是繁体特征字即视为繁体文本；
// 简体文本的偶发繁体字（异体字残留）通常 <1%）。
func needsT2S(s string, threshold float64) bool {
	if threshold <= 0 {
		threshold = 0.06
	}
	return tradRatio(s, 2000) >= threshold
}

// t2s 繁→简转换主入口：词条最长匹配优先 → 单字兜底。
// 非繁体文本（needsT2S=false）直接原样返回，零开销透传。
func t2s(s string) string {
	if s == "" || !needsT2S(s, 0) {
		return s
	}
	return t2sForce(s)
}

// t2sForce 无条件繁转简（不走占比判定，供已确认繁体的批量场景）。
func t2sForce(s string) string {
	if s == "" {
		return s
	}
	t2sInit()
	runes := []rune(s)
	var b strings.Builder
	b.Grow(len(s) + len(s)/4)
	i, n := 0, len(runes)
	for i < n {
		// 词条最长匹配（窗口从大到小）
		matched := false
		maxWin := t2sMaxLen
		if maxWin > n-i {
			maxWin = n - i
		}
		for win := maxWin; win >= 2; win-- {
			if v, ok := t2sPhrases[string(runes[i:i+win])]; ok {
				b.WriteString(v)
				i += win
				matched = true
				break
			}
		}
		if matched {
			continue
		}
		if v, ok := t2sChars[runes[i]]; ok {
			b.WriteRune(v)
		} else {
			b.WriteRune(runes[i])
		}
		i++
	}
	return b.String()
}
