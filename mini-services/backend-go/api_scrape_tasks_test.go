/**
 * api_scrape_tasks_test.go —— Task 30-b 回归锁定：taskRuleIDParam / taskPagesParam
 * 巨大数值（1e20 等）float→int 转换溢出修复的表驱动用例。
 */
package main

import "testing"

// TestTaskPagesParamExtremeValues 分页参数极端值（Task 30-b 修复锁定：
// 旧版 pages=1e20 经 parsePositiveInt 的 int64 转换溢出为负，绕过 p>999 上限，
// 负 pages 任务照常创建；TS 版在 float 域比较会 400）。
func TestTaskPagesParamExtremeValues(t *testing.T) {
	cases := []struct {
		name      string
		val       any
		wantPages int
		wantOK    bool
	}{
		{name: "常规数字", val: float64(3), wantPages: 3, wantOK: true},
		{name: "字符串数字", val: "12", wantPages: 12, wantOK: true},
		{name: "上界999", val: float64(999), wantPages: 999, wantOK: true},
		{name: "超界1000", val: float64(1000), wantOK: false},
		{name: "巨大值1e20_float", val: 1e20, wantOK: false},
		{name: "巨大值字符串1e20", val: "1e20", wantOK: false},
		{name: "巨大整数串", val: "99999999999999999999", wantOK: false},
		{name: "0", val: float64(0), wantOK: false},
		{name: "负数", val: float64(-5), wantOK: false},
		{name: "小数", val: 1.5, wantOK: false},
		{name: "非数字字符串", val: "abc", wantOK: false},
		// JS Number(true)=1 → 合法（与 TS Number(true)===1 宽式转换语义一致）
		{name: "布尔true", val: true, wantPages: 1, wantOK: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body := map[string]any{}
			if tc.val != nil {
				body["pages"] = tc.val
			}
			pages, provided, ok := taskPagesParam(body)
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tc.wantOK)
			}
			if !tc.wantOK {
				return
			}
			if !provided || pages != tc.wantPages {
				t.Fatalf("pages = %d (provided=%v), want %d", pages, provided, tc.wantPages)
			}
		})
	}
	// 未提供/空串：视为未提供（ok=true, provided=false）
	for _, val := range []any{nil, ""} {
		body := map[string]any{"pages": val}
		_, provided, ok := taskPagesParam(body)
		if !ok || provided {
			t.Fatalf("pages=%#v: expected provided=false ok=true, got provided=%v ok=%v", val, provided, ok)
		}
	}
}

// TestTaskRuleIDParamExtremeValues ruleId 极端值（Task 30-b 修复锁定：
// 2^53 上界内合法，超界 float 域拒绝，杜绝 int64 转换的实现定义溢出）。
func TestTaskRuleIDParamExtremeValues(t *testing.T) {
	cases := []struct {
		name string
		val  any
		want int64
		ok   bool
	}{
		{name: "常规", val: float64(7), want: 7, ok: true},
		{name: "字符串", val: "42", want: 42, ok: true},
		{name: "2^53内大数", val: float64(4503599627370496), want: 4503599627370496, ok: true},
		{name: "超2^53", val: 9.1e15, ok: false},
		{name: "巨大值1e20", val: 1e20, ok: false},
		{name: "巨大整数串", val: "100000000000000000000", ok: false},
		{name: "负数", val: float64(-1), ok: false},
		{name: "0", val: float64(0), ok: false},
		{name: "小数", val: 2.25, ok: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body := map[string]any{}
			if tc.val != nil {
				body["ruleId"] = tc.val
			}
			rid, provided, ok := taskRuleIDParam(body)
			if ok != tc.ok {
				t.Fatalf("ok = %v, want %v", ok, tc.ok)
			}
			if !tc.ok {
				return
			}
			if !provided || rid != tc.want {
				t.Fatalf("rid = %d (provided=%v), want %d", rid, provided, tc.want)
			}
		})
	}
}
