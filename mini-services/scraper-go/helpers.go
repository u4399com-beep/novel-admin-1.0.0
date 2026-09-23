/**
 * 全局小工具：环境变量读取 / 睡眠 / 同步类型别名。
 */
package main

import (
	"context"
	"log"
	"os"
	"os/exec"
	"sync"
	"time"
)

// execCommand 包装 exec.Command
func execCommand(name string, args ...string) *exec.Cmd { return exec.Command(name, args...) }

// execCommandContext 包装 exec.CommandContext（ctx 超时自动 kill 子进程）
func execCommandContext(ctx context.Context, name string, args ...string) *exec.Cmd {
	return exec.CommandContext(ctx, name, args...)
}

func getenv(name string) string { return os.Getenv(name) }

type syncMutex struct {
	sync.RWMutex
}

func (m *syncMutex) Lock()    { m.RWMutex.Lock() }
func (m *syncMutex) Unlock()  { m.RWMutex.Unlock() }
func (m *syncMutex) RLock()   { m.RWMutex.RLock() }
func (m *syncMutex) RUnlock() { m.RWMutex.RUnlock() }

func sleepMs(ms int64) { time.Sleep(time.Duration(ms) * time.Millisecond) }

// contextWithTimeout 包装 context.WithTimeout
func contextWithTimeout(d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), d)
}

func nowMs() int64 { return time.Now().UnixMilli() }

var logger = log.New(os.Stderr, "[scraper-go] ", log.LstdFlags|log.Lmicroseconds)
