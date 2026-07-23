#!/usr/bin/env bash
# ============================================================
# Novel Admin — 一键安装入口脚本
# 支持三种使用方式:
#   1. curl -fsSL https://raw.githubusercontent.com/u4399com-beep/novel-admin-1.0.0/main/install.sh | bash
#   2. git clone ... && cd novel-admin-1.0.0 && bash install.sh
#   3. tar xzf novel-admin-*.tar.gz && cd novel-admin-* && bash install.sh
# ============================================================
set -eo pipefail

REPO="u4399com-beep/novel-admin-1.0.0"
GIT_URL="https://github.com/${REPO}.git"
INSTALL_DIR="/opt/novel-admin"

# China GitHub raw file proxies
RAW_PROXIES=("https://ghfast.top" "https://mirror.ghproxy.com" "https://gh-proxy.com")

# Colors (safe fallback if no terminal)
if [ -t 2 ]; then
    C_RED='\033[0;31m' C_GRN='\033[0;32m' C_YLW='\033[0;33m' C_RST='\033[0m'
else
    C_RED='' C_GRN='' C_YLW='' C_RST=''
fi

log_info()  { printf "${C_GRN}[INFO]${C_RST}  %s\n" "$*" >&2; }
log_warn()  { printf "${C_YLW}[WARN]${C_RST}  %s\n" "$*" >&2; }
log_error() { printf "${C_RED}[ERROR]${C_RST} %s\n" "$*" >&2; }

# ── Helper: force-sync git repo, preserving .env ──
# Handles dirty working trees, merge conflicts, etc.
git_force_sync() {
    local dir="$1"
    [ -d "$dir/.git" ] || return 1
    command -v git &>/dev/null || return 1

    # Save .env if it exists (contains user's credentials)
    local _env_backup=""
    if [ -f "$dir/.env" ]; then
        _env_backup="/tmp/.env.novel-install.$$.bak"
        cp "$dir/.env" "$_env_backup" 2>/dev/null || true
    fi

    # Discard ALL local changes to tracked files
    git -C "$dir" checkout -- . 2>/dev/null || true

    # Try fast-forward pull first
    local _pulled=false
    if git -C "$dir" pull --ff-only 2>&1; then
        _pulled=true
    else
        # Pull failed (maybe diverged) — force reset to remote
        log_warn "git pull 失败，尝试强制同步..."
        if git -C "$dir" fetch origin main 2>/dev/null; then
            git -C "$dir" reset --hard origin/main 2>/dev/null && _pulled=true || true
        fi
    fi

    # Restore .env
    if [ -n "$_env_backup" ] && [ -f "$_env_backup" ]; then
        cp "$_env_backup" "$dir/.env" 2>/dev/null || true
        rm -f "$_env_backup"
    fi

    $_pulled && return 0
    return 1
}

# ── Try to find deploy.sh locally ──
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -f "${SCRIPT_DIR}/deploy.sh" ]; then
    # If it's a git repo, force-sync before running
    if [ -d "${SCRIPT_DIR}/.git" ]; then
        log_info "同步最新代码..."
        if git_force_sync "$SCRIPT_DIR"; then
            log_info "代码已更新"
        else
            log_warn "代码同步失败，使用本地版本继续"
        fi
    fi
    exec bash "${SCRIPT_DIR}/deploy.sh" "$@"
fi

# ── deploy.sh not found locally, need to fetch from GitHub ──
log_info "正在从 GitHub 获取部署脚本..."

# Check if already cloned at install dir
if [ -d "${INSTALL_DIR}/.git" ] && [ -f "${INSTALL_DIR}/deploy.sh" ]; then
    log_info "检测到已有安装目录，更新代码..."
    if git_force_sync "$INSTALL_DIR"; then
        exec bash "${INSTALL_DIR}/deploy.sh" "$@"
    fi
    # If sync failed, try running existing deploy.sh anyway
    exec bash "${INSTALL_DIR}/deploy.sh" "$@"
fi

# Not found anywhere — clone the repo
TMP_CLONE=""

# Method 1: git clone (if git is available)
if command -v git &>/dev/null; then
    rm -rf "$INSTALL_DIR" 2>/dev/null || true
    log_info "git clone ${GIT_URL} ..."
    if git clone --depth 1 "$GIT_URL" "$INSTALL_DIR" 2>/dev/null; then
        TMP_CLONE="$INSTALL_DIR"
    else
        # Try China proxies
        for proxy in "${RAW_PROXIES[@]}"; do
            log_info "  尝试镜像 ${proxy%%/*}..."
            rm -rf "$INSTALL_DIR" 2>/dev/null || true
            if git clone --depth 1 "${proxy}/${GIT_URL}" "$INSTALL_DIR" 2>/dev/null; then
                cd "$INSTALL_DIR"
                git remote set-url origin "$GIT_URL" 2>/dev/null || true
                TMP_CLONE="$INSTALL_DIR"
                break
            fi
        done
    fi
fi

# Method 2: download archive via curl/wget (if git failed)
if [ -z "$TMP_CLONE" ]; then
    log_info "尝试下载项目压缩包..."
    ARCHIVE_URL="https://github.com/${REPO}/archive/refs/heads/main.tar.gz"
    _dl_ok=false

    # Try direct
    if command -v curl &>/dev/null; then
        curl -fsSL --connect-timeout 15 --max-time 300 "$ARCHIVE_URL" -o /tmp/novel-admin.tar.gz 2>/dev/null && _dl_ok=true
    elif command -v wget &>/dev/null; then
        wget -q --timeout=300 -O /tmp/novel-admin.tar.gz "$ARCHIVE_URL" 2>/dev/null && _dl_ok=true
    fi

    # Try China proxies
    if ! $_dl_ok; then
        for proxy in "${RAW_PROXIES[@]}"; do
            log_info "  尝试镜像 ${proxy%%/*}..."
            _proxy_url="${proxy}/${ARCHIVE_URL}"
            if command -v curl &>/dev/null; then
                curl -fsSL --connect-timeout 15 --max-time 300 "$_proxy_url" -o /tmp/novel-admin.tar.gz 2>/dev/null && _dl_ok=true && break
            elif command -v wget &>/dev/null; then
                wget -q --timeout=300 -O /tmp/novel-admin.tar.gz "$_proxy_url" 2>/dev/null && _dl_ok=true && break
            fi
        done
    fi

    if $_dl_ok; then
        mkdir -p "$INSTALL_DIR"
        # Extract, strip the top-level directory (novel-admin-1.0.0-main/)
        tar xzf /tmp/novel-admin.tar.gz -C "$INSTALL_DIR" --strip-components=1 2>/dev/null
        rm -f /tmp/novel-admin.tar.gz
        if [ -f "${INSTALL_DIR}/deploy.sh" ]; then
            TMP_CLONE="$INSTALL_DIR"
        fi
    fi
fi

if [ -z "$TMP_CLONE" ] || [ ! -f "${TMP_CLONE}/deploy.sh" ]; then
    log_error "无法从 GitHub 获取 deploy.sh"
    log_error "请手动操作:"
    log_error "  git clone ${GIT_URL}"
    log_error "  cd novel-admin-1.0.0"
    log_error "  bash deploy.sh"
    exit 1
fi

chmod +x "${TMP_CLONE}/deploy.sh"
log_info "部署脚本已就绪，开始安装..."
exec bash "${TMP_CLONE}/deploy.sh" "$@"