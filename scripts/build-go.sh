#!/bin/bash
# build-go.sh —— 构建产物（Task 27 起：Go 单栈，Next.js 构建已拆除）。
# 产出：
#   mini-services/backend-go/backend-go.bin  （页面 SSR + API + runner，端口 3000）
#   mini-services/scraper-go/scraper-go.bin  （采集引擎，端口 3030）
#   mini-services/backend-go/web/static/css/tw.css（Tailwind 产物，模板类名变更后需重建）
# 部署见 docs/deployment.md（systemd 托管两进程）。
set -euo pipefail
cd "$(dirname "$0")/.."

export PATH="$PATH:/home/z/go-sdk/go/bin"
export GOPATH="${GOPATH:-/home/z/go}"

echo "[build-go] backend-go ..."
( cd mini-services/backend-go && go build -o backend-go.bin . )

echo "[build-go] scraper-go ..."
( cd mini-services/scraper-go && go build -o scraper-go.bin . )

echo "[build-go] tailwind css ..."
bun run build:css

echo "[build-go] done"
