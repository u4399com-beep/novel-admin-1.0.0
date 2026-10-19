#!/bin/bash
# =============================================================================
# bootstrap-cn.sh —— novel-admin 零前提一键部署引导（服务器连 git 都没有也能跑）
# =============================================================================
# 一条命令完成「下载源码 → 部署」（R127 起预构建快速路径：glibc>=2.34 免装 Go 秒级起服务）：
#   bash -c "$(curl -fsSL https://ghfast.top/https://raw.githubusercontent.com/u4399com-beep/novel-admin-1.0.0/main/scripts/bootstrap-cn.sh)"
#   （ghfast.top 失效时实测可用镜像：gh-proxy.com / ghproxy.net，替换 URL 前缀即可；
#   无 curl 用 wget 变体：
#   bash -c "$(wget -qO- https://ghfast.top/https://raw.githubusercontent.com/u4399com-beep/novel-admin-1.0.0/main/scripts/bootstrap-cn.sh)"）
# 可选参数：目标目录（默认 ~/novel-admin）：
#   bash -c "$(curl -fsSL ... )" /opt/novel-admin   ← 经 bash -c 传参见 docs/deployment.md §0.1
#
# 行为：
#   1. GitHub archive tarball 下载（镜像候选链：ghfast.top → gh-proxy.com → ghproxy.net
#      → 直连，任一成功即走——防单镜像死亡）
#   2. 解压并覆盖安装到目标目录 —— db/、public/covers/、download/、.env 数据产物
#      永不覆盖（重复执行 = 无 git 升级；有 git 服务器更推荐 bash scripts/upgrade.sh）
#   3. 调用 scripts/deploy-cn.sh 完成依赖/构建(或预构建直取)/启动/健康检查全链
# =============================================================================
set -euo pipefail

REPO_TARBALL_BASES=(
  "https://ghfast.top/https://github.com/u4399com-beep/novel-admin-1.0.0/archive/refs/heads/main.tar.gz"
  "https://gh-proxy.com/https://github.com/u4399com-beep/novel-admin-1.0.0/archive/refs/heads/main.tar.gz"
  "https://ghproxy.net/https://github.com/u4399com-beep/novel-admin-1.0.0/archive/refs/heads/main.tar.gz"
  "https://github.com/u4399com-beep/novel-admin-1.0.0/archive/refs/heads/main.tar.gz"
)
TARGET_DIR="${BOOTSTRAP_TARGET:-$HOME/novel-admin}"

say()  { echo "[bootstrap] $*"; }

# curl 或 wget 二选一
FETCH=""
if command -v curl >/dev/null 2>&1; then
  FETCH="curl -fsSL --max-time 600 -o"
elif command -v wget >/dev/null 2>&1; then
  FETCH="wget -qO"  # wget -qO <file> <url>
else
  echo "[bootstrap] FAIL: 需要 curl 或 wget（几乎所有发行版自带）" >&2; exit 1
fi
TAR_OK=0
if command -v tar >/dev/null 2>&1; then TAR_OK=1; else echo "[bootstrap] FAIL: 需要 tar" >&2; exit 1; fi

WORK="$(mktemp -d /tmp/novel-admin-bootstrap.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
TGZ="$WORK/main.tar.gz"

say "下载源码 tarball ..."
# R127 修复：旧版 `$TAR_OK` 未加测试语法（展开为 1 被 bash 当命令执行→「1: command not
# found」→条件恒假，成功下载也被丢弃）且首次失败后 TGZ="" 使后续尝试 curl -o 空参数——
# 远程一键命令自 R98 起潜伏损坏，/tmp 端到端演练实证后根修：TAR_OK 用 [ -eq ] 测试语法，
# TGZ 全程恒定路径，每轮尝试前 rm -f 保证幂等重试。
for u in "${REPO_TARBALL_BASES[@]}"; do
  say "  尝试: $u"
  rm -f "$TGZ"
  # shellcheck disable=SC2086
  if $FETCH "$TGZ" "$u" && [ "$TAR_OK" -eq 1 ] && tar -tzf "$TGZ" >/dev/null 2>&1; then
    say "  下载成功"; break
  fi
  rm -f "$TGZ"
done
[ -s "$TGZ" ] || { echo "[bootstrap] FAIL: 全部下载源失败（ghfast.top/gh-proxy.com/ghproxy.net/直连均不可达，请检查网络或更换镜像前缀）" >&2; exit 1; }

say "解压 ..."
tar -C "$WORK" -xzf "$TGZ"
SRC="$WORK/novel-admin-1.0.0-main"
[ -d "$SRC" ] || { echo "[bootstrap] FAIL: 解压目录异常（$SRC 不存在）" >&2; exit 1; }

say "安装到 $TARGET_DIR（db/public/download/.env 数据产物不覆盖）..."
mkdir -p "$TARGET_DIR"
# 覆盖代码但保留数据：tar 打包时排除数据目录，解到目标目录之上
tar -C "$SRC" --exclude='./db' --exclude='./public/covers' --exclude='./download' --exclude='./.env' -cf - . | tar -C "$TARGET_DIR" -xf -
say "安装完成"

say "进入部署（deploy-cn.sh：依赖 → Go → 构建 → 启动 → 健康检查）..."
cd "$TARGET_DIR"
exec bash scripts/deploy-cn.sh "$@"
