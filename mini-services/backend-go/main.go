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

	if _, err := getDB(); err != nil {
		log.Fatalf("[backend-go] DB 初始化失败: %v", err)
	}
	startSeedIfEmpty() // 初始库种子固化（Task 27）：空表自动播种 15 规则/9 分类/homeConfig
	log.Printf("[backend-go] mode=%s port=%d db=%s", mode, port, dbPath())

	if mode == "runner" || mode == "all" {
		go startRunner()
		go startPseoEnrichLoop() // PSEO 书名种子后台富集（12s/种子，见 pseo_book.go）
	}
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
		log.Printf("[backend-go] listening on :%d", port)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("[backend-go] HTTP 服务退出: %v", err)
		}
	} else {
		// runner-only：阻塞直到信号
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
		<-sig
		log.Println("[backend-go] runner 退出")
	}
}
