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
set -euo pipefail
cd "$(dirname "$0")/.."

export PATH="$PATH:/home/z/go-sdk/go/bin"
export GOPATH="${GOPATH:-/home/z/go}"

echo "[build-go] backend-go ..."
( cd mini-services/backend-go && go build -o backend-go.bin . )

echo "[build-go] scraper-go ..."
( cd mini-services/scraper-go && go build -o scraper-go.bin . )

echo "[build-go] done"
