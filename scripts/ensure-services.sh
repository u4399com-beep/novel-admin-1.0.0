#!/bin/bash
# 服务看护（精简版 watchdog）：只负责采集后端与引擎的存活拉起（幂等）。
# Task 27 更新：页面 SSR+API+runner 全在 backend-go 单进程（BACKEND_MODE=all，端口 3000），
# 由根 dev 链路（scripts/dev-go.sh）首选拉起与自愈；本脚本仅作二级兜底：
#   - backend-go 3000 不通 → 直接拉起 backend-go.bin（all 模式：页面+API+runner，Task 27 起 3000 由 Go 直接承载）
#   - 引擎 3030 不通 → 拉起 scraper-go.bin（Go 引擎，Task 13 起 TS 引擎已退役）
# 注意：绝不再拉起 TS 版 scripts/worker-runner.ts —— 它与 Go runner 会双写 ScrapeTask
# （防重 Set 是进程内的，双进程会重复执行同一任务）。心跳文件检测已改为后端端口探测，
# 避免「backend-go 活着但心跳文件尚未刷新」的竞态误判。
# 刻意不管前端进程拓扑（Task 27 起 3000=backend-go 自身）；历史教训：拉起 dev3001 会与 3000
# 实例竞争 .next 编译缓存导致 crash（14-b 实训教训），绝不恢复该行为。
# 用法：配合定时任务每分钟执行（self-healing）；也可手动 bash scripts/ensure-services.sh
# R90：repo 根改由脚本自身位置推断（任意部署路径自适应；deploy-cn.sh watchdog 复用本脚本）。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT" || exit 9

# 启动环境变量（R90：与 backend-go paths.go 解析链同源显式注入，任意部署路径正确）
BACKEND_DIR="$ROOT/mini-services/backend-go"
ENGINE_DIR="$ROOT/mini-services/scraper-go"
BACKEND_ENV=(env BACKEND_PORT=3000 BACKEND_MODE=all
  DB_PATH="$ROOT/db/custom.db"
  TXT_ROOT="$ROOT/download/novels"
  COVERS_DIR="$ROOT/public/covers")

# 业务后端 + 采集 runner（backend-go all 模式 :3000）
if ! curl -s -o /dev/null --max-time 5 http://127.0.0.1:3000/api/health; then
  # 先清残留（防端口占用互斥启动失败）
  pkill -f 'backend-go[.]bin' 2>/dev/null && sleep 1
  # 启动前刷新心跳文件，防其他看护者误判 runner 已死
  touch /tmp/scrape-runner-heartbeat 2>/dev/null
  cd "$BACKEND_DIR" && \
    setsid nohup "${BACKEND_ENV[@]}" ./backend-go.bin >> /tmp/backend-go-api.log 2>&1 </dev/null &
  echo "[$(date '+%H:%M:%S')] watchdog: backend-go(all) 拉起" >> /tmp/watchdog.log
  cd "$ROOT"
fi

# 采集引擎 :3030（scraper-go；TS 版 scraper-service 仅作回滚备份不再运行）
curl -s -o /dev/null --max-time 5 http://127.0.0.1:3030/api/strategies || {
  pkill -f 'scraper-[g]o.bin' 2>/dev/null && sleep 1
  cd "$ENGINE_DIR" && \
    setsid nohup ./scraper-go.bin >> /tmp/engine.log 2>&1 </dev/null &
  echo "[$(date '+%H:%M:%S')] watchdog: engine(scraper-go) 拉起" >> /tmp/watchdog.log
  cd "$ROOT"
}

echo "[$(date '+%H:%M:%S')] checked: backend=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/api/health) engine=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3030/api/strategies)" >> /tmp/watchdog.log
