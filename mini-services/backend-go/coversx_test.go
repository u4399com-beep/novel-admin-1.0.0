/**
 * coversx_test.go —— Task 33-b 回归锁定：isPrivateIp 移除 fc/fd/fe80 无差别前缀判定。
 * 根因：函数末尾本就有「含冒号=IPv6 一律拒绝」的 catch-all，前缀判定对 IPv6 字面量
 * 是死代码，唯一实际作用是把 fcxxx.com / fdzone.org 等公网域名误判私网 → SSRF 校验
 * assertPublicHttpURL 直接拒绝 → 封面下载恒失败（静默丢封面，日志无痕）。
 * 表驱动覆盖：私网/环回/CGNAT/链路本机仍全量拦截，公网域名（含 fc/fd/fe80 前缀）放行。
 */
package main

import "testing"

func TestIsPrivateIp(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		// 空与特殊名
		{"", true},
		{"localhost", true},
		{"a.localhost", true},
		{"x.local", true},
		{"x.internal", true},
		// IPv6（含冒号 → catch-all 拦截，私网段防线不弱化）
		{"::1", true},
		{"::", true},
		{"fc00::1", true},
		{"fd12::9", true},
		{"fe80::1", true},
		{"2001:db8::1", true},
		// IPv4 私网/保留段
		{"0.1.2.3", true},
		{"10.0.0.1", true},
		{"127.0.0.1", true},
		{"169.254.3.4", true},
		{"172.16.0.1", true},
		{"172.31.255.255", true},
		{"192.168.1.1", true},
		{"100.64.0.1", true},
		{"192.0.0.2", true},
		{"198.18.0.1", true},
		{"256.1.1.1", true}, // 越界八位组 → 拒绝
		// 公网 IPv4
		{"8.8.8.8", false},
		{"1.2.3.4", false},
		{"172.32.0.1", false},
		{"100.128.0.1", false},
		// Task 33-b 回归：fc/fd/fe80 前缀的公网域名（旧版误判私网 → 封面恒失败）
		{"fcds.com", false},
		{"fdzone.org", false},
		{"fe80.io", false},
		{"example.com", false},
		{"FCDS.COM", false}, // 入参已小写归一
	}
	for _, c := range cases {
		if got := isPrivateIp(c.in); got != c.want {
			t.Fatalf("isPrivateIp(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}
