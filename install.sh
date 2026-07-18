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

# ── Try to find deploy.sh ──
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -f "${SCRIPT_DIR}/deploy.sh" ]; then
    # If it's a git repo, always pull latest before running
    if [ -d "${SCRIPT_DIR}/.git" ] && command -v git &>/dev/null; then
        log_info "更新部署脚本..."
        cd "$SCRIPT_DIR" && git pull --ff-only 2>/dev/null || true
    fi
    exec bash "${SCRIPT_DIR}/deploy.sh" "$@"
fi

# ── deploy.sh not found locally, need to fetch from GitHub ──
log_info "正在从 GitHub 获取部署脚本..."

# Check if already cloned at install dir
if [ -d "${INSTALL_DIR}/.git" ] && [ -f "${INSTALL_DIR}/deploy.sh" ]; then
    log_info "检测到已有安装目录，更新代码..."
    cd "$INSTALL_DIR" && git pull --ff-only 2>/dev/null && \
        exec bash "${INSTALL_DIR}/deploy.sh" "$@"
fi

# Not found anywhere — clone the repo
TMP_CLONE=""

# Method 1: git clone (if git is available)
if command -v git &>/dev/null; then
    log_info "git clone ${GIT_URL} ..."
    if git clone --depth 1 "$GIT_URL" "$INSTALL_DIR" 2>/dev/null; then
        TMP_CLONE="$INSTALL_DIR"
    else
        # Try China proxies
        for proxy in "${RAW_PROXIES[@]}"; do
            log_info "  尝试镜像 ${proxy%%/*}..."
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