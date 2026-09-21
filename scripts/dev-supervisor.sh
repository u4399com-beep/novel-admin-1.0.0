#!/bin/bash
# dev server 看护循环：进程退出（守护清理/崩溃）后 2s 自动拉起，保证预览可用性。
# 采集任务在独立 runner 进程执行，不受 Next 重启影响（任务记录在 DB，骨架续传）。
cd /home/z/my-project
while true; do
  bun run dev >> dev.log 2>&1
  echo "[$(date '+%H:%M:%S')] dev exited (code=$?), restarting in 2s" >> /tmp/dev-supervisor.log
  sleep 2
done
