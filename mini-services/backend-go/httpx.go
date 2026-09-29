/**
 * backend-go —— HTTP 通用工具：JSON 读写 / 错误结构 / 时间序列化。
 *
 * 契约对齐要点：
 * - writeJSON 用 json.Encoder + SetEscapeHTML(false)，对齐 JS JSON.stringify 语义
 *   （中文/书名号不转义，与 TS 版响应逐字节兼容）
 * - 错误一律 { error, detail }（与 TS 版 API 完全一致）
 * - Prisma DateTime（SQLite ms 整数）对外序列化为 ISO 8601 UTC 字符串
 */
package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strconv"
	"time"
)

// writeJSON 写 JSON 响应
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return
	}
	_, _ = w.Write(buf.Bytes())
}

// failJSON 写错误响应 {error, detail}
func failJSON(w http.ResponseWriter, errMsg, detail string, status int) {
	writeJSON(w, status, map[string]string{"error": errMsg, "detail": detail})
}

// strField 从 body 取字符串字段（缺省空串）
func strField(v any, maxLen int) string {
	s, _ := v.(string)
	if maxLen > 0 && len([]rune(s)) > maxLen {
		rs := []rune(s)
		s = string(rs[:maxLen])
	}
	return s
}

// parseQueryStr 解析 query 参数字符串
func parseQueryStr(r *http.Request, key string) string {
	return r.URL.Query().Get(key)
}

// ---------- 时间序列化（Prisma 契约对齐） ----------

// isoFromMillis SQLite ms 整数 → ISO 8601 UTC 字符串（对齐 Prisma JSON 输出，如
// "2025-09-21T12:40:00.000Z"；0/负值输出零值时间）
func isoFromMillis(ms int64) string {
	if ms <= 0 {
		return "1970-01-01T00:00:00.000Z"
	}
	return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z")
}

// clampInt 整数夹取
func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// truncateRunes 按 rune 截断
func truncateRunes(s string, n int) string {
	rs := []rune(s)
	if len(rs) <= n {
		return s
	}
	return string(rs[:n])
}

// fmtF 格式化数值避免科学计数法输出
func fmtF(f float64) string {
	return strconv.FormatFloat(f, 'f', -1, 64)
}
