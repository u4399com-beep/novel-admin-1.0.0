#!/bin/bash
# 服务看护（精简版 watchdog）：只负责采集 runner 与引擎的存活拉起（幂等）
# 刻意不管 Next dev：dev 现直接跑在 3000（由沙箱/守护管理）；旧版在本脚本里拉起
# dev3001 会与 3000 实例竞争 .next 编译缓存导致 crash（14-b 实训教训），绝不恢复该行为。
# 用法：配合定时任务每分钟执行（self-healing）；也可手动 bash scripts/ensure-services.sh
cd /home/z/my-project

# 采集 runner：心跳文件 10s 内视为存活（比 pgrep 更真实——进程在但不轮询也算死）
HB=/tmp/scrape-runner-heartbeat
RUNNER_ALIVE=0
if [ -f "$HB" ]; then
  NOW=$(date +%s)
  MTIME=$(stat -c %Y "$HB" 2>/dev/null || echo 0)
  [ $((NOW - MTIME)) -lt 10 ] && RUNNER_ALIVE=1
fi
if [ "$RUNNER_ALIVE" -eq 0 ]; then
  pkill -f 'scripts/worker-runner' 2>/dev/null && sleep 1
  setsid nohup env SCRAPE_WORKER_RUNNER=1 bun --hot scripts/worker-runner.ts >> /tmp/runner.log 2>&1 </dev/null &
  echo "[$(date '+%H:%M:%S')] watchdog: runner 拉起（心跳缺失/过期）" >> /tmp/watchdog.log
fi

# 采集引擎 :3030
curl -s -o /dev/null --max-time 5 http://127.0.0.1:3030/api/strategies || {
  pkill -f 'scraper-service' 2>/dev/null && sleep 1
  cd /home/z/my-project/mini-services/scraper-service && \
    setsid nohup env SCRAPER_PORT=3030 bun --hot index.ts >> /tmp/engine.log 2>&1 </dev/null &
  echo "[$(date '+%H:%M:%S')] watchdog: engine 拉起" >> /tmp/watchdog.log
  cd /home/z/my-project
}

echo "[$(date '+%H:%M:%S')] checked: runner=$RUNNER_ALIVE engine=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3030/api/strategies)" >> /tmp/watchdog.log
