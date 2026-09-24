#!/usr/bin/env bash
# backend-go 启动脚本：构建（增量，go build 缓存）+ 前台运行。
# 端口默认 3000（BACKEND_PORT 可覆盖，3005 仅为 Task 24-26 迁移期兼容值）；
# 模式默认 all（BACKEND_MODE=api|runner|all）。
set -euo pipefail
cd "$(dirname "$0")"

export PATH="$PATH:/home/z/go-sdk/go/bin"
export GOPATH="${GOPATH:-/home/z/go}"

if command -v go >/dev/null 2>&1; then
  go build -o backend-go.bin .
else
  echo "[backend-go] go 工具链缺失，使用已有二进制" >&2
fi

exec ./backend-go.bin
