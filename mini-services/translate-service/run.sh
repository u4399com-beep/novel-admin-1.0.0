#!/usr/bin/env bash
# translate-service 启动（R137）：繁体 OpenCC + 英文 LLM 翻译侧车，端口 3032 固定。
# R169：bundle 优先——dist/translate-service.js 单文件自包含（bun build --target=bun
# 产物，opencc-js/z-ai-web-dev-sdk 全部内联），免疫沙箱磁盘高压清杀 node_modules
# （2026-11-22 实测：93% 水位清杀器秒级反复清除 node_modules，源码模式重启即崩）。
# bundle 缺失时回退源码模式（自动补装依赖）。SDK 缺失时服务仍起，英文翻译 503 明确
# 报错，繁体能力不受影响。崩溃自动重启（2s 间隔）。flock 单实例闸（仿 stealth R110）。
# 重建 bundle：cd mini-services/translate-service && bun install && \
#   bun build index.ts --target=bun --outfile dist/translate-service.js && rm -rf node_modules
set -u
cd "$(dirname "$0")"

exec 9>/tmp/translate-service.lock
if ! flock -n 9; then
  echo "[translate-service] 已有实例在运行（flock 持有），退出" >&2
  exit 0
fi

# bun 运行时定位（PATH 无 bun 时尝试常见位置）
if command -v bun >/dev/null 2>&1; then
  BUN=bun
elif [ -x "$HOME/.bun/bin/bun" ]; then
  BUN="$HOME/.bun/bin/bun"
else
  echo "[translate-service] bun 不可用，无法启动" >&2
  exit 1
fi

# R169：bundle 优先，源码回退（回退前自动补装依赖，抢清杀器时间窗需原子链）
if [ -f "dist/translate-service.js" ]; then
  RUNNER=("$BUN" "dist/translate-service.js")
else
  [ -d node_modules ] || "$BUN" install >/dev/null 2>&1 || true
  RUNNER=("$BUN" "run" "index.ts")
fi

while true; do
  "${RUNNER[@]}"
  code=$?
  echo "[translate-service] exited code=$code, restart in 2s" >&2
  sleep 2
done
