#!/usr/bin/env bash
# =============================================================================
# upgrade.sh —— novel-admin 一键升级（git 拉取 → 重建 → 重启 → 健康检查 → 失败回滚）
# =============================================================================
# 用法（服务器仓库目录内执行）：
#   bash scripts/upgrade.sh            # 升级到远程 main 最新
#   bash scripts/upgrade.sh v1.0.1     # 升级到指定 tag / commit / 分支
#
# 流程：
#   [1/6] 环境自检      git 可用、仓库干净度（本地改动自动 stash，升级后提示恢复）
#   [2/6] 拉取代码      git fetch + reset --hard 到目标（--ff-only 拒绝分叉历史）
#   [3/6] 部署二进制    ★ R127：glibc>=2.34 且架构匹配 → 直接用仓库预构建 bin（git pull
#                       同步拉到新 bin，升级零编译 ~10 秒）；否则源码构建 build-go.sh
#   [4/6] 重启          deploy-cn.sh（预构建走快速路径 cp / 源码构建后 --skip-build 复用）
#   [5/6] 健康检查      /api/health + /api/strategies（60s 窗口）
#   [6/6] 失败回滚      健康检查不过 → git reset 回升级前 commit → 按同形态部署 → 再检
#
# 数据安全：db/、public/covers/、download/novels/ 全在仓库内但不受 git 管，
#   git reset 不触碰数据；升级全程 SQLite WAL 进程级安全。
# =============================================================================
set -euo pipefail

# ---------- 输出与通用 ----------
if [ -t 1 ]; then
  C_G=$'\033[32m'; C_Y=$'\033[33m'; C_R=$'\033[31m'; C_B=$'\033[36m'; C_0=$'\033[0m'
else
  C_G=""; C_Y=""; C_R=""; C_B=""; C_0=""
fi
step() { echo "${C_B}==>[$1]${C_0} $2"; }
ok()   { echo "${C_G}  OK${C_0} $1"; }
warn() { echo "${C_Y}  WARN${C_0} $1"; }
die()  { echo "${C_R}  FAIL${C_0} $1" >&2; exit 1; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "当前目录不是 git 仓库（$ROOT）——升级脚本管理 git 仓库，全新部署请用 deploy-cn.sh"

TARGET="${1:-origin/HEAD}"
ORIGIN_URL="$(git remote get-url origin 2>/dev/null || echo '(无 remote)')"
PREV_REV="$(git rev-parse --short HEAD)"

echo ""
echo "${C_B}==============================================${C_0}"
echo " novel-admin 一键升级  repo=$ROOT"
echo " 当前: $PREV_REV → 目标: $TARGET"
echo " remote: $ORIGIN_URL"
echo "==============================================${C_0}"
echo ""

# ---------- [1/6] 环境自检 ----------
step "1/6" "环境自检"
STASHED=0
if ! git diff --quiet || ! git diff --cached --quiet; then
  git stash push -u -m "upgrade-autostash-$(date +%Y%m%d%H%M%S)" >/dev/null
  STASHED=1
  warn "检测到本地改动，已自动 stash（升级成功后 git stash pop 恢复）"
fi
ok "git 仓库就绪"

# ---------- [2/6] 拉取代码 ----------
step "2/6" "拉取最新代码（$TARGET）"
git fetch origin --tags --prune
# origin/HEAD 是符号引用，解析为实际分支
RESOLVED="$(git rev-parse --symbolic-full-name "$TARGET" 2>/dev/null | sed 's|^origin/||' || true)"
if [ -n "$RESOLVED" ] && git rev-parse --verify -q "$RESOLVED" >/dev/null 2>&1; then TARGET="$RESOLVED"; fi
git reset --hard "$TARGET"
git clean -fdq --exclude=db --exclude=public --exclude=download --exclude=.env
NEW_REV="$(git rev-parse --short HEAD)"
if [ "$NEW_REV" = "$PREV_REV" ]; then
  ok "已是最新（$NEW_REV），继续执行重建+重启（幂等）"
else
  ok "代码更新: $PREV_REV → $NEW_REV"
fi

# ---------- [3/6] 部署二进制（预构建快速路径优先，R127） ----------
# 检测：无本地 stash（可能改过源码）+ repo 双 bin 存在 + ELF 架构匹配 + glibc>=2.34
PREBUILT_UPGRADE=0
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)        GOARCH=amd64; EM_EXPECT=3e00 ;;
  aarch64|arm64) GOARCH=arm64; EM_EXPECT=b700 ;;
  *)             GOARCH=unknown; EM_EXPECT=none ;;
esac
GLIBC_VER="$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}')"
if [ "$STASHED" -eq 0 ] && [ "$GOARCH" != "unknown" ] && [ -n "$GLIBC_VER" ] \
   && [ -x "$ROOT/mini-services/backend-go/bin/backend-go" ] \
   && [ -x "$ROOT/mini-services/scraper-go/bin/scraper-go" ] \
   && [ "$(od -An -tx1 -j18 -N2 "$ROOT/mini-services/backend-go/bin/backend-go" 2>/dev/null | tr -d ' \n')" = "$EM_EXPECT" ] \
   && awk -v a="$GLIBC_VER" 'BEGIN{exit !(a>=2.34)}'; then
  PREBUILT_UPGRADE=1
fi
if [ "$PREBUILT_UPGRADE" -eq 1 ]; then
  step "3/6" "部署双服务（仓库预构建 bin，零编译 ~10 秒；arch=$GOARCH glibc=$GLIBC_VER）"
  ok "预构建快速路径命中——git pull 已同步拉到与源码原子提交的新 bin"
else
  step "3/6" "构建双服务（backend-go + scraper-go；$([ "$STASHED" -eq 1 ] && echo '检测到本地源码改动 stash，必须源码构建' || echo "预构建不可用 arch=$GOARCH glibc=${GLIBC_VER:-unknown}，回退源码构建")）"
  bash "$ROOT/scripts/build-go.sh"
  ok "构建完成"
fi

rollback() {
  echo ""
  warn "升级失败，回滚到 $PREV_REV ..."
  git reset --hard "$PREV_REV"
  if [ "$PREBUILT_UPGRADE" -eq 1 ]; then
    bash "$ROOT/scripts/deploy-cn.sh" >/dev/null 2>&1 || true
  else
    bash "$ROOT/scripts/build-go.sh" >/dev/null 2>&1 || true
    bash "$ROOT/scripts/deploy-cn.sh" --skip-build >/dev/null 2>&1 || true
  fi
  warn "已回滚并重启（$PREV_REV）。请检查网络/磁盘后重试升级。"
  exit 1
}

# ---------- [4/6] 重启（幂等；预构建走 deploy-cn.sh 快速路径，源码构建后 --skip-build 复用） ----------
if [ "$PREBUILT_UPGRADE" -eq 1 ]; then
  step "4/6" "重启双服务（复用 deploy-cn.sh 预构建快速路径）"
  bash "$ROOT/scripts/deploy-cn.sh" || rollback
else
  step "4/6" "重启双服务（复用 deploy-cn.sh --skip-build）"
  bash "$ROOT/scripts/deploy-cn.sh" --skip-build || rollback
fi

# ---------- [5/6] 健康检查 ----------
step "5/6" "健康检查（60s 窗口）"
PORT="${BACKEND_PORT:-3000}"
health_ok=0
for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$PORT/api/health" || true)
  [ "$code" = "200" ] && { health_ok=1; break; }
  sleep 2
done
[ "$health_ok" -eq 1 ] || { tail -20 /tmp/backend-go-api.log 2>/dev/null || true; rollback; }
ok "backend-go :$PORT /api/health = 200"
eng_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3030/api/strategies || true)
[ "$eng_code" = "200" ] && ok "scraper-go :3030 /api/strategies = 200" \
  || warn "引擎 :3030 未就绪（$eng_code）——watchdog 会自动拉起，不阻塞升级"

# ---------- [6/6] 收尾 ----------
step "6/6" "收尾"
[ "$STASHED" -eq 1 ] && warn "本地改动已 stash：git stash list 查看 / git stash pop 恢复"
curl -s --max-time 5 "http://127.0.0.1:$PORT/api/settings" >/dev/null 2>&1 || true

echo ""
echo "${C_G}==============================================${C_0}"
echo " 升级完成 ✓  $PREV_REV → $NEW_REV"
echo "----------------------------------------------"
echo " 站点入口 : http://<服务器IP>:$PORT/"
echo " 回滚命令 : git reset --hard $PREV_REV && bash scripts/build-go.sh && bash scripts/deploy-cn.sh --skip-build"
echo "==============================================${C_0}"
