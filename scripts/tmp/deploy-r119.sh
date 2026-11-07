#!/usr/bin/env bash
# R119 临时部署 v2：修复 pkill 模式（实际 cmdline 为相对路径 ./bin/<name>，
# R118 同款坑第三变体——'mini-services/*/bin' 前缀模式永远不匹配）。
# 失败码收尾保进程存活。
pkill -f '\./bin/scraper-go' 2>/dev/null; pkill -f 'bin/scraper-go' 2>/dev/null; sleep 1
cd /home/z/my-project/mini-services/scraper-go
setsid nohup env DB_PATH=/home/z/my-project/db/custom.db SCRAPE_PROXY_BUCKET_HOSTS=www.77shuku.info:3,www.biqutu.info:4 ./bin/scraper-go >> /tmp/scraper-go.log 2>&1 < /dev/null &
cd /home/z/my-project
pkill -f '\./bin/backend-go' 2>/dev/null; pkill -f 'bin/backend-go' 2>/dev/null; sleep 1
cd /home/z/my-project/mini-services/backend-go
setsid nohup env DB_PATH=/home/z/my-project/db/custom.db ./bin/backend-go >> /tmp/backend-go.log 2>&1 < /dev/null &
sleep 4
curl -s --max-time 3 http://127.0.0.1:3000/api/health | head -c 100; echo
curl -s --max-time 3 http://127.0.0.1:3030/api/health | head -c 100; echo
exit 7
