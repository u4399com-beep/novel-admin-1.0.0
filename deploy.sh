#!/usr/bin/env bash
# ╔═══════════════════════════════════════════════════════════════════════╗
# ║  📚 小说管理系统 — 生产环境一键部署脚本 v2                            ║
# ║  Novel Admin — Production One-Click Deploy Script                    ║
# ║                                                                     ║
# ║  设计目标:                                                          ║
# ║    • 真正的"开箱即用" — 从裸机到运行，零手动操作                     ║
# ║    • 兼容精简/最小化安装的 Linux 服务器                              ║
# ║    • 自动处理所有缺失工具 (curl, git, wget, docker...)              ║
# ║    • 完整的中国大陆网络环境支持                                      ║
# ║                                                                     ║
# ║  支持场景:                                                          ║
# ║    • tar.gz 压缩包解压后直接运行 (推荐, 离线部署)                    ║
# ║    • git clone 后运行 (在线部署)                                    ║
# ║                                                                     ║
# ║  兼容系统:                                                          ║
# ║    Debian 9+ · Ubuntu 16.04+ · CentOS 7/8/9 · RHEL 8/9             ║
# ║    Rocky Linux 8/9 · Alma Linux 9 · Amazon Linux 2/2023            ║
# ║    Alpine 3.10+ · openSUSE Leap/Tumbleweed                         ║
# ║                                                                     ║
# ║  用法:                                                              ║
# ║    chmod +x deploy.sh && ./deploy.sh           交互式安装           ║
# ║    ./deploy.sh -y                            全部默认值             ║
# ║    ./deploy.sh -d /data/novel-admin           自定义安装目录        ║
# ║    ./deploy.sh -p 8080                        自定义端口            ║
# ║    ./deploy.sh -d /data/app -p 8080 -y        组合参数              ║
# ║    ./deploy.sh --uninstall                     完全卸载              ║
# ║    ./deploy.sh --upgrade                       在线升级              ║
# ║    ./deploy.sh --backup                        备份数据库            ║
# ║    ./deploy.sh --rollback                      回滚到上一版本        ║
# ║    ./deploy.sh --status                        查看运行状态          ║
# ║    ./deploy.sh --logs                          查看实时日志          ║
# ║    ./deploy.sh --restart                       重启服务              ║
# ║    ./deploy.sh --stop                          停止服务              ║
# ╚═══════════════════════════════════════════════════════════════════════╝

# NOTE: We intentionally use `set -eo pipefail` but NOT `set -u`.
# Deployment scripts source external .env files which may reference
# undefined variables — `set -u` would kill the script incorrectly.
set -eo pipefail

# Trap ERR to show which command failed (instead of silent exit)
trap 'echo -e "\033[0;31m[ERROR] 命令失败退出: ${BASH_COMMAND:-未知}\033[0m" >&2; echo "  完整日志: ${LOG_FILE:-无}" >&2' ERR

# Make grep return 0 even when no match (avoid set -e + pipefail killing the script)
# This is safe: callers check the output, not the exit code
export GREP_OPTIONS=""  # deprecated but harmless
grep() { command grep "$@" || [ $? -eq 1 ]; }

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  GLOBALS
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="u4399com-beep/novel-admin-1.0.0"
GIT_URL="https://github.com/${REPO}.git"
ARCHIVE_URL="https://github.com/${REPO}/archive/refs/heads/main.tar.gz"

# China GitHub proxies (for git clone)
GIT_PROXIES=(
    "https://ghfast.top/https://github.com"
    "https://mirror.ghproxy.com/https://github.com"
    "https://gh-proxy.com/https://github.com"
)
# China raw file proxies (for curl/wget download)
RAW_PROXIES=("https://ghfast.top" "https://mirror.ghproxy.com")
# China Docker Hub mirrors
DOCKER_MIRRORS=(
    "https://docker.1ms.run"
    "https://docker.xuanyuan.me"
    "https://docker.m.daocloud.io"
    "https://docker.nju.edu.cn"
    "https://hub.rat.dev"
    "https://docker.chenby.cn"
    "https://docker.mirrors.ustc.edu.cn"
)

# Files that must exist for a valid project
REQUIRED_FILES=(Dockerfile docker-compose.yml docker-entrypoint.sh .env.production)

# Defaults
LOG_FILE="/tmp/novel-deploy-$(date +%Y%m%d_%H%M%S).log"
INSTALL_DIR="/opt/novel-admin"
APP_PORT=""
MODE="install"
AUTO_YES=false
VERBOSE=false

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  PARSE ARGUMENTS (proper while/shift loop)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
while [ $# -gt 0 ]; do
    case "$1" in
        -y|--yes)        AUTO_YES=true; shift ;;
        -d|--dir)        INSTALL_DIR="${2:-}"; [ -z "$INSTALL_DIR" ] && { echo "Error: -d requires a path"; exit 1; }; shift 2 ;;
        -p|--port)       APP_PORT="${2:-}"; [ -z "$APP_PORT" ] && { echo "Error: -p requires a port number"; exit 1; }; shift 2 ;;
        -v|--verbose)    VERBOSE=true; shift ;;
        --uninstall)     MODE="uninstall"; shift ;;
        --upgrade)       MODE="upgrade"; shift ;;
        --backup)        MODE="backup"; shift ;;
        --rollback)      MODE="rollback"; shift ;;
        --status)        MODE="status"; shift ;;
        --logs)          MODE="logs"; shift ;;
        --restart)       MODE="restart"; shift ;;
        --stop)          MODE="stop"; shift ;;
        -h|--help)
            sed -n '2,/^ ╚/p' "$0" | sed 's/^ ║  \?//'
            exit 0
            ;;
        *)
            echo "Unknown argument: $1"
            echo "Usage: $0 [-y] [-d DIR] [-p PORT] [--uninstall|--upgrade|--backup|--rollback|--status|--logs|--restart|--stop|-h]"
            exit 1
            ;;
    esac
done

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  LOGGING
#  Uses manual tee instead of exec > >(tee ...) for portability.
#  The process substitution >() may not work in some minimal envs
#  or when bash reads from a pipe (curl | bash).
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Color setup (detect if we have a real terminal)
if [ -t 1 ]; then
    C_RED='\033[0;31m'; C_GRN='\033[0;32m'; C_YEL='\033[1;33m'
    C_BLU='\033[0;34m'; C_CYN='\033[0;36m'; C_MAG='\033[0;35m'
    C_BLD='\033[1m';   C_DIM='\033[2m';    C_RST='\033[0m'
else
    C_RED=''; C_GRN=''; C_YEL=''; C_BLU=''; C_CYN=''; C_MAG=''; C_BLD=''; C_DIM=''; C_RST=''
fi

# Initialize log file
: > "$LOG_FILE" 2>/dev/null || LOG_FILE=""

# Unified output: prints to terminal AND appends to log file
_log() {
    local msg="$*"
    echo -e "$msg"
    [ -n "$LOG_FILE" ] && echo -e "$msg" >> "$LOG_FILE" 2>/dev/null
}

info()  { _log "${C_BLU}[INFO]${C_RST} $*"; }
ok()    { _log "${C_GRN}  ✓${C_RST} $*"; }
warn()  { _log "${C_YEL}[WARN]${C_RST} $*"; }
err()   { _log "${C_RED}[ERROR]${C_RST} $*"; }
step()  { _log "\n${C_MAG}${C_BLD}▶ $*${C_RST}"; }
die()   { err "$*"; [ -n "$LOG_FILE" ] && echo "  完整日志: ${LOG_FILE}"; exit 1; }

# Detect if stdin is a terminal (false in curl|bash mode)
if [ -t 0 ]; then
    _INTERACTIVE=true
else
    _INTERACTIVE=false
    # In non-interactive mode (curl|bash), default to AUTO_YES
    AUTO_YES=true
    info "检测到非交互模式 (curl|bash)，自动使用默认值"
fi

# Interactive prompts (auto-yes mode returns defaults)
ask() {
    if $AUTO_YES; then echo "${2:-}"; return; fi
    if [ -n "${2:-}" ]; then
        read -rp "$1 [${C_DIM}${2}${C_RST}]: " _r
        echo "${_r:-$2}"
    else
        read -rp "$1: " _r
        echo "${_r}"
    fi
}
ask_y() {
    if $AUTO_YES; then return 0; fi
    read -rp "$1 (Y/n): " _a
    [ -z "${_a:-}" ] || [[ "$_a" =~ ^[Yy] ]]
}
ask_n() {
    if $AUTO_YES; then return 1; fi
    read -rp "$1 (y/N): " _a
    [ -n "${_a:-}" ] && [[ "$_a" =~ ^[Yy] ]]
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  UTILITY FUNCTIONS
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Generate random hex string (N bytes → 2N hex chars)
rand_hex() {
    if command -v openssl &>/dev/null; then
        openssl rand -hex "${1:-32}" 2>/dev/null && return
    fi
    # Fallback: /dev/urandom (always available on Linux)
    tr -dc 'a-f0-9' </dev/urandom 2>/dev/null | head -c "$(( ${1:-32} * 2 ))"
    echo
}

# Generate random password (alphanumeric + symbols, 14 chars)
rand_pass() {
    if command -v openssl &>/dev/null; then
        openssl rand -base64 12 2>/dev/null | tr -d '=/+' | head -c 14 && echo && return
    fi
    tr -dc 'A-Za-z0-9!@#%' </dev/urandom 2>/dev/null | head -c 14
    echo
}

# Detect server IP (multiple strategies)
my_ip() {
    # Strategy 1: hostname -I (most Linux distros)
    _ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    if [[ -n "$_ip" && ! "$_ip" =~ ^127\. ]]; then echo "$_ip"; return; fi

    # Strategy 2: ip command
    _ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)
    if [[ -n "$_ip" && ! "$_ip" =~ ^127\. ]]; then echo "$_ip"; return; fi

    # Strategy 3: ifconfig
    _ip=$(ifconfig 2>/dev/null | awk '/inet / && !/127.0.0.1/{print $2}' | head -1 | tr -d 'addr:')
    if [[ -n "$_ip" && ! "$_ip" =~ ^127\. ]]; then echo "$_ip"; return; fi

    # Strategy 4: external service (only if curl exists)
    if command -v curl &>/dev/null; then
        for s in ifconfig.me ip.sb ipinfo.io/ip; do
            _ip=$(curl -sf --connect-timeout 3 "https://$s" 2>/dev/null) && \
            [[ "$_ip" =~ ^[0-9.]+$ ]] && { echo "$_ip"; return; }
        done
    fi

    echo "YOUR_SERVER_IP"
}

# Check if a TCP port is in use (works without ss/lsof/netstat)
port_in_use() {
    local port="$1"
    # Method 1: /proc/net/tcp (always available on Linux)
    if [ -f /proc/net/tcp ]; then
        # Convert port to hex (no printf %X needed, use awk)
        local hex_port=$(printf '%04X' "$port" 2>/dev/null)
        if [ -n "$hex_port" ] && grep -qi ":${hex_port} " /proc/net/tcp 2>/dev/null; then
            return 0
        fi
    fi
    # Method 2: ss
    if command -v ss &>/dev/null && ss -tlnp 2>/dev/null | grep -q ":${port} "; then
        return 0
    fi
    # Method 3: netstat
    if command -v netstat &>/dev/null && netstat -tlnp 2>/dev/null | grep -q ":${port} "; then
        return 0
    fi
    # Method 4: lsof
    if command -v lsof &>/dev/null && lsof -i :"$port" &>/dev/null; then
        return 0
    fi
    return 1
}

# Get available memory in MB (works without free)
get_mem_mb() {
    if command -v free &>/dev/null; then
        free -m 2>/dev/null | awk '/^Mem:/{print $2}'
        return
    fi
    # Fallback: /proc/meminfo
    if [ -f /proc/meminfo ]; then
        awk '/^MemTotal:/{printf "%.0f", $2/1024}' /proc/meminfo 2>/dev/null
        return
    fi
    echo "0"
}

# Get available disk space in GB for a path (works without df -BG)
get_disk_gb() {
    local path="${1:-/}"
    # Try df -BG first (available on GNU coreutils)
    _val=$(df -BG "$path" 2>/dev/null | awk 'NR==2{gsub(/G/,"",$4); print $4}')
    if [ -n "$_val" ] && [ "$_val" -gt 0 ] 2>/dev/null; then echo "$_val"; return; fi
    # Fallback: df -k (POSIX)
    _val=$(df -k "$path" 2>/dev/null | awk 'NR==2{printf "%.0f", $4/1024/1024}')
    echo "${_val:-0}"
}

# Get CPU count (works without nproc)
get_cpu_count() {
    nproc 2>/dev/null || \
    grep -c ^processor /proc/cpuinfo 2>/dev/null || \
    echo "1"
}

# Check if we're running as root
check_root() {
    if [ "$(id -u)" -ne 0 ]; then
        die "请使用 root 权限运行: sudo $0 $*"
    fi
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  PACKAGE MANAGER DETECTION & INSTALLATION
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PKG_MGR=""
PKG_INSTALL_CMD=""

detect_pkg_mgr() {
    if command -v apt-get &>/dev/null; then
        PKG_MGR="apt"; PKG_INSTALL_CMD="apt-get"
    elif command -v dnf &>/dev/null; then
        PKG_MGR="dnf"; PKG_INSTALL_CMD="dnf"
    elif command -v yum &>/dev/null; then
        PKG_MGR="yum"; PKG_INSTALL_CMD="yum"
    elif command -v apk &>/dev/null; then
        PKG_MGR="apk"; PKG_INSTALL_CMD="apk"
    elif command -v zypper &>/dev/null; then
        PKG_MGR="zypper"; PKG_INSTALL_CMD="zypper"
    else
        PKG_MGR="unknown"
    fi
}

# Install one or more packages (handles each pkg individually for resilience)
# Track if apt update was already done this run
_PKG_UPDATED=false

pkg_install() {
    case "$PKG_MGR" in
        apt)
            export DEBIAN_FRONTEND=noninteractive
            if ! $_PKG_UPDATED; then
                info "  更新软件源..."
                apt-get update -qq >>"$LOG_FILE" 2>&1
                _PKG_UPDATED=true
            fi
            ;;
    esac
    for pkg in "$@"; do
        command -v "$pkg" &>/dev/null && { ok "  ${pkg} 已存在"; continue; }
        info "  安装 ${pkg}..."
        case "$PKG_MGR" in
            apt)    apt-get install -y -qq "$pkg" >>"$LOG_FILE" 2>&1 ;;
            dnf)    dnf install -y -q "$pkg" >>"$LOG_FILE" 2>&1 ;;
            yum)    yum install -y -q "$pkg" >>"$LOG_FILE" 2>&1 ;;
            apk)    apk add --no-cache "$pkg" >>"$LOG_FILE" 2>&1 ;;
            zypper) zypper --non-interactive install -y "$pkg" >>"$LOG_FILE" 2>&1 ;;
            *)      warn "  无法自动安装 ${pkg} (未知包管理器)"; return 1 ;;
        esac
        # Verify — for library packages, check dpkg/rpm instead of command
        _found=false
        command -v "$pkg" &>/dev/null && _found=true
        dpkg -s "$pkg" &>/dev/null 2>&1 && _found=true
        rpm -q "$pkg" &>/dev/null 2>&1 && _found=true
        if $_found; then
            ok "  ${pkg} ✓"
        else
            warn "  ${pkg} 安装可能失败 (详见 ${LOG_FILE})"
        fi
    done
}

# Ensure curl is available (critical dependency)
ensure_curl() {
    if command -v curl &>/dev/null; then return; fi
    info "curl 未安装，尝试安装..."
    if command -v wget &>/dev/null; then return; fi  # wget is also acceptable for downloads
    pkg_install curl
    if ! command -v curl &>/dev/null; then
        die "无法安装 curl。请手动安装后重试。"
    fi
}

# Ensure a download tool exists (curl or wget)
ensure_downloader() {
    if command -v curl &>/dev/null; then
        DL_CMD="curl"
        DL_OPTS="-fsSL --connect-timeout 15 --max-time 300"
        return
    fi
    if command -v wget &>/dev/null; then
        DL_CMD="wget"
        DL_OPTS="-q --timeout=15"
        return
    fi
    # Last resort: install curl
    pkg_install curl
    if command -v curl &>/dev/null; then
        DL_CMD="curl"
        DL_OPTS="-fsSL --connect-timeout 15 --max-time 300"
        return
    fi
    die "系统缺少 curl 和 wget，且无法自动安装。请手动安装其中一个。"
}

# Download a URL to stdout or a file
dl_to_stdout() {
    case "$DL_CMD" in
        curl) curl $DL_OPTS "$1" 2>/dev/null ;;
        wget) wget $DL_OPTS -O - "$1" 2>/dev/null ;;
    esac
}
dl_to_file() {
    case "$DL_CMD" in
        curl) curl $DL_OPTS "$1" -o "$2" 2>/dev/null ;;
        wget) wget $DL_OPTS -O "$2" "$1" 2>/dev/null ;;
    esac
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  DOCKER INSTALLATION
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Install Docker via system package manager (when get.docker.com fails)
install_docker_via_pkg() {
    info "通过包管理器安装 Docker..."
    case "$PKG_MGR" in
        apt)
            export DEBIAN_FRONTEND=noninteractive
            _arch=$(dpkg --print-architecture 2>/dev/null || echo "amd64")
            _os_id=$(. /etc/os-release 2>/dev/null && echo "${ID:-debian}")
            _os_ver=$(. /etc/os-release 2>/dev/null && echo "${VERSION_CODENAME:-stable}")

            # Step 1: Install prerequisites (single apt-get update)
            pkg_install ca-certificates curl gnupg lsb-release apt-transport-https

            # Step 2a: Try Docker official repo (with China proxy fallback for GPG)
            mkdir -p /etc/apt/keyrings
            rm -f /etc/apt/keyrings/docker.gpg /tmp/docker.gpg
            _gpg_ok=false
            _gpg_urls=(
                "https://download.docker.com/linux/${_os_id}/gpg"
            )
            # Add China mirror proxies for GPG key
            for _dm in "${DOCKER_MIRRORS[@]}"; do
                _gpg_urls+=("${_dm}/https://download.docker.com/linux/${_os_id}/gpg")
            done
            for _gpg_url in "${_gpg_urls[@]}"; do
                if dl_to_file "$_gpg_url" /tmp/docker.gpg 2>/dev/null; then
                    gpg --batch --yes --dearmor -o /etc/apt/keyrings/docker.gpg 2>/dev/null && _gpg_ok=true
                    chmod a+r /etc/apt/keyrings/docker.gpg 2>/dev/null || true
                    break
                fi
            done

            if $_gpg_ok; then
                # Map unknown VERSION_CODENAME to closest known one
                case "$_os_ver" in
                    noble|plucky)  _apt_codename="noble" ;;   # 24.04 / 24.10
                    jammy)         _apt_codename="jammy" ;;   # 22.04
                    focal)         _apt_codename="focal" ;;   # 20.04
                    *)             _apt_codename="noble" ;;   # default to latest LTS
                esac

                echo "deb [arch=${_arch} signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/${_os_id} ${_apt_codename} stable" \
                    > /etc/apt/sources.list.d/docker.list

                _PKG_UPDATED=false
                info "  更新 Docker 软件源..."
                if apt-get update -qq >>"$LOG_FILE" 2>&1; then
                    _PKG_UPDATED=true
                    info "  安装 docker-ce ..."
                    if apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >>"$LOG_FILE" 2>&1; then
                        return 0
                    fi
                    warn "  docker-ce 安装失败"
                else
                    warn "  Docker 官方源不可用"
                fi
            else
                warn "  GPG key 下载失败 (网络不通)"
            fi

            # Step 2b: Fallback — use Ubuntu's built-in docker.io (no external repo needed)
            warn "  回退到系统自带 docker.io ..."
            rm -f /etc/apt/sources.list.d/docker.list
            _PKG_UPDATED=false
            apt-get install -y -qq docker.io docker-compose-v2 >>"$LOG_FILE" 2>&1 && return 0
            # Some older Ubuntu don't have docker-compose-v2
            apt-get install -y -qq docker.io >>"$LOG_FILE" 2>&1
            ;;
        dnf|yum)
            ${PKG_INSTALL_CMD} install -y -q yum-utils >>"$LOG_FILE" 2>&1 || true
            ${PKG_INSTALL_CMD}-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo >>"$LOG_FILE" 2>&1 || true
            ${PKG_INSTALL_CMD} install -y -q docker-ce docker-ce-cli containerd.io docker-compose-plugin >>"$LOG_FILE" 2>&1
            ;;
        apk)
            apk add --no-cache docker docker-compose docker-cli-compose >>"$LOG_FILE" 2>&1
            ;;
        zypper)
            zypper --non-interactive install -y docker docker-compose >>"$LOG_FILE" 2>&1
            ;;
        *)
            return 1
            ;;
    esac
}

# Full Docker installation flow
ensure_docker() {
    # Check if Docker is already installed
    if command -v docker &>/dev/null && docker version &>/dev/null; then
        _dv=$(docker version --format '{{.Server.Version}}' 2>/dev/null | head -1)
        ok "Docker ${_dv:-已安装}"
        return
    fi

    # Not installed or not running
    if command -v docker &>/dev/null; then
        warn "Docker 已安装但未运行，尝试启动..."
        systemctl start docker 2>/dev/null || service docker start 2>/dev/null || true
        sleep 3
        if docker info &>/dev/null; then
            ok "Docker 已启动"
            return
        fi
    fi

    # Need to install
    info "Docker 未安装，开始自动安装..."
    if ! $AUTO_YES; then
        ask_y "Docker 未安装，是否自动安装？（需要几分钟）" || die "请手动安装 Docker: curl -fsSL https://get.docker.com | sh"
    fi

    info "安装 Docker（可能需要几分钟）..."

    # Strategy 1: Official get.docker.com script (most universal)
    _installed=false
    info "尝试官方安装脚本 (get.docker.com)..."
    if dl_to_file "https://get.docker.com" /tmp/get-docker.sh 2>/dev/null; then
        info "执行 Docker 安装脚本（约需 1-3 分钟）..."
        sh /tmp/get-docker.sh >> "$LOG_FILE" 2>&1 && _installed=true
        rm -f /tmp/get-docker.sh
    fi
    if ! $_installed; then
        warn "官方脚本安装失败"
    fi

    # Strategy 2: Package manager
    if ! $_installed; then
        info "尝试包管理器安装..."
        install_docker_via_pkg && _installed=true || warn "包管理器安装失败"
    fi

    # Strategy 3: Manual binary download (last resort for minimal systems)
    if ! $_installed; then
        info "尝试手动下载 Docker 二进制..."
        _arch=$(uname -m)
        case "$_arch" in
            x86_64)  _docker_arch="x86_64" ;;
            aarch64) _docker_arch="aarch64" ;;
            armv7l)  _docker_arch="armhf" ;;
            *)       die "不支持的架构: $_arch" ;;
        esac
        _docker_ver="27.5.1"
        _docker_url="https://download.docker.com/linux/static/stable/${_docker_arch}/docker-${_docker_ver}.tgz"
        if ! dl_to_file "$_docker_url" /tmp/docker.tgz 2>/dev/null; then
            # Try China mirrors for Docker binary
            for _dm in "${DOCKER_MIRRORS[@]}"; do
                info "  尝试镜像 ${_dm%%/*}..."
                if dl_to_file "${_dm}/https://download.docker.com/linux/static/stable/${_docker_arch}/docker-${_docker_ver}.tgz" /tmp/docker.tgz 2>/dev/null; then
                    break
                fi
            done
        fi
        if [ -f /tmp/docker.tgz ]; then
            info "  解压 Docker 二进制..."
            tar xzf /tmp/docker.tgz -C /tmp >>"$LOG_FILE" 2>&1 && \
            cp /tmp/docker/* /usr/local/bin/ >>"$LOG_FILE" 2>&1 && \
            rm -rf /tmp/docker /tmp/docker.tgz && _installed=true
        fi
    fi

    if ! $_installed; then
        die "Docker 安装失败。请手动安装后重试:
  Debian/Ubuntu:  apt-get install docker-ce docker-compose-plugin
  CentOS/RHEL:    dnf install docker-ce docker-compose-plugin
  Alpine:         apk add docker docker-compose
  通用:           curl -fsSL https://get.docker.com | sh"
    fi

    # Start Docker
    systemctl enable docker 2>/dev/null || true
    systemctl start docker 2>/dev/null || service docker start 2>/dev/null || true
    sleep 3

    if ! docker info &>/dev/null; then
        die "Docker 启动失败。请检查: systemctl status docker"
    fi
    ok "Docker 已安装并启动"
}

# Detect Docker Compose command (V2 plugin vs standalone V1)
detect_compose_cmd() {
    if docker compose version &>/dev/null 2>&1; then
        COMPOSE_CMD="docker compose"
        ok "Docker Compose (plugin) $(docker compose version --short 2>/dev/null)"
        return
    fi
    if command -v docker-compose &>/dev/null; then
        COMPOSE_CMD="docker-compose"
        ok "Docker Compose (standalone) $(docker-compose version --short 2>/dev/null)"
        return
    fi

    # Not found — try to install automatically
    warn "Docker Compose 未找到，尝试自动安装..."
    _compose_ok=false

    # Method 1: Package manager (must update cache first)
    case "$PKG_MGR" in
        apt)
            export DEBIAN_FRONTEND=noninteractive
            apt-get update -qq >>"$LOG_FILE" 2>&1 || true
            for _pkg in docker-compose-v2 docker-compose-plugin docker-compose; do
                info "  尝试 apt install ${_pkg} ..."
                if apt-get install -y -qq "$_pkg" >>"$LOG_FILE" 2>&1; then
                    _compose_ok=true; break
                fi
            done
            ;;
        dnf|yum)
            for _pkg in docker-compose-plugin docker-compose; do
                ${PKG_INSTALL_CMD} install -y -q "$_pkg" >>"$LOG_FILE" 2>&1 && _compose_ok=true && break
            done
            ;;
        apk)
            apk add --no-cache docker-compose docker-cli-compose >>"$LOG_FILE" 2>&1 && _compose_ok=true
            ;;
        zypper)
            zypper --non-interactive install -y docker-compose >>"$LOG_FILE" 2>&1 && _compose_ok=true
            ;;
    esac

    # Method 2: Download standalone binary (works on all distros)
    if ! $_compose_ok; then
        info "  下载 Docker Compose 独立二进制..."
        _compose_ver="v2.32.4"
        _carch=$(uname -m)
        case "$_carch" in
            x86_64)  _compose_arch="x86_64" ;;
            aarch64) _compose_arch="aarch64" ;;
            armv7l)  _compose_arch="armv7" ;;
            *)       _compose_arch="x86_64" ;;
        esac
        _compose_url="https://github.com/docker/compose/releases/download/${_compose_ver}/docker-compose-linux-${_compose_arch}"
        # Build list of URLs to try (direct + China proxies)
        _compose_urls=("$_compose_url")
        for _dm in "${RAW_PROXIES[@]}"; do
            _compose_urls+=("${_dm}/${_compose_url}")
        done
        for _curl in "${_compose_urls[@]}"; do
            if dl_to_file "$_curl" /tmp/docker-compose 2>/dev/null && [ -f /tmp/docker-compose ] && [ -s /tmp/docker-compose ]; then
                mv -f /tmp/docker-compose /usr/local/bin/docker-compose
                chmod +x /usr/local/bin/docker-compose
                _compose_ok=true
                break
            fi
            rm -f /tmp/docker-compose
        done
    fi

    # Re-detect after install
    if docker compose version &>/dev/null 2>&1; then
        COMPOSE_CMD="docker compose"
        ok "Docker Compose (plugin) $(docker compose version --short 2>/dev/null)"
        return
    fi
    if command -v docker-compose &>/dev/null; then
        COMPOSE_CMD="docker-compose"
        ok "Docker Compose (standalone) $(docker-compose version --short 2>/dev/null)"
        return
    fi

    die "Docker Compose 自动安装失败。请手动安装:
  apt:  apt-get install docker-compose-v2
  通用: https://docs.docker.com/compose/install/
  详见日志: ${LOG_FILE}"
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  CHINA NETWORK SUPPORT
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Check if Docker Hub is directly reachable
docker_hub_reachable() {
    curl -sf --connect-timeout 5 "https://registry-1.docker.io/v2/" &>/dev/null
}

# Configure Docker mirror (merges with existing daemon.json)
configure_docker_mirror() {
    if docker_hub_reachable; then
        ok "Docker Hub 直连正常"
        return
    fi

    warn "Docker Hub 不可达，配置国内镜像加速..."

    # Backup existing config
    if [ -f /etc/docker/daemon.json ]; then
        cp /etc/docker/daemon.json "/etc/docker/daemon.json.bak.$(date +%s)" 2>/dev/null || true
    fi

    # Build mirror list JSON
    _mirror_json="["
    _sep=""
    for _m in "${DOCKER_MIRRORS[@]}"; do
        _mirror_json="${_mirror_json}${_sep}\"${_m}\""
        _sep=", "
    done
    _mirror_json="${_mirror_json}]"

    # Merge with existing config if present
    if command -v python3 &>/dev/null && [ -f /etc/docker/daemon.json ]; then
        python3 -c "
import json, sys
try:
    cfg = json.load(open('/etc/docker/daemon.json'))
except: cfg = {}
cfg['registry-mirrors'] = json.loads('''${_mirror_json}''')
json.dump(cfg, open('/etc/docker/daemon.json','w'), indent=2)
print('merged')
" 2>/dev/null && ok "镜像加速已配置（合并已有配置）" && return
    fi

    # Simple: just write new config
    mkdir -p /etc/docker
    echo "{\"registry-mirrors\":${_mirror_json}}" > /etc/docker/daemon.json

    # Restart Docker to apply
    systemctl daemon-reload 2>/dev/null || true
    systemctl restart docker 2>/dev/null || service docker restart 2>/dev/null || true
    sleep 3

    if docker info 2>/dev/null | grep -q "Registry Mirrors"; then
        ok "镜像加速已配置 (${#DOCKER_MIRRORS[@]} 个源)"
    else
        warn "镜像配置已写入但可能未生效"
        warn "如构建时报网络错误，请手动重启: systemctl restart docker"
    fi
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  FIREWALL MANAGEMENT
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
open_firewall_port() {
    local port="${1:-3000}"
    local opened=false

    # ufw (Ubuntu/Debian)
    if command -v ufw &>/dev/null; then
        if ufw status 2>/dev/null | grep -qi "active"; then
            if ! ufw status 2>/dev/null | grep -q "${port}"; then
                ufw allow "${port}/tcp" >/dev/null 2>&1 && opened=true || true
            fi
        fi
    fi || true

    # firewalld (CentOS/RHEL/Rocky/Alma)
    if command -v firewall-cmd &>/dev/null; then
        if systemctl is-active --quiet firewalld 2>/dev/null; then
            if ! firewall-cmd --list-ports 2>/dev/null | grep -q "${port}"; then
                firewall-cmd --permanent --add-port="${port}/tcp" >/dev/null 2>&1 || true
                firewall-cmd --reload >/dev/null 2>&1 || true
                opened=true
            fi
        fi
    fi || true

    # iptables (raw, last resort — just inform user)
    if ! $opened && command -v iptables &>/dev/null; then
        if iptables -L INPUT -n 2>/dev/null | grep -q "REJECT\|DROP"; then
            warn "检测到 iptables 规则，请手动放行端口 ${port}:"
            warn "  iptables -I INPUT -p tcp --dport ${port} -j ACCEPT"
        fi
    fi || true

    if $opened; then
        ok "防火墙已放行端口 ${port}"
    else
        ok "无需防火墙配置"
    fi
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  COMPOSE SHORTCUT (wraps detected COMPOSE_CMD)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
compose() {
    $COMPOSE_CMD "$@"
}

# ═══════════════════════════════════════════════════════════════════
#  MODE: STATUS
# ═══════════════════════════════════════════════════════════════════
if [ "$MODE" = "status" ]; then
    if [ ! -f "${INSTALL_DIR}/docker-compose.yml" ]; then
        echo "未找到安装 (${INSTALL_DIR})"
        exit 1
    fi
    cd "$INSTALL_DIR"
    echo ""
    docker compose ps 2>/dev/null || docker-compose ps 2>/dev/null || echo "无法获取容器状态"
    echo ""
    echo "  安装目录:  ${INSTALL_DIR}"
    echo "  磁盘占用:  $(du -sh . 2>/dev/null | cut -f1)"
    if [ -f .env ]; then
        _sp=$(grep '^APP_PORT=' .env 2>/dev/null | cut -d= -f2)
        _su=$(grep '^ADMIN_USERNAME=' .env 2>/dev/null | cut -d= -f2)
        _sa=$(grep '^APP_URL=' .env 2>/dev/null | cut -d= -f2)
        echo "  端口:      ${_sp:-3000}"
        echo "  地址:      ${_sa:-未配置}"
        echo "  管理员:    ${_su:-admin}"
    fi
    echo ""
    exit 0
fi

# ═══════════════════════════════════════════════════════════════════
#  MODE: LOGS
# ═══════════════════════════════════════════════════════════════════
if [ "$MODE" = "logs" ]; then
    if [ ! -f "${INSTALL_DIR}/docker-compose.yml" ]; then
        echo "未找到安装 (${INSTALL_DIR})"
        exit 1
    fi
    cd "$INSTALL_DIR"
    docker compose logs -f --tail=100 2>/dev/null || docker-compose logs -f --tail=100 2>/dev/null
    exit 0
fi

# ═══════════════════════════════════════════════════════════════════
#  MODE: RESTART
# ═══════════════════════════════════════════════════════════════════
if [ "$MODE" = "restart" ]; then
    if [ ! -f "${INSTALL_DIR}/docker-compose.yml" ]; then
        echo "未找到安装 (${INSTALL_DIR})"
        exit 1
    fi
    cd "$INSTALL_DIR"
    echo "重启服务..."
    docker compose restart 2>/dev/null || docker-compose restart 2>/dev/null
    echo "完成。查看日志: $0 --logs"
    exit 0
fi

# ═══════════════════════════════════════════════════════════════════
#  MODE: STOP
# ═══════════════════════════════════════════════════════════════════
if [ "$MODE" = "stop" ]; then
    if [ ! -f "${INSTALL_DIR}/docker-compose.yml" ]; then
        echo "未找到安装 (${INSTALL_DIR})"
        exit 1
    fi
    cd "$INSTALL_DIR"
    echo "停止服务..."
    docker compose stop 2>/dev/null || docker-compose stop 2>/dev/null
    echo "完成。启动: $0 --restart 或 cd ${INSTALL_DIR} && docker compose start"
    exit 0
fi

# ═══════════════════════════════════════════════════════════════════
#  MODE: UNINSTALL
# ═══════════════════════════════════════════════════════════════════
if [ "$MODE" = "uninstall" ]; then
    if [ ! -f "${INSTALL_DIR}/docker-compose.yml" ]; then
        die "未找到安装 (${INSTALL_DIR})"
    fi
    echo ""
    warn "即将永久删除:"
    warn "  • 安装目录: ${INSTALL_DIR}"
    warn "  • Docker 容器: novel-manager, novel-postgres"
    warn "  • Docker 镜像: 本地构建的镜像"
    warn "  • 数据卷: PostgreSQL 数据（永久丢失）"
    echo ""
    if ! ask_y "确认完全卸载？"; then
        echo "已取消。"
        exit 0
    fi
    cd "$INSTALL_DIR"
    docker compose down -v --rmi local 2>/dev/null || docker-compose down -v --rmi local 2>/dev/null || true
    cd /
    rm -rf "$INSTALL_DIR"
    ok "已完全卸载"
    exit 0
fi

# ═══════════════════════════════════════════════════════════════════
#  MODE: BACKUP
# ═══════════════════════════════════════════════════════════════════
if [ "$MODE" = "backup" ]; then
    if [ ! -f "${INSTALL_DIR}/docker-compose.yml" ]; then
        die "未找到安装 (${INSTALL_DIR})"
    fi
    cd "$INSTALL_DIR"
    _ts=$(date +%Y%m%d_%H%M%S)
    _bf="backups/backup_${_ts}.sql"
    mkdir -p backups
    info "备份数据库 → ${_bf}..."

    # Get DB user from .env if available
    _db_user="novel"
    _db_name="novel_admin"
    [ -f .env ] && _db_user=$(grep '^POSTGRES_USER=' .env 2>/dev/null | cut -d= -f2)
    [ -f .env ] && _db_name=$(grep '^POSTGRES_DB=' .env 2>/dev/null | cut -d= -f2)
    _db_user=${_db_user:-novel}
    _db_name=${_db_name:-novel_admin}

    if docker compose exec -T postgres pg_dump -U "$_db_user" "$_db_name" > "$_bf" 2>/dev/null; then
        _sz=$(du -h "$_bf" 2>/dev/null | cut -f1)
        ok "备份完成: ${INSTALL_DIR}/${_bf} (${_sz})"
    else
        err "备份失败（PostgreSQL 容器可能未运行）"
        err "先启动服务: cd ${INSTALL_DIR} && docker compose up -d"
        exit 1
    fi
    exit 0
fi

# ═══════════════════════════════════════════════════════════════════
#  MODE: ROLLBACK
# ═══════════════════════════════════════════════════════════════════
if [ "$MODE" = "rollback" ]; then
    _rollback_dir="${INSTALL_DIR}.rollback"
    if [ ! -d "$_rollback_dir" ]; then
        die "未找到回滚备份 (${_rollback_dir})"
    fi
    info "停止当前服务..."
    cd "$INSTALL_DIR" && docker compose down 2>/dev/null || docker-compose down 2>/dev/null || true
    info "执行回滚..."
    rm -rf "${INSTALL_DIR}.bak2" 2>/dev/null || true
    mv "$INSTALL_DIR" "${INSTALL_DIR}.bak2"
    mv "$_rollback_dir" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
    info "启动回滚版本..."
    docker compose up -d 2>/dev/null || docker-compose up -d 2>/dev/null
    ok "已回滚到上一版本"
    warn "旧版本备份在: ${INSTALL_DIR}.bak2（可手动删除）"
    exit 0
fi

# ═══════════════════════════════════════════════════════════════════
#  MODE: UPGRADE
# ═══════════════════════════════════════════════════════════════════
if [ "$MODE" = "upgrade" ]; then
    if [ ! -f "${INSTALL_DIR}/docker-compose.yml" ]; then
        die "未找到安装 (${INSTALL_DIR})"
    fi
    cd "$INSTALL_DIR"

    # Pre-upgrade backup
    _ts=$(date +%Y%m%d_%H%M%S)
    mkdir -p backups
    _db_user="novel"; _db_name="novel_admin"
    [ -f .env ] && _db_user=$(grep '^POSTGRES_USER=' .env 2>/dev/null | cut -d= -f2)
    [ -f .env ] && _db_name=$(grep '^POSTGRES_DB=' .env 2>/dev/null | cut -d= -f2)
    docker compose exec -T postgres pg_dump -U "${_db_user:-novel}" "${_db_name:-novel_admin}" \
        > "backups/pre_upgrade_${_ts}.sql" 2>/dev/null || warn "数据库备份失败（容器可能未运行）"
    ok "数据库已备份: backups/pre_upgrade_${_ts}.sql"

    # Replace files from tarball source
    if [ "$SCRIPT_DIR" != "$INSTALL_DIR" ] && [ -f "${SCRIPT_DIR}/Dockerfile" ]; then
        info "从 ${SCRIPT_DIR} 复制新版本文件..."
        rm -rf "${INSTALL_DIR}.rollback" 2>/dev/null || true
        cp -a "$INSTALL_DIR" "${INSTALL_DIR}.rollback"
        # Copy all project directories and files (skip .env, node_modules, .next, backups)
        for item in src prisma public mini-services Dockerfile docker-compose.yml docker-entrypoint.sh \
                    .dockerignore .env.production tsconfig.json next.config.ts postcss.config.mjs \
                    tailwind.config.ts package.json bun.lock components.json eslint.config.mjs; do
            [ -e "${SCRIPT_DIR}/$item" ] && \
            rm -rf "${INSTALL_DIR:?}/$item" && \
            cp -a "${SCRIPT_DIR}/$item" "${INSTALL_DIR}/$item" 2>/dev/null || true
        done
        ok "文件已更新"
    elif [ -d .git ] && command -v git &>/dev/null; then
        info "git pull 拉取最新代码..."
        if git pull --ff-only 2>&1; then
            ok "代码已更新"
        else
            warn "git pull 失败，尝试手动解决或使用 tarball 方式升级"
        fi
    else
        die "无法升级: 非 git 仓库且找不到新版本文件"
        die "请下载最新 tarball，解压后在新目录运行: ./deploy.sh --upgrade"
    fi

    # Handle .env migration (add new variables, keep existing values)
    if [ -f .env.production ]; then
        info "检查配置项更新..."
        # Source existing .env to get current values
        # We read specific keys instead of 'source' to avoid set -u issues
        for _key in POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB DB_PORT APP_PORT APP_NAME APP_URL \
                     TZ NEXTAUTH_SECRET NEXTAUTH_URL ADMIN_USERNAME ADMIN_PASSWORD SCRAPER_SERVICE_TOKEN \
                     FIRECRAWL_API_KEY FIRECRAWL_API_URL AGENTQL_API_KEY AGENTQL_API_URL \
                     CLOUD_BROWSER_PROVIDER BROWSERLESS_API_KEY BROWSERLESS_API_URL \
                     STEEL_API_KEY STEEL_API_URL; do
            _existing=$(grep "^${_key}=" .env 2>/dev/null | head -1)
            _template=$(grep "^${_key}=" .env.production 2>/dev/null | head -1)
            # If template has it but .env doesn't, add it
            if [ -n "$_template" ] && [ -z "$_existing" ]; then
                echo "$_template" >> .env
                info "  新增配置项: ${_key}"
            fi
        done
    fi

    info "重新构建并启动..."
    docker compose up -d --build 2>&1
    ok "升级完成！"
    echo ""
    echo "  如有问题回滚:  $0 --rollback"
    echo "  查看日志:      $0 --logs"
    exit 0
fi

# ═══════════════════════════════════════════════════════════════════
#  MODE: INSTALL (main flow)
# ═══════════════════════════════════════════════════════════════════

# ── 0. Root Check ──
check_root "$@"

# ── Banner ──
[ -t 1 ] && clear 2>/dev/null || true
echo ""
echo -e "${C_CYN}${C_BLD}╔═══════════════════════════════════════════════╗${C_RST}"
echo -e "${C_CYN}${C_BLD}║    📚 小说管理系统 · 生产环境一键部署 v2       ║${C_RST}"
echo -e "${C_CYN}${C_BLD}╚═══════════════════════════════════════════════╝${C_RST}"
echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  STEP 1: System Detection
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
step "[1/8] 系统检测"

# OS info
if [ -f /etc/os-release ]; then
    # shellcheck source=/dev/null
    . /etc/os-release
    info "系统: ${NAME:-Unknown} (${ID:-unknown}) ${VERSION_ID:-}"
else
    warn "无法检测系统版本（缺少 /etc/os-release）"
fi

# Architecture
_arch=$(uname -m)
info "架构: ${_arch}"

# Kernel
_kern=$(uname -r)
_kern_major=$(echo "$_kern" | awk -F. '{print $1}')
_kern_minor=$(echo "$_kern" | awk -F. '{print $2}')
info "内核: ${_kern}"

# Check minimum kernel (Docker requires 3.10+)
if [ "${_kern_major:-0}" -lt 3 ] || { [ "${_kern_major:-0}" -eq 3 ] && [ "${_kern_minor:-0}" -lt 10 ]; }; then
    die "内核版本过低 (${_kern})，Docker 需要 3.10+。请升级内核。"
fi

# Check architecture (Docker supports x86_64, aarch64, armhf)
case "$_arch" in
    x86_64|aarch64|armv7l|armhf) ok "架构支持" ;;
    *) die "不支持的架构: $_arch（Docker 需要 x86_64/aarch64/armhf）" ;;
esac

# Detect package manager
detect_pkg_mgr
info "包管理器: ${PKG_MGR:-未知}"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  STEP 2: Resource Check
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
step "[2/8] 资源检查"

# Memory
_mem_mb=$(get_mem_mb)
_mem_mb=${_mem_mb:-0}
if [ "$_mem_mb" -lt 1500 ] 2>/dev/null; then
    warn "内存仅 ${_mem_mb}MB（建议 2GB+）"
    _swap_mb=$(free -m 2>/dev/null | awk '/^Swap:/{print $2}')
    _swap_mb=${_swap_mb:-0}
    if [ "$_swap_mb" -lt 1000 ] 2>/dev/null; then
        warn "Swap 不足或不存在，低内存可能导致构建失败 (OOM)"
        if ask_y "自动创建 2GB swap 文件？"; then
            _swapfile="/swapfile"
            if [ ! -f "$_swapfile" ]; then
                info "创建 swap 文件（可能需要一分钟）..."
                dd if=/dev/zero of="$_swapfile" bs=1M count=2048 2>/dev/null
                chmod 600 "$_swapfile"
                mkswap "$_swapfile" >/dev/null 2>&1
                swapon "$_swapfile" 2>/dev/null
                grep -q 'swapfile' /etc/fstab 2>/dev/null || echo "$_swapfile none swap sw 0 0" >> /etc/fstab
            fi
            _swap_now=$(free -m 2>/dev/null | awk '/^Swap:/{print $2}')
            ok "Swap 已创建: ${_swap_now:-?}MB"
        fi
    else
        ok "已有 Swap: ${_swap_mb}MB"
    fi
else
    ok "内存 ${_mem_mb}MB"
fi

# Disk
_disk_gb=$(get_disk_gb "$(dirname "$INSTALL_DIR" 2>/dev/null || echo /)")
_disk_gb=${_disk_gb:-0}
if [ "$_disk_gb" -lt 5 ] 2>/dev/null; then
    die "磁盘空间不足: ${_disk_gb}GB 可用（至少需要 5GB）"
fi
ok "磁盘 ${_disk_gb}GB 可用"

# CPU
_cores=$(get_cpu_count)
if [ "$_cores" -lt 2 ] 2>/dev/null; then
    warn "仅 ${_cores} 核 CPU，Docker 构建可能较慢（预计 10-15 分钟）"
else
    ok "CPU ${_cores} 核"
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  STEP 3: Docker Environment
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
step "[3/8] Docker 环境"

ensure_docker
detect_compose_cmd

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  STEP 4: Network & Mirror
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
step "[4/8] 网络与镜像加速"

ensure_downloader
configure_docker_mirror

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  STEP 5: Get Project Files
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
step "[5/8] 获取项目文件"

_got=false

# Case A: Script is running INSIDE the project directory (tarball extract)
if [ -f "${SCRIPT_DIR}/Dockerfile" ] && [ -f "${SCRIPT_DIR}/docker-compose.yml" ]; then
    if [ "$SCRIPT_DIR" = "$INSTALL_DIR" ]; then
        # Already in the right place
        ok "项目文件就绪 (当前目录)"
        _got=true
    else
        # Copy to install directory
        if [ -d "$INSTALL_DIR" ]; then
            if [ -f "${INSTALL_DIR}/docker-compose.yml" ]; then
                info "检测到已有安装，将备份后替换..."
                rm -rf "${INSTALL_DIR}.rollback" 2>/dev/null || true
                mv "$INSTALL_DIR" "${INSTALL_DIR}.rollback"
            else
                if ! ask_y "${INSTALL_DIR} 已存在但无有效安装，删除重建？"; then
                    die "请手动清理 ${INSTALL_DIR} 后重试"
                fi
                rm -rf "$INSTALL_DIR"
            fi
        fi
        info "复制项目文件到 ${INSTALL_DIR}..."
        mkdir -p "$INSTALL_DIR"
        cp -a "$SCRIPT_DIR/." "$INSTALL_DIR/"
        _got=true
        ok "项目文件已复制"
    fi
fi

# Case B: Existing git install
if ! $_got && [ -d "${INSTALL_DIR}/.git" ] && command -v git &>/dev/null; then
    if ask_y "检测到已有 Git 安装 (${INSTALL_DIR})，更新代码？"; then
        cd "$INSTALL_DIR"
        if git pull --ff-only 2>&1; then
            ok "代码已更新"
            _got=true
        else
            warn "git pull 失败"
        fi
    else
        _got=true
    fi
fi

# Case C: Git clone (direct)
if ! $_got && command -v git &>/dev/null; then
    [ -d "$INSTALL_DIR" ] && rm -rf "$INSTALL_DIR"
    info "git clone..."
    if git clone --depth 1 "$GIT_URL" "$INSTALL_DIR" 2>&1; then
        _got=true; ok "克隆成功"
    fi

    # Case C2: Git clone via proxy
    if ! $_got; then
        for _px in "${GIT_PROXIES[@]}"; do
            info "  尝试代理 ${_px%%/*}..."
            if git clone --depth 1 "${_px}/${REPO}.git" "$INSTALL_DIR" 2>&1; then
                cd "$INSTALL_DIR"
                git remote set-url origin "$GIT_URL" 2>/dev/null || true
                _got=true; ok "通过代理克隆成功"
                break
            fi
        done
    fi
fi

# Case D: Download tarball (curl or wget)
if ! $_got; then
    [ -d "$INSTALL_DIR" ] && rm -rf "$INSTALL_DIR"
    info "下载压缩包..."

    for _url in "$ARCHIVE_URL"; do
        for _proxy in "" "${RAW_PROXIES[@]}"; do
            _full_url="${_proxy}${_url}"
            info "  尝试 ${_full_url%%\?*}..."
            if dl_to_file "$_full_url" /tmp/novel-admin.tar.gz 2>/dev/null; then
                mkdir -p /tmp/novel-tmp && rm -rf /tmp/novel-tmp/*
                if tar xzf /tmp/novel-admin.tar.gz -C /tmp/novel-tmp 2>/dev/null; then
                    _extracted=$(find /tmp/novel-tmp -maxdepth 1 -type d -name "novel-admin*" | head -1)
                    if [ -n "$_extracted" ] && [ -f "${_extracted}/Dockerfile" ]; then
                        mkdir -p "$INSTALL_DIR"
                        cp -a "$_extracted/." "$INSTALL_DIR/"
                        _got=true; ok "下载成功"
                    fi
                fi
                rm -rf /tmp/novel-admin.tar.gz /tmp/novel-tmp
                $_got && break 2
            fi
        done
    done
fi

if ! $_got; then
    die "获取项目文件失败！
  方式1 (推荐): 下载 tar.gz 到服务器，解压后运行 deploy.sh
  方式2: 手动 git clone ${GIT_URL}
  方式3: 在有网络的机器上下载后 scp 传到服务器"
fi

cd "$INSTALL_DIR"

# Verify required files exist
_missing=""
for _f in "${REQUIRED_FILES[@]}"; do
    [ ! -f "$_f" ] && _missing="${_missing} ${_f}"
done
if [ -n "$_missing" ]; then
    die "缺少必要文件:${_missing}
  请确保下载了完整的发布包"
fi
ok "项目文件验证通过"

# Make scripts executable
chmod +x deploy.sh docker-entrypoint.sh install.sh 2>/dev/null || true

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  STEP 6: Firewall
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
step "[6/8] 防火墙"

# Determine port (peek from existing .env or use default/flag)
_fw_port="${APP_PORT:-3000}"
[ -f .env ] && _fw_port=$(grep '^APP_PORT=' .env 2>/dev/null | head -1 | cut -d= -f2) || true
_fw_port=${_fw_port:-3000}
open_firewall_port "$_fw_port" || true

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  STEP 7: Configuration (.env generation)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
step "[7/8] 生成配置"

GENERATE_ENV=true
if [ -f .env ]; then
    # Check if .env has ALL required variables (not just some)
    _env_complete=true
    for _req_var in POSTGRES_PASSWORD POSTGRES_DB ADMIN_PASSWORD NEXTAUTH_SECRET SCRAPER_SERVICE_TOKEN APP_PORT DB_PORT; do
        grep -q "^${_req_var}=" .env 2>/dev/null || { _env_complete=false; break; }
    done

    if ! $_env_complete; then
        warn ".env 不完整（缺少必需变量），将重新生成"
        _env_bak=".env.bak.$(date +%Y%m%d_%H%M%S)"
        cp .env "$_env_bak" 2>/dev/null
        rm -f .env
        ok "旧配置已备份: ${_env_bak}"
    else
        # Peek at existing config for display
        _old_port=$(grep '^APP_PORT=' .env 2>/dev/null | head -1 | cut -d= -f2)
        _old_user=$(grep '^ADMIN_USERNAME=' .env 2>/dev/null | head -1 | cut -d= -f2)
        _old_port=${_old_port:-3000}
        _old_user=${_old_user:-admin}

        if $AUTO_YES || ! ask_y ".env 已存在 (端口=${_old_port}, 用户=${_old_user})，重新生成配置？"; then
            info "保留现有 .env 配置"
            GENERATE_ENV=false
        else
            _env_bak=".env.bak.$(date +%Y%m%d_%H%M%S)"
            cp .env "$_env_bak"
            ok "旧配置已备份: ${_env_bak}"
        fi
    fi
fi

if $GENERATE_ENV; then
    # Pre-generate secure random values
    _gen_db_pw=$(rand_hex 16)
    _gen_secret=$(rand_hex 32)
    _gen_token=$(rand_hex 32)
    _gen_admin_pw=$(rand_pass 14)

    if ! $AUTO_YES; then
        echo ""
        info "配置参数（回车使用默认值）:"
        echo ""
    fi

    # Port
    _port="${APP_PORT:-}"
    [ -z "$_port" ] && _port=$(ask "  应用端口" "3000")
    if ! [[ "$_port" =~ ^[0-9]+$ ]] || [ "$_port" -lt 1 ] || [ "$_port" -gt 65535 ]; then
        warn "无效端口，使用默认值 3000"
        _port=3000
    fi
    if port_in_use "$_port"; then
        warn "端口 ${_port} 已被占用"
        _new_port=$(ask "  换个端口" "$(( _port + 1 ))")
        if [[ "$_new_port" =~ ^[0-9]+$ ]] && [ "$_new_port" -ge 1 ] && [ "$_new_port" -le 65535 ]; then
            _port="$_new_port"
        fi
    fi

    # Admin
    _admin_user=$(ask "  管理员用户名" "admin")
    _admin_pw=$(ask "  管理员密码" "$_gen_admin_pw")
    [ -z "$_admin_pw" ] && _admin_pw="$_gen_admin_pw"

    # Server address
    _server_addr=$(ask "  服务器 IP 或域名" "$(my_ip)")
    [[ "$_server_addr" =~ ^https?:// ]] && _app_url="$_server_addr" || _app_url="http://${_server_addr}:${_port}"

    # Timezone
    _tz=$(ask "  时区" "Asia/Shanghai")

    # Write .env
    cat > .env <<EOF
# ══════════════════════════════════════════════════════
# Novel Admin — 自动生成 $(date '+%Y-%m-%d %H:%M:%S')
# ⚠️ 包含密钥信息，请勿提交到版本控制
# ══════════════════════════════════════════════════════

# ─── Database ──────────────────────────────────────────
POSTGRES_USER=novel
POSTGRES_PASSWORD=${_gen_db_pw}
POSTGRES_DB=novel_admin
DB_PORT=5432

# ─── App ───────────────────────────────────────────────
APP_PORT=${_port}
APP_NAME=小说管理系统
APP_URL=${_app_url}
TZ=${_tz}

# ─── Authentication ────────────────────────────────────
NEXTAUTH_SECRET=${_gen_secret}
NEXTAUTH_URL=${_app_url}

# ─── Admin ─────────────────────────────────────────────
ADMIN_USERNAME=${_admin_user}
ADMIN_PASSWORD=${_admin_pw}

# ─── Service-to-Service ────────────────────────────────
SCRAPER_SERVICE_TOKEN=${_gen_token}

# ─── Optional External Services (uncomment to enable) ─
# FIRECRAWL_API_KEY=
# FIRECRAWL_API_URL=
# AGENTQL_API_KEY=
# AGENTQL_API_URL=
# CLOUD_BROWSER_PROVIDER=browserless
# BROWSERLESS_API_KEY=
# BROWSERLESS_API_URL=
# STEEL_API_KEY=
# STEEL_API_URL=
EOF
    chmod 600 .env
    ok ".env 已生成 (权限 600)"

    # Save values for final display
    SAVE_USER="$_admin_user"
    SAVE_PASS="$_admin_pw"
    SAVE_URL="$_app_url"
    SAVE_PORT="$_port"
else
    # Read from existing .env
    SAVE_USER=$(grep '^ADMIN_USERNAME=' .env 2>/dev/null | head -1 | cut -d= -f2)
    SAVE_PASS=$(grep '^ADMIN_PASSWORD=' .env 2>/dev/null | head -1 | cut -d= -f2)
    SAVE_URL=$(grep '^APP_URL=' .env 2>/dev/null | head -1 | cut -d= -f2)
    SAVE_PORT=$(grep '^APP_PORT=' .env 2>/dev/null | head -1 | cut -d= -f2)
    SAVE_USER=${SAVE_USER:-admin}
    SAVE_PORT=${SAVE_PORT:-3000}
    SAVE_URL=${SAVE_URL:-http://localhost:${SAVE_PORT}}
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  STEP 8: Build, Start, Verify
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
step "[8/8] 构建、启动、验证"

if $AUTO_YES; then
    info "首次构建约 5-10 分钟，请耐心等待..."
else
    info "首次构建约 5-10 分钟"
    info "构建过程输出已保存，仅显示关键步骤..."
fi
echo ""

# ── Build ──
T0=$(date +%s)
BUILD_LOG="/tmp/novel-build-$(date +%Y%m%d_%H%M%S).log"
COMPOSE_CMD_BUILD="$COMPOSE_CMD"  # Save for later use

set +e
$COMPOSE_CMD_BUILD build 2>&1 | tee "$BUILD_LOG" | while IFS= read -r _line; do
    # Show only important lines to reduce noise
    if echo "$_line" | grep -qiE '(^Step |=> (RUN|COPY|FROM)|ERROR|fail|successfully tag|warn)'; then
        echo "  $_line"
    fi
done
BUILD_RC=${PIPESTATUS[0]}
set -e
BUILD_TIME=$(( $(date +%s) - T0 ))
echo ""

if [ $BUILD_RC -ne 0 ]; then
    echo ""
    err "构建失败！(耗时 ${BUILD_TIME}s)"
    echo ""

    # Analyze build log for actionable diagnostics
    info "诊断构建失败原因..."

    if grep -qi 'invalid interpolation\|interpolation format\|variable.*not set\|required.*not set' "$BUILD_LOG" 2>/dev/null; then
        err "  → docker-compose.yml 变量配置错误"
        err "  解决方案:"
        err "    1. 检查 .env 文件是否缺少必需变量"
        err "    2. 删除 .env 重新生成: rm .env && ./deploy.sh"
        err "    3. 手动检查: cat ${INSTALL_DIR}/.env"

    elif grep -qi 'OOM\|killed\|cannot allocate\|out of memory' "$BUILD_LOG" 2>/dev/null; then
        err "  → 内存不足 (OOM Killed)"
        err "  解决方案:"
        err "    1. 增加 Swap:"
        err "       fallocate -l 4G /swapfile && chmod 600 /swapfile"
        err "       mkswap /swapfile && swapon /swapfile"
        err "    2. 降低 docker-compose.yml 中的 memory limits"
        err "    3. 使用更大内存的服务器 (推荐 2GB+)"

    elif grep -qi 'timeout\|TLS handshake\|connection refused\|network\|dial tcp\|no route to host' "$BUILD_LOG" 2>/dev/null; then
        err "  → 网络连接问题"
        err "  解决方案:"
        err "    1. 检查 Docker 镜像加速: docker info | grep -A10 'Registry Mirrors'"
        err "    2. 重启 Docker: systemctl restart docker"
        err "    3. 手动拉取基础镜像测试: docker pull oven/bun:1"
        err "    4. 重试 (无缓存): cd ${INSTALL_DIR} && docker compose build --no-cache"

    elif grep -qi 'permission denied\|cannot open\|access denied' "$BUILD_LOG" 2>/dev/null; then
        err "  → 权限问题"
        err "  解决方案:"
        err "    1. 确保使用 root 运行: sudo $0"
        err "    2. 检查文件权限: ls -la ${INSTALL_DIR}/"

    elif grep -qi 'no space left\|disk full\|write error' "$BUILD_LOG" 2>/dev/null; then
        err "  → 磁盘空间不足"
        err "  解决方案:"
        err "    1. 清理 Docker 缓存: docker system prune -a"
        err "    2. 检查磁盘: df -h"
        _curr_disk=$(get_disk_gb "$INSTALL_DIR")
        err "    3. 当前可用: ${_curr_disk}GB"

    elif grep -qi 'Type error\|Failed to compile\|error TS\|Build error\|error: script' "$BUILD_LOG" 2>/dev/null; then
        err "  → 代码编译错误"
        err "  解决方案:"
        err "    1. 查看具体错误: grep -B2 -A5 'Type error\\|error TS' ${BUILD_LOG}"
        err "    2. 可能是版本不兼容，请确认下载了完整发布包"

    else
        err "  → 未知错误类型"
    fi

    echo ""
    # Show last 30 lines of build log for context
    err "构建日志最后 30 行:"
    echo "  ─────────────────────────────────────"
    tail -30 "$BUILD_LOG" 2>/dev/null | sed 's/^/  /'
    echo "  ─────────────────────────────────────"
    echo ""
    err "完整日志: cat ${BUILD_LOG}"
    err "重试: cd ${INSTALL_DIR} && docker compose build --no-cache 2>&1 | tee build.log"
    rm -f "$BUILD_LOG" 2>/dev/null
    exit 1
fi

ok "构建完成 (${BUILD_TIME}s)"
rm -f "$BUILD_LOG" 2>/dev/null

# ── Start ──
echo ""
set +e
$COMPOSE_CMD up -d 2>&1
START_RC=$?
set -e

if [ $START_RC -ne 0 ]; then
    err "启动失败！(退出码: ${START_RC})"
    if port_in_use "${SAVE_PORT}"; then
        err "  端口 ${SAVE_PORT} 已被其他程序占用"
        err "  修改 .env 中 APP_PORT 后重试: docker compose up -d"
    else
        err "  查看日志: cd ${INSTALL_DIR} && docker compose logs"
    fi
    exit 1
fi
ok "容器已启动"

# ── Health Check ──
echo ""
info "等待服务就绪（最长 3 分钟）..."

ELAPSED=0
MAX_WAIT=180
HEALTHY=false

while [ $ELAPSED -lt $MAX_WAIT ]; do
    # Check if containers are still running
    if ! docker compose ps 2>/dev/null | grep -qE 'Up|running'; then
        echo ""
        err "容器异常退出！"
        echo ""
        err "容器状态:"
        docker compose ps 2>/dev/null
        echo ""
        err "最近日志 (novel-manager):"
        docker compose logs --tail=30 novel-manager 2>/dev/null | tail -20
        exit 1
    fi

    # HTTP health check
    if command -v curl &>/dev/null; then
        if curl -sf --connect-timeout 2 "http://localhost:${SAVE_PORT}/api/auth/csrf" &>/dev/null; then
            HEALTHY=true
            break
        fi
    fi

    # Progress indicator (write to stderr to avoid log pollution)
    _pct=$(( ELAPSED * 100 / MAX_WAIT ))
    if [ -t 2 ]; then
        _filled=$(( _pct * 30 / 100 ))
        _empty=$(( 30 - _filled ))
        _bar=$(printf '%*s' "$_filled" | tr ' ' '█')$(printf '%*s' "$_empty" | tr ' ' '░')
        printf "\r  [%s] %3d%% 等待中... " "$_bar" "$_pct" >&2
    fi

    sleep 3
    ELAPSED=$((ELAPSED + 3))
done

# Clear progress line
[ -t 2 ] && printf "\r%*s\r" 60 "" >&2

# ── Save Credentials ──
CREDS_FILE="${INSTALL_DIR}/.credentials.txt"
cat > "$CREDS_FILE" <<CREDSEOF
===========================================
  📚 小说管理系统 — 登录信息
  生成时间: $(date '+%Y-%m-%d %H:%M:%S')
===========================================

  前台 (登录页):   ${SAVE_URL}
  后台 (管理面板): ${SAVE_URL}
  抓取服务 API:    内部端口 3099 (不对外暴露)

  管理员用户名:   ${SAVE_USER}
  管理员密码:     ${SAVE_PASS}

  ⚠️ 请妥善保管此文件！建议保存后删除。
  ⚠️ 删除命令: rm -f ${CREDS_FILE}
CREDSEOF
chmod 600 "$CREDS_FILE"

# ── Final Result ──
echo ""
if $HEALTHY; then
    echo -e "${C_GRN}${C_BLD}╔══════════════════════════════════════════════════╗${C_RST}"
    echo -e "${C_GRN}${C_BLD}║            ✅ 部署成功！系统已就绪               ║${C_RST}"
    echo -e "${C_GRN}${C_BLD}╚══════════════════════════════════════════════════╝${C_RST}"
    echo ""
    echo -e "${C_BLD}┌──────────────────────────────────────────────────┐${C_RST}"
    echo -e "${C_BLD}│  📚  小说管理系统 · 登录信息                      │${C_RST}"
    echo -e "${C_BLD}├──────────────────────────────────────────────────┤${C_RST}"
    echo -e "${C_BLD}│${C_RST}  ${C_BLD}前台 (登录页):${C_RST}    ${C_CYN}${SAVE_URL}${C_RST}"
    echo -e "${C_BLD}│${C_RST}  ${C_BLD}后台 (管理面板):${C_RST}  ${C_CYN}${SAVE_URL}${C_RST}"
    echo -e "${C_BLD}│${C_RST}  ${C_BLD}抓取服务 API:${C_RST}    ${C_DIM}内部端口 3099 (不对外暴露)${C_RST}"
    echo -e "${C_BLD}├──────────────────────────────────────────────────┤${C_RST}"
    echo -e "${C_BLD}│${C_RST}  ${C_BLD}管理员用户名:${C_RST}   ${C_CYN}${SAVE_USER}${C_RST}"
    echo -e "${C_BLD}│${C_RST}  ${C_BLD}管理员密码:${C_RST}     ${C_CYN}${SAVE_PASS}${C_RST}"
    echo -e "${C_BLD}└──────────────────────────────────────────────────┘${C_RST}"
    echo ""
    echo -e "  ${C_YEL}${C_BLD}⚠️  请立即保存以上信息！关闭终端后将无法再次查看密码${C_RST}"
    echo ""
    echo -e "  ${C_BLD}── 常用命令 ────────────────────────────────${C_RST}"
    echo -e "    查看日志:   ${C_CYN}./deploy.sh --logs${C_RST}"
    echo -e "    重启服务:   ${C_CYN}./deploy.sh --restart${C_RST}"
    echo -e "    停止服务:   ${C_CYN}./deploy.sh --stop${C_RST}"
    echo -e "    查看状态:   ${C_CYN}./deploy.sh --status${C_RST}"
    echo -e "    备份数据库: ${C_CYN}./deploy.sh --backup${C_RST}"
    echo -e "    升级:       ${C_CYN}./deploy.sh --upgrade${C_RST}"
    echo -e "    回滚:       ${C_CYN}./deploy.sh --rollback${C_RST}"
    echo -e "    完全卸载:   ${C_CYN}./deploy.sh --uninstall${C_RST}"
    echo ""
    echo -e "  ${C_BLD}── 文件位置 ────────────────────────────────${C_RST}"
    echo -e "    安装目录:   ${C_DIM}${INSTALL_DIR}${C_RST}"
    echo -e "    配置文件:   ${C_DIM}${INSTALL_DIR}/.env${C_RST}"
    echo -e "    凭据文件:   ${C_DIM}${CREDS_FILE}${C_RST}"
    echo -e "    部署日志:   ${C_DIM}${LOG_FILE:-无}${C_RST}"
    echo ""
else
    echo -e "${C_YEL}⏳ 健康检查超时 (${MAX_WAIT}s)，但服务可能仍在启动中...${C_RST}"
    echo ""
    echo -e "${C_BLD}┌──────────────────────────────────────────────────┐${C_RST}"
    echo -e "${C_BLD}│  📚  小说管理系统 · 登录信息 (请等待服务就绪)      │${C_RST}"
    echo -e "${C_BLD}├──────────────────────────────────────────────────┤${C_RST}"
    echo -e "${C_BLD}│${C_RST}  ${C_BLD}前台 (登录页):${C_RST}    ${C_CYN}${SAVE_URL}${C_RST}"
    echo -e "${C_BLD}│${C_RST}  ${C_BLD}后台 (管理面板):${C_RST}  ${C_CYN}${SAVE_URL}${C_RST}"
    echo -e "${C_BLD}├──────────────────────────────────────────────────┤${C_RST}"
    echo -e "${C_BLD}│${C_RST}  ${C_BLD}管理员用户名:${C_RST}   ${C_CYN}${SAVE_USER}${C_RST}"
    echo -e "${C_BLD}│${C_RST}  ${C_BLD}管理员密码:${C_RST}     ${C_CYN}${SAVE_PASS}${C_RST}"
    echo -e "${C_BLD}└──────────────────────────────────────────────────┘${C_RST}"
    echo ""
    echo -e "  检查状态:   ${C_CYN}./deploy.sh --status${C_RST}"
    echo -e "  查看日志:   ${C_CYN}./deploy.sh --logs${C_RST}"
    echo -e "  凭据文件:   ${C_CYN}cat ${CREDS_FILE}${C_RST}"
    echo -e "  部署日志:   ${C_CYN}${LOG_FILE:-无}${C_RST}"
    echo ""
    echo -e "  ${C_YEL}提示: 首次启动 Prisma 数据库迁移可能需要额外 1-2 分钟${C_RST}"
fi
echo ""
