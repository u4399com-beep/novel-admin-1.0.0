#!/usr/bin/env bash
# R120 部署：scraper-go + backend-go（pkill 模式按实际 cmdline './bin/<name>'——R119 教训）。
# stealth 另行重启（run.sh 2s 自愈环拉起新 server.py）。失败码收尾保进程存活。
# engine.env 单一来源（R116-4b 契约）：source 后仅取 KEY=VALUE 行注入。
set -u
ENGINE_ENVS=$(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' /home/z/my-project/scripts/engine.env | tr '\n' ' ')
pkill -f '\./bin/scraper-go' 2>/dev/null; sleep 1
cd /home/z/my-project/mini-services/scraper-go
setsid nohup env DB_PATH=/home/z/my-project/db/custom.db $ENGINE_ENVS ./bin/scraper-go >> /tmp/scraper-go.log 2>&1 < /dev/null &
cd /home/z/my-project
pkill -f '\./bin/backend-go' 2>/dev/null; sleep 1
cd /home/z/my-project/mini-services/backend-go
setsid nohup env DB_PATH=/home/z/my-project/db/custom.db ./bin/backend-go >> /tmp/backend-go.log 2>&1 < /dev/null &
sleep 4
curl -s --max-time 3 http://127.0.0.1:3000/api/health | head -c 120; echo
curl -s --max-time 3 http://127.0.0.1:3030/api/health | head -c 120; echo
exit 7
