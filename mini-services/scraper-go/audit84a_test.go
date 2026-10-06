package main

import "testing"

// TestReGarbageCoverSrc R84：None/null/undefined 字面量封面 URL 拒绝（末段精确匹配，
// 路径中间含子串的正常图不误杀）。
func TestReGarbageCoverSrc(t *testing.T) {
	garbage := []string{
		"https://img22.ixdzs.com/None",
		"https://img22.ixdzs.com/none",
		"https://img.example.com/null",
		"https://img.example.com/undefined?v=2",
		"https://img.example.com/None#frag",
	}
	for _, u := range garbage {
		if !reGarbageCoverSrc.MatchString(u) {
			t.Errorf("垃圾 URL 应命中: %s", u)
		}
	}
	normal := []string{
		"https://img.example.com/covers/6.jpg",
		"https://img.example.com/Noneless/7.jpg",
		"https://img.example.com/img/null-safe.png",
		"https://img.example.com/cover?id=1&type=big",
	}
	for _, u := range normal {
		if reGarbageCoverSrc.MatchString(u) {
			t.Errorf("正常 URL 误杀: %s", u)
		}
	}
}
