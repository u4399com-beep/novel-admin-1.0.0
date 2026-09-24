/**
 * scraper-go —— novel-admin 采集引擎（Golang 版）服务入口。
 *
 * 端口: 3030（backend-go engineclient.go 的引擎目标；SCRAPER_PORT 可覆盖）
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

        // runner 心跳观测（只观测不拉起）：Go 迁移（Task 18）后采集 runner = backend-go，
        // 本引擎旧版在这里拉起 TS worker-runner.ts 的互监护已成为 TS runner 复活源
        //（双 runner 双写 ScrapeTask 重复执行任务，实证事故见 worklog Task 19-b）。
        // TS runner 的清除由 backend-go runner 的防复活护栏负责（启动+每 5 分钟 pkill）；
        // backend-go 进程的拉起由 Next backend-supervisor 与 ensure-services.sh 兑底，本进程不再插手。
        go runnerObserveLoop()

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

// runnerHeartbeat runner 心跳文件（Go runner=backend-go 每 2s 刷新；10s 未刷新视为离线）
const runnerHeartbeat = "/tmp/scrape-runner-heartbeat"

// runnerObserveLoop 仅观测 runner 心跳并告警，绝不拉起任何 runner：
// 历史教训（TS 版互监护 + Go 版旧互监护）：本进程拉起 TS worker-runner.ts 会与 Go runner
// 双写 ScrapeTask 重复执行任务；拉起第二个 backend-go runner 亦会双 runner 抢任务。
// runner 缺位时的兜底链路：Next backend-supervisor（秒级）→ ensure-services.sh（分钟级）。
func runnerObserveLoop() {
        warnedAt := int64(0)
        for {
                time.Sleep(30 * time.Second)
                stale := true
                if stat, err := os.Stat(runnerHeartbeat); err == nil {
                        stale = time.Since(stat.ModTime()) >= 10*time.Second
                }
                if !stale {
                        warnedAt = 0
                        continue
                }
                // 节流告警（每 10 分钟最多一条）：观测告警不承担拉起职责
                if nowMs()-warnedAt < 10*60_000 {
                        continue
                }
                warnedAt = nowMs()
                logger.Printf("runner 心跳缺失超过 10s（backend-go 可能离线，由 backend-supervisor/ensure-services 兑底；本引擎不拉起 runner）")
        }
}
