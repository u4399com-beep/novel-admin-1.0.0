#!/usr/bin/env bash
# LibreTranslate 侧车 :5000（R173：en/ja/ko 唯一引擎；zh-Hant/zh-HK 走 OpenCC 快通道不经此服务）。
# 依赖：venv（setup-venv.sh）+ 四模型（install-models.sh）。崩溃自动重启（2s 间隔）+ flock 单实例。
set -u
cd "$(dirname "$0")"

exec 9>/tmp/libretranslate.lock
if ! flock -n 9; then
  echo "[libretranslate] 已有实例在运行（flock 持有），退出" >&2
  exit 0
fi
echo $$ > /tmp/libretranslate.pid  # R182：pidfile 供 ensure-services.sh --restart 二段式重启

if [ -x "venv/bin/libretranslate" ]; then
  LT="venv/bin/libretranslate"
else
  LT="libretranslate"
fi

# R182：--load-only 按已装模型动态计算——模型面随 install-models.sh 渐进落地，
# 服务先以现有语种对绑定（零等待），每次重启自动扩宽（防启动期黑洞下载阻塞绑定：
# 索引缓存已过滤到 4 目标 pair，缺失 pair 由本进程补拉，装齐后即秒绑）。
PY="venv/bin/python3"
[ -x "$PY" ] || PY="python3"
LOAD_ONLY=$("$PY" -c "
from argostranslate import package
codes = set()
for p in package.get_installed_packages():
    codes.add(p.from_code); codes.add(p.to_code)
print(','.join(sorted(codes)) if codes else 'zh,en')
" 2>/dev/null)
[ -z "$LOAD_ONLY" ] && LOAD_ONLY="zh,en"
echo "[libretranslate] load-only=$LOAD_ONLY"

while true; do
  "$LT" --host 127.0.0.1 --port 5000 --load-only "$LOAD_ONLY" --threads 4
  code=$?
  echo "[libretranslate] exited code=$code, restart in 2s" >&2
  sleep 2
done
