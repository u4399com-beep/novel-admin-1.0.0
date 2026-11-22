#!/usr/bin/env bash
# CloakBrowser chromium-146 断点续传下载循环（R156：官方 301 → GitHub CloakHQ releases，ghfast 镜像）
set -u
URL="https://ghfast.top/https://github.com/CloakHQ/cloakbrowser/releases/download/chromium-v146.0.7680.177.5/cloakbrowser-linux-x64.tar.gz"
DEST="/home/z/.cloakbrowser/cloakbrowser-linux-x64.tar.gz"
mkdir -p /home/z/.cloakbrowser
for i in $(seq 1 60); do
  sz=$(stat -c%s "$DEST" 2>/dev/null || echo 0)
  if [ "$sz" -ge 216000000 ]; then echo "[cloak-dl] done size=$sz round=$i"; break; fi
  echo "[cloak-dl] round=$i resume from $sz"
  curl -fsSL -C - -o "$DEST" "$URL" --max-time 120 || sleep 2
done
sz=$(stat -c%s "$DEST" 2>/dev/null || echo 0)
echo "[cloak-dl] final size=$sz"
if [ "$sz" -ge 216000000 ]; then
  cd /home/z/.cloakbrowser && tar -xzf cloakbrowser-linux-x64.tar.gz && echo "[cloak-dl] extracted OK"
fi
