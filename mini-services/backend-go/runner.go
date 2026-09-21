/**
 * backend-go —— 采集编排 runner（逐行移植 scripts/worker-runner.ts）。
 *
 * 职责：
 * - 启动时僵尸任务回收（worker.recoverStaleTasks：把本进程启动前仍 pending/running 的任务标 failed）
 * - 每 2s 轮询 status=pending 的 ScrapeTask → triggerScrapeTask（worker 内 running Set 防重）
 * - 每轮刷新心跳文件 /tmp/scrape-runner-heartbeat（scrape API 判断 runner 存活的依据，路径不变）
 * - 每 15 轮（≈30s）探测引擎 127.0.0.1:3030/api/strategies；不可达则拉起 scraper-go
 *   （互监护：Go 版拉起对象是 scraper-go 二进制；pkill 用 [g] 字符类防自匹配——修复 TS 版
 *    pkill 与 spawn 同串导致自杀的 bug，见 worklog Task 13）
 * - 未分类书慢速 LLM 归类：每轮最多 1 本（llmChat 冷却窗自适应），不阻塞采集轮询
 */
package main

import (
	"database/sql"
	"log"
	"net/http"
	"os"
	osexec "os/exec"
	"time"
)

const (
	runnerHeartbeatFile = "/tmp/scrape-runner-heartbeat"
	runnerPollInterval  = 2 * time.Second
	runnerEngineEvery   = 15
	engineBaseURL       = "http://127.0.0.1:3030"
)

var runnerHTTPClient = &http.Client{Timeout: 8 * time.Second}

// recategorizeOne 未分类书慢速归类（每轮 0-1 本）。返回是否处理了一本。
func recategorizeOne() bool {
	var bookID int
	var title, description string
	err := queryOne(
		`SELECT n.id, n.title, n.description FROM Novel n
                 JOIN Category c ON n.categoryId = c.id
                 WHERE c.name = ? ORDER BY n.id LIMIT 1`,
		[]any{&bookID, &title, &description},
		FALLBACK_CATEGORY,
	)
	if err != nil {
		return false // 未分类类不存在或无书
	}
	canon := canonicalCategoryWithHint("", title, description)
	if canon == FALLBACK_CATEGORY || canon == "" {
		return false // LLM 冷却中/推断未果：本轮跳过
	}
	// 分类 upsert（唯一冲突回读）
	var catID int64
	rowErr := queryOne(`SELECT id FROM Category WHERE name = ?`, []any{&catID}, canon)
	if rowErr != nil {
		id, insErr := execReturningID(
			`INSERT INTO Category (name, sort, createdAt, updatedAt) VALUES (?, 0, ?, ?)`,
			canon, nowMillis(), nowMillis(),
		)
		if insErr != nil {
			// 并发竞态：回读
			if rErr := queryOne(`SELECT id FROM Category WHERE name = ?`, []any{&catID}, canon); rErr != nil {
				return false
			}
		} else {
			catID = id
		}
	}
	if _, err := exec(`UPDATE Novel SET categoryId = ?, updatedAt = ? WHERE id = ?`, catID, nowMillis(), bookID); err != nil {
		return false
	}
	log.Printf("[backend-go-runner] recategorize 《%s》→ %s", truncateRunes(title, 24), canon)
	return true
}

// ensureEngine 引擎互监护：不可达则杀残留后 setsid 完全托孤拉起 scraper-go
func ensureEngine() {
	resp, err := runnerHTTPClient.Get(engineBaseURL + "/api/strategies")
	if err == nil {
		_ = resp.Body.Close()
		if resp.StatusCode >= 200 && resp.StatusCode < 500 {
			return // 引擎存活（40x 也说明进程在）
		}
	}
	log.Println("[backend-go-runner] engine 不可达，重新拉起")
	// 两步走：先 pkill（[g] 防自匹配），再 setsid 托孤拉起（Task 13 教训：pkill 与 spawn
	// 放同一 bash -c 时 pkill -f 会匹配到自身命令行导致自杀）
	_ = runBash("pkill -f 'scraper-[g]o.bin' 2>/dev/null; sleep 0.3; true")
	_ = runBash("cd /home/z/my-project/mini-services/scraper-go && setsid nohup ./scraper-go.bin >> /tmp/engine.log 2>&1 < /dev/null &")
}

// runBash 执行一条 bash 命令（不等待长任务；失败仅忽略）
func runBash(cmd string) error {
	c := osexec.Command("bash", "-c", cmd)
	c.Stdin = nil
	c.Stdout = nil
	c.Stderr = nil
	return c.Start()
}

// startRunner runner 主循环入口（main.go 在 runner/all 模式下 go 调用）
func startRunner() {
	log.Printf("[backend-go-runner] started (polling pending tasks every %s)", runnerPollInterval)

	// 僵尸任务回收（worker.ts recoverStaleTasks 语义：Go runner 是唯一任务执行方，
	// 启动时把遗留 pending/running 一次性标 failed）
	recoverStaleTasks()

	tick := 0
	for {
		func() {
			defer func() {
				if r := recover(); r != nil {
					log.Printf("[backend-go-runner] poll panic(已恢复): %v", r)
				}
			}()
			// 心跳：mtime 每轮刷新
			now := time.Now()
			if _, err := os.Stat(runnerHeartbeatFile); err == nil {
				_ = os.Chtimes(runnerHeartbeatFile, now, now)
			} else {
				if f, err := os.Create(runnerHeartbeatFile); err == nil {
					_ = f.Close()
				}
			}

			if tick%runnerEngineEvery == 0 {
				ensureEngine()
			}

			// 轮询 pending 任务
			var ids []int
			err := queryList(`SELECT id FROM ScrapeTask WHERE status = 'pending' ORDER BY id ASC LIMIT 5`,
				func(rows *sql.Rows) error {
					var id int
					if err := rows.Scan(&id); err != nil {
						return err
					}
					ids = append(ids, id)
					return nil
				})
			if err != nil {
				log.Printf("[backend-go-runner] poll error: %v", err)
			} else {
				for _, id := range ids {
					triggerScrapeTask(id)
				}
				if len(ids) > 0 {
					log.Printf("[backend-go-runner] dispatched %d task(s)", len(ids))
				}
			}

			// 未分类慢速归类（0-1 本/轮）
			_ = recategorizeOne()
		}()
		tick++
		time.Sleep(runnerPollInterval)
	}
}
