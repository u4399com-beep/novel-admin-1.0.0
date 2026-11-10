#!/usr/bin/env bash
# translate-service 启动（R137）：繁体 OpenCC + 英文 LLM 翻译侧车，端口 3032 固定。
# 依赖：bun（opencc-js / z-ai-web-dev-sdk；SDK 缺失时服务仍起，英文翻译 503 明确报错，
# 繁体能力不受影响）。崩溃自动重启（2s 间隔）。flock 单实例闸（仿 stealth-service R110）。
set -u
cd "$(dirname "$0")"

exec 9>/tmp/translate-service.lock
if ! flock -n 9; then
  echo "[translate-service] 已有实例在运行（flock 持有），退出" >&2
  exit 0
fi

# bun 运行时定位（PATH 无 bun 时尝试常见位置）
if command -v bun >/dev/null 2>&1; then
  RUNNER=(bun run index.ts)
elif [ -x "$HOME/.bun/bin/bun" ]; then
  RUNNER=("$HOME/.bun/bin/bun" run index.ts)
else
  echo "[translate-service] bun 不可用，无法启动" >&2
  exit 1
fi

while true; do
  "${RUNNER[@]}"
  code=$?
  echo "[translate-service] exited code=$code, restart in 2s" >&2
  sleep 2
done
