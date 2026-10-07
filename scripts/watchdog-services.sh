#!/usr/bin/env bash
# 沙箱看门狗（R102）：守护 backend-go(:3000) + scraper-go(:3030) + stealth-service(:3031)
# flock 独占：多实例并发启动时只有持有锁的实例工作（防互拉重复）。
# 用法：nohup bash scripts/watchdog-services.sh > /tmp/watchdog.log 2>&1 &
set -u
export PATH=$PATH:/home/z/go-sdk/go/bin
export GOPATH=/home/z/go
ROOT=/home/z/my-project
LOCK=/tmp/watchdog-services.lock

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "watchdog 已有实例在跑，退出"
  exit 0
fi

restart() { # name
  local name="$1"
  case "$name" in
    backend)
      curl -s --max-time 3 http://127.0.0.1:3000/api/health | rg -q '"ok":true' && return 0
      if [ ! -x "$ROOT/mini-services/backend-go/bin/backend-go" ]; then
        (cd "$ROOT/mini-services/backend-go" && go build -o bin/backend-go .) >>/tmp/backend-go.log 2>&1
      fi
      (cd "$ROOT" && DB_PATH=$ROOT/db/custom.db nohup "$ROOT/mini-services/backend-go/bin/backend-go" >>/tmp/backend-go.log 2>&1 &)
      ;;
    scraper)
      curl -s --max-time 3 http://127.0.0.1:3030/api/health | rg -q '"ok":true' && return 0
      if [ ! -x "$ROOT/mini-services/scraper-go/bin/scraper-go" ]; then
        (cd "$ROOT/mini-services/scraper-go" && go build -o bin/scraper-go .) >>/tmp/scraper-go.log 2>&1
      fi
      (cd "$ROOT/mini-services/scraper-go" && nohup ./bin/scraper-go >>/tmp/scraper-go.log 2>&1 &)
      ;;
    stealth)
      curl -s --max-time 3 http://127.0.0.1:3031/health | rg -q '"ok": *true' && return 0
      (cd "$ROOT/mini-services/stealth-service" && nohup bash run.sh >>/tmp/stealth.log 2>&1 &)
      ;;
  esac
  echo "[$(date +%H:%M:%S)] restarted $name"
}

echo "[$(date +%H:%M:%S)] watchdog started"
while true; do
  restart backend
  restart scraper
  restart stealth
  sleep 8
done
