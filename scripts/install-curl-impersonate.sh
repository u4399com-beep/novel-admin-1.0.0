#!/usr/bin/env bash
# 重装 curl-impersonate 二进制（v0.6.1 x86_64-linux-gnu，21 个）到 ~/.local/bin
# 背景：沙箱会周期性清理 ~/.local/bin（已发生两次）；引擎侧已有 60s 空结果重探逻辑，
#      重装后无需重启引擎。用法: bash scripts/install-curl-impersonate.sh
set -euo pipefail
mkdir -p "$HOME/.local/bin"
curl -sL --max-time 120 -o /tmp/curl-imp.tar.gz \
  "https://github.com/lwthiker/curl-impersonate/releases/download/v0.6.1/curl-impersonate-v0.6.1.x86_64-linux-gnu.tar.gz"
tar -xzf /tmp/curl-imp.tar.gz -C "$HOME/.local/bin/"
chmod +x "$HOME/.local/bin/curl_"* "$HOME/.local/bin/curl-impersonate-"* 2>/dev/null || true
echo "installed: $(ls "$HOME/.local/bin" | wc -l) binaries"
