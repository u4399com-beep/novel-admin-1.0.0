#!/usr/bin/env bash
# LibreTranslate 模型一键安装（R168）——小说站四语种最小集：
#   zh→en、en→zh、en→ja、en→ko（zh→ja/zh→ko 由 LibreTranslate 经 en pivot 自动接通）
# + minisbd 句切 onnx（en/zh-hans/ja/ko，首翻惰性下载会被沙箱/离线环境卡死，此处预置）。
#
# 模型通道：
#   - argos 模型：argos-net.com（直连即可；argosopentech S3 旧 bucket 已废弃勿用）
#   - minisbd onnx：GitHub Releases（直连失败自动走 ghfast.top 代理）
# 支持断点续传（curl -C -），失败重跑即可。
set -u

LT_DIR="$HOME/.local/share/argos-translate"
PKG_DIR="$LT_DIR/packages"
MODEL_DIR="${MODEL_DIR:-/tmp/argos-models}"
SBD_DIR="$HOME/.cache/minisbd"

# pip 安装引导（幂等）
if ! command -v libretranslate >/dev/null 2>&1 && [ ! -x "$HOME/.venv/bin/libretranslate" ]; then
  echo "[install-models] 未检测到 libretranslate，开始 pip 安装…"
  pip3 install libretranslate -i https://mirrors.aliyun.com/pypi/simple/ \
    || pip3 install libretranslate \
    || pip3 install libretranslate -i https://pypi.tuna.tsinghua.edu.cn/simple/
fi

mkdir -p "$MODEL_DIR" "$SBD_DIR"

# ---------- argos 模型（~370MB） ----------
# 版本号对应 argospm-index（argos-translate-lt 1.12.1 运行时）
MODELS=(
  "zh_en|translate-zh_en-1_9|74481402"
  "en_zh|translate-en_zh-1_9|70743021"
  "en_ja|translate-en_ja-1_1|120470284"
  "en_ko|translate-en_ko-1_1|120789009"
)

fetch() { # url out expect_size
  local url="$1" out="$2" want="${3:-0}" have cur
  have=$(stat -c%s "$out" 2>/dev/null || echo 0)
  if [ "$want" -gt 0 ] && [ "$have" -ge "$want" ]; then
    echo "[models] 已存在（$have B）：$out"; return 0
  fi
  for i in 1 2 3 4 5; do
    curl -L -C - --max-time 270 -o "$out" "$url" && return 0
    cur=$(stat -c%s "$out" 2>/dev/null || echo 0)
    echo "[models] 重试 $i（已下 $cur B）"; sleep 2
  done
  return 1
}

for entry in "${MODELS[@]}"; do
  IFS='|' read -r name file size <<<"$entry"
  echo "[models] $name ..."
  fetch "https://argos-net.com/v1/$file.argosmodel" "$MODEL_DIR/$name.argosmodel" "$size" || {
    echo "[models] FAIL: $name"; exit 1
  }
done

# 安装进 argos 运行时（幂等：已装跳过）
python3 - "$MODEL_DIR" <<'PY'
import glob, sys
from argostranslate import package
have = {(p.from_code, p.to_code) for p in package.get_installed_packages()}
for f in sorted(glob.glob(sys.argv[1] + "/*.argosmodel")):
    codes = []
    try:
        pkg = package.get_package_from_path(f)
        codes = [pkg.from_code, pkg.to_code]
    except Exception:
        pass
    if len(codes) == 2 and tuple(codes) in have:
        print(f"[install] 已装 {codes[0]}->{codes[1]}，跳过 {f.split('/')[-1]}")
        continue
    package.install_from_path(f)
    print(f"[install] installed: {f.split('/')[-1]}")
PY

# ---------- minisbd 句切 onnx（<1MB each） ----------
SBD_BASE="https://github.com/LibreTranslate/MiniSBD/releases/download/v0.0.1"
for lang in en zh-hans ja ko; do
  out="$SBD_DIR/$lang.onnx"
  if [ -s "$out" ]; then echo "[sbd] 已存在：$lang.onnx"; continue; fi
  if ! curl -sfL --max-time 30 -o "$out" "$SBD_BASE/$lang.onnx"; then
    echo "[sbd] 直连失败，走 ghfast.top 代理…"
    curl -sfL --max-time 30 -o "$out" "https://ghfast.top/$SBD_BASE/$lang.onnx" \
      || { echo "[sbd] FAIL: $lang.onnx"; rm -f "$out"; exit 1; }
  fi
  echo "[sbd] ok: $lang.onnx ($(stat -c%s "$out") B)"
done

echo "[install-models] 完成。启动：bash run.sh（或交给 ensure-services.sh）"
