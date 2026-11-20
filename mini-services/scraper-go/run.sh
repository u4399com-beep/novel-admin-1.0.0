#!/usr/bin/env bash
# scraper-go 启动（run.sh 循环重启包装，与 stealth-service/run.sh 同架构）：
# 沙箱会话清理会周期性杀死后台单进程（R151 实证），父循环立即重生。
# R116：engine.env 单一来源（分桶代理 env 注入，手工/自动拉起路径同源）。
# flock 单实例闸（防多实例抢 3030 端口崩溃循环）。
set -u
cd "$(dirname "$0")"

exec 9>/tmp/scraper-go.lock
if ! flock -n 9; then
  echo "[scraper-go] 已有实例在运行（flock 持有），退出" >&2
  exit 0
fi

# R110：分桶代理 env 单一来源（repoRoot/scripts/engine.env）
if [ -f "../../scripts/engine.env" ]; then
  set -a
  . ../../scripts/engine.env
  set +a
fi

while true; do
  ./bin/scraper-go
  code=$?
  echo "[scraper-go] exited code=$code, restart in 2s" >&2
  sleep 2
done
