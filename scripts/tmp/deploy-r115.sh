#!/bin/bash
# R115 部署：双服务重启（新 bin 已在 bin/ 就位）+ 看门狗拉起
set -u
pkill -f '/bin/backend-go' 2>/dev/null
pkill -f '/bin/scraper-go' 2>/dev/null
sleep 1
pgrep -f '/bin/backend-go|/bin/scraper-go' >/dev/null && { pkill -9 -f '/bin/backend-go|/bin/scraper-go'; sleep 1; }

cd /home/z/my-project
DB_PATH=/home/z/my-project/db/custom.db nohup mini-services/backend-go/bin/backend-go >>/tmp/backend-go.log 2>&1 </dev/null &
cd /home/z/my-project/mini-services/scraper-go
SCRAPE_PROXY_BUCKET_HOSTS="www.trxsw.com:3,www.77shuku.info:3" nohup ./bin/scraper-go >>/tmp/scraper-go.log 2>&1 </dev/null &

# 看门狗（防沙箱收割后无人拉起）
cd /home/z/my-project
pgrep -f watchdog-services.sh >/dev/null || nohup bash scripts/watchdog-services.sh >/tmp/watchdog.log 2>&1 </dev/null &

for i in $(seq 1 20); do
  B=$(curl -s --max-time 2 http://127.0.0.1:3000/api/health | grep -c '"ok":true')
  S=$(curl -s --max-time 2 http://127.0.0.1:3030/api/health | grep -c '"ok":true')
  [ "$B" = "1" ] && [ "$S" = "1" ] && { echo "R115 deploy: both healthy"; exit 7; }
  sleep 1
done
echo "R115 deploy: NOT ready (watchdog will retry)"
exit 7
