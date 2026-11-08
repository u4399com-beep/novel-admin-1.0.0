/**
 * backend-go —— 服务入口（Golang 版业务后端，Task 27 起为全站唯一进程）。
 *
 * 端口: 3000（BACKEND_PORT 可覆盖），直接承载用户预览流量（页面 SSR + 业务 API +
 * 采集 runner 三合一），Next.js 代理层已拆除。引擎仍为 scraper-go（127.0.0.1:3030）。
 * 迁移期兼容：BACKEND_PORT=3005 仍可运行（老部署配置不受影响）。
 *
 * 进程模式（BACKEND_MODE 或 -mode）：
 *   api    —— 仅 HTTP API
 *   runner —— 仅采集编排 runner（轮询 pending 任务、心跳文件、引擎互监护、慢速归类）
 *   all    —— api + runner 同进程（开发/验证用；生产建议拆双进程互不拖累）
 *
 * 运行时代谢对齐 TS 时代：
 * - runner 心跳文件 /tmp/scrape-runner-heartbeat（scrape API 判断 runner 存活依据，路径不变）
 * - runner 每 2s 轮询 pending 任务；每 15 轮（≈30s）探测引擎并互监护拉起
 *
 * 合规红线：仅抓取公开页面；robots 提示与域名限速由 scraper-go 引擎层负责。
 */
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"
)

func parsePort() int {
	if s := os.Getenv("BACKEND_PORT"); s != "" {
		if n, err := strconv.Atoi(s); err == nil && n > 0 && n < 65536 {
			return n
		}
	}
	return 3000
}

func parseMode() string {
	if m := os.Getenv("BACKEND_MODE"); m != "" {
		return m
	}
	return "all"
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	mode := parseMode()
	port := parsePort()

	initAdminToken() // R135 P0：管理面写保护令牌装载（ADMIN_TOKEN 空=关闭零破坏）
	if adminTokenEnabled() {
		log.Printf("[backend-go] ADMIN_TOKEN 已启用：写接口需 X-Admin-Token（公开读接口不受影响）")
	}

	if _, err := getDB(); err != nil {
		log.Fatalf("[backend-go] DB 初始化失败: %v", err)
	}
	startSeedIfEmpty() // 初始库种子固化（Task 27）：空表自动播种 15 规则/9 分类/homeConfig
	log.Printf("[backend-go] mode=%s port=%d db=%s", mode, port, dbPath())

	// R102-b: 任务历史清理（boot 一轮 + 6h 周期循环，runner/all 模式挂载；
	// getDB once 已完成，此处走常规助手无死锁风险——Task 30 P1 口径）
	if n := cleanupFinishedTasks(); n > 0 {
		log.Printf("[task-history] boot 清理完成，删除历史任务 %d 条", n)
	}

	if mode == "runner" || mode == "all" {
		go startRunner()
		go startPseoEnrichLoop()      // PSEO 书名种子后台富集（12s/种子，见 pseo_book.go）
		go startProxyWatch()          // E18 出口池自愈（10min/轮，PROXYWATCH_OFF=1 停用，见 proxywatch.go）
		go startProxyPoolHarvest()    // R103 全局代理池收割（5min/轮：搜代理+连通性测试+筛选+规则补种，PROXYPOOL_OFF=1 停用，见 miniproxypool.go）
		go startRuleHealthLoop()      // E19 规则健康巡检（45min/轮，RULEHEALTH_OFF=1 停用，见 rulehealth.go）
		go startFleetKeeper()         // E26 舰队自持（5min/轮，FLEETKEEPER_OFF=1 停用，见 fleetkeeper.go）
		go startCoverSweepLoop()      // 封面巡检自愈（30min/轮，COVERSWEEP_OFF=1 停用，见 api_noveltools.go）
		go startBackupLoop()          // R135 P1：DB 自动备份（VACUUM INTO 原子快照，12h/轮，BACKUP_OFF=1 停用，见 backupx.go）
		go startPseoReenrichSweep()   // 种子重富集自愈（60min/轮，PSEO_REENRICH_OFF=1 停用，见 pseo_reenrich.go）
		go cleanupFinishedTasksLoop() // R102-b 任务历史清理（6h/轮，见 tasklogx.go）
	}
	// R135 可观测三件套（api/all 模式挂载：拨测自探需要本进程 HTTP 面）。
	// runner-only 模式无 HTTP 监听，拨测/快照无意义，故不挂载。
	if mode == "api" || mode == "all" {
		go startObservabilityLoop() // 拨测 5min/stats 快照 10min/批量paused检测 60s（OBS_OFF=1 停用，见 observability.go）
	}
	// R135: 服务重启告警（boot 完成后一次；webhook 未配置时 fireAlert 零成本直返）。
	// 异步发送不阻塞启动序列；runner 模式同样覆盖（runner 重启也是值得知道的事件）。
	go fireAlert("service_restart", fmt.Sprintf("backend-go 启动（mode=%s port=%d）", mode, port), dbPath())
	// startDevWatcher 已随 Next.js 退役（Task 27）：3000 端口由本进程直接承载，
	// 看护职责归沙箱 dev 链路 / systemd（见 scripts/dev-go.sh 与 deployment.md）。
	if mode == "api" || mode == "all" {
		srv := &http.Server{
			Addr:              ":" + itoa(port),
			Handler:           http.HandlerFunc(dispatch),
			ReadHeaderTimeout: 10 * time.Second,
			ReadTimeout:       65 * time.Second, // scrape 代理最长 60s
			WriteTimeout:      65 * time.Second,
			IdleTimeout:       120 * time.Second,
		}
		go func() {
			sig := make(chan os.Signal, 1)
			signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
			<-sig
			log.Println("[backend-go] 收到退出信号，graceful shutdown…")
			ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
			defer cancel()
			_ = srv.Shutdown(ctx)
		}()
		// P1 运维整改（R136）：BACKEND_TLS_CERT/BACKEND_TLS_KEY 同时非空 → 原生 HTTPS
		// 直连（自签内网/内网加密形态）；公网运营标准形态仍为反代层 TLS 终结
		// （仓库 Caddyfile 顶部样例 / docs/deployment.md §8.4）
		tlsCert, tlsKey := os.Getenv("BACKEND_TLS_CERT"), os.Getenv("BACKEND_TLS_KEY")
		if tlsCert != "" && tlsKey != "" {
			log.Printf("[backend-go] listening on :%d (TLS cert=%s)", port, tlsCert)
			if err := srv.ListenAndServeTLS(tlsCert, tlsKey); err != nil && !errors.Is(err, http.ErrServerClosed) {
				log.Fatalf("[backend-go] HTTPS 服务退出: %v", err)
			}
		} else {
			log.Printf("[backend-go] listening on :%d", port)
			if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				log.Fatalf("[backend-go] HTTP 服务退出: %v", err)
			}
		}
	} else {
		// runner-only：阻塞直到信号
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
		<-sig
		log.Println("[backend-go] runner 退出")
	}
}
