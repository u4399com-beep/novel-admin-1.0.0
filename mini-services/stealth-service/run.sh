#!/usr/bin/env bash
# stealth-service 启动（R101）：iv8 / CloakBrowser 反检测侧车，端口 3031 固定。
# 依赖：python3 + pip install -r requirements.txt（缺库时服务仍起，对应能力 /health 报 false，
# 引擎策略自动跳过）。崩溃自动重启（2s 间隔）。
set -u
cd "$(dirname "$0")"

while true; do
  python3 server.py
  code=$?
  echo "[stealth-service] exited code=$code, restart in 2s" >&2
  sleep 2
done
