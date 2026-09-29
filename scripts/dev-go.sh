#!/bin/bash
# dev-go.sh —— 项目 dev 入口（Task 27 起：完全摆脱 Next.js，Go 单进程承载 3000）。
#
# 沙箱 dev.sh 链路执行 `bun run dev`（原为 next dev -p 3000），现改为后台自愈循环
# 启动 backend-go（页面 SSR + 业务 API + 采集 runner 三合一，BACKEND_MODE=all）。
# 端口 3000 与沙箱预览面板契约不变；采集引擎 scraper-go 由 mini-services-start
# 或 ensure-services.sh 兜底拉起（3030），backend-go 内置互监护也会自愈拉起引擎。
#
# 自愈循环：进程崩溃 2s 后自动拉起（对齐原 dev-supervisor.sh 语义）；由沙箱 dev
# 链路（基础设施进程）孵化 → 长寿稳定（交互会话直接派生的进程会被沙箱收割器
# 清理，见 devwatch 时代实证，故本脚本必须经 `bun run dev` 链路进入）。
set -u
cd "$(dirname "$0")/../mini-services/backend-go"

export BACKEND_PORT="${BACKEND_PORT:-3000}"
export BACKEND_MODE="${BACKEND_MODE:-all}"

# 已有健康实例则退出（防双实例双 runner：mini-services-start 与本脚本只能活一个）
health=$(curl -s --max-time 2 "http://127.0.0.1:${BACKEND_PORT}/api/health" 2>/dev/null || true)
if printf '%s' "$health" | grep -q '"service":"backend-go"'; then
  echo "[dev-go] :${BACKEND_PORT} 已有 backend-go 实例，退出防双实例"
  exit 0
fi

touch /tmp/scrape-runner-heartbeat 2>/dev/null
while true; do
  bash run.sh
  code=$?
  echo "[$(date '+%H:%M:%S')] backend-go exited (code=$code), restarting in 2s" >> /tmp/dev-supervisor.log
  sleep 2
done
