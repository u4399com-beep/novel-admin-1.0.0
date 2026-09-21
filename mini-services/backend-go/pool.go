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
)

// poolOutcome 池执行结果
type poolOutcome struct {
	processed    int
	stoppedEarly bool
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
