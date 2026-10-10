#!/usr/bin/env bash
# stealth-service 启动（R101）：iv8 / CloakBrowser 反检测侧车，端口 3031 固定。
# 依赖：python3 + pip install -r requirements.txt（缺库时服务仍起，对应能力 /health 报 false，
# 引擎策略自动跳过）。崩溃自动重启（2s 间隔）。
# R110：flock 单实例闸——多个 run.sh 并存会互相抢 3031 端口进入崩溃重启循环，
# /health 间歇失败连锁引擎把 fetch-cloak/fetch-iv8 标不可用。
set -u
cd "$(dirname "$0")"

exec 9>/tmp/stealth-service.lock
if ! flock -n 9; then
  echo "[stealth-service] 已有实例在运行（flock 持有），退出" >&2
  exit 0
fi

# 优先使用 venv（存在则激活），保证 cloakbrowser / iv8 可导入
if [ -x "venv/bin/python3" ]; then
  PY="venv/bin/python3"
else
  PY="python3"
fi

while true; do
  "$PY" server.py
  code=$?
  echo "[stealth-service] exited code=$code, restart in 2s" >&2
  sleep 2
done
