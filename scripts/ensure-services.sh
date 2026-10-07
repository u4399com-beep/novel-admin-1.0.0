#!/usr/bin/env bash
# 确保双服务在跑（沙箱周期清理后台进程的对策：每个工作调用开头先跑本脚本）
# 用法：bash scripts/ensure-services.sh && <你的命令>
ROOT=/home/z/my-project
OK=1
curl -s --max-time 2 http://127.0.0.1:3000/api/health | rg -q '"ok":true' || OK=0
curl -s --max-time 2 http://127.0.0.1:3030/api/health | rg -q '"ok":true' || OK=0
[ "$OK" = "1" ] && exit 0
# backend
if ! curl -s --max-time 2 http://127.0.0.1:3000/api/health | rg -q '"ok":true'; then
  (cd "$ROOT" && DB_PATH=$ROOT/db/custom.db nohup "$ROOT/mini-services/backend-go/bin/backend-go" >>/tmp/backend-go.log 2>&1 &)
fi
# scraper
if ! curl -s --max-time 2 http://127.0.0.1:3030/api/health | rg -q '"ok":true'; then
  (cd "$ROOT/mini-services/scraper-go" && nohup ./bin/scraper-go >>/tmp/scraper-go.log 2>&1 &)
fi
# 等待就绪（最多 15s）
for i in $(seq 1 15); do
  B=0; S=0
  curl -s --max-time 2 http://127.0.0.1:3000/api/health | rg -q '"ok":true' && B=1
  curl -s --max-time 2 http://127.0.0.1:3030/api/health | rg -q '"ok":true' && S=1
  [ "$B" = "1" ] && [ "$S" = "1" ] && { echo "services ready"; exit 0; }
  sleep 1
done
echo "services NOT ready"; exit 1
