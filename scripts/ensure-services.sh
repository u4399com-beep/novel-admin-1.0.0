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
# translate（R137：阅读页翻译侧车 :3032，OpenCC 繁体 + LLM 英文；可选组件不进 OK 早退，
# 拉起模式与 stealth 同构：进程存活判断防 flock 竞争，缺失依赖时 run.sh 日志明示）
if [ -f "$ROOT/mini-services/translate-service/index.ts" ] \
   && [ -f "$ROOT/mini-services/translate-service/node_modules/opencc-js/package.json" ]; then
  if ! curl -s --max-time 2 http://127.0.0.1:3032/api/health | rg -q '"ok":true'; then
    if ! pgrep -f 'translate-service/run.sh' >/dev/null 2>&1; then
      (cd "$ROOT/mini-services/translate-service" && nohup ./run.sh >>/tmp/translate-service.log 2>&1 &)
    fi
  fi
fi
# libretranslate（R168：LibreTranslate 兜底引擎 :5000，LLM 失败段垫底；可选组件不进 OK
# 早退，拉起模式与 stealth/translate 同构。libretranslate 未安装时 run.sh 日志明示，
# translate-service 探针熔断自动跳过 libre——不阻塞主链路）
if [ -x "$HOME/.venv/bin/libretranslate" ] || command -v libretranslate >/dev/null 2>&1; then
  if ! curl -s --max-time 2 http://127.0.0.1:5000/languages >/dev/null 2>&1; then
    if ! pgrep -f 'libretranslate/run.sh' >/dev/null 2>&1; then
      (cd "$ROOT/mini-services/libretranslate" && nohup ./run.sh >>/tmp/libretranslate.log 2>&1 &)
    fi
  fi
fi
[ "$OK" = "1" ] && exit 0
# backend
if ! curl -s --max-time 2 http://127.0.0.1:3000/api/health | rg -q '"ok":true'; then
  # R151: run.sh 循环重启包装拉起（与 stealth 同架构）——沙箱会话清理会周期性杀死
  # 后台单进程（实证 60-90s），父循环立即重生；flock 单实例闸防重叠
  (cd "$ROOT/mini-services/backend-go" && nohup ./run.sh >>/tmp/backend-go.log 2>&1 &)
fi
# scraper
if ! curl -s --max-time 2 http://127.0.0.1:3030/api/health | rg -q '"ok":true'; then
  # R151: 同 backend，走 run.sh（内含 engine.env source + flock + 循环重启）
  (cd "$ROOT/mini-services/scraper-go" && nohup ./run.sh >>/tmp/scraper-go.log 2>&1 &)
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
