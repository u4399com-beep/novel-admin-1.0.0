#!/usr/bin/env bash
# 确保双服务在跑（沙箱周期清理后台进程的对策：每个工作调用开头先跑本脚本）
# 用法：bash scripts/ensure-services.sh && <你的命令>
ROOT=/home/z/my-project
OK=1
mkdir -p "$ROOT/db"  # R104: SQLite 打开失败 error14 的根因（沙箱重置后 db/ 目录随 gitignore 丢失）
curl -s --max-time 2 http://127.0.0.1:3000/api/health | rg -q '"ok":true' || OK=0
curl -s --max-time 2 http://127.0.0.1:3030/api/health | rg -q '"ok":true' || OK=0
# stealth（R109：三层架构侧车 :3031，iv8 + CloakBrowser；不可用时引擎自动跳过，不阻塞主链路）
# 注意：stealth 是可选组件，不计入 OK 早退条件，但每次都尽力拉起
# R110：健康探测失败≠没在跑（负载下 /health 会超时）——先看进程存活性，真没了才拉起，
# 防止高负载期每次调用都叠加一个 run.sh 实例（会互相抢 3031 端口崩溃循环）
if ! curl -s --max-time 2 http://127.0.0.1:3031/health | rg -q '"ok":true'; then
  if ! pgrep -f 'stealth-service/run.sh' >/dev/null 2>&1; then
    (cd "$ROOT/mini-services/stealth-service" && nohup ./run.sh >>/tmp/stealth.log 2>&1 &)
  fi
fi
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
