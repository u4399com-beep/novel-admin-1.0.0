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

// ==================== R104: 范围采集 {page} 占位符 + 起止页 ====================
//
// 用户诉求：范围采集（list 任务）目标 URL 支持 {page} 占位符，并可设置从第几页到第几页。
//
// 语义设计（向后兼容零破坏）：
//   - TargetURL 含 {page} 占位符（原样或 parseHttpURL 百分号编码后的 %7Bpage%7D，大小写
//     不敏感——Go url.Parse+String() 会把花括号编码为 %7B/%7D，API 层存的是编码形）：
//     每一页 URL = 占位符替换为页码，页码区间 [pageFrom, pageTo]；不再做首页原样抓取
//     （原样 URL 里的占位符对源站是 404 垃圾页），也不再走规则 paginationTemplate/猜测
//     变体（任务级显式占位符优先级最高）。
//   - TargetURL 不含占位符：完全沿用旧行为——第 1 页 = TargetURL 原样（pageFrom>1 时
//     跳过原样首页，从 pageFrom 开始按变体生成），k≥2 走模板/猜测变体；pageTo 未设置
//     时沿用 pages（页数上限=末页索引）。
//   - pageFrom/pageTo 任一为 0 = 未设置：start=1，end=pages（pages=0 时退 1，仅首页）。

// pagePlaceholderForms {page} 占位符的全部识别形态（小写比对；%7bpage%7d 为 Go
// url.Parse+String() 百分号编码形，大小写差异已被 ToLower 归一）
var pagePlaceholderForms = []string{"{page}", "%7bpage%7d"}

// hasPagePlaceholder 任务目标 URL 是否含 {page} 占位符（大小写不敏感，含编码形）
func hasPagePlaceholder(u string) bool {
        low := strings.ToLower(u)
        for _, f := range pagePlaceholderForms {
                if strings.Contains(low, f) {
                        return true
                }
        }
        return false
}

// expandPagePlaceholder {page} 占位符替换为页码 k（仅已确认含占位符的 URL 调用；
// 所有形态一并替换，防混合形态只换一半）
func expandPagePlaceholder(u string, k int) string {
        low := strings.ToLower(u)
        for _, f := range pagePlaceholderForms {
                if strings.Contains(low, f) {
                        u = replaceInsensitive(u, f, itoa(k))
                        low = strings.ToLower(u)
                }
        }
        return u
}

// replaceInsensitive 大小写不敏感的子串替换（占位符体量小，朴素实现足够）
func replaceInsensitive(s, old, new string) string {
        low, oldLow := strings.ToLower(s), strings.ToLower(old)
        var b strings.Builder
        for {
                idx := strings.Index(low, oldLow)
                if idx < 0 {
                        b.WriteString(s)
                        return b.String()
                }
                b.WriteString(s[:idx])
                b.WriteString(new)
                s = s[idx+len(old):]
                low = low[idx+len(oldLow):]
        }
}

// effectivePageRange 计算范围采集的有效起止页（含 {page} 占位符与旧语义两种形态）。
// 返回 start/end（均 ≥1）；end<start 视为配置矛盾，调用方按「无页可采」处理。
func effectivePageRange(task TaskRecord) (start, end int) {
        start, end = 1, 1
        if task.PageFrom > 0 {
                start = task.PageFrom
        }
        if task.PageTo > 0 {
                end = task.PageTo
        } else if task.Pages > 0 {
                end = task.Pages
        }
        if end < start {
                end = start
        }
        return start, end
}
