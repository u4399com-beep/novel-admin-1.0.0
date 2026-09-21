/**
 * backend-go —— 列表页翻页 URL 生成。
 *
 * TS 源：src/lib/scrape/pagination.ts（逐行移植）
 * - 规则配置了 listRule.paginationTemplate 时严格按模板生成（{k}=页码、{url}=首页 URL encode）
 * - 未配置时回退猜测：?page=k（已有 query 则 &page=k）与 /page/k 两种变体，去重
 *
 * 移植差异：
 * - encodeURIComponent 语义用 jsEncodeURIComponent 精确复刻（Go url.QueryEscape 的
 *   空格→'+' 与 !'()* 转义行为与 JS 不同）
 * - JS URL 构造器对非法/相对 URL 抛异常 → catch 分支；Go url.Parse 对相对 URL 不报错，
 *   故以 IsAbs() 判定走哪个分支，语义对齐
 * - JS URLSearchParams.set 保留既有参数顺序；Go url.Values.Encode 按键名排序输出，
 *   多参数列表页的 query 顺序可能与 TS 版不同（不影响抓取语义）
 */
package main

import (
	"net/url"
	"strings"
)

const upperHexDigits = "0123456789ABCDEF"

// jsEncodeURIComponent 精确复刻 JS encodeURIComponent：保留 A-Za-z0-9 -_.!~*'()，
// 其余（含 /）按 UTF-8 字节转 %XX 大写
func jsEncodeURIComponent(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
			c == '-' || c == '_' || c == '.' || c == '!' || c == '~' || c == '*' || c == '\'' || c == '(' || c == ')' {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(upperHexDigits[c>>4])
		b.WriteByte(upperHexDigits[c&0x0F])
	}
	return b.String()
}

// hasPaginationTemplate 规则是否配置了分页模板（运行时清洗后的 listRule 里为非空字符串）
func hasPaginationTemplate(listRule RuleMap) bool {
	return strings.TrimSpace(listRule["paginationTemplate"]) != ""
}

// buildPageVariants 生成第 k 页（k≥2）候选 URL 列表：模板优先，未配置时给猜测变体
func buildPageVariants(listRule RuleMap, baseURL string, k int) []string {
	tpl := strings.TrimSpace(listRule["paginationTemplate"])
	if tpl != "" {
		if strings.Contains(tpl, "{url}") {
			tpl = strings.ReplaceAll(tpl, "{url}", jsEncodeURIComponent(baseURL))
		}
		return []string{strings.ReplaceAll(tpl, "{k}", itoa(k))}
	}
	return guessPageVariants(baseURL, k)
}

// guessPageVariants 历史猜测逻辑（自 worker.ts 迁入）：?page=k 与 /page/k 两种变体，去重
func guessPageVariants(u string, k int) []string {
	var out []string
	if parsed, err := url.Parse(u); err == nil && parsed.IsAbs() {
		// 变体一：searchParams.set('page', k)（其余 query 保留）
		if parsed.Path == "" {
			parsed.Path = "/" // JS URL pathname 恒为 "/" 起，toString 带斜杠
		}
		q := parsed.Query()
		q.Set("page", itoa(k))
		parsed.RawQuery = q.Encode()
		out = append(out, parsed.String())

		// 变体二：pathname 去尾斜杠 + "/page/k"，search 清空（hash 保留）
		if p2, err2 := url.Parse(u); err2 == nil {
			p2.Path = strings.TrimRight(p2.Path, "/") + "/page/" + itoa(k)
			p2.RawQuery = ""
			if p2.String() != out[0] {
				out = append(out, p2.String())
			}
		}
	} else {
		// JS new URL 抛异常的兜底分支：字符串拼接
		if strings.Contains(u, "?") {
			out = append(out, u+"&page="+itoa(k))
		} else {
			out = append(out, u+"?page="+itoa(k))
		}
		out = append(out, strings.TrimRight(u, "/")+"/page/"+itoa(k))
	}
	// 去重（保持顺序，[...new Set(out)] 语义）
	seen := map[string]bool{}
	uniq := out[:0]
	for _, v := range out {
		if !seen[v] {
			seen[v] = true
			uniq = append(uniq, v)
		}
	}
	return uniq
}
