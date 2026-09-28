/**
 * 全局小工具：环境变量读取 / 睡眠 / 上下文包装。
 */
package main

import (
	"context"
	"log"
	"os"
	"os/exec"
	"strings"
	"time"
)

// execCommand 已删除（Task 46-a 清理：无调用点死代码；实际使用的是 execCommandContext）

// execCommandContext 包装 exec.CommandContext（ctx 超时自动 kill 子进程）
func execCommandContext(ctx context.Context, name string, args ...string) *exec.Cmd {
	return exec.CommandContext(ctx, name, args...)
}

// execErrDetail Task 56-a（P4·子进程失败排障信息透出）：cmd.Output() 把子进程 stderr
// （--show-error 的 "curl: (7) Failed to connect ..." / python traceback 等人读错误）
// 挂到 *exec.ExitError.Stderr，旧实现只透出 execErr.Error() 的裸 "exit status N"——
// 连接层失败原因（DNS 失败/连接拒绝/TLS 握手失败/超时）整条丢失，attempts 明细排障失真。
// stderr 为空（信号 kill/非 ExitError）时回退 Error()；截断 300 字符防异常超长刷屏。
func execErrDetail(execErr error) string {
	if ee, ok := execErr.(*exec.ExitError); ok && len(ee.Stderr) > 0 {
		if s := strings.TrimSpace(string(ee.Stderr)); s != "" {
			return truncateStr(s, 300)
		}
	}
	return execErr.Error()
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
