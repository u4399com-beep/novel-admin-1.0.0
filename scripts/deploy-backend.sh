#!/bin/bash
# R29 部署：E25 增强版 backend-go 上线（R21 加固模式：pkill→轮询→cp→启动，cp 失败 exit 9）
set -u
export PATH=/home/z/go-sdk/go/bin:$PATH
export GOPATH=/home/z/go

cd /home/z/my-project/mini-services/backend-go || exit 9
go build -o backend-go.bin.new . || { echo "build failed"; exit 9; }

pkill -f 'backend-go[.]bin' 2>/dev/null
for i in $(seq 1 10); do
  pgrep -f 'backend-go[.]bin' >/dev/null || break
  sleep 0.5
done
pgrep -f 'backend-go[.]bin' >/dev/null && pkill -9 -f 'backend-go[.]bin' && sleep 1

cp backend-go.bin.new backend-go.bin || { echo "cp failed (text-file-busy?)"; exit 9; }
rm -f backend-go.bin.new

setsid nohup env BACKEND_PORT=3000 BACKEND_MODE=all ./backend-go.bin >> /tmp/backend-go-api.log 2>&1 </dev/null &
sleep 3
curl -s --max-time 5 http://127.0.0.1:3000/api/health > /dev/null && echo "backend healthy" || echo "backend NOT ready yet (watchdog will retry)"
exit 7
