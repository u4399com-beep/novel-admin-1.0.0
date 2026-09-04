#!/usr/bin/env bash
# ============================================================
# Novel Admin — 一键安装入口脚本 v2
# 支持四种使用方式:
#   1. bash <(curl -fsSL https://raw.githubusercontent.com/u4399com-beep/novel-admin-1.0.0/main/install.sh)
#   2. 国内加速: bash <(curl -fsSL https://ghfast.top/https://raw.githubusercontent.com/u4399com-beep/novel-admin-1.0.0/main/install.sh)
#   3. git clone ... && cd novel-admin-1.0.0 && bash install.sh
#   4. tar xzf novel-admin-*.tar.gz && cd novel-admin-* && bash install.sh
# ============================================================
set -eo pipefail
trap 'rm -f /tmp/novel-admin.tar.gz; rm -rf /tmp/novel-tmp' EXIT

REPO="u4399com-beep/novel-admin-1.0.0"
GIT_URL="https://github.com/${REPO}.git"
INSTALL_DIR="/opt/novel-admin"

# Colors (safe fallback if no terminal)
if [ -t 2 ]; then
    C_RED='\033[0;31m' C_GRN='\033[0;32m' C_YLW='\033[0;33m' C_RST='\033[0m'
else
    C_RED='' C_GRN='' C_YLW='' C_RST=''
fi

log_info()  { printf "${C_GRN}[INFO]${C_RST}  %s\n" "$*" >&2; }
log_warn()  { printf "${C_YLW}[WARN]${C_RST}  %s\n" "$*" >&2; }
log_error() { printf "${C_RED}[ERROR]${C_RST} %s\n" "$*" >&2; }

# ── Detect China network ──
_IS_CHINA=false
if ! curl -s -m 5 https://www.google.com >/dev/null 2>&1; then
    _IS_CHINA=true
    log_info "检测到国内网络环境，将优先使用镜像加速"
fi

# ── Helper: force-sync git repo, preserving .env ──
git_force_sync() {
    local dir="$1"
    [ -d "$dir/.git" ] || return 1
    command -v git &>/dev/null || return 1

    # Save .env if it exists (contains user's credentials)
    local _env_backup=""
    if [ -f "$dir/.env" ]; then
        _env_backup="${TMPDIR:-/tmp}/.env.novel-install.$$.bak"
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

# ── Helper: git clone with multiple mirrors ──
git_clone_mirrors() {
    local target_dir="$1"
    local _mirrors=(
        "https://github.com/${REPO}.git"
        "https://ghfast.top/https://github.com/${REPO}.git"
        "https://kkgithub.com/${REPO}.git"
        "https://gitclone.com/github.com/${REPO}.git"
        "https://hub.fastgit.xyz/${REPO}.git"
        "https://github.com.cnpmjs.org/${REPO}.git"
    )

    # 国内环境：优先国内镜像
    if [ "$_IS_CHINA" = "true" ]; then
        _mirrors=(
            "https://ghfast.top/https://github.com/${REPO}.git"
            "https://kkgithub.com/${REPO}.git"
            "https://gitclone.com/github.com/${REPO}.git"
            "https://github.com.cnpmjs.org/${REPO}.git"
            "https://hub.fastgit.xyz/${REPO}.git"
            "https://github.com/${REPO}.git"
        )
    fi

    for _mirror in "${_mirrors[@]}"; do
        local _name="${_mirror%%/u4399*}"
        _name="${_name%/}"
        log_info "  尝试: ${_name} ..."
        rm -rf "$target_dir" 2>/dev/null || true
        if git clone --depth 1 "$_mirror" "$target_dir" 2>/dev/null; then
            # 修正 remote url
            git -C "$target_dir" remote set-url origin "$GIT_URL" 2>/dev/null || true
            return 0
        fi
    done
    return 1
}

# ── Helper: download archive with proxies ──
download_archive() {
    local output="$1"
    local _archive_url="https://github.com/${REPO}/archive/refs/heads/main.tar.gz"
    local _proxies=(
        ""
        "https://ghfast.top/"
        "https://gh-proxy.com/"
        "https://mirror.ghproxy.com/"
        "https://gh.idayer.com/"
    )

    for _proxy in "${_proxies[@]}"; do
        local _url="${_proxy}${_archive_url}"
        local _name="${_proxy:-direct}"
        _name="${_name%/}"
        log_info "  尝试: ${_name} ..."
        if command -v curl &>/dev/null; then
            if curl -fsSL --connect-timeout 15 --max-time 300 "$_url" -o "$output" 2>/dev/null; then
                return 0
            fi
        elif command -v wget &>/dev/null; then
            if wget -q --timeout=300 -O "$output" "$_url" 2>/dev/null; then
                return 0
            fi
        fi
    done
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
    # Clean up temp files BEFORE exec (trap won't fire after exec)
    rm -f /tmp/novel-admin.tar.gz; rm -rf /tmp/novel-tmp
    exec bash "${SCRIPT_DIR}/deploy.sh" "$@"
fi

# ── deploy.sh not found locally, need to fetch from GitHub ──
log_info "正在获取部署脚本..."

# Check if already cloned at install dir
if [ -d "${INSTALL_DIR}/.git" ] && [ -f "${INSTALL_DIR}/deploy.sh" ]; then
    log_info "检测到已有安装目录，更新代码..."
    if git_force_sync "$INSTALL_DIR"; then
        rm -f /tmp/novel-admin.tar.gz; rm -rf /tmp/novel-tmp
        exec bash "${INSTALL_DIR}/deploy.sh" "$@"
    fi
    # If sync failed, try running existing deploy.sh anyway
    rm -f /tmp/novel-admin.tar.gz; rm -rf /tmp/novel-tmp
    exec bash "${INSTALL_DIR}/deploy.sh" "$@"
fi

# Not found anywhere — need to download
TMP_CLONE=""

# Method 1: git clone with multiple mirrors
if command -v git &>/dev/null; then
    log_info "git clone 获取代码..."
    if git_clone_mirrors "$INSTALL_DIR"; then
        TMP_CLONE="$INSTALL_DIR"
        log_info "代码获取完成 (git clone)"
    else
        log_warn "所有 git clone 镜像均失败"
    fi
fi

# Method 2: download archive via curl/wget (if git failed)
if [ -z "$TMP_CLONE" ]; then
    log_info "尝试下载项目压缩包..."
    if download_archive /tmp/novel-admin.tar.gz; then
        mkdir -p "$INSTALL_DIR"
        if tar xzf /tmp/novel-admin.tar.gz -C "$INSTALL_DIR" --strip-components=1 2>/dev/null; then
            log_info "压缩包解压完成"
            if [ -f "${INSTALL_DIR}/deploy.sh" ]; then
                TMP_CLONE="$INSTALL_DIR"
            fi
        else
            log_warn "压缩包解压失败，文件可能已损坏"
        fi
    else
        log_warn "压缩包下载失败"
    fi
    rm -f /tmp/novel-admin.tar.gz
fi

# Method 3: download individual files (last resort)
if [ -z "$TMP_CLONE" ]; then
    log_info "尝试逐文件下载关键文件..."
    GIT_RAW="https://raw.githubusercontent.com/${REPO}/main"
    _FILE_PROXIES=("" "https://ghfast.top/" "https://gh-proxy.com/" "https://mirror.ghproxy.com/")

    _dl_count=0
    for f in deploy.sh Dockerfile docker-compose.yml docker-entrypoint.sh .env.docker .dockerignore quick-docker.sh; do
        for _proxy in "${_FILE_PROXIES[@]}"; do
            _url="${_proxy}${GIT_RAW}/${f}"
            if command -v curl &>/dev/null; then
                curl -fsSL --connect-timeout 10 --max-time 60 "$_url" -o "${INSTALL_DIR}/${f}" 2>/dev/null && _dl_count=$((_dl_count + 1)) && break
            elif command -v wget &>/dev/null; then
                wget -q --timeout=60 -O "${INSTALL_DIR}/${f}" "$_url" 2>/dev/null && _dl_count=$((_dl_count + 1)) && break
            fi
        done
    done
    mkdir -p "${INSTALL_DIR}/mini-services/scraper-service/src/scrape-rules" "${INSTALL_DIR}/backups"

    if [ "$_dl_count" -ge 3 ] && [ -f "${INSTALL_DIR}/deploy.sh" ]; then
        TMP_CLONE="$INSTALL_DIR"
        log_info "关键文件下载完成 (${_dl_count} 个)"
    fi
fi

if [ -z "$TMP_CLONE" ] || [ ! -f "${TMP_CLONE}/deploy.sh" ]; then
    log_error "无法获取部署脚本！"
    log_error ""
    log_error "请尝试以下方法:"
    log_error ""
    log_error "  方法1: 国内用户推荐 - 使用 ghfast.top 加速"
    log_error "    bash <(curl -fsSL https://ghfast.top/https://raw.githubusercontent.com/${REPO}/main/install.sh)"
    log_error ""
    log_error "  方法2: 手动下载压缩包"
    log_error "    浏览器打开: https://github.com/${REPO}/archive/refs/heads/main.zip"
    log_error "    解压后运行: bash deploy.sh"
    log_error ""
    log_error "  方法3: 配置 git 代理"
    log_error "    git config --global http.proxy socks5://127.0.0.1:1080"
    log_error "    git clone ${GIT_URL}"
    log_error "    cd novel-admin-1.0.0 && bash deploy.sh"
    log_error ""
    log_error "  方法4: 离线部署"
    log_error "    在有网络的机器上运行: bash pack.sh"
    log_error "    将 .tar.gz 传到服务器，解压后运行: bash deploy.sh"
    exit 1
fi

chmod +x "${TMP_CLONE}/deploy.sh"
log_info "部署脚本已就绪，开始安装..."
# Clean up temp files BEFORE exec (trap won't fire after exec)
rm -f /tmp/novel-admin.tar.gz; rm -rf /tmp/novel-tmp
exec bash "${TMP_CLONE}/deploy.sh" "$@"
