/**
 * backend-go —— 任务运行日志与进度写回。
 *
 * TS 源：src/lib/scrape/run-log.ts（Run 类逐行移植）
 *
 * 移植差异：
 * - TS Run 实例被并发车道共享（单线程安全）；Go 显式加互斥锁保护 lines/counters
 * - flush 用 UPDATE ScrapeTask SET log=?, ... WHERE id=?；SQLite 无 Prisma P2025，
 *   「任务记录被删除返回 false」改用 RowsAffected==0 判定（语义等价）
 * - 其他错误（如 SQLite 瞬时锁）：execRetry 内 200ms 退避重试一次，仍失败不视为删除——
 *   日志行留驻内存，由下一次成功的 flush 一并落盘（与 TS 哲学一致）
 * - MAX_LOG_LINES=100 滚动、MAX_WARNINGS_LOGGED=3、单行 500 字截断，全部对齐
 */
package main

import (
	"database/sql"
	"strings"
	"sync"
	"time"
)

const (
	MAX_LOG_LINES       = 100
	MAX_WARNINGS_LOGGED = 3
)

// runTs 本地时间 HH:MM:SS（对齐 TS toTimeString().slice(0, 8)）
func runTs() string {
	return time.Now().Format("15:04:05")
}

// Run 单个采集任务的日志缓冲与成果计数（跨多本书累积）
type Run struct {
	TaskID int

	mu       sync.Mutex
	lines    []string
	created  int
	updated  int
	chapters int
}

// NewRun 构造（对应 TS new Run(taskId)）
func NewRun(taskID int) *Run { return &Run{TaskID: taskID} }

// Log 追加一行带时间戳日志（单行 500 字截断 + 100 行滚动）
func (r *Run) Log(msg string) {
	line := truncateRunes("["+runTs()+"] "+msg, 500)
	r.mu.Lock()
	r.lines = append(r.lines, line)
	if len(r.lines) > MAX_LOG_LINES {
		r.lines = append([]string(nil), r.lines[len(r.lines)-MAX_LOG_LINES:]...)
	}
	r.mu.Unlock()
}

// LogWarnings 记录引擎提示（最多 MAX_WARNINGS_LOGGED 条）
func (r *Run) LogWarnings(warnings []string) {
	n := len(warnings)
	if n > MAX_WARNINGS_LOGGED {
		n = MAX_WARNINGS_LOGGED
	}
	for i := 0; i < n; i++ {
		r.Log("引擎提示: " + truncateRunes(warnings[i], 200))
	}
}

// LogText 全部日志行（\n 连接）
func (r *Run) LogText() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return strings.Join(r.lines, "\n")
}

// IncCreated 新建书籍计数 +1（并发车道调用）
func (r *Run) IncCreated() { r.mu.Lock(); r.created++; r.mu.Unlock() }

// IncUpdated 更新书籍计数 +1（并发车道调用）
func (r *Run) IncUpdated() { r.mu.Lock(); r.updated++; r.mu.Unlock() }

// IncChapters 采集章节数 +1（并发车道调用）
func (r *Run) IncChapters() { r.mu.Lock(); r.chapters++; r.mu.Unlock() }

// Snapshot 读取任务级成果计数
func (r *Run) Snapshot() (created, updated, chapters int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.created, r.updated, r.chapters
}

// rowCountOf 读取受影响行数（0 = WHERE 目标不存在 → P2025 语义）
func rowCountOf(res sql.Result) int64 {
	if res == nil {
		return 0
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0
	}
	return n
}

// Flush 写回日志与进度字段；任务记录被删除时返回 false（调用方应停止执行）。
// 与 isCanceled 的 fail-open 哲学一致：仅「目标行不存在」才判定已删除；
// 其他错误（如 SQLite 瞬时锁）由 execRetry 短暂退避后重试一次，仍失败不视为删除。
// Task 26-d：显式触碰 updatedAt（TS 版 Prisma @updatedAt 自动维护；Go 裸 SQL 需手动，
// 否则列表页「更新时间」对长跑任务永远冻结在创建时刻）。
func (r *Run) Flush(extra *TaskFlushFields) bool {
	sets := []string{"log = ?", "updatedAt = ?"}
	args := []any{r.LogText(), nowMillis()}
	if extra != nil {
		if extra.Done != nil {
			sets = append(sets, "done = ?")
			args = append(args, *extra.Done)
		}
		if extra.Total != nil {
			sets = append(sets, "total = ?")
			args = append(args, *extra.Total)
		}
		if extra.ChaptersDone != nil {
			sets = append(sets, "chaptersDone = ?")
			args = append(args, *extra.ChaptersDone)
		}
		if extra.ChaptersTotal != nil {
			sets = append(sets, "chaptersTotal = ?")
			args = append(args, *extra.ChaptersTotal)
		}
		if extra.Created != nil {
			sets = append(sets, "created = ?")
			args = append(args, *extra.Created)
		}
		if extra.Updated != nil {
			sets = append(sets, "updated = ?")
			args = append(args, *extra.Updated)
		}
		if extra.Chapters != nil {
			sets = append(sets, "chapters = ?")
			args = append(args, *extra.Chapters)
		}
	}
	args = append(args, r.TaskID)
	res, err := execRetry("UPDATE ScrapeTask SET "+strings.Join(sets, ", ")+" WHERE id = ?", args...)
	if err != nil {
		// 非 P2025 类错误（SQLite 无该码）：乐观返回 true，日志行留驻内存等待下次 flush
		return true
	}
	return rowCountOf(res) > 0
}
