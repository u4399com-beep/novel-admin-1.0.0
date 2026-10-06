#!/bin/bash
# build-go.sh —— 构建产物（Task 27 起：Go 单栈，Next.js 构建已拆除；
# Task 58 起：零 Node/TS——bun/Tailwind 构建期管线拆除，tw.css 为仓库内 vendored 资产）。
# 产出：
#   mini-services/backend-go/backend-go.bin  （页面 SSR + API + runner，端口 3000）
#   mini-services/scraper-go/scraper-go.bin  （采集引擎，端口 3030）
# 说明：
#   web/static/css/tw.css 已固化进仓库（与当前模板类名同步），本脚本不再重新生成。
#   若模板新增工具类导致样式缺失，用 go run ./scripts/csscheck 检测漂移后按
#   docs/deployment.md §CSS 的手动再生流程处理（一次性、非运行时依赖）。
# 部署见 docs/deployment.md（systemd 托管两进程）。
# R90：工具链定位环境自适应——通用路径（/usr/local/go）优先探测，沙箱布局兜底，
#   GOPROXY 缺省走 goproxy.cn（国内服务器开箱即用，海外经 proxy 直连回退不受影响）。
set -euo pipefail
cd "$(dirname "$0")/.."

# ---- Go 工具链定位：PATH 已有 → /usr/local/go → 沙箱 /home/z/go-sdk ----
if ! command -v go >/dev/null 2>&1; then
  for cand in /usr/local/go/bin /home/z/go-sdk/go/bin; do
    if [ -x "$cand/go" ]; then
      export PATH="$PATH:$cand"
      break
    fi
  done
fi
command -v go >/dev/null 2>&1 || { echo "[build-go] ERROR: go 不在 PATH，且 /usr/local/go/bin、/home/z/go-sdk/go/bin 均未找到。请先安装 Go >= 1.22（国内: bash scripts/deploy-cn.sh 自动处理）" >&2; exit 1; }
export GOPATH="${GOPATH:-$HOME/go}"
# 国内模块代理：goproxy.cn 官方推荐写法（direct 兜底直连；sumdb 校验经 proxy 端点透传，完整性不降级）
export GOPROXY="${GOPROXY:-https://goproxy.cn,direct}"

echo "[build-go] go=$(command -v go) GOPROXY=$GOPROXY"
echo "[build-go] backend-go ..."
( cd mini-services/backend-go && go build -o backend-go.bin . )

echo "[build-go] scraper-go ..."
( cd mini-services/scraper-go && go build -o scraper-go.bin . )

echo "[build-go] done"
