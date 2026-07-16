#!/usr/bin/env bash
# ╔═══════════════════════════════════════════════════════════════════════╗
# ║                                                                       ║
# ║   📚 小说管理系统 — Docker 一键安装脚本                                 ║
# ║   Novel Admin — One-Click Docker Installer                            ║
# ║                                                                       ║
# ║   GitHub: github.com/u4399com-beep/novel-admin-1.0.0                  ║
# ║                                                                       ║
# ║   一键安装:                                                            ║
# ║     curl -fsSL https://raw.githubusercontent.com/                      ║
# ║       u4399com-beep/novel-admin-1.0.0/main/install.sh | bash          ║
# ║                                                                       ║
# ║   非交互安装(使用默认值):                                                ║
# ║     curl -fsSL ... | bash -s -- -y                                    ║
# ║                                                                       ║
# ║   指定安装目录:                                                         ║
# ║     curl -fsSL ... | bash -s -- -d /data/novel-admin                  ║
# ║                                                                       ║
# ║   卸载:                                                               ║
# ║     /opt/novel-admin/install.sh --uninstall                           ║
# ║                                                                       ║
# ╚═══════════════════════════════════════════════════════════════════════╝

set -euo pipefail

# ================================================================
#  CONSTANTS
# ================================================================
readonly REPO_OWNER="u4399com-beep"
readonly REPO_NAME="novel-admin-1.0.0"
readonly REPO_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}.git"
readonly REPO_RAW="https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main"
readonly ARCHIVE_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}/archive/refs/heads/main.tar.gz"
readonly DEFAULT_DIR="/opt/novel-admin"

# GitHub 国内加速代理（按优先级排列）
readonly GITHUB_CLONE_PROXIES=(
    "https://ghfast.top/https://github.com"
    "https://mirror.ghproxy.com/https://github.com"
    "https://gh-proxy.com/https://github.com"
)
readonly GITHUB_RAW_PROXIES=(
    "https://ghfast.top"
    "https://mirror.ghproxy.com"
)

# Docker Hub 国内镜像源
readonly DOCKER_MIRROR_LIST=(
    "https://docker.1ms.run"
    "https://docker.xuanyuan.me"
    "https://docker.m.daocloud.io"
    "https://docker.nju.edu.cn"
    "https://hub.rat.dev"
    "https://docker.chenby.cn"
    "https://docker.mirrors.ustc.edu.cn"
)

# 需要的文件清单
readonly REQUIRED_FILES=(
    "Dockerfile"
    "docker-compose.yml"
    "docker-entrypoint.sh"
    ".env.production"
)

# ================================================================
#  PARSE ARGUMENTS
# ================================================================
MODE="install"
AUTO_YES=false
INSTALL_DIR=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        -y|--yes|--noninteractive)  AUTO_YES=true; shift ;;
        -d|--dir)                   INSTALL_DIR="${2:-}"; shift 2 ;;
        --uninstall|--remove)       MODE="uninstall"; shift ;;
        -h|--help)
            sed -n '2,/^ ╚/p' "$0" | grep '^ ║' | sed 's/^ ║  \?//'
            exit 0
            ;;
        *) echo "❌ 未知参数: $1"; exit 1 ;;
    esac
done

# 安装模式下设置默认目录
if [[ "$MODE" == "install" && -z "$INSTALL_DIR" ]]; then
    INSTALL_DIR="$DEFAULT_DIR"
fi

# ================================================================
#  COLOR & LOGGING
# ================================================================
if [[ -t 1 ]]; then
    readonly C_RED='\033[0;31m' C_GREEN='\033[0;32m' C_YELLOW='\033[1;33m'
    readonly C_BLUE='\033[0;34m' C_CYAN='\033[0;36m' C_PURPLE='\033[0;35m'
    readonly C_BOLD='\033[1m'    C_DIM='\033[2m'    C_RESET='\033[0m'
else
    readonly C_RED='' C_GREEN='' C_YELLOW='' C_BLUE='' C_CYAN=''
    readonly C_PURPLE='' C_BOLD='' C_DIM='' C_RESET=''
fi

info()  { echo -e "${C_BLUE}[INFO]${C_RESET} $*"; }
ok()    { echo -e "${C_GREEN}  ✓${C_RESET} $*"; }
warn()  { echo -e "${C_YELLOW}[WARN]${C_RESET} $*"; }
err()   { echo -e "${C_RED}[ERROR]${C_RESET} $*" >&2; }
step()  { echo -e "\n${C_PURPLE}${C_BOLD}▶ $*${C_RESET}"; }

die() {
    err "$*"
    exit 1
}

# 进度条
progress_bar() {
    local current total width label
    current="$1"; total="$2"; label="${3:-}"
    width=30
    local pct=$(( current * 100 / total ))
    local filled=$(( pct * width / 100 ))
    local empty=$(( width - filled ))
    local bar
    bar="$(printf '%*s' "$filled" | tr ' ' '█')$(printf '%*s' "$empty" | tr ' ' '░')"
    printf "\r  [${bar}] %3d%% %s " "$pct" "$label" >&2
}

# 交互式输入
ask() {
    local prompt="$1" default="${2:-}"
    if $AUTO_YES; then
        echo "$default"
        return
    fi
    if [[ -n "$default" ]]; then
        read -rp "$prompt [${C_DIM}${default}${C_RESET}]: " REPLY
        echo "${REPLY:-$default}"
    else
        read -rp "$prompt: " REPLY
        echo "$REPLY"
    fi
}

ask_yes() {
    local prompt="$1" default="${2:-y}"
    if $AUTO_YES; then return 0; fi
    local yn
    [[ "$default" =~ ^[Yy] ]] && local hint="Y/n" || local hint="y/N"
    read -rp "$prompt (${hint}): " yn
    [[ -z "$yn" || "$yn" =~ ^[Yy] ]]
}

# ================================================================
#  CRYPTO HELPERS
# ================================================================
rand_hex() {
    local bytes="${1:-32}"
    if command -v openssl &>/dev/null; then
        openssl rand -hex "$bytes" 2>/dev/null && return
    fi
    # fallback
    tr -dc 'a-f0-9' </dev/urandom | head -c "$(( bytes * 2 ))"
    echo
}

rand_password() {
    local len="${1:-14}"
    if command -v openssl &>/dev/null; then
        # openssl rand -base64 may produce =+/, filter them out
        openssl rand -base64 "$(( len + 4 ))" 2>/dev/null | tr -d '=/+' | head -c "$len" && echo && return
    fi
    tr -dc 'A-Za-z0-9!@#$%&*' </dev/urandom | head -c "$len"
    echo
}

get_server_ip() {
    local ip
    # Try hostname -I first
    ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    if [[ -n "$ip" && ! "$ip" =~ ^127\. ]]; then
        echo "$ip"; return
    fi
    # Try external IP services
    for svc in ifconfig.me ip.sb ipinfo.io/ip; do
        ip=$(curl -sf --connect-timeout 3 "https://$svc" 2>/dev/null) && \
        [[ -n "$ip" && "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && \
        { echo "$ip"; return; }
    done
    echo "YOUR_SERVER_IP"
}

# ================================================================
#  MODE: UNINSTALL
# ================================================================
if [[ "$MODE" == "uninstall" ]]; then
    # Find the install directory
    if [[ ! -d "$INSTALL_DIR" ]]; then
        # Try default
        if [[ -d "$DEFAULT_DIR" ]]; then
            INSTALL_DIR="$DEFAULT_DIR"
        else
            die "未找到安装目录。请指定: $0 --uninstall -d <目录>"
        fi
    fi

    if [[ ! -f "${INSTALL_DIR}/docker-compose.yml" ]]; then
        die "${INSTALL_DIR} 不是有效的安装目录"
    fi

    echo ""
    warn "即将删除以下内容："
    warn "  • 目录: ${INSTALL_DIR}"
    warn "  • Docker 容器 + 数据卷 (数据库数据将永久删除！)"
    echo ""
    if ! ask_yes "确认卸载？"; then
        echo "已取消。"
        exit 0
    fi

    cd "$INSTALL_DIR"
    docker compose down -v --rmi local 2>/dev/null || true
    cd /
    rm -rf "$INSTALL_DIR"
    echo ""
    ok "卸载完成。所有数据已删除。"
    exit 0
fi

# ================================================================
#  MODE: INSTALL
# ================================================================

# --- Banner ---
if [[ -t 1 ]]; then clear 2>/dev/null || true; fi
echo ""
echo -e "${C_CYAN}${C_BOLD}╔═══════════════════════════════════════════════════╗${C_RESET}"
echo -e "${C_CYAN}${C_BOLD}║                                                   ║${C_RESET}"
echo -e "${C_CYAN}${C_BOLD}║     📚 小说管理系统 · Docker 一键安装              ║${C_RESET}"
echo -e "${C_CYAN}${C_BOLD}║                                                   ║${C_RESET}"
echo -e "${C_CYAN}${C_BOLD}╚═══════════════════════════════════════════════════╝${C_RESET}"
echo -e "${C_DIM}  ${REPO_OWNER}/${REPO_NAME}${C_RESET}"
echo ""

# ================================================================
#  STEP 1/7 — Docker Environment
# ================================================================
step "[1/7] Docker 环境"

install_docker() {
    info "正在安装 Docker..."
    local os_id os_version
    if [[ -f /etc/os-release ]]; then
        os_id=$(  . /etc/os-release && echo "$ID")
        os_version=$(. /etc/os-release && echo "$VERSION_CODENAME")
    fi

    if command -v apt-get &>/dev/null; then
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -qq >/dev/null 2>&1
        apt-get install -y -qq ca-certificates curl gnupg lsb-release >/dev/null 2>&1

        # Add Docker official GPG key
        mkdir -p /etc/apt/keyrings
        local gpg_url="https://download.docker.com/linux/${os_id:-debian}/gpg"
        curl -fsSL "$gpg_url" 2>/dev/null | gpg --dearmor -o /etc/apt/keyrings/docker.gpg 2>/dev/null || true
        chmod a+r /etc/apt/keyrings/docker.gpg 2>/dev/null || true

        # Add Docker repo
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/${os_id:-debian} ${os_version:-stable} stable" \
            > /etc/apt/sources.list.d/docker.list 2>/dev/null || true

        apt-get update -qq >/dev/null 2>&1
        apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null 2>&1

    elif command -v yum &>/dev/null || command -v dnf &>/dev/null; then
        yum install -y -q yum-utils >/dev/null 2>&1
        yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo >/dev/null 2>&1
        yum install -y -q docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null 2>&1

    elif command -v apk &>/dev/null; then
        apk add --no-cache docker docker-compose >/dev/null 2>&1

    else
        die "不支持的操作系统。请手动安装 Docker:\n  curl -fsSL https://get.docker.com | sh"
    fi

    # Start Docker daemon
    systemctl enable --now docker 2>/dev/null || service docker start 2>/dev/null || true
    sleep 2
}

if ! command -v docker &>/dev/null; then
    if ask_yes "Docker 未安装，是否自动安装？"; then
        install_docker
    else
        die "请先安装 Docker:\n  curl -fsSL https://get.docker.com | sh"
    fi
fi

# Verify Docker version
DOCKER_VER=$(docker version --format '{{.Server.Version}}' 2>/dev/null | head -1)
[[ -z "$DOCKER_VER" ]] && DOCKER_VER=$(docker --version 2>/dev/null | grep -oP '\d+\.\d+\.\d+' | head -1)
ok "Docker ${DOCKER_VER:-已安装}"

# Verify Docker Compose
if docker compose version &>/dev/null; then
    COMPOSE_CMD="docker compose"
elif command -v docker-compose &>/dev/null; then
    COMPOSE_CMD="docker-compose"
else
    die "未找到 Docker Compose。请重新安装 Docker。"
fi
local_compose_ver=$(docker compose version --short 2>/dev/null || docker-compose version --short 2>/dev/null || echo "unknown")
ok "Docker Compose ${local_compose_ver}"

# Ensure Docker daemon is running
if ! docker info &>/dev/null; then
    systemctl start docker 2>/dev/null || service docker start 2>/dev/null || true
    sleep 3
    if ! docker info &>/dev/null; then
        die "Docker 守护进程启动失败。请手动运行: systemctl start docker"
    fi
fi
ok "Docker 运行中"

# ================================================================
#  STEP 2/7 — Docker Mirror (China Network)
# ================================================================
step "[2/7] 镜像加速"

configure_mirror() {
    local daemon_json="/etc/docker/daemon.json"

    # Test if Docker Hub is directly reachable
    if curl -sf --connect-timeout 5 "https://registry-1.docker.io/v2/" &>/dev/null; then
        ok "Docker Hub 直连正常，无需配置镜像"
        return 0
    fi

    warn "Docker Hub 不可达，正在配置国内镜像加速..."

    # Backup existing config
    if [[ -f "$daemon_json" ]]; then
        cp "$daemon_json" "${daemon_json}.bak.$(date +%s)"
        info "已备份原配置: ${daemon_json}.bak.*"
    fi

    # Build mirror JSON
    local mirrors_json="["
    local first=true
    for mirror in "${DOCKER_MIRROR_LIST[@]}"; do
        if $first; then first=false; else mirrors_json+=","; fi
        mirrors_json+="\"${mirror}\""
    done
    mirrors_json+="]"

    mkdir -p /etc/docker
    echo "{\"registry-mirrors\":${mirrors_json}}" > "$daemon_json"

    # Restart Docker daemon
    systemctl daemon-reload 2>/dev/null
    systemctl restart docker 2>/dev/null || service docker restart 2>/dev/null || true
    sleep 3

    # Verify
    if docker info 2>/dev/null | grep -q "Registry Mirrors"; then
        ok "国内镜像加速已配置（${#DOCKER_MIRROR_LIST[@]} 个源）"
    else
        warn "镜像已写入 ${daemon_json}，但 Docker 可能未正确加载"
        warn "可手动检查: docker info | grep -A5 'Registry Mirrors'"
    fi
}

configure_mirror

# ================================================================
#  STEP 3/7 — Disk Space Check
# ================================================================
step "[3/7] 磁盘检查"

check_disk() {
    local target="$1"
    local avail_gb
    avail_gb=$(df -BG "$target" 2>/dev/null | awk 'NR==2{print $4}' | tr -d 'G')
    echo "${avail_gb:-0}"
}

AVAIL_GB=$(check_disk "$(dirname "$INSTALL_DIR" 2>/dev/null || echo /)")
if [[ "$AVAIL_GB" -lt 5 ]]; then
    die "磁盘空间不足: ${AVAIL_GB}GB 可用（至少需要 5GB）\n请清理空间后重试"
fi
ok "可用磁盘 ${AVAIL_GB}GB"

# ================================================================
#  STEP 4/7 — Clone / Download Project
# ================================================================
step "[4/7] 获取项目代码"

clone_success=false

# --- If already installed, offer update ---
if [[ -d "${INSTALL_DIR}/.git" ]]; then
    cd "$INSTALL_DIR"
    if ask_yes "检测到已有安装 (${INSTALL_DIR})，是否更新？"; then
        info "拉取最新代码..."
        if git pull --ff-only 2>&1; then
            ok "代码已更新"
            clone_success=true
        else
            warn "git pull 失败，使用现有代码继续"
            clone_success=true
        fi
    else
        info "使用现有代码"
        clone_success=true
    fi
fi

# --- Clone / download if needed ---
if ! $clone_success; then
    # Remove existing non-git directory
    if [[ -d "$INSTALL_DIR" ]]; then
        if ! ask_yes "${INSTALL_DIR} 已存在但非 git 仓库，删除重建？"; then
            die "请手动处理 ${INSTALL_DIR} 目录后重试"
        fi
        rm -rf "$INSTALL_DIR"
    fi

    # Strategy 1: git clone (direct)
    if command -v git &>/dev/null; then
        info "尝试直连 GitHub..."
        if git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" 2>&1; then
            clone_success=true
            ok "git clone 成功"
        fi
    fi

    # Strategy 2: git clone via proxy
    if ! $clone_success && command -v git &>/dev/null; then
        for proxy in "${GITHUB_CLONE_PROXIES[@]}"; do
            proxy_url="${proxy}/${REPO_OWNER}/${REPO_NAME}.git"
            info "尝试代理: ${proxy}"
            if git clone --depth 1 "$proxy_url" "$INSTALL_DIR" 2>&1; then
                # Reset remote to original for future pulls
                cd "$INSTALL_DIR" && git remote set-url origin "$REPO_URL" 2>/dev/null || true
                clone_success=true
                ok "通过代理克隆成功"
                break
            fi
        done
    fi

    # Strategy 3: curl download tar.gz
    if ! $clone_success; then
        info "git 克隆失败，尝试下载压缩包..."
        tar_urls=(
            "$ARCHIVE_URL"
        )
        for proxy in "${GITHUB_RAW_PROXIES[@]}"; do
            tar_urls+=("${proxy}/${ARCHIVE_URL}")
        done

        for url in "${tar_urls[@]}"; do
            info "下载: ${url%%\?*}..."
            if curl -fsSL --connect-timeout 15 --max-time 120 "$url" -o /tmp/novel-admin.tar.gz 2>/dev/null; then
                # Extract
                mkdir -p /tmp/novel-extract
                rm -rf /tmp/novel-extract/*
                if tar xzf /tmp/novel-admin.tar.gz -C /tmp/novel-extract 2>/dev/null; then
                    # Find the extracted directory (github archives use repo-name-branch)
                    extracted_dir=$(find /tmp/novel-extract -maxdepth 1 -type d -name "${REPO_NAME}*" | head -1)
                    if [[ -n "$extracted_dir" ]]; then
                        mkdir -p "$INSTALL_DIR"
                        cp -a "$extracted_dir/." "$INSTALL_DIR/"
                        rm -rf /tmp/novel-extract /tmp/novel-admin.tar.gz
                        clone_success=true
                        ok "压缩包下载并解压成功"
                        break
                    fi
                fi
                rm -f /tmp/novel-admin.tar.gz
            fi
        done
    fi

    if ! $clone_success; then
        die "无法获取项目代码！\n请检查网络，或手动下载: ${REPO_URL}\n然后放到 ${INSTALL_DIR}"
    fi
fi

cd "$INSTALL_DIR"

# --- Verify required files ---
missing=()
for f in "${REQUIRED_FILES[@]}"; do
    [[ ! -f "$f" ]] && missing+=("$f")
done
if [[ ${#missing[@]} -gt 0 ]]; then
    die "仓库缺少必要文件:\n  ${missing[*]}\n仓库可能不完整，请重新克隆"
fi
ok "文件完整性检查通过"

# ================================================================
#  STEP 5/7 — Generate Configuration
# ================================================================
step "[5/7] 生成配置"

# --- Check existing .env ---
NEED_ENV=true
if [[ -f .env ]]; then
    # Source existing values for display
    source .env 2>/dev/null || true
    local_port="${APP_PORT:-3000}"
    local_user="${ADMIN_USERNAME:-admin}"

    if $AUTO_YES || ! ask_yes ".env 已存在 (端口=${local_port}, 用户=${local_user})，重新配置？"; then
        info "保留现有配置"
        NEED_ENV=false
    else
        # Backup
        bak=".env.bak.$(date '+%Y%m%d_%H%M%S')"
        cp .env "$bak"
        ok "已备份旧配置: ${bak}"
    fi
fi

if $NEED_ENV; then
    # Generate secure random values
    db_password=$(rand_hex 16)
    auth_secret=$(rand_hex 32)
    scraper_token=$(rand_hex 32)
    admin_password=$(rand_password 14)

    if ! $AUTO_YES; then
        echo ""
        info "配置安装参数（直接回车使用默认值）:"
        echo ""
    fi

    # Port
    port=$(ask "  端口" "3000")
    # Validate port
    if ! [[ "$port" =~ ^[0-9]+$ ]] || [[ "$port" -lt 1 ]] || [[ "$port" -gt 65535 ]]; then
        warn "端口无效，使用 3000"
        port=3000
    fi
    # Check port conflict
    if ss -tlnp 2>/dev/null | grep -q ":${port} " || \
       lsof -i :"$port" &>/dev/null; then
        warn "端口 ${port} 已被占用"
        port=$(ask "  请换一个端口" "$((port + 1))")
    fi

    # Admin credentials
    admin_user=$(ask "  管理员用户名" "admin")

    if ! $AUTO_YES; then
        input_pass=$(ask "  管理员密码" "$admin_password")
        [[ -n "$input_pass" ]] && admin_password="$input_pass"
    fi

    # Server address
    server_ip=$(get_server_ip)
    server_addr=$(ask "  服务器 IP 或域名" "$server_ip")
    if [[ "$server_addr" =~ ^https?:// ]]; then
        app_url="$server_addr"
    else
        app_url="http://${server_addr}:${port}"
    fi

    # Timezone
    timezone=$(ask "  时区" "Asia/Shanghai")

    # Write .env
    cat > .env <<ENVEOF
# ═══════════════════════════════════════════════════════════
# Novel Management System — Auto-generated by install.sh
# Generated: $(date '+%Y-%m-%d %H:%M:%S')
# ⚠️ 请勿提交到 Git！此文件包含敏感信息。
# ═══════════════════════════════════════════════════════════

# ─── Database (PostgreSQL) ───────────────────────────────
POSTGRES_USER=novel
POSTGRES_PASSWORD=${db_password}
POSTGRES_DB=novel_admin
DB_PORT=5432

# ─── Application ─────────────────────────────────────────
APP_PORT=${port}
APP_NAME=小说管理系统
APP_URL=${app_url}
TZ=${timezone}

# ─── Authentication (NEXTAUTH) ───────────────────────────
NEXTAUTH_SECRET=${auth_secret}
NEXTAUTH_URL=${app_url}

# ─── Admin Account ───────────────────────────────────────
ADMIN_USERNAME=${admin_user}
ADMIN_PASSWORD=${admin_password}

# ─── Service Auth ────────────────────────────────────────
SCRAPER_SERVICE_TOKEN=${scraper_token}

# ─── Optional: External Scraping Services ────────────────
# 取消注释并填写以启用外部爬虫服务:
# FIRECRAWL_API_KEY=
# FIRECRAWL_API_URL=
# AGENTQL_API_KEY=
# AGENTQL_API_URL=
# CLOUD_BROWSER_PROVIDER=browserless
# BROWSERLESS_API_KEY=
# BROWSERLESS_API_URL=
# STEEL_API_KEY=
# STEEL_API_URL=
ENVEOF

    chmod 600 .env
    ok ".env 已生成"

    # Store for later display
    FINAL_USER="$admin_user"
    FINAL_PASS="$admin_password"
    FINAL_URL="$app_url"
    FINAL_PORT="$port"
else
    # Source existing .env for display
    source .env 2>/dev/null || true
    FINAL_USER="${ADMIN_USERNAME:-admin}"
    FINAL_PASS="${ADMIN_PASSWORD}"
    FINAL_URL="${APP_URL:-http://localhost:${APP_PORT:-3000}}"
    FINAL_PORT="${APP_PORT:-3000}"
fi

# ================================================================
#  STEP 6/7 — Build & Start
# ================================================================
step "[6/7] 构建并启动"

info "首次构建约需 5-10 分钟 (取决于网络速度)..."
info "构建过程中会下载基础镜像 + 安装依赖 + 编译项目"
echo ""

BUILD_START=$(date +%s)

# Build (capture exit code through pipe)
set +e
$COMPOSE_CMD build 2>&1 | tee /tmp/novel-admin-build.log | while IFS= read -r line; do
    # Show key progress lines
    if echo "$line" | grep -qiE '(^Step |=> (=>|RUN|COPY|FROM)|DONE|ERROR|fail|WARN|successfully tagged|naming to)'; then
        echo "  $line"
    fi
done
BUILD_RC=${PIPESTATUS[0]}
set -e

BUILD_TIME=$(( $(date +%s) - BUILD_START ))
MINUTES=$(( BUILD_TIME / 60 ))
SECONDS=$(( BUILD_TIME % 60 ))

echo ""

if [[ $BUILD_RC -ne 0 ]]; then
    echo ""
    err "构建失败！耗时 ${MINUTES}m${SECONDS}s"
    err "查看完整日志: cat /tmp/novel-admin-build.log"
    echo ""
    err "常见原因:"
    err "  1. 网络问题 — Docker Hub 或 npm/bun registry 不可达"
    err "  2. 内存不足 — 至少需要 2GB 可用内存"
    err "  3. 磁盘不足 — 至少需要 5GB 可用空间"
    echo ""
    err "解决方法:"
    err "  • 重新运行此脚本 (已配置镜像加速，第二次通常更快)"
    err "  • 手动构建: cd ${INSTALL_DIR} && $COMPOSE_CMD build --no-cache"
    exit 1
fi

ok "构建完成 (${MINUTES}m${SECONDS}s)"

# Start containers
echo ""
info "启动服务..."
set +e
$COMPOSE_CMD up -d 2>&1
START_RC=$?
set -e

if [[ $START_RC -ne 0 ]]; then
    echo ""
    err "启动失败！"
    err "可能原因: 端口 ${FINAL_PORT} 被占用"
    err "解决: 修改 ${INSTALL_DIR}/.env 中的 APP_PORT 后重新运行:"
    err "  cd ${INSTALL_DIR} && $COMPOSE_CMD up -d"
    exit 1
fi
ok "容器已启动"

# ================================================================
#  STEP 7/7 — Health Check
# ================================================================
step "[7/7] 健康检查"

MAX_WAIT=180   # 最长等待 3 分钟
INTERVAL=3    # 每 3 秒检查一次
elapsed=0
healthy=false

echo ""

while [[ $elapsed -lt $MAX_WAIT ]]; do
    # Check if containers are still running
    if ! $COMPOSE_CMD ps 2>/dev/null | grep -qE 'Up|healthy|running'; then
        echo ""
        err "容器异常退出！"
        echo ""
        info "最近日志:"
        $COMPOSE_CMD logs --tail=30 2>&1
        echo ""
        err "排查建议:"
        err "  1. 查看完整日志: cd ${INSTALL_DIR} && $COMPOSE_CMD logs -f"
        err "  2. 检查内存: free -h (至少需要 2GB)"
        err "  3. 重新构建: cd ${INSTALL_DIR} && $COMPOSE_CMD up -d --build"
        exit 1
    fi

    # Try HTTP health check
    if curl -sf --connect-timeout 2 "http://localhost:${FINAL_PORT}/api/auth/csrf" &>/dev/null; then
        healthy=true
        # Complete the progress bar
        progress_bar "$MAX_WAIT" "$MAX_WAIT" "就绪!"
        echo ""
        break
    fi

    # Update progress bar
    progress_bar "$elapsed" "$MAX_WAIT" "等待启动..."
    sleep "$INTERVAL"
    elapsed=$((elapsed + INTERVAL))
done

echo ""

# --- Save credentials ---
CRED_FILE="${INSTALL_DIR}/.credentials.txt"
cat > "$CRED_FILE" <<CREDEOF
╔═══════════════════════════════════════════════════╗
║        📚 小说管理系统 — 登录凭据                  ║
║        Generated: $(date '+%Y-%m-%d %H:%M:%S')            ║
╚═══════════════════════════════════════════════════╝

访问地址:  ${FINAL_URL}
用户名:    ${FINAL_USER}
密码:      ${FINAL_PASS}

⚠️  请妥善保管此文件，建议保存后立即删除！
CREDEOF
chmod 600 "$CRED_FILE"

# --- Final output ---
echo ""
if $healthy; then
    echo -e "${C_GREEN}${C_BOLD}╔═══════════════════════════════════════════════════╗${C_RESET}"
    echo -e "${C_GREEN}${C_BOLD}║             ✅ 安装成功！系统已就绪                ║${C_RESET}"
    echo -e "${C_GREEN}${C_BOLD}╚═══════════════════════════════════════════════════╝${C_RESET}"
    echo ""
    echo -e "  🌐  ${C_BOLD}访问地址:${C_RESET}  ${C_CYAN}${FINAL_URL}${C_RESET}"
    echo -e "  👤  ${C_BOLD}用户名:${C_RESET}    ${C_BOLD}${FINAL_USER}${C_RESET}"
    echo -e "  🔑  ${C_BOLD}密码:${C_RESET}      ${C_BOLD}${FINAL_PASS}${C_RESET}"
    echo ""
    echo -e "  📋  ${C_BOLD}常用命令:${C_RESET}"
    echo -e "      查看日志:  ${C_CYAN}cd ${INSTALL_DIR} && ${COMPOSE_CMD} logs -f${C_RESET}"
    echo -e "      停止服务:  ${C_CYAN}cd ${INSTALL_DIR} && ${COMPOSE_CMD} stop${C_RESET}"
    echo -e "      启动服务:  ${C_CYAN}cd ${INSTALL_DIR} && ${COMPOSE_CMD} start${C_RESET}"
    echo -e "      重启服务:  ${C_CYAN}cd ${INSTALL_DIR} && ${COMPOSE_CMD} restart${C_RESET}"
    echo -e "      查看状态:  ${C_CYAN}cd ${INSTALL_DIR} && ${COMPOSE_CMD} ps${C_RESET}"
    echo ""
    echo -e "      数据备份:  ${C_CYAN}cd ${INSTALL_DIR} && ${COMPOSE_CMD} exec -T postgres \\${C_RESET}"
    echo -e "                  ${C_CYAN}pg_dump -U novel novel_admin > backup_\$(date +%Y%m%d).sql${C_RESET}"
    echo ""
    echo -e "  🔄  ${C_BOLD}升级系统:${C_RESET}"
    echo -e "      ${C_CYAN}cd ${INSTALL_DIR} && git pull && ${COMPOSE_CMD} up -d --build${C_RESET}"
    echo ""
    echo -e "  🗑️  ${C_BOLD}卸载系统:${C_RESET}"
    echo -e "      ${C_CYAN}${INSTALL_DIR}/install.sh --uninstall${C_RESET}"
    echo ""
    echo -e "  📁  ${C_BOLD}文件位置:${C_RESET}"
    echo -e "      项目目录:  ${C_DIM}${INSTALL_DIR}${C_RESET}"
    echo -e "      配置文件:  ${C_DIM}${INSTALL_DIR}/.env${C_RESET}"
    echo -e "      登录凭据:  ${C_DIM}${CRED_FILE}${C_RESET}"
    echo ""
    echo -e "  ${C_YELLOW}${C_BOLD}⚠️  请立即保存以上信息！凭据已写入 ${CRED_FILE}${C_RESET}"
    echo ""
else
    echo -e "${C_YELLOW}⏳ 健康检查超时，但服务可能仍在启动中（特别是低配服务器）${C_RESET}"
    echo ""
    echo -e "  检查状态:  ${C_CYAN}cd ${INSTALL_DIR} && ${COMPOSE_CMD} ps${C_RESET}"
    echo -e "  实时日志:  ${C_CYAN}cd ${INSTALL_DIR} && ${COMPOSE_CMD} logs -f${C_RESET}"
    echo -e "  查看凭据:  ${C_CYAN}cat ${CRED_FILE}${C_RESET}"
    echo ""
    echo -e "  ${C_DIM}如果服务正常启动，请稍等 1-2 分钟后访问 ${FINAL_URL}${C_RESET}"
    echo ""
fi

# Cleanup build log
rm -f /tmp/novel-admin-build.log 2>/dev/null