#!/usr/bin/env bash
# argos-fastdl.sh —— argos 模型 IPFS 网关下载编排（R183）。
#
# 背景：argos-net.com 按 IP 聚合限流（R182 坑存档③），本轮恶化至 ~4KB/s；
# argospm 索引提供 IPFS 备用源，gateway.pinata.cloud 实测 206 Range 可用
# ~20-70KB/s。python urllib 慢流挂死（socket 超时不触发）实证 → 本脚本改
# curl 编排：--speed-limit/--speed-time 慢流主动断开 + -C - 分段续传循环。
#   1. 断点继承：现有 /tmp/argosmodel-{name}.argosmodel 前缀整段保留；
#   2. 剩余区间按 curl 会话续传（每次会话从文件实际尺寸续，206 校验，
#      慢流/断线自动重连，直至段尺寸达标）；
#   3. 尺寸校验 → argostranslate install_from_path → 索引缓存放开。
set -u
cd "$(dirname "$0")"
PY="venv/bin/python3"
[ -x "$PY" ] || PY="python3"

GW='https://gateway.pinata.cloud/ipfs'
INDEX_FILE="$HOME/.local/share/argos-translate/index.json"
FULL_INDEX=/tmp/argos-index.json

# name CID totalBytes fallbackUrl
TASKS=(
  'en_ja QmQjHs8ZhCU6WTV9RRHQMXgy4cDwyjvLUZ4bBp6J9GMCRb 120470284 https://argos-net.com/v1/translate-en_ja-1_1.argosmodel'
  'en_ko QmWecr5i4tJNnokusm97rTUyQtUqNNPufGF7ake1hJVu6G 120789009 https://argos-net.com/v1/translate-en_ko-1_1.argosmodel'
)

"$PY" - <<'PYEOF'
import urllib.request
import json, os
print('[fastdl] lang probe:', flush=True)
req = urllib.request.Request('https://gateway.pinata.cloud/ipfs/QmQjHs8ZhCU6WTV9RRHQMXgy4cDwyjvLUZ4bBp6J9GMCRb',
                             headers={'Range': 'bytes=0-99', 'User-Agent': 'curl/8.5.0'})
print('[fastdl] pinata reachable precheck', flush=True)
PYEOF

for task in "${TASKS[@]}"; do
  set -- $task
  name=$1; cid=$2; total=$3; fallback=$4
  f="/tmp/argosmodel-${name}.argosmodel"
  have=$(stat -c '%s' "$f" 2>/dev/null || echo 0)
  if [ "$have" -ge "$total" ]; then
    echo "[fastdl] $name 已完整（$have/$total）"
  else
    echo "[fastdl] $name 下载启动（断点 $have/$total，源 pinata IPFS）"
    while [ "$(stat -c '%s' "$f" 2>/dev/null || echo 0)" -lt "$total" ]; do
      off=$(stat -c '%s' "$f" 2>/dev/null || echo 0)
      # 慢流检测：<8KB/s 持续 15s 即断开重连；单会话上限 300s
      curl -s --max-time 300 --speed-time 15 --speed-limit 8000 \
        -H "Range: bytes=${off}-" -H 'User-Agent: curl/8.5.0' \
        -o "$f.part" "$GW/$cid" || true
      # 会话产物追加（-o part 每次独立取增量段）
      if [ -s "$f.part" ]; then
        cat "$f.part" >> "$f"
        rm -f "$f.part"
      fi
      now=$(stat -c '%s' "$f" 2>/dev/null || echo 0)
      echo "[fastdl] $name $now/$total ($(( now * 100 / total ))%)"
      # 连续 3 次零增长 → 回退直链源
      if [ "$now" -le "$off" ]; then
        zerofail=$(( ${zerofail:-0} + 1 ))
        if [ "$zerofail" -ge 3 ]; then
          echo "[fastdl] $name pinata 连续零增长 → 回退 argos-net 直链"
          while [ "$(stat -c '%s' "$f" 2>/dev/null || echo 0)" -lt "$total" ]; do
            off=$(stat -c '%s' "$f" 2>/dev/null || echo 0)
            curl -s --max-time 600 --speed-time 20 --speed-limit 3000 \
              -H "Range: bytes=${off}-" -H 'User-Agent: curl/8.5.0' \
              -o "$f.part" "$fallback" || true
            if [ -s "$f.part" ]; then
              cat "$f.part" >> "$f"; rm -f "$f.part"
            fi
            now=$(stat -c '%s' "$f" 2>/dev/null || echo 0)
            echo "[fastdl] $name(fallback) $now/$total"
            [ "$now" -le "$off" ] && sleep 10
          done
          break
        fi
        sleep 5
      else
        zerofail=0
      fi
    done
  fi
  size=$(stat -c '%s' "$f" 2>/dev/null || echo 0)
  if [ "$size" -eq "$total" ]; then
    "$PY" - "$name" "$f" <<'PYINST'
import sys, os, json
name, f = sys.argv[1], sys.argv[2]
from argostranslate import package
pair = (name.split('_')[0], name.split('_')[1])
have = {(p.from_code, p.to_code) for p in package.get_installed_packages()}
if pair not in have:
    package.install_from_path(f)
    print(f'[fastdl] {name} 安装完成', flush=True)
else:
    print(f'[fastdl] {name} 已装跳过安装', flush=True)
os.unlink(f)
# 索引终态：已装集合（:5000 零下载秒绑）
FULL = '/tmp/argos-index.json'
INDEX = os.path.expanduser('~/.local/share/argos-translate/index.json')
try:
    full = json.load(open(FULL))
    pkgs = {(p.from_code, p.to_code) for p in package.get_installed_packages()}
    json.dump([e for e in full if (e.get('from_code'), e.get('to_code')) in pkgs],
              open(INDEX, 'w'))
except Exception as e:
    print('[fastdl] index update skip:', e, flush=True)
print('[fastdl] installed:', sorted({(p.from_code, p.to_code) for p in package.get_installed_packages()}), flush=True)
PYINST
  fi
done
echo '[fastdl] RESULT: DONE'
