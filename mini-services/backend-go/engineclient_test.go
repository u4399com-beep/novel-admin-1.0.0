/**
 * engineclient_test.go —— Task 27-c 回归锁定：isSameChapterPagination 的三处语义
 * （25-a 修复⑧在本轮重新应用，加测试防再次合并丢失）：
 *  ① base 为站点根时空前缀不误判（同主机任意路径 ≠ 同章分页）
 *  ② 「路径完全相等 + ?page=N」显式分支（EscapedPath 不含 '?'，sep=='?' 分支不可达）
 *  ③ 常规 base_2.html / base/2.html 前缀续写 + 数字续写（/1/ vs /12/）负例
 */
package main

import "testing"

func TestIsSameChapterPagination(t *testing.T) {
	cases := []struct {
		name string
		base string
		next string
		want bool
	}{
		{"前缀续写 _2.html", "https://x.com/book/1/abc.html", "https://x.com/book/1/abc_2.html", true},
		{"前缀续写 /2.html", "https://x.com/book/1/abc", "https://x.com/book/1/abc/2.html", true},
		{"省略后缀差异 vl7 → vl7_2", "https://x.com/vl7", "https://x.com/vl7_2.html", true},
		{"数字续写负例", "https://x.com/book/1/", "https://x.com/book/12/", false},
		{"站点根空前缀负例", "https://x.com", "https://x.com/2.html", false},
		{"跨主机负例", "https://x.com/book/1/a.html", "https://y.com/book/1/a_2.html", false},
		{"路径相等+page 参数", "https://x.com/reader.php?cid=111", "https://x.com/reader.php?cid=111&page=2", true},
		{"路径相等非 page 参数负例", "https://x.com/reader.php?cid=111", "https://x.com/reader.php?cid=112", false},
		{"非绝对 URL 负例", "https://x.com/book/1/a.html", "a_2.html", false},
	}
	for _, c := range cases {
		if got := isSameChapterPagination(c.base, c.next); got != c.want {
			t.Fatalf("%s: isSameChapterPagination(%q, %q) = %v, want %v", c.name, c.base, c.next, got, c.want)
		}
	}
}
