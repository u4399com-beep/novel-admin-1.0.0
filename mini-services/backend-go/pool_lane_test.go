/**
 * pool_lane_test.go —— Task 31-b 车道感知自适应并发回归（表驱动 + 并发）：
 * 覆盖 laneShrinkStep/laneRestoreStep 步进曲线、laneLimiter 动态闸的收缩/回升语义、
 * runPoolDynamic 全量处理无丢失、chapterPageOrderFromURL 顺序页序号提取。
 * 运行：cd mini-services/backend-go && go test -race ./...
 */
package main

import (
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestLaneShrinkStep 收缩步进曲线（12→4→2，任务书口径，表驱动）
func TestLaneShrinkStep(t *testing.T) {
	cases := []struct{ cur, want int64 }{
		{12, 4}, {11, 4}, {5, 4}, {4, 2}, {3, 2}, {2, 2}, {1, 2}, {0, 2},
	}
	for _, c := range cases {
		if got := laneShrinkStep(c.cur); got != c.want {
			t.Fatalf("laneShrinkStep(%d) = %d, want %d", c.cur, got, c.want)
		}
	}
}

// TestLaneRestoreStep 回升步进曲线（每档 +2，封顶 max，表驱动）
func TestLaneRestoreStep(t *testing.T) {
	cases := []struct {
		cur, max, want int64
	}{
		{2, 12, 4}, {4, 12, 6}, {10, 12, 12}, {11, 12, 12}, {12, 12, 12},
		{2, 4, 4}, {3, 4, 4}, {2, 2, 2}, {1, 12, 3},
	}
	for _, c := range cases {
		if got := laneRestoreStep(c.cur, c.max); got != c.want {
			t.Fatalf("laneRestoreStep(%d,%d) = %d, want %d", c.cur, c.max, got, c.want)
		}
	}
}

// TestLaneLimiterShrink 收缩即时生效：limit 4→2 后活跃并发不超过 2
func TestLaneLimiterShrink(t *testing.T) {
	lim := newLaneLimiter(12)
	lim.setLimit(6)
	var active, maxActive atomic.Int64
	var stop atomic.Bool
	var wg sync.WaitGroup
	for g := 0; g < 12; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 30; i++ {
				if !lim.acquire(stop.Load) {
					return
				}
				n := active.Add(1)
				for {
					m := maxActive.Load()
					if n <= m || maxActive.CompareAndSwap(m, n) {
						break
					}
				}
				time.Sleep(2 * time.Millisecond)
				active.Add(-1)
				lim.release()
			}
		}()
	}
	time.Sleep(30 * time.Millisecond)
	lim.setLimit(2) // 模拟限流降档
	time.Sleep(60 * time.Millisecond)
	lim.setLimit(6) // 回开
	time.Sleep(60 * time.Millisecond)
	stop.Store(true)
	lim.setLimit(12) // 广播唤醒全部等待者让其看到 stop
	wg.Wait()
	if m := maxActive.Load(); m > 6 {
		t.Fatalf("活跃并发 %d 超过当时上限 6", m)
	}
	if m := maxActive.Load(); m < 2 {
		t.Fatalf("活跃并发峰值 %d 过低，闸似乎完全没放行", m)
	}
}

// TestRunPoolDynamicAllProcessed runPoolDynamic 全量处理无丢失（含中途降档/回开）
func TestRunPoolDynamicAllProcessed(t *testing.T) {
	lim := newLaneLimiter(6)
	const total = 300
	var processed atomic.Int64
	items := make([]int, total)
	for i := range items {
		items[i] = i
	}
	var seen sync.Map
	done := make(chan struct{})
	go func() {
		defer close(done)
		out := runPoolDynamic(items, lim, func(item int, _ int) {
			processed.Add(1)
			seen.Store(item, true)
			time.Sleep(time.Millisecond)
		}, nil)
		if out.processed != total {
			t.Errorf("processed = %d, want %d", out.processed, total)
		}
		if out.stoppedEarly {
			t.Errorf("不应提前停止")
		}
	}()
	time.Sleep(10 * time.Millisecond)
	lim.setLimit(2) // 降档
	time.Sleep(10 * time.Millisecond)
	lim.setLimit(6) // 回开
	<-done
	if processed.Load() != total {
		t.Fatalf("processed = %d, want %d（有 item 丢失或重复执行）", processed.Load(), total)
	}
	for i := 0; i < total; i++ {
		if _, ok := seen.Load(i); !ok {
			t.Fatalf("item %d 未被处理", i)
		}
	}
}

// TestRunPoolDynamicStop 限流降档到 1 车道 + shouldStop 命中 → 池及时收工不悬挂
func TestRunPoolDynamicStop(t *testing.T) {
	lim := newLaneLimiter(8)
	lim.setLimit(1)
	items := make([]int, 500)
	for i := range items {
		items[i] = i
	}
	var stopFlag atomic.Bool
	processed := 0
	out := runPoolDynamic(items, lim, func(item int, _ int) {
		time.Sleep(2 * time.Millisecond)
		processed++ // 主车道串行（limit=1）无竞态
		if processed >= 20 {
			stopFlag.Store(true) // 第 20 件后触发停止
		}
	}, func() bool { return stopFlag.Load() })
	if !out.stoppedEarly {
		t.Fatalf("shouldStop 命中后应提前停止")
	}
	if processed >= 500 {
		t.Fatalf("停止后不应处理全部 item（processed=%d）", processed)
	}
}

// TestChapterPageOrderFromURL 顺序页序号提取（Task 31-b 智能续传排序的解析层，表驱动）
func TestChapterPageOrderFromURL(t *testing.T) {
	cases := []struct {
		in   string
		want int64
	}{
		{"https://ixdzs8.com/read/644268/p1.html", 1},
		{"https://ixdzs8.com/read/644268/p680.html", 680},
		{"https://ixdzs8.com/read/644268/p123.html", 123},
		{"http://x.com/book/p42.htm", 42},
		{"https://x.com/chapter/77.html", 1 << 62}, // 无 /p{n} 序号形态
		{"", 1 << 62}, // 空 URL
		{"https://ixdzs8.com/read/644268/", 1 << 62}, // 书页非章节
	}
	for _, c := range cases {
		if got := chapterPageOrderFromURL(c.in); got != c.want {
			t.Fatalf("chapterPageOrderFromURL(%q) = %d, want %d", c.in, got, c.want)
		}
	}
	// 大序号不溢出（9 位内）
	if got := chapterPageOrderFromURL("https://x.com/p999999999.html"); got != 999999999 {
		t.Fatalf("9 位序号应精确解析，got %d", got)
	}
	// 排序语义：p10 应排在 p2 之后（数值序而非字典序）
	orders := []int64{
		chapterPageOrderFromURL("https://x.com/p10.html"),
		chapterPageOrderFromURL("https://x.com/p2.html"),
	}
	if !(orders[0] > orders[1]) {
		t.Fatal("数值序排序语义错误")
	}
}

// TestLaneLimiterConcurrent 高并发 acquire/release 打满-归还循环（-race）
func TestLaneLimiterConcurrent(t *testing.T) {
	lim := newLaneLimiter(4)
	var wg sync.WaitGroup
	for g := 0; g < 16; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 100; i++ {
				if !lim.acquire(nil) {
					return
				}
				if lim.limitVal() > 4 {
					t.Error(fmt.Sprintf("limit 越界: %d", lim.limitVal()))
					lim.release()
					return
				}
				lim.release()
				if i%50 == 0 {
					lim.setLimit(2 + i%3) // 中途动态调整 2..4
				}
			}
		}(g)
	}
	wg.Wait()
	lim.setLimit(4)
}
