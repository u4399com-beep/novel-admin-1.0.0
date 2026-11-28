#!/usr/bin/env bash
# backend-go 启动（run.sh 循环重启包装，与 stealth-service/run.sh 同架构）：
# 沙箱的会话清理会周期性杀死后台单进程（R151 实证：setsid/nohup 直拉的
# backend-go 与 scraper-go 均在 60-90s 内被静默清除，而 stealth 的 run.sh
# 无限循环架构存活至今——清杀手只杀子进程，父循环立即重生）。
# 依赖：DB_PATH（缺省 {repoRoot}/db/custom.db，repoRoot 按 paths.go 解析链）。
# flock 单实例闸（R110 同款：多实例并存会抢 3000 端口崩溃循环）。
# R169：translate-service 同树守护——本循环挂在平台进程树（bun-dev 包装链）下，
# 实证幸存 3h+；agent shell 直启的 run.sh 循环数分钟内被静默清除（本轮多次实证：
# translate run.sh/watchdog 三度阵亡而本循环安然无恙）。translate 侧车（:3032，
# libre 兜底+预热工作器关键依赖）挂靠本循环内的常驻守护子循环重生，死亡 ≤38s 自愈。
set -u
cd "$(dirname "$0")"

exec 9>/tmp/backend-go.lock
if ! flock -n 9; then
  echo "[backend-go] 已有实例在运行（flock 持有），退出" >&2
  exit 0
fi

DB_FILE="${DB_PATH:-$(cd ../.. && pwd)/db/custom.db}"
mkdir -p "$(dirname "$DB_FILE")"

# R169：translate-service 同树守护子循环（本循环的子进程=平台树成员，随本循环长存；
# :3032 健康失败即拉起 translate run.sh（bundle 优先模式），flock 单实例闸防重复。
# 30s 巡检间隔：translate 死亡最坏 38s 内复活（run.sh 自身另有 2s 崩溃重启环）。
# 9>&- 关闭继承的 backend flock fd（R116 ⑤：不钉住看门狗锁）。
(
  while true; do
    if ! curl -s --max-time 2 http://127.0.0.1:3032/api/health >/dev/null 2>&1; then
      if ! pgrep -f 'translate-service' >/dev/null 2>&1; then
        # 前台派生（不套外层括号）：translate run.sh 成为守护子循环的直系子进程，
        # 挂靠本树幸存（双重 fork 会孤儿化到 ppid=1 成为清杀手靶标——本轮实测）
        cd ../translate-service && nohup bash run.sh >>/tmp/translate-service.log 2>&1 9>&- &
        cd "$OLDPWD" || cd ../backend-go
      fi
    fi
    sleep 30
  done
) &

# R185：libretranslate 同树守护（:5000 四语种模型装载 ~20s，探活给足裕量；
# run.sh 自带 flock 单实例闸。未安装 venv 时静默跳过——translate 探针熔断自愈）
(
  while true; do
    if ! curl -s --max-time 6 http://127.0.0.1:5000/languages >/dev/null 2>&1; then
      if ! pgrep -f 'libretranslate' >/dev/null 2>&1; then
        if [ -x ../libretranslate/venv/bin/libretranslate ] || [ -x "$HOME/.local/share/lt-venv/bin/libretranslate" ] || command -v libretranslate >/dev/null 2>&1; then
          cd ../libretranslate && nohup bash run.sh >>/tmp/libretranslate.log 2>&1 9>&- &
          cd "$OLDPWD" || cd ../backend-go
        fi
      fi
    fi
    sleep 30
  done
) &

while true; do
  DB_PATH="$DB_FILE" ./bin/backend-go
  code=$?
  echo "[backend-go] exited code=$code, restart in 2s" >&2
  sleep 2
done
