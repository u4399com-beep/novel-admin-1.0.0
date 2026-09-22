/**
 * 字符集检测与解码（逐行移植自 charset.ts）。
 * 优先级（对齐 WHATWG 编码嗅探，经审查确认）：
 *   请求强制指定 > BOM 嗅探 > HTTP Content-Type > HTML meta charset > UTF-8 字节嗅探 > GB18030 兜底 > latin1 透传。
 * 中文小说站大量使用 GBK/GB2312/GB18030/BIG5，统一用 x/net/html/charset（x/text 底座）解码。
 */
package main

import (
	"golang.org/x/net/html/charset"
	"regexp"
	"strings"
	"unicode/utf8"
)

// decodeResult 与 TS DecodeResult 同构
type decodeResult struct {
	Encoding string // 规范化后的编码名（大写显示用），如 UTF-8 / GBK / GB18030 / BIG5
	Text     string
	Warnings []string
}

// 常见别名 → 规范编码名（与 iconv-lite 别名表对齐）
var charsetAlias = map[string]string{
	"utf8":              "utf-8",
	"unicode-1-1-utf-8": "utf-8",
	"unicode":           "utf-8",
	"unicode-1-1":       "utf-8",
	"utf16":             "utf-16le",
	"utf-16":            "utf-16le",
	"unicodefffe":       "utf-16be",
	"gb2312":            "gbk",
	"gb_2312":           "gbk",
	"gb_2312-80":        "gbk",
	"gb231280":          "gbk",
	"csgb2312":          "gbk",
	"cngb":              "gbk",
	"chinese":           "gbk",
	"gbk2312":           "gbk",
	"x-gbk":             "gbk",
	// GB18030 是 GBK 的官方超集；显式别名防止被误标准化为 gbk
	"gb18030":      "gb18030",
	"gb18030-2000": "gb18030",
	"gb18030-2005": "gb18030",
	"gb18030-2022": "gb18030",
	"cp936":        "gbk",
	"ms936":        "gbk",
	"cp950":        "big5",
	"big5hkscs":    "big5-hkscs",
	"big5-hkscs":   "big5-hkscs",
	"x-big5":       "big5",
	"iso88591":     "iso-8859-1",
	"iso8859-1":    "iso-8859-1",
	"latin1":       "iso-8859-1",
	"l1":           "iso-8859-1",
	"cp1252":       "windows-1252",
	"sjis":         "shift_jis",
	"shift-jis":    "shift_jis",
	"shiftjs":      "shift_jis",
	"ksc5601":      "euc-kr",
	"euckr":        "euc-kr",
}

func normalizeCharset(raw string) string {
	if raw == "" {
		return ""
	}
	s := strings.ToLower(strings.TrimSpace(raw))
	s = strings.Trim(s, `"'`)
	if s == "" {
		return ""
	}
	if v, ok := charsetAlias[s]; ok {
		return v
	}
	return s
}

var reCharsetInCT = regexp.MustCompile(`(?i)charset\s*=\s*["']?([\w-]+)`)

// charsetFromContentType 从 Content-Type 头提取 charset（单/双引号均可，个别服务器输出 charset='gbk'）
func charsetFromContentType(contentType string) string {
	if contentType == "" {
		return ""
	}
	m := reCharsetInCT.FindStringSubmatch(contentType)
	if m == nil {
		return ""
	}
	return m[1]
}

// sniffBom BOM 嗅探
func sniffBom(b []byte) string {
	if len(b) < 3 {
		return ""
	}
	if b[0] == 0xef && b[1] == 0xbb && b[2] == 0xbf {
		return "utf-8"
	}
	if b[0] == 0xff && b[1] == 0xfe {
		return "utf-16le"
	}
	if b[0] == 0xfe && b[1] == 0xff {
		return "utf-16be"
	}
	return ""
}

var reMetaCharset = regexp.MustCompile(`(?i)<meta[^>]+charset\s*=\s*["']?\s*([a-zA-Z0-9._-]+)`)

// metaCharset 在前 4KB 内找 <meta charset=...> / <meta http-equiv=content-type content=...charset=...>
func metaCharset(b []byte) string {
	end := len(b)
	if end > 4096 {
		end = 4096
	}
	head := bytesToLatin1String(b[:end])
	m := reMetaCharset.FindStringSubmatch(head)
	if m == nil {
		return ""
	}
	return m[1]
}

// bytesToLatin1String 逐字节映射为字符串（0x00-0xFF → U+0000-U+00FF），等价 Buffer.toString('latin1')
func bytesToLatin1String(b []byte) string {
	var sb strings.Builder
	sb.Grow(len(b))
	for _, c := range b {
		sb.WriteRune(rune(c))
	}
	return sb.String()
}

// looksValidUtf8 UTF-8 严格校验
func looksValidUtf8(b []byte) bool { return utf8.Valid(b) }

// replacementRatio 替换符守卫：非 UTF-8 解码是宽松模式（坏字节 → U+FFFD，永不抛错），
// 「用错误的编码解码」也会得到非空文本。U+FFFD 占比超阈值视为解码失败，继续尝试下一候选。
func replacementRatio(text string) float64 {
	if text == "" {
		return 0
	}
	bad := 0
	total := 0
	for _, r := range text {
		total++
		if r == 0xfffd {
			bad++
		}
	}
	if total == 0 {
		return 0
	}
	return float64(bad) / float64(total)
}

const maxReplacementRatio = 0.01

// formatRatio 输出 1 位小数（等价 (ratio*100).toFixed(1)）
func formatRatio(r float64) string {
	v := uint64(r*100000 + 0.5) // 百分比放大 1000 倍保留 1 位小数
	return itoa(int(v/1000)) + "." + itoa(int(v%1000))
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [24]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// decodeHtml 主入口：把原始响应字节安全解码为文本。全程不 panic，失败逐级降级并在 warnings 中说明。
func decodeHtml(b []byte, forcedCharset, headerCharset string) decodeResult {
	warnings := []string{}
	if len(b) == 0 {
		return decodeResult{Encoding: "UTF-8", Text: "", Warnings: []string{"响应体为空"}}
	}

	forced := ""
	if forcedCharset != "" {
		forced = normalizeCharset(forcedCharset)
		if forced == "" {
			warnings = append(warnings, "强制编码参数无法解析，已忽略")
		}
	}
	bom := sniffBom(b)
	header := normalizeCharset(headerCharset)
	meta := normalizeCharset(metaCharset(b))
	if header != "" && meta != "" && header != meta {
		warnings = append(warnings, "HTTP 头声明 "+header+" 与 HTML meta 声明 "+meta+" 不一致，优先采用 HTTP 头")
	}

	// tryDecode：iso-8859-1 走纯逐字节映射（x/net/html/charset 按 WHATWG 会把该标签映射到
	// windows-1252，与本引擎「latin1 透传」语义不符）；其余编码交给 charset.Lookup。
	tryDecode := func(enc, source string, guard bool) string {
		if enc == "" {
			return ""
		}
		var decoded string
		if enc == "iso-8859-1" {
			decoded = bytesToLatin1String(b)
		} else {
			enc1, _ := charset.Lookup(enc)
			if enc1 == nil {
				warnings = append(warnings, "编码 "+enc+"（来源: "+source+"）不受支持，跳过")
				return ""
			}
			text, err := enc1.NewDecoder().Bytes(b)
			if err != nil {
				warnings = append(warnings, "编码 "+enc+"（来源: "+source+"）解码失败，跳过")
				return ""
			}
			decoded = string(text)
		}
		if utf8.RuneCountInString(decoded) == 0 {
			return ""
		}
		if guard {
			ratio := replacementRatio(decoded)
			if ratio > maxReplacementRatio {
				warnings = append(warnings, "编码 "+enc+"（来源: "+source+"）解码后乱码占比 "+formatRatio(ratio)+"%（疑似编码声明错误），跳过")
				return ""
			}
		}
		return decoded
	}

	// 1) 强制指定 2) BOM 3) HTTP 头 4) meta 声明
	// guard 仅对"声明可能出错"的头/meta 生效；强制指定与 BOM 是明确意图/强证据，不做占比拦截
	candidates := []struct {
		enc    string
		source string
		guard  bool
	}{
		{forced, "请求强制指定", false},
		{bom, "BOM 嗅探", false},
		{header, "HTTP Content-Type", true},
		{meta, "HTML meta 声明", true},
	}
	for _, c := range candidates {
		if text := tryDecode(c.enc, c.source, c.guard); text != "" {
			return decodeResult{Encoding: strings.ToUpper(c.enc), Text: text, Warnings: dedupeStrings(warnings)}
		}
	}

	// 5) 字节嗅探：合法 UTF-8 则用 UTF-8
	if looksValidUtf8(b) {
		return decodeResult{
			Encoding: "UTF-8",
			Text:     string(b),
			Warnings: dedupeStrings(append(warnings, "响应未声明（有效）编码，按 UTF-8 字节嗅探解码")),
		}
	}

	// 6) 兜底：GB18030（中文小说站最常见的历史编码）。GB18030 是 GBK 的严格超集：
	// GBK 字节序列解码结果完全一致，且能正确处理 GB18030 四字节字符（GBK 会解出乱码）
	if gbkText := tryDecode("gb18030", "GB18030 兜底", true); gbkText != "" {
		return decodeResult{
			Encoding: "GB18030",
			Text:     gbkText,
			Warnings: dedupeStrings(append(warnings, "未声明编码且非合法 UTF-8，按 GB18030 兜底解码（GB18030 兼容 GBK，中文站常见情况）")),
		}
	}

	// 7) 最终透传：latin1 永不失败
	return decodeResult{
		Encoding: "ISO-8859-1",
		Text:     bytesToLatin1String(b),
		Warnings: dedupeStrings(append(warnings, "所有解码策略失败，已按 latin1 透传（结果可能乱码）")),
	}
}

func dedupeStrings(arr []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(arr))
	for _, s := range arr {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}
