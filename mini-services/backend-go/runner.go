/**
 * backend-go —— 采集编排 runner（逐行移植 scripts/worker-runner.ts）。
 *
 * 职责：
 * - 启动时僵尸任务回收（worker.recoverStaleTasks：把本进程启动前仍 running 的任务转 paused
 *   可恢复续传，进度保留——非 failed，Task 27-c 注释纠偏）
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
	// runnerTSKillEvery TS runner 防复活护栏的低频执行周期（轮数）：15 轮×2s=30s 探引擎，
	// 150 轮≈5 分钟清一次 TS runner（残余复活窗口 ≤5 分钟，与引擎互监护同数量级）
	runnerTSKillEvery = 150
)

// tsRunnerPkillPattern TS 版采集 runner（scripts/worker-runner.ts，bun 进程）的 pkill 模式。
// [r] 字符类防 pkill 自匹配（pkill 自身命令行含该字面量，正则 [r] 不匹配 [r] 字面文本）。
// 绝不误杀自身：模式只匹配 worker-runner.ts 字样，backend-go.bin / scraper-go.bin 均不含。
const tsRunnerPkillPattern = "worker-[r]unner.ts"

// killTSScrapeRunner 防复活护栏：Go 迁移后 TS runner（bun worker-runner.ts）是已退役的
// 双写源——它与 Go runner 双写 ScrapeTask 会重复执行同一任务（防重集合是进程内的，
// 跨进程失效，实证事故见 worklog Task 19-b）。历史复活源包括 ensure-services.sh 旧版、
// scraper-go 旧版互监护、手工误启。此处在 Go runner 启动时与心跳循环低频执行 pkill，
// 确保任何环境以任何方式拉起的 TS runner 都会被清除。
func killTSScrapeRunner() {
	out, err := osexec.Command("pkill", "-f", tsRunnerPkillPattern).CombinedOutput()
	if err == nil {
		// pkill 命中至少一个进程时 exit 0：记一行日志到 stdout（进程日志）与任务无关
		log.Printf("[backend-go-runner] TS runner 防复活护栏：已清除残留 worker-runner.ts 进程（pkill 输出 %d 字节）", len(out))
	}
	// exit 1 = 无匹配进程（常态），静默
}

var runnerHTTPClient = &http.Client{Timeout: 8 * time.Second}

// recategorizeOne 未分类书慢速归类（每轮 0-1 本）。返回是否处理了一本。
// Task 27-b 收编修复：LLM 失败（冷却/401）时旧实现 LIMIT 1 无轮转 → 永久卡死在同一本
// 无关键词书上，后续书全部饿死。改为 OFFSET 轮转：失败也推进游标，LLM 恢复后自然收敛。
var recatOffset int

func recategorizeOne() bool {
	var bookID int
	var title, description string
	err := queryOne(
		`SELECT n.id, n.title, n.description FROM Novel n
                 JOIN Category c ON n.categoryId = c.id
                 WHERE c.name = ? ORDER BY n.id LIMIT 1 OFFSET ?`,
		[]any{&bookID, &title, &description},
		FALLBACK_CATEGORY, recatOffset,
	)
	if err != nil {
		recatOffset = 0 // 游标越界（表缩小/全处理）：回到队首
		err = queryOne(
			`SELECT n.id, n.title, n.description FROM Novel n
                 JOIN Category c ON n.categoryId = c.id
                 WHERE c.name = ? ORDER BY n.id LIMIT 1`,
			[]any{&bookID, &title, &description},
			FALLBACK_CATEGORY,
		)
		if err != nil {
			return false // 未分类类不存在或无书
		}
	}
	recatOffset++
	// Task 28-b: 改走非缓存归类路径。旧代码 canonicalCategoryWithHint 会把 LLM 失败期
	// （401/冷却）的 FALLBACK 结果永久写入 hint 缓存（catCache 无过期机制），LLM 凭证
	// 恢复后这批书仍命中缓存 → 永远 return false，队列空转不收敛。改为：本地关键词
	// （标题+简介 240 字）优先，残余直接 llmClassifyBook（串行+30s 冷却治理在 llm.go），
	// 负结果不落缓存，LLM 恢复后下一轮即可自然归类。
	canon := classifyBookLocal(title, description)
	if canon == "" {
		canon = llmClassifyBook(title, description)
	}
	if canon == FALLBACK_CATEGORY || canon == "" {
		return false // LLM 冷却中/推断未果：本轮跳过
	}
	// 分类 upsert（唯一冲突回读）。
	// 【23-a 修复死代码 Bug】原 INSERT 写了不存在的 createdAt/updatedAt 列（Category 表只有
	// id/name/sort 三列），导致此 INSERT 一直失败、慢速 LLM 重归类从未生效 → 改为 (name, sort)。
	var catID int64
	rowErr := queryOne(`SELECT id FROM Category WHERE name = ?`, []any{&catID}, canon)
	if rowErr != nil {
		id, insErr := execRetryReturningID(
			`INSERT INTO Category (name, sort) VALUES (?, 0)`,
			canon,
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
	if recatOffset > 0 {
		recatOffset-- // 成功离队：游标回退一格，下轮从同位置继续（队列已前移）
	}
	log.Printf("[backend-go-runner] recategorize 《%s》→ %s", truncateRunes(title, 24), canon)
	return true
}

// ensureEngine 引擎互监护：不可达则杀残留后 setsid 完全托孤拉起 scraper-go。
// Task 26-d：BACKEND_ENGINE_URL/PORT 指向非默认引擎时只观测不杀不拉（自定义引擎进程
// 的拉起方式未知，pkill 'scraper-[g]o.bin' 会误杀生产引擎且无法正确重拉）。
func ensureEngine() {
	resp, err := runnerHTTPClient.Get(engineBaseURL() + "/api/strategies")
	if err == nil {
		_ = resp.Body.Close()
		if resp.StatusCode >= 200 && resp.StatusCode < 500 {
			return // 引擎存活（40x 也说明进程在）
		}
	}
	if !isDefaultEngineURL() {
		log.Printf("[backend-go-runner] 自定义引擎 %s 不可达（仅观测，不执行 pkill/拉起）", engineBaseURL())
		return
	}
	log.Println("[backend-go-runner] engine 不可达，重新拉起")
	// 两步走：先 pkill（[g] 防自匹配），再 setsid 托孤拉起（Task 13 教训：pkill 与 spawn
	// 放同一 bash -c 时 pkill -f 会匹配到自身命令行导致自杀）
	// Task 33: pkill 同步等待完成后再 spawn（消除 pkill/spawn 异步竞态）
	_ = runBashSync("pkill -f 'scraper-[g]o.bin' 2>/dev/null; true", 5*time.Second)
	_ = runBashSync("cd /home/z/my-project/mini-services/scraper-go && setsid nohup ./scraper-go.bin >> /tmp/engine.log 2>&1 < /dev/null &", 3*time.Second)
}

// runBashSync 同步执行 bash 命令（Task 33：限时等待完成，超时放后台收敛）。
// Task 35-b: 前身 runBash（异步 fire-and-forget）已随 pkill/spawn 串行化修复删除——
// Start 后必须 Wait：bash -c 内的 setsid & 立即返回使 bash 退出，若父进程不 Wait，
// 每条命令都会在进程表里留下 zombie（长跑数日累积数万僵尸条目）。
// ensureEngine 的 pkill 与 spawn 必须串行化：旧实现两条 runBash 都是异步 fire-and-forget，
// 「pkill 旧引擎 → spawn 新引擎」存在自愈竞态——pkill 的 0.3s sleep 尚未结束时 spawn 的
// 新引擎可能已被同一模式匹配击杀（Task 13 TS 版自杀 bug 的异步残留形态，engine.log 曾
// 出现「listening 后无任何退出痕迹消失」的实证）。spawn 本身立即返回（bash 内 setsid &），
// 同步化开销可忽略。
func runBashSync(cmd string, timeout time.Duration) error {
	c := osexec.Command("bash", "-c", cmd)
	c.Stdin = nil
	c.Stdout = nil
	c.Stderr = nil
	if err := c.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- c.Wait() }()
	select {
	case err := <-done:
		return err
	case <-time.After(timeout):
		go func() { _ = <-done }() // 超时后由 goroutine 收尾，防 zombie
		return nil
	}
}

// ==================== 限流类熔断的有界自动恢复（Task 33） ====================
//
// 背景（2026-09-25 六站实采实证）：严格限流站（23qb/ggd66/rixsw 等）phase2 几乎必然
// 触发 60 连败熔断转 paused，此前只能等人工 PATCH resume——夜间/长跑场景吞吐归零。
// 且熔断前虽已降档（Task 33 起 resume 还延续降档经验），但引擎 AIMD/hosthealth 冷却
// 仅 60s，几分钟内源站限流窗口通常已过。
// 策略：限流类熔断（message 含「限流」+「软拦截」特征）的 paused 任务，updatedAt 静默
// ≥3 分钟后自动重新入队（条件 UPDATE 防与手动操作竞态）；每任务每进程生命周期至多
// 4 次——防「resume 即熔断」的无限抖动烧预算；4 次后转纯手动。
// 非限流类熔断（封禁/不可达）不自动恢复：那类站点需要人工介入排查。

const (
	autoResumeSilentMs   = 3 * 60 * 1000 // 熔断后静默等待（引擎冷却 60s × 3 冗余）
	autoResumeMaxPerTask = 4             // 每任务自动恢复上限（进程生命周期内）
)

var autoResumeAttempts = map[int]int{}

func autoResumePausedTasks() {
	var ids []int
	err := queryList(
		`SELECT "id" FROM "ScrapeTask"
                 WHERE "status" = 'paused' AND "message" LIKE '%限流%软拦截%'
                   AND "updatedAt" <= ?`,
		func(rows *sql.Rows) error {
			var id int
			if err := rows.Scan(&id); err != nil {
				return err
			}
			ids = append(ids, id)
			return nil
		}, nowMillis()-autoResumeSilentMs)
	if err != nil {
		return
	}
	for _, id := range ids {
		if autoResumeAttempts[id] >= autoResumeMaxPerTask {
			continue
		}
		autoResumeAttempts[id]++
		n := autoResumeAttempts[id]
		var logv string
		_ = queryOne(`SELECT "log" FROM "ScrapeTask" WHERE "id" = ?`, []any{&logv}, id)
		line := "[" + runTs() + "] 自动恢复（限流冷却结束）：第 " + itoa(n) + "/" + itoa(autoResumeMaxPerTask) + " 次重新入队（车道降档经验已延续，缺失正文自动续传）"
		if logv != "" {
			logv += "\n"
		}
		logv = lastLines(logv+line, MAX_LOG_LINES)
		res, err := exec(
			`UPDATE "ScrapeTask" SET "status" = 'pending', "message" = '自动恢复（限流冷却结束），等待 runner 领取继续采集', "log" = ?, "updatedAt" = ? WHERE "id" = ? AND "status" = 'paused'`,
			logv, nowMillis(), id)
		if err == nil {
			if cnt, _ := res.RowsAffected(); cnt > 0 {
				log.Printf("[backend-go-runner] task %d 限流熔断自动恢复（第 %d 次）", id, n)
			}
		}
	}
}

// startRunner runner 主循环入口（main.go 在 runner/all 模式下 go 调用）
func startRunner() {
	log.Printf("[backend-go-runner] started (polling pending tasks every %s)", runnerPollInterval)

	// 僵尸任务回收（recoverStaleTasks 语义：Go runner 是唯一任务执行方，启动时把本进程
	// 启动前仍 running 的任务一次性转 paused 可恢复续传；Task 27-c 注释纠偏：旧文案
	// 「标 failed」与实际行为不符）
	recoverStaleTasks()

	// TS runner 防复活护栏：启动即清一次，之后每 runnerTSKillEvery 轮（≈5 分钟）再清
	killTSScrapeRunner()

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

			if tick%runnerTSKillEvery == 0 {
				killTSScrapeRunner() // TS runner 防复活护栏（低频）
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

			// Task 33: 限流类熔断任务的有界自动恢复（每 15 轮≈30s 扫一次）
			if tick%15 == 0 {
				autoResumePausedTasks()
			}
		}()
		tick++
		time.Sleep(runnerPollInterval)
	}
}
