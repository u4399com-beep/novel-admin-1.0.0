/**
 * aimd_test.go —— Task 31-b AIMD 自适应限速回归（表驱动 + 并发）：
 * 覆盖 aimdMulStep/aimdAddStep 纯函数曲线、noteAdaptiveRateLimited/noteAdaptiveSuccess
 * 状态机（乘性增大/Retry-After 直接采纳/加性回落/退出自适应态）与并发安全（-race）。
 * 运行：cd mini-services/scraper-go && go test -race ./...
 */
package main

import (
	"fmt"
	"sync"
	"testing"
)

// TestAimdMulStep 乘性增大曲线：×1.5、上界 8s、下限不低于基础礼貌间隔（表驱动）
func TestAimdMulStep(t *testing.T) {
	cases := []struct {
		name  string
		cur   int64
		floor int64
		want  int64
	}{
		{"首次限流自基础间隔起放大", 0, 1200, 1800},
		{"基础间隔精确值", 1200, 1200, 1800},
		{"连败继续放大", 1800, 1200, 2700},
		{"普通值放大", 2000, 1200, 3000},
		{"奇数截断", 5333, 1200, 7999},
		{"上界钳制", 6000, 1200, 8000},
		{"已在上界保持", 8000, 1200, 8000},
		{"自定义基础间隔下限", 0, 1000, 1500},
		{"cur 低于 floor 先抬到 floor", 999, 1000, 1500},
	}
	for _, c := range cases {
		if got := aimdMulStep(c.cur, c.floor); got != c.want {
			t.Fatalf("%s: aimdMulStep(%d,%d) = %d, want %d", c.name, c.cur, c.floor, got, c.want)
		}
	}
}

// TestAimdAddStep 加性回落曲线：每次 -50ms、下限基础间隔、不越回落后为 floor（表驱动）
func TestAimdAddStep(t *testing.T) {
	cases := []struct {
		name  string
		cur   int64
		floor int64
		want  int64
	}{
		{"普通回落", 1800, 1200, 1750},
		{"接近下限钳到 floor", 1250, 1200, 1200},
		{"略高于 floor", 1220, 1200, 1200},
		{"已在 floor", 1200, 1200, 1200},
		{"低于 floor 拉回 floor", 1000, 1200, 1200},
		{"上界附近正常回落", 8000, 1200, 7950},
	}
	for _, c := range cases {
		if got := aimdAddStep(c.cur, c.floor); got != c.want {
			t.Fatalf("%s: aimdAddStep(%d,%d) = %d, want %d", c.name, c.cur, c.floor, got, c.want)
		}
	}
}

// TestAimdStateMachine 自适应态状态机：增大→采纳 Retry-After→回落→退出自适应态
func TestAimdStateMachine(t *testing.T) {
	host := "aimd-sm.test"
	floor := getMinIntervalMs()

	// 初始：未进入自适应态
	if v := hostAdaptiveIntervalMs(host); v != 0 {
		t.Fatalf("新 host 自适应间隔应为 0，got %d", v)
	}
	// 未进入自适应态时成功不应产生状态
	noteAdaptiveSuccess(host)
	if v := hostAdaptiveIntervalMs(host); v != 0 {
		t.Fatalf("无自适应态时成功不应写入间隔，got %d", v)
	}

	// 乘性增大：0→1800→2700
	noteAdaptiveRateLimited(host, nil)
	if v := hostAdaptiveIntervalMs(host); v != aimdMulStep(0, floor) {
		t.Fatalf("首次限流后应 ×1.5，got %d", v)
	}
	noteAdaptiveRateLimited(host, nil)
	if v := hostAdaptiveIntervalMs(host); v != aimdMulStep(aimdMulStep(0, floor), floor) {
		t.Fatalf("二次限流后应再 ×1.5，got %d", v)
	}

	// Retry-After 直接采纳（低于基础间隔时抬到基础间隔，且不高于既有自适应值）
	small := int64(500)
	noteAdaptiveRateLimited(host, &small)
	if v := hostAdaptiveIntervalMs(host); v < floor || v < aimdMulStep(aimdMulStep(0, floor), floor) {
		t.Fatalf("小 Retry-After 不应拉低既有自适应位，got %d (floor=%d)", v, floor)
	}
	// Retry-After 直接采纳（大值）
	big := int64(5000)
	noteAdaptiveRateLimited(host, &big)
	if v := hostAdaptiveIntervalMs(host); v != 5000 {
		t.Fatalf("Retry-After=5s 应直接采纳，got %d", v)
	}

	// 加性回落：每次成功 -50ms，到达基础间隔后退出自适应态（归 0）
	// Task 31-d 编译修复：v 作用域止于上一个 if（:= 短声明），此处应为 big（=5000，已断言采纳）
	cur := big
	steps := 0
	for cur > floor {
		noteAdaptiveSuccess(host)
		cur = hostAdaptiveIntervalMs(host)
		steps++
		if steps > 200 {
			t.Fatalf("回落未收敛：cur=%d", cur)
		}
	}
	// 恰好在 floor 处退出自适应态（下一拍归 0）
	noteAdaptiveSuccess(host)
	if v := hostAdaptiveIntervalMs(host); v != 0 {
		t.Fatalf("回到基础间隔后应退出自适应态（0），got %d", v)
	}
	if steps != int(5000-floor)/int(aimdDecayStepMS) {
		t.Fatalf("回落步数不符：steps=%d（从 5000 到 %d，每次 -%d）", steps, floor, aimdDecayStepMS)
	}
}

// TestAimdConcurrent 限流/成功信号并发打在同一主机槽位（-race 下验证原子字段无竞争）。
// Task 31 收编修复：不调用 acquireDomainSlot——它对真实时间睡眠（AIMD 间隔最高 8s），
// 8×300 次会把测试拖到数十分钟"假死"；并发安全面在 note*/读快照原子字段上即可验证。
func TestAimdConcurrent(t *testing.T) {
	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			host := fmt.Sprintf("aimd-race-%d.test", g%2)
			ra := int64(2000)
			for i := 0; i < 300; i++ {
				if i%3 == 0 {
					noteAdaptiveRateLimited(host, &ra)
				} else if i%3 == 1 {
					noteAdaptiveRateLimited(host, nil)
				} else {
					noteAdaptiveSuccess(host)
				}
				_ = hostAdaptiveIntervalMs(host)
				_ = snapshotAdaptiveIntervals()
			}
		}(g)
	}
	wg.Wait()
}
