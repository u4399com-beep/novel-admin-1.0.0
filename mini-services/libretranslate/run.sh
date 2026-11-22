#!/usr/bin/env bash
# libretranslate 侧车启动（R168）：开源 NMT 翻译引擎（LibreTranslate/Argos Translate，
# ctranslate2 CPU 推理，无 torch），端口 5000 固定（仅 127.0.0.1 内网，定位同
# translate-service :3032——backend/侧车内网调用，不经网关暴露公网）。
#
# 定位：translate-service 的「兜底/加速」引擎——LLM 文学翻译仍是质量首选，
# libre 在 LLM 失败（429/枯竭/超时）时垫底，保证全站翻译永不空白（R168）。
#
# 首次部署（详见 README.md）：
#   pip install libretranslate            # 阿里云镜像优先（清华对包文件 403）
#   bash install-models.sh                # 四模型 zh_en/en_zh/en_ja/en_ko + 句切 onnx
#
# 崩溃自动重启（2s 间隔，与 translate-service/stealth-service 同款形态）。
# flock 单实例闸（防 run.sh 自身被多重拉起）。
set -u
cd "$(dirname "$0")"

exec 9>/tmp/libretranslate.lock
if ! flock -n 9; then
  echo "[libretranslate] 已有实例在运行（flock 持有），退出" >&2
  exit 0
fi

# python 定位：venv 优先（libretranslate 装在 /home/z/.venv）
if [ -x "$HOME/.venv/bin/libretranslate" ]; then
  LT_BIN="$HOME/.venv/bin/libretranslate"
elif command -v libretranslate >/dev/null 2>&1; then
  LT_BIN="$(command -v libretranslate)"
else
  echo "[libretranslate] libretranslate 不可用：请先 pip install libretranslate（见 README.md）" >&2
  exit 1
fi

# LT_ARGS：额外启动参数透传（如 --load-only zh,en,ja,ko）
# 注意：--update-models 是布尔旗标（无 =false 语法）；不传即不联网检查模型更新
# （模型由 install-models.sh 预置，离线环境也能起）。
LT_ARGS="${LT_ARGS:---load-only zh,en,ja,ko --disable-web-ui}"

while true; do
  "$LT_BIN" --port 5000 --host 127.0.0.1 $LT_ARGS
  code=$?
  echo "[libretranslate] exited code=$code, restart in 2s" >&2
  sleep 2
done
