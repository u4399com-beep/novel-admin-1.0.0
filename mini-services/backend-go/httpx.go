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
	"io"
	"net/http"
	"strconv"
	"time"
)

const maxBodyBytes = 1 << 20 // 1MB 请求体上限（与引擎一致）

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

// readJSON 读取请求体到 map[string]any（超限/坏 JSON 返回 false 并已写 400 响应）
func readJSON(w http.ResponseWriter, r *http.Request) (map[string]any, bool) {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes+1))
	if err != nil {
		failJSON(w, "参数错误", "请求体读取失败", 400)
		return nil, false
	}
	if len(body) > maxBodyBytes {
		failJSON(w, "参数错误", "请求体超限（>1MB）", 413)
		return nil, false
	}
	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		failJSON(w, "参数错误", "请求体不是合法 JSON 对象", 400)
		return nil, false
	}
	if m == nil {
		m = map[string]any{}
	}
	return m, true
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

// boolField 取布尔字段
func boolField(v any) bool {
	b, _ := v.(bool)
	return b
}

// floatField 取数值字段（JSON 数字统一 float64）
func floatField(v any) float64 {
	f, _ := v.(float64)
	return f
}

// intField 取整数字段
func intField(v any) int {
	return int(floatField(v))
}

// optIntField 可选整数字段（存在且为数字返回 true）
func optIntField(v any) (int, bool) {
	f, ok := v.(float64)
	if !ok {
		return 0, false
	}
	return int(f), true
}

// parseID 解析路径参数 id（非数字写 400 响应并返回 false）
func parseID(w http.ResponseWriter, raw string) (int, bool) {
	id, err := strconv.Atoi(raw)
	if err != nil || id <= 0 {
		failJSON(w, "参数错误", "id 须为正整数", 400)
		return 0, false
	}
	return id, true
}

// parseQueryInt 解析 query 参数为整数（非法/缺省返回 def）
func parseQueryInt(r *http.Request, key string, def int) int {
	v := r.URL.Query().Get(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
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
