#!/bin/bash
# dev server 看护循环：进程退出（守护清理/崩溃）后 2s 自动拉起，保证预览可用性。
# 采集任务在独立 runner 进程执行，不受 Next 重启影响（任务记录在 DB，骨架续传）。
#
# Task 23 更新：沙箱实测 next-server(Turbopack dev) RSS 会膨胀到 ~2GB 触发内核 OOM
# （dmesg: Killed process next-server anon-rss:2071508kB），加上 Go 构建/vet 的瞬时
# 内存后必然爆 4GB 沙箱限额。给 node 显式设 1.25GB 堆上限：Turbopack dev 足够，
# 超限由 V8 自己 GC/报错回收，而不是被内核 OOM 击杀拖垮全机。
cd /home/z/my-project
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=1280"
while true; do
  bun run dev >> dev.log 2>&1
  echo "[$(date '+%H:%M:%S')] dev exited (code=$?), restarting in 2s" >> /tmp/dev-supervisor.log
  sleep 2
done
