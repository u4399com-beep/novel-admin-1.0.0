/**
 * 全局小工具：环境变量读取 / 睡眠 / 上下文包装。
 */
package main

import (
	"context"
	"log"
	"os"
	"os/exec"
	"time"
)

// execCommand 已删除（Task 46-a 清理：无调用点死代码；实际使用的是 execCommandContext）

// execCommandContext 包装 exec.CommandContext（ctx 超时自动 kill 子进程）
func execCommandContext(ctx context.Context, name string, args ...string) *exec.Cmd {
	return exec.CommandContext(ctx, name, args...)
}

func getenv(name string) string { return os.Getenv(name) }

// syncMutex 已删除（Task 49-a 精简：RWMutex 包装从未用到读锁，唯一使用点 ssrf.go dnsCacheMu
// 收敛为 sync.Mutex）

func sleepMs(ms int64) { time.Sleep(time.Duration(ms) * time.Millisecond) }

// contextWithTimeout 包装 context.WithTimeout
func contextWithTimeout(d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), d)
}

func nowMs() int64 { return time.Now().UnixMilli() }

var logger = log.New(os.Stderr, "[scraper-go] ", log.LstdFlags|log.Lmicroseconds)
