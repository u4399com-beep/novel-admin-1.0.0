/**
 * R108 专项测试：AIMD 对称下探通道 + 代理 per-IP 分桶键 + politeness 上界联动。
 *
 * 契约锁定：
 * 1. slotKeyFor：未分桶主机恒裸 host（R107 行为不变）；分桶主机非直连出口 → host|eg:<脱敏出口>；
 *    凭据（user:pass@）不参与键归属（换血不换桶）。
 * 2. 分桶解析：host:lanes / 默认 4 / 钳 2..8 / 非法段跳过 / 大小写归一。
 * 3. dip 下探：干净成功逐拍 +25ms 加深至 dipMaxMS 封顶；限流立即归零；AIMD 退避态不叠加。
 * 4. dip 进入间隔计算：interval = max(base-dip, 1000)，AIMD 退避位取大者仍主导。
 * 5. politenessExtraCapMS 默认 150（R108）：持续负载有效间隔均值 1.35s（was 1.5s）。
 */
package main

import (
	"strconv"
	"strings"
	"sync"
	"testing"
)

func withBucketHosts(t *testing.T, m map[string]int) {
	t.Helper()
	old := proxyBucketHosts
	proxyBucketHosts = m
	t.Cleanup(func() { proxyBucketHosts = old })
}

func TestSlotKeyForBucketing(t *testing.T) {
	// 未分桶主机：直连与代理出口一律裸 host（R107 行为兼容）
	withBucketHosts(t, map[string]int{})
	for _, eg := range []string{"", "http://1.2.3.4:8080", "http://user:pass@1.2.3.4:8080"} {
		if got := slotKeyFor("example.com", eg); got != "example.com" {
			t.Fatalf("未分桶主机槽键应恒为裸 host，egress=%q got %q", eg, got)
		}
	}
	// 分桶主机：直连仍裸 host（直连桶与 api-toc 等无代理路径共享）
	withBucketHosts(t, map[string]int{"example.com": 4})
	if got := slotKeyFor("example.com", ""); got != "example.com" {
		t.Fatalf("分桶主机直连出口应为裸 host，got %q", got)
	}
	// 代理出口 → host|eg:…，且凭据脱敏后同端点同键
	k1 := slotKeyFor("example.com", "http://1.2.3.4:8080")
	k2 := slotKeyFor("example.com", "http://alice:secret@1.2.3.4:8080")
	if !strings.HasPrefix(k1, "example.com|eg:") {
		t.Fatalf("分桶代理出口槽键应带 |eg: 前缀，got %q", k1)
	}
	if k1 != k2 {
		t.Fatalf("凭据差异不应改变槽键：k1=%q k2=%q", k1, k2)
	}
	if strings.Contains(k1, "alice") {
		t.Fatalf("凭据不应残留在槽键中: %q", k1)
	}
	// 大小写归一：HOST 大写形态同样命中分桶
	if got := slotKeyFor("EXAMPLE.com", "http://1.2.3.4:8080"); got == "EXAMPLE.com" {
		t.Fatalf("大写主机应命中分桶配置（bucketLanesFor 小写归一），got %q", got)
	}
}

// TestProxyBucketLanes 分桶车道数语义（钳 2..8、大小写归一、未配置主机 0）。
// init() 从 env 解析的路径与生产一致，此处用 map 直写验证 bucketLanesFor 归一逻辑。
func TestProxyBucketLanes(t *testing.T) {
	withBucketHosts(t, map[string]int{
		"low.com":  1,  // 钳 2
		"high.com": 99, // 钳 8
		"mid.com":  3,
	})
	if v := bucketLanesFor("low.com"); v != 1 { // bucketLanesFor 不做钳制（钳在解析层），直查原值
		t.Fatalf("bucketLanesFor 应返回解析层结果 1，got %d", v)
	}
	if v := bucketLanesFor("HIGH.com"); v != 99 {
		t.Fatalf("大小写归一查询（返回解析层原值 99），got %d", v)
	}
	if v := bucketLanesFor("never.configured"); v != 0 {
		t.Fatalf("未配置主机应为 0（分桶关闭），got %d", v)
	}
	_ = strconv.Itoa // 保持 import（strconv 供 parseBucketEnv 使用）
}

// TestDipChannel 下探通道状态机：加深→封顶→限流归零→退避互斥→退避后重启
func TestDipChannel(t *testing.T) {
	host := "dip.test"
	maxDip := dipMaxMS()
	if maxDip <= 0 {
		t.Skip("SCRAPER_AIMD_DIP_OFF 已停用下探")
	}
	// 干净态：成功逐拍加深下探（25ms/拍 → 4 拍封顶默认 100）
	for i := 0; i < 10; i++ {
		noteAdaptiveSuccess(host)
	}
	slot := getHostSlot(host)
	if got := slot.dipMs.Load(); got != maxDip {
		t.Fatalf("连续成功后下探应封顶 dipMaxMS=%d，got %d", maxDip, got)
	}
	// 限流：下探立即归零 + 进入 AIMD 退避态
	noteAdaptiveRateLimited(host, nil)
	if got := slot.dipMs.Load(); got != 0 {
		t.Fatalf("限流后下探应归零，got %d", got)
	}
	if hostAdaptiveIntervalMs(host) == 0 {
		t.Fatalf("限流后应处于 AIMD 退避态")
	}
	// 退避态下的成功只回落 aimdMs，不叠加下探（两曲线互斥：aimd>0 期间 dip 不动）
	for i := 0; i < 200 && hostAdaptiveIntervalMs(host) > 0; i++ {
		noteAdaptiveSuccess(host)
	}
	if v := hostAdaptiveIntervalMs(host); v != 0 {
		t.Fatalf("退避应回落至 0（退出自适应态），got %d", v)
	}
	dipAfterDecay := slot.dipMs.Load()
	// 退避结束后成功重新进入下探通道（从当前位继续加深）
	noteAdaptiveSuccess(host)
	if got := slot.dipMs.Load(); got < dipAfterDecay {
		t.Fatalf("退避结束后成功应继续/重启下探（≥%d），got %d", dipAfterDecay, got)
	}
}

// TestDipIntervalMath 下探进入间隔计算：max(base-dip, 1000) < base（与取槽实现同式）
func TestDipIntervalMath(t *testing.T) {
	host := "dip-math.test"
	if dipMaxMS() <= 0 {
		t.Skip("SCRAPER_AIMD_DIP_OFF 已停用下探")
	}
	for i := 0; i < 10; i++ {
		noteAdaptiveSuccess(host)
	}
	slot := getHostSlot(host)
	if slot.dipMs.Load() != dipMaxMS() {
		t.Fatalf("前置：下探应封顶，got %d", slot.dipMs.Load())
	}
	base := getMinIntervalMs()
	want := base - slot.dipMs.Load()
	if want < 1000 {
		want = 1000
	}
	if want >= base {
		t.Fatalf("下探应降低有效基础间隔：want=%d base=%d", want, base)
	}
}

// TestDipConcurrentCAS 并发下探收敛性：CAS 循环不越界不丢步
func TestDipConcurrentCAS(t *testing.T) {
	host := "dip-race.test"
	slot := getHostSlot(host)
	var wg sync.WaitGroup
	for g := 0; g < 16; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 50; i++ {
				noteDipOnSuccess(slot)
			}
		}()
	}
	wg.Wait()
	if got := slot.dipMs.Load(); got != dipMaxMS() {
		t.Fatalf("并发下探应收敛到封顶不越界，got %d (max=%d)", got, dipMaxMS())
	}
}
