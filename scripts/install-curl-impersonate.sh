#!/usr/bin/env bash
# 重装 curl-impersonate 二进制（v0.6.1 x86_64-linux-gnu，21 个）到 ~/.local/bin
# 供现行 Go 引擎 scraper-go（:3030）curl-impersonate / fetch-curl 策略调用；
# 沙箱会周期性清理 ~/.local/bin（已发生两次）；引擎侧已有 60s 空结果重探逻辑，
# 重装后无需重启引擎。用法: bash scripts/install-curl-impersonate.sh
# R90：下载源改为国内镜像候选链（ghfast.top / gh-proxy.com / ghproxy.net / 直连），
# 逐个尝试 + tar 完整性校验，国内服务器不再因 GitHub 直连超时而失败。
set -euo pipefail
mkdir -p "$HOME/.local/bin"

GH_BASE="https://github.com/lwthiker/curl-impersonate/releases/download/v0.6.1/curl-impersonate-v0.6.1.x86_64-linux-gnu.tar.gz"
TARBALL="/tmp/curl-imp.tar.gz"

# 候选源：镜像前缀代理 + 官方直连兜底（镜像失效自动降级到下一个）
MIRRORS=(
  "https://ghfast.top/$GH_BASE"
  "https://gh-proxy.com/$GH_BASE"
  "https://ghproxy.net/$GH_BASE"
  "$GH_BASE"
)

ok=0
for url in "${MIRRORS[@]}"; do
  echo "[curl-imp] trying: $url"
  if curl -fsSL --max-time 180 -o "$TARBALL" "$url" \
     && tar -tzf "$TARBALL" >/dev/null 2>&1; then
    echo "[curl-imp] downloaded + verified from: $url"
    ok=1
    break
  fi
  rm -f "$TARBALL"
done

if [ "$ok" -ne 1 ]; then
  echo "[curl-imp] ERROR: 全部镜像源失败（可手动下载 $GH_BASE 后解压到 ~/.local/bin）" >&2
  exit 1
fi

tar -xzf "$TARBALL" -C "$HOME/.local/bin/"
chmod +x "$HOME/.local/bin/curl_"* "$HOME/.local/bin/curl-impersonate-"* 2>/dev/null || true
rm -f "$TARBALL"
echo "installed: $(ls "$HOME/.local/bin" | wc -l) binaries"
