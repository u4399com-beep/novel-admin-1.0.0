#!/bin/bash
# Task 58 起零 Node：直接调用纯 Go 构建（原 bun install + bun run build shim 已无必要）
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"
bash scripts/build-go.sh
