#!/bin/bash
# ╔══════════════════════════════════════════════════════════════════╗
# ║  📚 小说管理系统 - Docker 一键安装脚本                        ║
# ║  Novel Admin - One-Click Docker Installer                      ║
# ║                                                              ║
# ║  GitHub: github.com/u4399com-beep/novel-admin-1.0.0           ║
# ║                                                              ║
# ║  Usage:                                                      ║
# ║    curl -fsSL https://raw.githubusercontent.com/               ║
# ║      u4399com-beep/novel-admin-1.0.0/main/install.sh | bash  ║
# ║                                                              ║
# ║  Options:                                                     ║
# ║    -y, --yes        Use all defaults (non-interactive)        ║
# ║    -d, --dir DIR    Install directory (default: /opt/novel-admin) ║
# ║    --uninstall      Remove everything (containers, images, data) ║
# ║    -h, --help       Show this help                            ║
# ╚══════════════════════════════════════════════════════════════════╝

set -euo pipefail

# ═══════════════════════════════════════════════════════════════
# Constants
# ═══════════════════════════════════════════════════════════════
REPO="https://github.com/u4399com-beep/novel-admin-1.0.0.git"
REPO_RAW="https://raw.githubusercontent.com/u4399com-beep/novel-admin-1.0.0/main"
# GitHub 国内代理（按优先级尝试）
GITHUB_PROXIES=(
    "https://ghfast.top/https://github.com"
    "https://mirror.ghproxy.com/https://github.com"
    "https://gh-proxy.com/https://github.com"
)
# Docker Hub 国内镜像
DOCKER_MIRRORS='["https://docker.1ms.run","https://docker.xuanyuan.me","https://docker.m.daocloud.io","https://docker.nju.edu.cn","https://hub.rat.dev","https://docker.chenby.cn","https://docker.mirrors.ustc.edu.cn"]'

# ═══════════════════════════════════════════════════════════════
# Parse Arguments
# ═══════════════════════════════════════════════════════════════
AUTO_YES=false
INSTALL_DIR="/opt/novel-admin"
DO_UNINSTALL=false

while [[ $# -gt 0 ]]; do
    case $1 in
        -y|--yes)    AUTO_YES=true; shift ;;
        -d|--dir)    INSTALL_DIR="$2"; shift 2 ;;
        --uninstall) DO_UNINSTALL=true; shift ;;
        -h|--help)
            head -20 "$0" | grep '^#' | sed 's/^# \?//'
            exit 0
            ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

# ═══════════════════════════════════════════════════════════════
# Color & Output Helpers
# ═══════════════════════════════════════════════════════════════
if [ -t 1 ]; then
    R='\033[0;31m' G='\033[0;32m' Y='\033[1;33m'
    B='\033[0;34m' C='\033[0;36m' M='\033[0;35m'
    N='\033[0m'    BD='\033[1m' DM='\033[2m'
else
    R= G= Y= B= C= M= N= BD= DM=
fi

log_info()  { echo -e "${B}[INFO]${N} $*"; }
log_ok()    { echo -e "${G}  ✓${N} $*"; }
log_warn()  { echo -e "${Y}[WARN]${N} $*"; }
log_err()   { echo -e "${R}[ERROR]${N} $*" >&2; }
log_step()  { echo -e "\n${M}${BD}▶ $*${N}"; }

ask() {
    local prompt="$1" default="${2:-}"
    if $AUTO_YES; then
        echo "$default"
        return
    fi
    if [ -n "$default" ]; then
        read -rp "$prompt [$default]: " REPLY
        echo "${REPLY:-$default}"
    else
        read -rp "$prompt: " REPLY
        echo "$REPLY"
    fi
}

ask_yes() {
    local prompt="$1" default="${2:-Y}"
    if $AUTO_YES; then
        return 0
    fi
    local yn
    read -rp "$prompt (Y/n): " yn
    [[ -z "$yn" || "$yn" =~ ^[Yy] ]]
}

die() {
    log_err "$*"
    exit 1
}

# ═══════════════════════════════════════════════════════════════
# Uninstall Mode
# ═══════════════════════════════════════════════════════════════
if $DO_UNINSTALL; then
    if [ -d "$INSTALL_DIR" ]; then
        cd "$INSTALL_DIR"
        log_info "Stopping and removing containers and volumes..."
        docker compose down -v --rmi local 2>/dev/null || true
        cd /
        log_info "Removing project directory..."
        rm -rf "$INSTALL_DIR"
        log_ok "Uninstall complete. All data has been removed."
    else
        log_warn "Not installed at ${INSTALL_DIR}, nothing to remove."
    fi
    exit 0
fi

# ═══════════════════════════════════════════════════════════════
# Banner
# ═══════════════════════════════════════════════════════════════
[ -t 1 ] && clear 2>/dev/null || true
echo ""
echo -e "${C}${BD}╔══════════════════════════════════════════════════╗${N}"
echo -e "${C}${BD}║                                                  ║${N}"
echo -e "${C}${BD}║    📚 小说管理系统 · Docker 一键安装             ║${N}"
echo -e "${C}${BD}║    github.com/u4399com-beep/novel-admin-1.0.0    ║${N}"
echo -e "${C}${BD}║                                                  ║${N}"
echo -e "${C}${BD}╚══════════════════════════════════════════════════╝${N}"
echo ""

# ═══════════════════════════════════════════════════════════════
# Step 1/7: Docker Environment
# ═══════════════════════════════════════════════════════════════
log_step "[1/7] Docker 环境"

# --- Install Docker if missing ---
if ! command -v docker &>/dev/null; then
    if ! ask_yes "Docker 未安装，是否自动安装？"; then
        die "请先安装 Docker: curl -fsSL https://get.docker.com | sh"
    fi
    log_info "正在安装 Docker..."
    if command -v apt-get &>/dev/null; then
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -qq && apt-get install -y -qq ca-certificates curl gnupg lsb-release >/dev/null 2>&1
        . /etc/os-release
        mkdir -p /etc/apt/keyrings
        curl -fsSL "https://download.docker.com/linux/$ID/gpg" | gpg --dearmor -o /etc/apt/keyrings/docker.gpg 2>/dev/null
        chmod a+r /etc/apt/keyrings/docker.gpg
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$ID $VERSION_CODENAME stable" \
            > /etc/apt/sources.list.d/docker.list
        apt-get update -qq && apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null 2>&1
    elif command -v yum &>/dev/null; then
        yum install -y -q yum-utils >/dev/null 2>&1
        yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo >/dev/null 2>&1
        yum install -y -q docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null 2>&1
    elif command -v apk &>/dev/null; then
        apk add --no-cache docker docker-compose >/dev/null 2>&1
    else
        die "不支持的系统，请手动安装: curl -fsSL https://get.docker.com | sh"
    fi
    systemctl enable --now docker 2>/dev/null || service docker start 2>/dev/null || true
    log_ok "Docker 已安装"
fi
log_ok "Docker $(docker --version | grep -oP '\d+\.\d+\.\d+' | head -1)"

# --- Docker Compose ---
if docker compose version &>/dev/null; then
    COMPOSE="docker compose"
elif command -v docker-compose &>/dev/null; then
    COMPOSE="docker-compose"
else
    die "Docker Compose 未找到，请重装 Docker"
fi
log_ok "Compose $(docker compose version --short 2>/dev/null || echo 'ok')"

# --- Daemon running? ---
if ! docker info &>/dev/null; then
    systemctl start docker 2>/dev/null || service docker start 2>/dev/null || true
    sleep 2
    docker info &>/dev/null || die "Docker 守护进程启动失败"
fi
log_ok "Docker 运行中"

# ═══════════════════════════════════════════════════════════════
# Step 2/7: Docker Mirror (China)
# ═══════════════════════════════════════════════════════════════
log_step "[2/7] 镜像加速"

DAEMON_JSON="/etc/docker/daemon.json"
HUB_OK=false
curl -sf --connect-timeout 5 "https://registry-1.docker.io/v2/" &>/dev/null && HUB_OK=true

if $HUB_OK; then
    log_ok "Docker Hub 可达，无需镜像"
else
    log_warn "Docker Hub 不可达，配置国内镜像加速..."
    [ -f "$DAEMON_JSON" ] && cp "$DAEMON_JSON" "${DAEMON_JSON}.bak.$(date +%s)"
    mkdir -p /etc/docker
    printf '{"registry-mirrors":%s}\n' "$DOCKER_MIRRORS" > "$DAEMON_JSON"
    systemctl daemon-reload 2>/dev/null; systemctl restart docker 2>/dev/null || service docker restart 2>/dev/null || true
    sleep 3
    if docker info 2>/dev/null | grep -q "Registry Mirrors"; then
        log_ok "国内镜像已生效"
    else
        log_warn "镜像已写入 ${DAEMON_JSON}，但可能未生效"
    fi
fi

# ═══════════════════════════════════════════════════════════════
# Step 3/7: Disk Space
# ═══════════════════════════════════════════════════════════════
log_step "[3/7] 磁盘检查"

AVAIL=$(df -BG "$INSTALL_DIR" 2>/dev/null | awk 'NR==2{print $4}' | tr -d 'G')
[ -z "$AVAIL" ] && AVAIL=$(df -BG / | awk 'NR==2{print $4}' | tr -d 'G')
if [ "${AVAIL:-0}" -lt 5 ]; then
    die "磁盘空间不足: ${AVAIL}GB (至少需要 5GB)"
fi
log_ok "可用 ${AVAIL}GB"

# ═══════════════════════════════════════════════════════════════
# Step 4/7: Clone Project
# ═══════════════════════════════════════════════════════════════
log_step "[4/7] 获取项目"

clone_repo() {
    local url="$1"
    log_info "尝试: $url"
    git clone --depth 1 "$url" "$INSTALL_DIR" 2>&1
}

if [ -d "${INSTALL_DIR}/.git" ]; then
    cd "$INSTALL_DIR"
    if ask_yes "项目已存在 (${INSTALL_DIR})，是否更新？"; then
        git pull --ff-only 2>&1 || log_warn "git pull 失败，继续使用现有版本"
        log_ok "已更新"
    fi
    cd "$INSTALL_DIR"
else
    if [ -d "$INSTALL_DIR" ]; then
        if ! ask_yes "${INSTALL_DIR} 已存在但非 git 仓库，删除重建？"; then
            die "请手动处理 ${INSTALL_DIR}"
        fi
        rm -rf "$INSTALL_DIR"
    fi

    CLONED=false
    # 1) 直连 GitHub
    if command -v git &>/dev/null && ! $CLONED; then
        if clone_repo "$REPO" 2>/dev/null; then CLONED=true; fi
    fi
    # 2) 国内代理
    if command -v git &>/dev/null && ! $CLONED; then
        for proxy in "${GITHUB_PROXIES[@]}"; do
            PROXY_URL="${proxy}/u4399com-beep/novel-admin-1.0.0.git"
            if clone_repo "$PROXY_URL" 2>/dev/null; then
                CLONED=true
                # Fix remote to original for future pulls
                cd "$INSTALL_DIR" && git remote set-url origin "$REPO" 2>/dev/null
                break
            fi
        done
    fi
    # 3) curl 下载 tar.gz
    if ! $CLONED; then
        log_info "git 克隆失败，尝试 curl 下载..."
        for base in "$REPO_RAW" "${GITHUB_PROXIES[0]}/raw.githubusercontent.com/u4399com-beep/novel-admin-1.0.0/main"; do
            if curl -fsSL --connect-timeout 10 "${base}/../archive/refs/heads/main.tar.gz" -o /tmp/novel.tar.gz 2>/dev/null; then
                mkdir -p "$INSTALL_DIR"
                tar xzf /tmp/novel.tar.gz -C /tmp/ 2>/dev/null
                # Find the extracted directory
                EXTRACTED=$(find /tmp -maxdepth 1 -type d -name "novel-admin*" | head -1)
                if [ -n "$EXTRACTED" ] && [ "$EXTRACTED" != "$INSTALL_DIR" ]; then
                    cp -a "$EXTRACTED/." "$INSTALL_DIR/"
                    rm -rf "$EXTRACTED"
                fi
                rm -f /tmp/novel.tar.gz
                CLONED=true
                break
            fi
        done
    fi

    $CLONED || die "无法获取项目代码，请检查网络或手动下载: ${REPO}"
    cd "$INSTALL_DIR"
    log_ok "项目就绪: ${INSTALL_DIR}"
fi

# Verify
for f in Dockerfile docker-compose.yml docker-entrypoint.sh .env.production; do
    [ -f "$f" ] || die "缺少必要文件: $f，仓库可能不完整"
done
log_ok "文件完整性检查通过"

# ═══════════════════════════════════════════════════════════════
# Step 5/7: Configuration
# ═══════════════════════════════════════════════════════════════
log_step "[5/7] 生成配置"

# --- Crypto helpers ---
rand_hex() {
    local n=${1:-32}
    if command -v openssl &>/dev/null; then
        openssl rand -hex "$n"
    else
        tr -dc 'a-f0-9' </dev/urandom | head -c "$((n * 2))"
    fi
}
rand_pass() {
    local n=${1:-14}
    if command -v openssl &>/dev/null; then
        openssl rand -base64 "$((n * 4 / 3 + 1))" | tr -d '/+=' | head -c "$n"
    else
        tr -dc 'A-Za-z0-9!@#%' </dev/urandom | head -c "$n"
    fi
}
my_ip() {
    local ip
    ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    [[ -z "$ip" || "$ip" == 127.* ]] && ip=$(curl -sf --connect-timeout 3 ifconfig.me 2>/dev/null || true)
    [[ -z "$ip" || "$ip" == 127.* ]] && ip=$(curl -sf --connect-timeout 3 ip.sb 2>/dev/null || true)
    echo "${ip:-YOUR_SERVER_IP}"
}

# --- Check existing .env ---
NEED_ENV=true
if [ -f .env ]; then
    source .env 2>/dev/null || true
    if $AUTO_YES || ! ask_yes ".env 已存在 (端口=${APP_PORT:-3000}, 用户=${ADMIN_USERNAME:-admin})，重新配置？"; then
        log_info "保留现有 .env"
        NEED_ENV=false
    else
        cp .env ".env.bak.$(date +%Y%m%d_%H%M%S)"
        log_ok "已备份旧 .env"
    fi
fi

if $NEED_ENV; then
    _secret=$(rand_hex 32)
    _token=$(rand_hex 32)
    _dbpw=$(rand_hex 16)
    _autopw=$(rand_pass 14)

    if ! $AUTO_YES; then
        echo ""
        log_info "配置安装参数（回车使用默认值）:"
        echo ""
    fi

    _port=$(ask  "  端口"     "3000")
    [[ "$_port" =~ ^[0-9]+$ ]] && [ "$_port" -ge 1 ] && [ "$_port" -le 65535 ] || _port=3000

    # Check port conflict
    if ss -tlnp 2>/dev/null | grep -q ":${_port} "; then
        log_warn "端口 ${_port} 已被占用"
        _port=$(ask "  换个端口" "$(( _port + 1 ))")
    fi

    _user=$(ask  "  管理员用户名" "admin")
    _pass=$(ask  "  管理员密码"   "$_autopw")
    _ip=$(my_ip)
    _addr=$(ask "  服务器 IP/域名" "$_ip")

    [[ "$_addr" =~ ^https?:// ]] && _url="$_addr" || _url="http://${_addr}:${_port}"
    _tz=$(ask "  时区" "Asia/Shanghai")

    cat > .env <<EOF
# Novel Management System - Auto-generated $(date '+%Y-%m-%d %H:%M:%S')
# Source: ${REPO}

# Database
POSTGRES_USER=novel
POSTGRES_PASSWORD=${_dbpw}
POSTGRES_DB=novel_admin
DB_PORT=5432

# App
APP_PORT=${_port}
APP_NAME=小说管理系统
APP_URL=${_url}
TZ=${_tz}

# Auth
NEXTAUTH_SECRET=${_secret}
ADMIN_USERNAME=${_user}
ADMIN_PASSWORD=${_pass}
SCRAPER_SERVICE_TOKEN=${_token}

# Optional external services (uncomment to enable)
# FIRECRAWL_API_KEY=
# AGENTQL_API_KEY=
# BROWSERLESS_API_KEY=
# STEEL_API_KEY=
EOF
    chmod 600 .env
    log_ok ".env 已生成"
fi

source .env 2>/dev/null || true
PORT="${APP_PORT:-3000}"

# ═══════════════════════════════════════════════════════════════
# Step 6/7: Build & Start
# ═══════════════════════════════════════════════════════════════
log_step "[6/7] 构建并启动"
log_info "首次构建约需 5-10 分钟，请耐心等待..."
echo ""

T0=$(date +%s)

set +e
$COMPOSE build 2>&1 | tee /tmp/novel-build.log | while IFS= read -r line; do
    echo "$line" | grep -qiE '(^Step|=> (=>|RUN|COPY|FROM)|DONE|ERROR|fail|successfully tag)' && echo "  $line"
done
RC=${PIPESTATUS[0]}
set -e

DT=$(( $(date +%s) - T0 ))
echo ""
[ $RC -ne 0 ] && die "构建失败 (${DT}s)! 查看日志: cat /tmp/novel-build.log"
log_ok "构建完成 (${DT}s)"

echo ""
set +e
$COMPOSE up -d 2>&1
RC=$?
set -e
[ $RC -ne 0 ] && die "启动失败! 端口 ${PORT} 可能被占用，修改 .env 中的 APP_PORT 后重试"
log_ok "服务已启动"

# ═══════════════════════════════════════════════════════════════
# Step 7/7: Health Check & Result
# ═══════════════════════════════════════════════════════════════
log_step "[7/7] 健康检查"
echo ""

MAX=180; ELAPSED=0; OK=false
while [ $ELAPSED -lt $MAX ]; do
    # Crash check
    if ! $COMPOSE ps 2>/dev/null | grep -qE 'Up|healthy'; then
        echo ""
        log_err "容器异常退出!"
        $COMPOSE logs --tail=30 2>&1
        exit 1
    fi

    curl -sf "http://localhost:${PORT}/api/auth/csrf" &>/dev/null && { OK=true; break; }

    PCT=$(( ELAPSED * 100 / MAX ))
    F=$(( PCT / 5 )); E=$(( 20 - F ))
    BAR=$(printf '%*s' "$F" | tr ' ' '█')$(printf '%*s' "$E" | tr ' ' '░')
    printf "\r  [%s] %3d%% (%ds/%ds) " "$BAR" "$PCT" "$ELAPSED" "$MAX"
    sleep 3; ELAPSED=$((ELAPSED + 3))
done
echo ""

# --- Save credentials to file ---
CRED_FILE="${INSTALL_DIR}/.credentials.txt"
cat > "$CRED_FILE" <<EOF
===========================================
  小说管理系统 - 登录凭据
  Generated: $(date '+%Y-%m-%d %H:%M:%S')
===========================================

访问地址:  ${APP_URL:-http://localhost:${PORT}}
用户名:    ${ADMIN_USERNAME:-admin}
密码:      ${ADMIN_PASSWORD}

⚠️ 请妥善保管此文件，建议保存后删除。
EOF
chmod 600 "$CRED_FILE"

# --- Print result ---
echo ""
if $OK; then
    echo -e "${G}${BD}╔══════════════════════════════════════════════════╗${N}"
    echo -e "${G}${BD}║              ✅ 安装成功！系统已就绪              ║${N}"
    echo -e "${G}${BD}╚══════════════════════════════════════════════════╝${N}"
    echo ""
    echo -e "  🌐  ${BD}访问地址:${N}  ${C}${APP_URL:-http://localhost:${PORT}}${N}"
    echo -e "  👤  ${BD}用户名:${N}    ${BD}${ADMIN_USERNAME:-admin}${N}"
    echo -e "  🔑  ${BD}密码:${N}      ${BD}${ADMIN_PASSWORD}${N}"
    echo ""
    echo -e "  📋  ${BD}常用命令:${N}"
    echo -e "      查看日志:  ${C}cd ${INSTALL_DIR} && ${COMPOSE} logs -f${N}"
    echo -e "      停止:      ${C}cd ${INSTALL_DIR} && ${COMPOSE} stop${N}"
    echo -e "      重启:      ${C}cd ${INSTALL_DIR} && ${COMPOSE} restart${N}"
    echo -e "      状态:      ${C}cd ${INSTALL_DIR} && ${COMPOSE} ps${N}"
    echo -e "      备份:      ${C}cd ${INSTALL_DIR} && ${COMPOSE} exec -T postgres pg_dump -U novel novel_admin > backup.sql${N}"
    echo -e "      卸载:      ${C}cd ${INSTALL_DIR} && ${COMPOSE} down -v && rm -rf ${INSTALL_DIR}${N}"
    echo ""
    echo -e "  🔄  ${BD}升级:${N}      ${C}cd ${INSTALL_DIR} && git pull && ${COMPOSE} up -d --build${N}"
    echo ""
    echo -e "  📁  ${BD}文件:${N}      凭据: ${DM}${INSTALL_DIR}/.credentials.txt${N}"
    echo -e "                配置: ${DM}${INSTALL_DIR}/.env${N}"
    echo ""
    echo -e "  ${Y}⚠️  请立即保存以上信息！凭据已写入 .credentials.txt${N}"
else
    echo -e "${Y}健康检查超时，但服务可能已在启动中。${N}"
    echo ""
    echo -e "  检查:  ${C}cd ${INSTALL_DIR} && ${COMPOSE} ps${N}"
    echo -e "  日志:  ${C}cd ${INSTALL_DIR} && ${COMPOSE} logs -f${N}"
    echo -e "  凭据:  ${C}cat ${INSTALL_DIR}/.credentials.txt${N}"
    echo ""
fi

rm -f /tmp/novel-build.log 2>/dev/null