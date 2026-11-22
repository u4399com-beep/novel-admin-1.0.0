#!/usr/bin/env bash
# deploy-backend.sh —— 重编 + 原子替换 + 热重启 backend（开发/运维快捷通道）。
# R151 收敛：单产物 bin/backend-go（仓库受控形态），拉起走 run.sh 循环重启包装
# （flock 单实例闸 + 崩溃自动重启）。旧 *.bin 双产物形态已废除（见 build-go.sh R151 注）。
set -euo pipefail
cd "$(dirname "$0")/../mini-services/backend-go"

go build -trimpath -ldflags="-s -w" -o bin/backend-go.new . || { echo "build failed"; exit 9; }

# R112: 兼容两种进程形态——CWD 启动（./backend-go.bin）与 bin/ 路径启动
# （bin/backend-go 无点号，旧模式 backend-go[.]bin 永不匹配 → 旧进程苟活、
#  新进程撞端口静默退出——R148 坑存档同款）
pkill -f 'backend-go[.]bin|/bin/backend-go' 2>/dev/null || true
for i in 1 2 3 4 5; do
  pgrep -f 'backend-go[.]bin|/bin/backend-go' >/dev/null || break
  sleep 1
done
pgrep -f 'backend-go[.]bin|/bin/backend-go' >/dev/null && pkill -9 -f 'backend-go[.]bin|/bin/backend-go' && sleep 1

mv -f bin/backend-go.new bin/backend-go || { echo "mv failed (text-file-busy?)"; exit 9; }

# run.sh 循环重启包装：flock 抢不到=已有实例在跑（被 pkill 误杀时由其父循环自动重生）
setsid nohup ./run.sh >> /tmp/backend-go-api.log 2>&1 </dev/null &
sleep 2
curl -s --max-time 5 http://127.0.0.1:3000/api/health | grep -q '"ok":true' && echo "[deploy-backend] restarted OK" || echo "[deploy-backend] WARN: health 未就绪（冷启动建表中，稍后复验）"
