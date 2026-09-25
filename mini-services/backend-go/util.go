/**
 * backend-go —— 通用小工具（字符串/IO/并发安全容器）。
 */
package main

import (
	"io"
	"strconv"
	"strings"
)

// itoa int → string
func itoa(n int) string {
	return strconv.Itoa(n)
}

// trimSpaceStr 去两端空白（含 JS \s 语义的常见空白）
func trimSpaceStr(s string) string {
	return strings.TrimSpace(s)
}

// readAllLimited 限量读取（上限 maxBytes；超出即截断）
func readAllLimited(r io.Reader, maxBytes int) ([]byte, error) {
	lr := io.LimitReader(r, int64(maxBytes)+1)
	b, err := io.ReadAll(lr)
	if err != nil {
		return b, err
	}
	if len(b) > maxBytes {
		b = b[:maxBytes]
	}
	return b, nil
}
