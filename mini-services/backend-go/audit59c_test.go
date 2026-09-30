package main

// audit59c_test.go —— Task 59-R3 LLM 429 重试风暴根修测试。
//
// 病灶：固定 30s 冷却无退避升级，上游限流未恢复时每到冷却期即重试再 429，
// 生产实证 30s 周期无限循环。锁定：指数退避序列 30s→60s→…→600s 封顶、
// 成功归零恢复基础窗、shift 溢出安全。
import (
	"testing"
	"time"
)

func TestLLMBackoffEscalation(t *testing.T) {
	// 归位全局态（测试隔离）
	coolMu.Lock()
	llmFailStreak = 0
	cooldownAt = 0
	coolMu.Unlock()
	t.Cleanup(func() {
		coolMu.Lock()
		llmFailStreak = 0
		cooldownAt = 0
		coolMu.Unlock()
	})

	wantBackoffs := []int64{30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000, 600_000}
	for i, want := range wantBackoffs {
		llmMarkCooldown()
		coolMu.Lock()
		remaining := cooldownAt - time.Now().UnixMilli()
		coolMu.Unlock()
		// 允许 2s 时钟抖动（测试进程调度）
		if remaining < want-2_000 || remaining > want {
			t.Fatalf("第%d次失败退避应≈%dms: got %dms", i+1, want, remaining)
		}
	}

	llmMarkSuccess()
	llmMarkCooldown()
	coolMu.Lock()
	remaining := cooldownAt - time.Now().UnixMilli()
	coolMu.Unlock()
	if remaining < 28_000 || remaining > 30_000 {
		t.Fatalf("成功归零后应恢复基础窗 30s: got %dms", remaining)
	}
}
