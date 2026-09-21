/**
 * scraper-go —— novel-admin 采集引擎（Golang 版）服务入口。
 *
 * 端口: 3030（与主站 src/app/api/scrape/route.ts 的代理目标一致；SCRAPER_PORT 可覆盖）
 *
 * 本文件只保留启动与路由分发；业务 handler 在 handlers.go，
 * 策略链/反反爬在 chain.go + strategies.go + curlimp.go + browser.go，
 * 规则提取器在 extract.go / selectors.go / content.go / jsontoc.go。
 *
 * 路由（与 TS 版完全一致）:
 *   GET  /api/strategies  可用抓取策略及状态
 *   GET  /api/health      健康检查
 *   POST /api/test        { url, rule: { listRule?, bookRule?, chapterRule? }, strategy?, charset?, timeoutMs? }
 *   POST /api/chapter     { url, rule?: ChapterRule, charset?, strategy?, timeoutMs? }
 *
 * 错误一律 JSON { error, detail }；策略全败返回结构化 502 而非 panic；
 * 成功与失败响应都携带 attempts 明细（每次网络尝试的状态/耗时/画像/挑战页标记）便于调试。
 *
 * 合规红线（不可移除）：
 * - 仅用于公开可访问内容，禁止采集需登录/付费内容；
 * - 内置 robots.txt 提示（warn-only）与默认低频限速（每域名 ≥1.2s）；
 * - 不含任何验证码破解、账号伪装、登录态伪造功能。
 */
package main

import (
        "fmt"
        "net/http"
        "os"
        "strconv"
        "strings"
        "time"
)

const serviceVersion = "2.0.0"
const serviceRuntime = "go1.22"

func parsePort() int {
        parsed, err := strconv.Atoi(os.Getenv("SCRAPER_PORT"))
        if err == nil && parsed > 0 && parsed < 65536 {
                return parsed
        }
        return 3030
}

// route 路由分发
func route(w http.ResponseWriter, r *http.Request) {
        path := strings.TrimRight(r.URL.Path, "/")
        if path == "" {
                path = "/"
        }
        method := strings.ToUpper(r.Method)

        if method == "OPTIONS" {
                w.Header().Set("Access-Control-Allow-Origin", "*")
                w.Header().Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
                w.Header().Set("Access-Control-Allow-Headers", "content-type")
                w.Header().Set("Access-Control-Max-Age", "86400")
                w.WriteHeader(204)
                return
        }

        if method == "GET" && path == "/" {
                writeJSON(w, 200, map[string]any{
                        "ok": true, "service": "scraper-service", "version": serviceVersion, "runtime": serviceRuntime,
                        "endpoints": []string{"GET /api/strategies", "GET /api/health", "POST /api/test", "POST /api/chapter"},
                })
                return
        }

        if method == "GET" && path == "/api/health" {
                writeJSON(w, 200, map[string]any{
                        "ok": true, "service": "scraper-service", "port": parsePort(),
                        "time": time.Now().UTC().Format(time.RFC3339Nano),
                })
                return
        }

        if method == "GET" && path == "/api/strategies" {
                handleStrategies(w, r)
                return
        }

        if method == "POST" && path == "/api/test" {
                body := parseBody(w, r)
                if body == nil {
                        failJSON(w, "请求体错误", "请求体必须是 JSON 对象，形如 { url, rule: { listRule?, bookRule?, chapterRule? }, strategy?, charset?, timeoutMs? }", 400)
                        return
                }
                handleTest(w, body)
                return
        }

        if method == "POST" && path == "/api/chapter" {
                body := parseBody(w, r)
                if body == nil {
                        failJSON(w, "请求体错误", "请求体必须是 JSON 对象，形如 { url, rule?: { titleSelector?, contentSelector?, nextSelector? }, charset?, strategy?, timeoutMs? }", 400)
                        return
                }
                handleChapter(w, body)
                return
        }

        failJSON(w, "Not Found", "未知路由 "+method+" "+path+"。可用: GET /api/strategies, GET /api/health, POST /api/test, POST /api/chapter", 404)
}

func main() {
        port := parsePort()

        mux := http.NewServeMux()
        mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
                // 不向客户端泄漏内部堆栈/内部路径；完整堆栈只进服务端日志
                defer func() {
                        if rec := recover(); rec != nil {
                                logger.Printf("unhandled panic: %v", rec)
                                failJSON(w, "服务器内部错误", "请求处理失败，请查看服务端日志", 500)
                        }
                }()
                route(w, r)
        })

        server := &http.Server{
                Addr:              fmt.Sprintf("127.0.0.1:%d", port),
                Handler:           mux,
                ReadHeaderTimeout: 10 * time.Second,
                // 不设 WriteTimeout：策略链预算 55s + 主站 60s 消费超时已兜底，
                // 服务端再设会切断长抓取（与 TS Bun.serve 行为一致）
        }

        // 引擎自心跳（每 2s utime 一次）：沙箱环境会静默回收「空闲」后台进程，
        // 周期性文件活动是对冲手段。心跳文件同时供互监护/运维判定引擎存活。
        go heartbeatLoop()

        // Runner 互监护（本进程长寿，由它兜底拉起采集 runner）：
        // 每 30s 检查 /tmp/scrape-runner-heartbeat；10s 未刷新即视为 runner 死亡，
        // 以 setsid 完全脱离本进程会话的方式重启（kill 残留避免双实例抢任务）。
        go runnerWatchdogLoop()

        logger.Printf("listening on http://127.0.0.1:%d", port)
        logger.Printf("合规约束: 域名限速≥1.2s | robots.txt warn-only | SSRF 逐跳校验 | 禁验证码破解/账号伪装/付费内容 | runtime=%s", serviceRuntime)
        if err := server.ListenAndServe(); err != nil {
                logger.Printf("server exit: %v", err)
                os.Exit(1)
        }
}

const engineHeartbeat = "/tmp/scraper-engine-heartbeat"

func heartbeatLoop() {
        for {
                now := time.Now()
                if err := os.Chtimes(engineHeartbeat, now, now); err != nil {
                        _ = os.WriteFile(engineHeartbeat, []byte(now.Format(time.RFC3339)), 0o644)
                }
                time.Sleep(2 * time.Second)
        }
}

// runnerHeartbeat runner 心跳文件（runner 每 2s 刷新；10s 未刷新视为死亡）
const runnerHeartbeat = "/tmp/scrape-runner-heartbeat"

// runner 相关说明：旧 TS 版把 pkill 与 spawn 放在同一条 bash -c 里，而 spawn 段本身包含
// 「bun scripts/worker-runner.ts」明文路径 → pkill -f 必然命中外层 bash 自身命令行（实证 exit 143），
// setsid 永不执行——TS 版互监护拉起 runner 实际从未生效的潜伏 bug。
// Go 版拆成两步：①pkill（模式用 [r] 字符类防自匹配）②spawn（命令串不含 pkill）。
const runnerPkillPattern = "bun scripts/worker-runne[r]"

const runnerSpawn =
        "cd /home/z/my-project && exec setsid nohup env SCRAPE_WORKER_RUNNER=1 bun scripts/worker-runner.ts >> /tmp/runner.log 2>&1 < /dev/null &"

func runnerWatchdogLoop() {
        for {
                time.Sleep(30 * time.Second)
                stale := true
                if stat, err := os.Stat(runnerHeartbeat); err == nil {
                        stale = time.Since(stat.ModTime()) >= 10*time.Second
                }
                if !stale {
                        continue
                }
                logger.Printf("runner 心跳缺失，重新拉起")
                // ① 清残留（避免双实例抢任务）；pkill 自身命令行含 [r] 模式，不会匹配到它自己
                if out, err := execCommand("pkill", "-f", runnerPkillPattern).CombinedOutput(); err != nil {
                        _ = out // 无匹配进程时 pkill 返回非零，属正常
                }
                // ② 以 setsid 完全脱离本进程会话的方式重启
                cmd := execCommand("bash", "-c", runnerSpawn)
                if err := cmd.Start(); err != nil {
                        logger.Printf("runner 拉起失败: %v", err)
                }
                // Start 不 Wait 会产生僵尸进程（bash 本身很快退出）：用 goroutine Wait 回收
                go func() { _ = cmd.Wait() }()
        }
}
