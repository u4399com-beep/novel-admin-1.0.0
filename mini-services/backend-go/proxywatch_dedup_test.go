package main

import (
	"reflect"
	"testing"
)

// R128 E25 收尾：主机级多样性帽——同 IP 多端口免费源形态（101kks 池 102.244.78.61 ×3
// 实证）单 IP 集中 = 同生死（源站封 IP 一锅端）。三用例锁契约：
// ①同 host 达 2 口帽即拒后续 ②不同 host 正常放行且保序（快口优先语义） ③异形串保守放行。

func TestProxyHostDiversityFilterCapR128(t *testing.T) {
	pool := []string{"102.244.78.61:80", "102.244.78.61:8080"} // 同 IP 已 2 口（历史池形态）
	cands := []string{
		"102.244.78.61:3128", // 同 IP 第 3 口 → 拒
		"1.2.3.4:80",         // 新 IP → 放行
		"1.2.3.4:3128",       // 同 IP 第 2 口 → 放行（帽=2 容忍双端口多径）
		"1.2.3.4:9999",       // 同 IP 第 3 口 → 拒
		"5.6.7.8:80",         // 新 IP → 放行
	}
	got := proxyHostDiversityFilter(pool, cands)
	want := []string{"1.2.3.4:80", "1.2.3.4:3128", "5.6.7.8:80"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("diversity filter mismatch\n got: %v\nwant: %v", got, want)
	}
}

func TestProxyHostDiversityFilterOrderAndNilPoolR128(t *testing.T) {
	// nil pool（miniproxypool 补种场景）：候选依序全放行（各自 host 计数独立累计）
	cands := []string{"9.9.9.1:80", "9.9.9.2:80", "9.9.9.1:81", "9.9.9.3:80", "9.9.9.1:82"}
	got := proxyHostDiversityFilter(nil, cands)
	want := []string{"9.9.9.1:80", "9.9.9.2:80", "9.9.9.1:81", "9.9.9.3:80"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("nil-pool filter mismatch\n got: %v\nwant: %v", got, want)
	}
}

func TestProxyHostMalformedConservativeR128(t *testing.T) {
	// 异形串（无冒号/空串）原样返回——过滤层保守放行而非误杀
	if got := proxyHost("noproxyhost"); got != "noproxyhost" {
		t.Fatalf("malformed host passthrough broken: %q", got)
	}
	if got := proxyHost("1.2.3.4:8080"); got != "1.2.3.4" {
		t.Fatalf("basic host extraction broken: %q", got)
	}
	// IPv6 [::1]:80 形态：取最后一个冒号前 → "[::1]"（保守可用，不误杀）
	if got := proxyHost("[::1]:80"); got != "[::1]" {
		t.Fatalf("ipv6 host extraction broken: %q", got)
	}
}
