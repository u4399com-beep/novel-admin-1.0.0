#!/bin/bash
# R29 部署：E25 增强版 backend-go 上线（R21 加固模式：pkill→轮询→cp→启动，cp 失败 exit 9）
set -u
export PATH=/home/z/go-sdk/go/bin:$PATH
export GOPATH=/home/z/go

cd /home/z/my-project/mini-services/backend-go || exit 9
go build -o backend-go.bin.new . || { echo "build failed"; exit 9; }

# R112: 兼容两种进程形态——CWD 启动（./backend-go.bin）与 bin/ 路径启动
# （bin/backend-go 无点号，旧模式 backend-go[.]bin 永不匹配 → 旧进程苟活、
#  新进程 bind: address already in use 静默死亡，部署假成功）。R112 aijjxs 实证。
pkill -f 'backend-go[.]bin|/bin/backend-go' 2>/dev/null
for i in $(seq 1 10); do
  pgrep -f 'backend-go[.]bin|/bin/backend-go' >/dev/null || break
  sleep 0.5
done
pgrep -f 'backend-go[.]bin|/bin/backend-go' >/dev/null && pkill -9 -f 'backend-go[.]bin|/bin/backend-go' && sleep 1

cp backend-go.bin.new backend-go.bin || { echo "cp failed (text-file-busy?)"; exit 9; }
rm -f backend-go.bin.new

setsid nohup env BACKEND_PORT=3000 BACKEND_MODE=all ./backend-go.bin >> /tmp/backend-go-api.log 2>&1 </dev/null &
sleep 3
curl -s --max-time 5 http://127.0.0.1:3000/api/health > /dev/null && echo "backend healthy" || echo "backend NOT ready yet (watchdog will retry)"
exit 7
