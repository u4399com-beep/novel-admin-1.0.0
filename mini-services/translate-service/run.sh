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
if ! flock -w 20 9; then
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

# R173 终局（R186 落定）：LLM 兜底正式退出——en/ja/ko 四模型全载（:5000 languages
# 实证）、libre 稳态承载（libreSegs 持续增长、libreFails <0.5%）、llmFallbacks 仅存于
# :5000 重启窗口事件（非稳态路径，R185-c 同树守护子循环已把空窗压到 30s 级）。关闭后
# 窗口期失败段留空由幂等队列/transbulk 重试重消化（诚实契约：失败段不编造）。
# 回退方式：删掉下行 export 或置 0（index.ts L293 开关读数）。
export TRANSLATE_LLM_FALLBACK_OFF=1

# R169：bundle 优先，源码回退（回退前自动补装依赖，抢清杀器时间窗需原子链）
if [ -f "dist/translate-service.js" ]; then
  RUNNER=("$BUN" "dist/translate-service.js")
else
  [ -d node_modules ] || "$BUN" install >/dev/null 2>&1 || true
  RUNNER=("$BUN" "run" "index.ts")
fi

while true; do
  # TRANSLATE_LLM_FALLBACK_OFF 经 export 对子进程持续生效（崩溃重启循环内不丢）
  "${RUNNER[@]}"
  code=$?
  echo "[translate-service] exited code=$code, restart in 2s" >&2
  sleep 2
done
