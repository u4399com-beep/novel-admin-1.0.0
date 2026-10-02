/**
 * coversx_test.go —— Task 33-b / Task 50 回归锁定。
 * Task 33-b：isPrivateIp 移除 fc/fd/fe80 无差别前缀判定（fcxxx.com 公网域名误判私网）。
 * Task 50：移除「含冒号=IPv6 一律拒绝」catch-all，IPv6 按真实网段语义判定——
 * 根因：公网站点普遍双栈（101kks.com 实测 A+AAAA），DNS 逐址校验遇任一 v6 地址
 * 即整体误判私网 → 封面下载全站静默失败（图床直连明明可达）。
 * 表驱动覆盖：私网/环回/CGNAT/链路本机/文档段仍全量拦截；公网全球单播（Cloudflare
 * 2606:4700:: 等）与 v4-mapped 公网/私网按真实语义放行/拦截；fc/fd/fe80 前缀公网域名放行。
 */
package main

import (
	"net"
	"testing"
)

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
		// IPv6 私网/保留段（语义判定仍拦截）
		{"::1", true},
		{"::", true},
		{"fc00::1", true},
		{"fd12::9", true},
		{"fe80::1", true},
		{"febf::1", true},
		{"2001:db8::1", true},     // 文档保留段
		{"::ffff:10.0.0.1", true}, // v4-mapped 私网
		{"::ffff:192.168.1.1", true},
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
		// Task 76 加固段：组播/保留/TEST-NET-2/6to4 relay 早期确定性拒绝
		{"224.0.0.1", true},       // 组播
		{"239.255.255.250", true}, // 组播顶段
		{"240.0.0.1", true},       // 保留段
		{"255.255.255.255", true}, // 广播
		{"198.51.100.7", true},    // TEST-NET-2
		{"192.88.99.1", true},     // 6to4 relay（已弃用）
		{"256.1.1.1", true},       // 越界八位组 → 拒绝
		// 公网 IPv4
		{"8.8.8.8", false},
		{"1.2.3.4", false},
		{"172.32.0.1", false},
		{"100.128.0.1", false},
		// Task 76 豁免契约锁定：TEST-NET-3 有意保留公网判定（免 DNS 测试夹具，
		// audit51/51b/60/69 系列依赖；不得加入私网判定）
		{"203.0.113.99", false},
		// Task 50 核心回归：公网 IPv6 全球单播（双栈站点 DNS 返回形态）必须放行
		{"2606:4700::1", false}, // Cloudflare
		{"2606:4700:10::6814:150b", false},
		{"2001:4860:4860::8888", false}, // Google DNS
		{"::ffff:8.8.8.8", false},       // v4-mapped 公网
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

// TestIsPrivateIPAddrDirect net.IP 直判路径（assertPublicHttpURL DNS 逐址校验 /
// coverDialControl 拨号前终校验的共用判定）
func TestIsPrivateIPAddrDirect(t *testing.T) {
	cases := []struct {
		ip   string
		want bool
	}{
		{"2606:4700::1", false},
		{"104.26.10.91", false},
		{"::ffff:104.26.10.91", false},
		{"10.0.0.1", true},
		{"::ffff:10.0.0.1", true},
		{"fe80::1", true},
		{"fc00::1", true},
		{"2001:db8::1", true},
	}
	for _, c := range cases {
		ip := net.ParseIP(c.ip)
		if ip == nil {
			t.Fatalf("ParseIP(%q) = nil", c.ip)
		}
		if got := isPrivateIPAddr(ip); got != c.want {
			t.Fatalf("isPrivateIPAddr(%q) = %v, want %v", c.ip, got, c.want)
		}
	}
}
