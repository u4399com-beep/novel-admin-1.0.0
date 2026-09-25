/**
 * storex_test.go —— Task 28-b 智能完结（源站状态 → serial|finished 映射）回归：
 * 旧正则 `完|fin` 的两类误判——「未完结」含「完」被误判完结、英文 Completed（无 fin）
 * 被误判连载；修复后否定/进行时词表先行，完结词表补 compl。
 * 纯函数测试，不触 DB/网络。
 */
package main

import "testing"

func TestMapNovelStatus(t *testing.T) {
	cases := []struct {
		raw  string
		want string
	}{
		{"", "serial"},            // 默认值：源站未提供状态 → 连载（保守）
		{"连载中", "serial"},         // 进行时
		{"连载", "serial"},          // 裸连载（不含完结词，负向表不含裸「连载」——「连载完结」语义保护）
		{"连载完结", "finished"},      // 合成词：完结优先于裸连载
		{"完结", "finished"},        // 最常见完结形态
		{"已完结", "finished"},       // 前缀完
		{"完本", "finished"},        // 完本
		{"全书完", "finished"},       // 尾完
		{"未完结", "serial"},         // Task 28-b：旧版误判 finished
		{"连载未完", "serial"},        // Task 28-b：旧版误判 finished
		{"未完待续", "serial"},        // Task 28-b
		{"暂停", "serial"},          // 停更系（两值模型下归连载）
		{"太监", "serial"},          // 断更系
		{"停更", "serial"},          // 停更系
		{"Completed", "finished"}, // Task 28-b：旧版误判 serial（无 fin 字样）
		{"finished", "finished"},  // 英文 fin
		{"連載中", "serial"},         // 繁体进行时
		{"完結", "finished"},        // 繁体完结（含「完」）
		{"状态：已完结", "finished"},    // 引擎 stripFieldLabel 失守时的兜底容错
	}
	for _, c := range cases {
		if got := mapNovelStatus(c.raw); got != c.want {
			t.Errorf("mapNovelStatus(%q) = %q, want %q", c.raw, got, c.want)
		}
	}
}
