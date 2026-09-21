/**
 * JS 字符串语义工具：JS 的 \s / trim 与 Go 的 \s / TrimSpace 集合不同
 * （JS 含 \u00a0/\u3000/\u2000-\u200a/\ufeff 等 Unicode 空白）。
 * 为保行为一致，凡来自 TS 的文本清洗逻辑统一使用本文件的 JS 语义版本。
 */
package main

import (
        "regexp"
        "strings"
        "unicode"
)

// reJSWhitespace 等价 JS /\s+/（含 Unicode 空白全集）
var reJSWhitespace = regexp.MustCompile(`[\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+`)

// trimJSSpace 等价 JS String.prototype.trim()
func trimJSSpace(s string) string {
        return strings.TrimFunc(s, func(r rune) bool {
                switch r {
                case '\t', '\n', '\v', '\f', '\r', ' ', 0x0085, 0x00a0, 0x1680, 0x2028, 0x2029,
                        0x202f, 0x205f, 0x3000, 0xfeff:
                        return true
                }
                return r >= 0x2000 && r <= 0x200a
        })
}

// collapse 等价 selectors.ts collapse：NBSP→空格、JS 空白折叠、trim
func collapse(s string) string {
        return trimJSSpace(strings.ReplaceAll(reJSWhitespace.ReplaceAllString(s, " "), " ", " "))
}

// runeLen UTF-16 code unit 数（JS String.length 语义）；BMP 内等于字符数
func runeLen(s string) int { return len([]rune(s)) }

// splitJSSpace 等价 JS s.split(/\s+/)（先 trim 语义由调用方保证：空 token 由调用方过滤）
func splitJSSpace(s string) []string {
        parts := reJSWhitespace.Split(s, -1)
        out := parts[:0]
        for _, p := range parts {
                if p != "" {
                        out = append(out, p)
                }
        }
        return out
}

// normalizeNewlines \r\n / \r → \n
func normalizeNewlines(s string) string {
        if !strings.ContainsRune(s, '\r') {
                return s
        }
        s = strings.ReplaceAll(s, "\r\n", "\n")
        return strings.ReplaceAll(s, "\r", "\n")
}

// splitLines 按 \n 切行
func splitLines(s string) []string { return strings.Split(s, "\n") }

// joinLines 单 \n 连接
func joinLines(lines []string) string { return strings.Join(lines, "\n") }

// jsIndexOfFold 简化大小写无关包含判断（当前未用，保留给 challenge 文本匹配）
func containsFold(s, sub string) bool { return strings.Contains(strings.ToLower(s), strings.ToLower(sub)) }

var _ = unicode.IsSpace
