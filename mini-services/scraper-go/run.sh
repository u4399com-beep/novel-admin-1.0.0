#!/usr/bin/env bash
# scraper-go 启动脚本：构建（增量，go build 缓存）+ 前台运行。
# 端口默认 3030（SCRAPER_PORT 可覆盖）；心跳/互监护等行为与 TS 版一致（见 main.go）。
set -euo pipefail
cd "$(dirname "$0")"

export PATH="$PATH:/home/z/go-sdk/go/bin"
export GOPATH="${GOPATH:-/home/z/go}"

mkdir -p bin
if command -v go >/dev/null 2>&1; then
  go build -o bin/scraper-go .
else
  echo "[scraper-go] go 工具链缺失，使用已有二进制 bin/scraper-go" >&2
fi
if [ ! -x bin/scraper-go ]; then
  echo "[scraper-go] 无可用二进制（bin/scraper-go 缺失且无 go 工具链）" >&2
  exit 1
fi

exec ./bin/scraper-go
