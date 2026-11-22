#!/usr/bin/env bash
# backend-go 启动（run.sh 循环重启包装，与 stealth-service/run.sh 同架构）：
# 沙箱的会话清理会周期性杀死后台单进程（R151 实证：setsid/nohup 直拉的
# backend-go 与 scraper-go 均在 60-90s 内被静默清除，而 stealth 的 run.sh
# 无限循环架构存活至今——清杀手只杀子进程，父循环立即重生）。
# 依赖：DB_PATH（缺省 {repoRoot}/db/custom.db，repoRoot 按 paths.go 解析链）。
# flock 单实例闸（R110 同款：多实例并存会抢 3000 端口崩溃循环）。
set -u
cd "$(dirname "$0")"

exec 9>/tmp/backend-go.lock
if ! flock -n 9; then
  echo "[backend-go] 已有实例在运行（flock 持有），退出" >&2
  exit 0
fi

DB_FILE="${DB_PATH:-$(cd ../.. && pwd)/db/custom.db}"
mkdir -p "$(dirname "$DB_FILE")"

while true; do
  DB_PATH="$DB_FILE" ./bin/backend-go
  code=$?
  echo "[backend-go] exited code=$code, restart in 2s" >&2
  sleep 2
done
