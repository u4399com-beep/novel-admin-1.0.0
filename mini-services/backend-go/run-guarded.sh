#!/usr/bin/env bash
# run-guarded.sh —— backend-go mini-service 守卫启动（防双实例）。
#
# Task 27 拓扑：3000 = backend-go 单进程（页面+API+runner）。3000 实例可能由
#   a) 根 `bun run dev`（scripts/dev-go.sh，沙箱 dev.sh 链路）或
#   b) 本守卫（mini-services-start 链路）拉起，二者只能活一个。
# 本脚本探测 3000 健康端点：已是 backend-go → 退出 0（防双 runner 双写任务）；
# 3000 无人监听或非本服务 → 以默认 3000 启动。生产部署（systemd）直接用 run.sh。
set -u
cd "$(dirname "$0")"

health=$(curl -s --max-time 2 http://127.0.0.1:3000/api/health 2>/dev/null || true)
if printf '%s' "$health" | grep -q '"service":"backend-go"'; then
  echo "[backend-go] :3000 已有实例（dev 链路），守卫退出防双实例"
  exit 0
fi

export BACKEND_PORT="${BACKEND_PORT:-3000}"
exec bash run.sh
