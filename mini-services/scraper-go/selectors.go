/**
 * goquery 选择器工具层（移植自 extract/selectors.ts）：备选拆分 / @attr 解析 / 文本与链接提取。
 *
 * 约定（与 TS 版一致）：
 * - 所有选择器字符串支持逗号分隔的"备选"，从左到右取第一个非空结果（CSS 原生逗号是并集语义，
 *   这里按备选语义逐个尝试，且能容忍单个选择器非法）；
 * - 选择器支持 `sel@attr` 后缀取属性（如 meta[property="og:image"]@content）；
 * - 匹配语义：优先在 scope 内查找（find），scope 自身命中选择器时同样采纳（is）；
 * - 链接一律按 base 补全为绝对地址。
 * - goquery/cascadia 对非法选择器会 panic：所有选择器先经 Compile 校验，非法直接跳过（对齐 TS 的 try/catch 语义）。
 */
package main

import (
	"regexp"
	"strings"

	"github.com/PuerkitoBio/goquery"
	"github.com/andybalholm/cascadia"
)

// scope 类型别名
type scope = goquery.Selection

// compileSel 校验并编译选择器；非法返回 nil（调用方跳过，对齐 TS catch 语义）。
// goquery.Matcher 是接口，cascadia.Selector 实现之。
func compileSel(raw string) goquery.Matcher {
	if raw == "" {
		return nil
	}
	sel, err := cascadia.Compile(raw)
	if err != nil {
		return nil
	}
	return sel
}

// findSafe scope 内查找（非法选择器返回 nil）
func findSafe(s *goquery.Selection, sel string) *goquery.Selection {
	m := compileSel(sel)
	if m == nil {
		return nil
	}
	return s.FindMatcher(m)
}

// isSafe scope 自身是否命中选择器
func isSafe(s *goquery.Selection, sel string) bool {
	m := compileSel(sel)
	if m == nil {
		return false
	}
	return s.IsMatcher(m)
}

// sliceSel 前 n 个元素（cheerio .slice(0,n) 自动截断语义；goquery 超长会 panic，故封装）
func sliceSel(s *goquery.Selection, n int) *goquery.Selection {
	if s.Length() < n {
		n = s.Length()
	}
	return s.Slice(0, n)
}

// splitAlternatives 逗号拆分备选选择器（跳过括号/属性选择器内部的逗号）
func splitAlternatives(sel string) []string {
	out := []string{}
	depth := 0
	var cur strings.Builder
	for _, ch := range sel {
		if ch == '(' || ch == '[' {
			depth++
		} else if ch == ')' || ch == ']' {
			if depth > 0 {
				depth--
			}
		}
		if ch == ',' && depth == 0 {
			if strings.TrimSpace(cur.String()) != "" {
				out = append(out, strings.TrimSpace(cur.String()))
			}
			cur.Reset()
		} else {
			cur.WriteRune(ch)
		}
	}
	if strings.TrimSpace(cur.String()) != "" {
		out = append(out, strings.TrimSpace(cur.String()))
	}
	return out
}

var reSelAttr = regexp.MustCompile(`@([a-zA-Z][\w:-]*)$`)

// parseSel 解析 `sel@attr` 语法
func parseSel(raw string) (string, string) {
	if m := reSelAttr.FindStringSubmatchIndex(raw); m != nil {
		return strings.TrimSpace(raw[:m[0]]), raw[m[2]:m[3]]
	}
	return strings.TrimSpace(raw), ""
}

// pickText 在 scope 内按备选顺序取第一个非空文本/属性（find 优先，scope 自身命中亦采纳）
func pickText(s *goquery.Selection, rawSelectors []string) string {
	for _, raw := range rawSelectors {
		selector, attr := parseSel(raw)
		if selector == "" {
			continue
		}
		val := ""
		m := compileSel(selector)
		if m == nil {
			continue // 非法选择器直接跳过
		}
		el := s.FindMatcher(m).First()
		if el.Length() > 0 {
			if attr != "" {
				val = el.AttrOr(attr, "")
			} else {
				val = el.Text()
			}
		} else if s.Length() > 0 && s.IsMatcher(m) {
			// scope 自身命中选择器（如 scope 是 <a> 而 selector 为 a@title）
			if attr != "" {
				val = s.AttrOr(attr, "")
			} else {
				val = s.Text()
			}
		}
		t := collapse(val)
		if t != "" {
			return t
		}
	}
	return ""
}

// firstMatch 在 scope 内按备选顺序取第一个命中元素
func firstMatch(s *goquery.Selection, rawSelectors []string) *goquery.Selection {
	for _, raw := range rawSelectors {
		selector, _ := parseSel(raw)
		if selector == "" {
			continue
		}
		m := compileSel(selector)
		if m == nil {
			continue
		}
		el := s.FindMatcher(m).First()
		if el.Length() > 0 {
			return el
		}
		if s.Length() > 0 && s.IsMatcher(m) {
			return s
		}
	}
	return nil
}

// toAbs 相对链接 → 绝对地址；空链接/JS 伪协议/纯锚点均返回 ""
func toAbs(href, base string) string {
	h := strings.TrimSpace(href)
	if h == "" || strings.HasPrefix(strings.ToLower(h), "javascript:") || strings.HasPrefix(h, "#") {
		return ""
	}
	u := urlJoin(h, base)
	if u == nil {
		return ""
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return ""
	}
	return u.String()
}

// pickHref 按备选顺序取第一个可解析为绝对 URL 的链接（支持 @attr，默认取 href）
func pickHref(s *goquery.Selection, rawSelectors []string, base string) string {
	for _, raw := range rawSelectors {
		selector, attr := parseSel(raw)
		if selector == "" {
			continue
		}
		m := compileSel(selector)
		if m == nil {
			continue
		}
		el := s.FindMatcher(m).First()
		var node *goquery.Selection
		if el.Length() > 0 {
			node = el
		} else if s.Length() > 0 && s.IsMatcher(m) {
			node = s
		}
		if node == nil {
			continue
		}
		href := node.AttrOr("href", "")
		if attr != "" {
			href = node.AttrOr(attr, "")
		}
		if abs := toAbs(href, base); abs != "" {
			return abs
		}
	}
	return ""
}
