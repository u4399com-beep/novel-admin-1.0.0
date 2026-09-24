/**
 * backend-go —— 有界并发池（采集两阶段共用）：固定车道数循环取件，绝不无界 goroutine 扇出。
 *
 * TS 源：src/lib/scrape/pool.ts（runPool / throttledCheck 逐行移植）
 *
 * 移植差异：
 * - TS 单线程事件循环使 next/processed/stoppedEarly 天然无竞态；Go 侧显式加互斥锁
 * - 单件 worker panic 用 recover 兜底（记日志不中止整个池）——TS 版 worker 抛错会 reject
 *   整个 runPool，Go 版更稳；任务级致命错误由调用方经 phase1.Fatal 通道显式传递
 * - shouldStop 协作式停止（任务取消）：每个车道取下一件前检查，命中即提前收工
 */
package main

import (
	"log"
	"sync"
	"time"
)

// poolOutcome 池执行结果
type poolOutcome struct {
	processed    int
	stoppedEarly bool
}

// ==================== Task 31-b: 车道感知自适应并发（限流站降档/回开） ====================

// laneShrinkStep 收缩步进纯函数（表驱动测试见 pool_lane_test.go）：
// >4 车道 → 降到 4；≤4 且 >2 → 降到 2；已在 2 保持（任务书 12→4→2）。
func laneShrinkStep(cur int64) int64 {
	if cur > 4 {
		return 4
	}
	if cur > 2 {
		return 2
	}
	return 2
}

// laneRestoreStep 回升步进纯函数：每次 +2，封顶 max（成功恢复后缓慢回升，绝不超配置上限）。
func laneRestoreStep(cur, max int64) int64 {
	if cur >= max {
		return max
	}
	next := cur + 2
	if next > max {
		next = max
	}
	return next
}

// laneLimiter 动态车道闸：active 车道数受 limit 实时约束——
// limit 收缩时不杀在途 goroutine（尊重正在抓取的章节），新取件在 acquire 处排队等待；
// limit 回升时 setLimit 广播唤醒排队车道。phase2Fill 用它替代固定 runPool 实现限流降档。
type laneLimiter struct {
	mu     sync.Mutex
	cond   *sync.Cond
	active int
	limit  int
	max    int
}

func newLaneLimiter(max int) *laneLimiter {
	if max < 1 {
		max = 1
	}
	l := &laneLimiter{limit: max, max: max}
	l.cond = sync.NewCond(&l.mu)
	return l
}

// acquire 取一条车道。返回 false = 应停止（shouldStop 命中/任务收尾）。
// stopped 回调在锁内调用：throttledCheck 自带互斥与 250ms 节流，锁序无环
// （limiter.mu → throttledCheck.mu，反向不存在），与 runPool 的 shouldStop 同口径。
// stop 判定优先于车道放行（等待者被 setLimit 广播唤醒后能立即退出，不悬挂）。
func (l *laneLimiter) acquire(stopped func() bool) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	for {
		if stopped != nil && stopped() {
			return false
		}
		if l.active < l.limit {
			l.active++
			return true
		}
		l.cond.Wait()
	}
}

// release 归还车道并唤醒一个等待者
func (l *laneLimiter) release() {
	l.mu.Lock()
	l.active--
	l.cond.Signal()
	l.mu.Unlock()
}

// setLimit 调整活跃车道上限（唤醒全部等待者重新竞争/退出）
func (l *laneLimiter) setLimit(n int) {
	if n < 1 {
		n = 1
	}
	if n > l.max {
		n = l.max
	}
	l.mu.Lock()
	l.limit = n
	l.cond.Broadcast()
	l.mu.Unlock()
}

// kick 唤醒全部等待者复检退出条件（Task 31 收编修复：shouldStop 外部翻转——任务取消/
// 熔断触发——发生在全部车道都在 cond.Wait 时，无人 release→无人 Signal→永挂死锁；
// runPoolDynamic 的 watchdog 周期 kick 让等待者醒来重查 stopped() 后正常退出）
func (l *laneLimiter) kick() {
	l.mu.Lock()
	l.cond.Broadcast()
	l.mu.Unlock()
}

// limitVal 当前车道上限快照（观测用）
func (l *laneLimiter) limitVal() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.limit
}

// runPoolDynamic 动态车道并发池：maxLanes 个常驻 goroutine，每件工作前先经 laneLimiter
// 取车道（活跃并发 ≤ limit 实时值），取件/shouldStop 语义与 runPool 一致。
// Task 31-b: phase2Fill 限流降档（12→4→2）与成功回开（+2/档）的执行底座。
func runPoolDynamic[T any](items []T, limiter *laneLimiter, worker func(item T, index int), shouldStop func() bool) poolOutcome {
	if len(items) == 0 {
		return poolOutcome{}
	}
	var mu sync.Mutex
	next := 0
	processed := 0
	stoppedEarly := false

	// Task 31 收编修复：watchdog 周期 kick——车道全在 Wait 时 shouldStop 外部翻转
	// （cancel/熔断）无活跃车道 release，cond.Signal 无人发出 → 死锁；watchdog 广播
	// 让等待者复检 stopped() 退出。100ms 轮询成本可忽略（唤醒后空转一拍即退）。
	stopKick := make(chan struct{})
	var kickWG sync.WaitGroup
	kickWG.Add(1)
	go func() {
		defer kickWG.Done()
		t := time.NewTicker(100 * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-stopKick:
				return
			case <-t.C:
				limiter.kick()
			}
		}
	}()

	var wg sync.WaitGroup
	for lane := 0; lane < limiter.max; lane++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				if !limiter.acquire(shouldStop) {
					mu.Lock()
					stoppedEarly = true
					mu.Unlock()
					return
				}
				mu.Lock()
				if stoppedEarly || (shouldStop != nil && shouldStop()) {
					stoppedEarly = true
					mu.Unlock()
					limiter.release()
					return
				}
				i := next
				next++
				mu.Unlock()
				if i >= len(items) {
					limiter.release()
					return
				}
				func() {
					defer limiter.release()
					defer func() {
						if r := recover(); r != nil {
							log.Printf("[scrape-worker] pool worker panic (item #%d): %v", i, r)
						}
					}()
					worker(items[i], i)
				}()
				mu.Lock()
				processed++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	close(stopKick) // Task 31: 收 watchdog
	kickWG.Wait()

	mu.Lock()
	defer mu.Unlock()
	return poolOutcome{processed: processed, stoppedEarly: stoppedEarly}
}

// runPool 有界并发池：lanes = max(1, min(limit, len(items)))
func runPool[T any](items []T, limit int, worker func(item T, index int), shouldStop func() bool) poolOutcome {
	if len(items) == 0 {
		return poolOutcome{}
	}
	lanes := limit
	if lanes > len(items) {
		lanes = len(items)
	}
	if lanes < 1 {
		lanes = 1
	}

	var mu sync.Mutex
	next := 0
	processed := 0
	stoppedEarly := false

	var wg sync.WaitGroup
	for lane := 0; lane < lanes; lane++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				mu.Lock()
				if stoppedEarly {
					mu.Unlock()
					return
				}
				if shouldStop != nil && shouldStop() {
					stoppedEarly = true
					mu.Unlock()
					return
				}
				i := next
				next++
				mu.Unlock()
				if i >= len(items) {
					return
				}
				func() {
					defer func() {
						if r := recover(); r != nil {
							log.Printf("[scrape-worker] pool worker panic (item #%d): %v", i, r)
						}
					}()
					worker(items[i], i)
				}()
				mu.Lock()
				processed++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()

	mu.Lock()
	defer mu.Unlock()
	return poolOutcome{processed: processed, stoppedEarly: stoppedEarly}
}

// throttledCheck 高频取消检查节流包装：limit 并发下逐件查 DB 会放大查询量，
// 包装后至多每 intervalMs（默认 250）做一次真实检查，其余命中缓存结果。
// TS 单线程共享闭包变量；Go 加锁保护（检查期间持锁，天然防重复并发检查）。
func throttledCheck(check func() bool, intervalMs ...int) func() bool {
	interval := 250
	if len(intervalMs) > 0 && intervalMs[0] > 0 {
		interval = intervalMs[0]
	}
	var mu sync.Mutex
	lastAt := int64(0)
	lastVal := false
	return func() bool {
		mu.Lock()
		defer mu.Unlock()
		now := nowMillis()
		if now-lastAt < int64(interval) {
			return lastVal
		}
		lastAt = now
		lastVal = check()
		return lastVal
	}
}
