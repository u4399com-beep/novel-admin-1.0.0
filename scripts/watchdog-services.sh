#!/usr/bin/env bash
# 沙箱看门狗（R102）：守护 backend-go(:3000) + scraper-go(:3030) + stealth-service(:3031)
# flock 独占：多实例并发启动时只有持有锁的实例工作（防互拉重复）。
# 用法：nohup bash scripts/watchdog-services.sh > /tmp/watchdog.log 2>&1 &
#
# R116 反脆弱改造（OOM crash-loop 实证复盘：stealth 2h 内被杀 26 次、backend 被杀 1 次、
# watchdog 自身 fork 耗尽连环误判）：
# 1. 连续失败闸：探活连续 FAIL_STRIKES 次失败才判死重启——忙时 /health 慢一次、
#    fork 耗尽导致 curl 无法派生等瞬时故障不再触发重启（旧版一次超时立即 spawn）。
# 2. stealth 探活超时 3→8s：Python GIL + 浏览器 cloak/iv8 请求进行中时 /health
#    延迟可达 5s+（R111 红线「/health 超时≠死亡」的 watchdog 侧落地）。
# 3. 重启防抖：每服务 RESTART_COOLDOWN_S 内不重复重启（run.sh 自带 2s 崩溃重启环 +
#    flock 单实例闸，watchdog 只兜底「真正死亡」，不再制造 flock 空转日志噪音）。
# 4. 内存水位观测：MemAvailable 低于警戒线时节流记录（OOM 取证：内核击杀前留档）。
# 5. 【R116 实证根修】fd 泄漏：旧版 flock fd 9 被 nohup 子进程继承——旧 watchdog 死亡后
#    锁仍被存活的 backend-go 持有，新 watchdog 永远拿不到锁=保护永久失效（本轮实证：
#    watchdog 死亡后 backend-go 长期占用 /tmp/watchdog-services.lock，无任何看护）。
#    修复：spawn 时 9>&- 显式关闭；锁文件升级 v2（旧锁被存量进程持有，等其自然退出）。
set -u
export PATH=$PATH:/home/z/go-sdk/go/bin
export GOPATH=/home/z/go
ROOT=/home/z/my-project
LOCK=/tmp/watchdog-services-v2.lock # v2：旧锁被存量 backend-go 继承 fd 占用（见头注⑤）

FAIL_STRIKES=2          # 连续 N 次探活失败才判死
RESTART_COOLDOWN_S=60   # 同服务两次重启之间的最小间隔
PROBE_TIMEOUT_BACKEND=5
PROBE_TIMEOUT_SCRAPER=5
PROBE_TIMEOUT_STEALTH=8 # R116: GIL/浏览器忙时 /health 慢，旧 3s 必误判
MEM_GUARD_MB=400        # MemAvailable 低于此值记录告警（节流 5min）

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "watchdog 已有实例在跑，退出"
  exit 0
fi

declare -A FAILS       # 服务连续失败计数
declare -A LAST_RESTART

now_s() { date +%s; }

mem_guard_log() {
  local avail_kb now last
  avail_kb=$(awk '/MemAvailable/{print $2}' /proc/meminfo 2>/dev/null || echo 0)
  [ "$avail_kb" -ge $((MEM_GUARD_MB * 1024)) ] && return 0
  now=$(now_s)
  last=${MEM_LAST_LOG:-0}
  if [ $((now - last)) -ge 300 ]; then
    echo "[$(date +%H:%M:%S)] [mem-guard] MemAvailable $((avail_kb / 1024))MB < ${MEM_GUARD_MB}MB（OOM 风险观测点：若随后出现进程被杀，优先查 stealth chrome 树内存）"
    MEM_LAST_LOG=$now
  fi
  return 0
}

restart() { # name probe_url probe_timeout
  local name="$1" url="$2" timeout="$3"
  mem_guard_log
  local body ok=0
  # curl 派生失败（fork 耗尽）时 body 为空且退出码非 0——与探活失败同口径计入连败，
  # 由 FAIL_STRIKES + 冷却双闸防误重启（瞬时资源耗尽不迁移成重启风暴）。
  body=$(curl -s --max-time "$timeout" "$url" 2>/dev/null) || body=""
  case "$body" in
    *'"ok":true'*|'"ok": *true'*) ok=1 ;;
  esac
  if [ "$ok" = 1 ]; then
    if [ "${FAILS[$name]:-0}" -gt 0 ]; then
      echo "[$(date +%H:%M:%S)] $name 探活恢复（此前连败 ${FAILS[$name]} 次，未重启过——瞬时故障被连败闸吸收）"
    fi
    FAILS[$name]=0
    return 0
  fi

  local n=$(( ${FAILS[$name]:-0} + 1 ))
  FAILS[$name]=$n
  if [ "$n" -lt "$FAIL_STRIKES" ]; then
    return 0 # 未达连败阈值：观察，不动作
  fi

  local now last
  now=$(now_s)
  last=${LAST_RESTART[$name]:-0}
  if [ $((now - last)) -lt "$RESTART_COOLDOWN_S" ]; then
    return 0 # 防抖冷却期内：不重复重启（run.sh/flock 自愈环已覆盖瞬态）
  fi
  LAST_RESTART[$name]=$now
  FAILS[$name]=0

  case "$name" in
    backend)
      if [ ! -x "$ROOT/mini-services/backend-go/bin/backend-go" ]; then
        (cd "$ROOT/mini-services/backend-go" && go build -o bin/backend-go .) >>/tmp/backend-go.log 2>&1
      fi
      # 9>&-：关闭继承的 flock fd（R116 ⑤），子进程不再钉住看门狗锁
      (cd "$ROOT" && DB_PATH=$ROOT/db/custom.db nohup "$ROOT/mini-services/backend-go/bin/backend-go" >>/tmp/backend-go.log 2>&1 9>&- &)
      ;;
    scraper)
      if [ ! -x "$ROOT/mini-services/scraper-go/bin/scraper-go" ]; then
        (cd "$ROOT/mini-services/scraper-go" && go build -o bin/scraper-go .) >>/tmp/scraper-go.log 2>&1
      fi
      (cd "$ROOT/mini-services/scraper-go" && nohup ./bin/scraper-go >>/tmp/scraper-go.log 2>&1 9>&- &)
      ;;
    stealth)
      (cd "$ROOT/mini-services/stealth-service" && nohup bash run.sh >>/tmp/stealth.log 2>&1 9>&- &)
      ;;
  esac
  echo "[$(date +%H:%M:%S)] restarted $name（连败 $FAIL_STRIKES 次达阈值，冷却 ${RESTART_COOLDOWN_S}s）"
}

echo "[$(date +%H:%M:%S)] watchdog started（R116 反脆弱版：连败闸=$FAIL_STRIKES 防抖=${RESTART_COOLDOWN_S}s stealth探活=${PROBE_TIMEOUT_STEALTH}s）"
while true; do
  restart backend  http://127.0.0.1:3000/api/health "$PROBE_TIMEOUT_BACKEND"
  restart scraper  http://127.0.0.1:3030/api/health "$PROBE_TIMEOUT_SCRAPER"
  restart stealth  http://127.0.0.1:3031/health     "$PROBE_TIMEOUT_STEALTH"
  sleep 8
done