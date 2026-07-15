#!/bin/bash
# ============================================================
# 📚 小说管理系统 - 一键安装脚本 (from GitHub)
# Novel Management System - One-Click Installer
# ============================================================
#
# 使用方法 / Usage:
#   curl -fsSL https://raw.githubusercontent.com/u4399com-beep/novel-admin-1.0.0/main/install.sh | bash
#
# 或者手动下载后运行:
#   wget https://raw.githubusercontent.com/u4399com-beep/novel-admin-1.0.0/main/install.sh
#   chmod +x install.sh && ./install.sh
#
# 本脚本会自动完成:
#   1. 检测 Docker 环境（未安装则自动安装）
#   2. 从 GitHub 克隆项目
#   3. 生成安全的随机密码和密钥
#   4. 创建 .env 配置文件
#   5. Docker 构建并启动所有服务
#   6. 等待健康检查通过，显示登录信息
# ============================================================

set -e

# ─── Colors ───
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m'
BOLD='\033[1m'
DIM='\033[2m'

# ─── Constants ───
REPO_URL="https://github.com/u4399com-beep/novel-admin-1.0.0.git"
REPO_RAW="https://raw.githubusercontent.com/u4399com-beep/novel-admin-1.0.0/main"
INSTALL_DIR="/opt/novel-admin"

# ─── Helper Functions ───
info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()      { echo -e "${GREEN}  ✓${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; }
step()    { echo -e "\n${MAGENTA}${BOLD}▶ $*${NC}"; }
banner()  { echo -e "${CYAN}${BOLD}$*${NC}"; }

# ─── Trap: cleanup on error ───
trap 'error "Script interrupted. Partial installation may exist at ${INSTALL_DIR}"; exit 1' INT TERM

# ============================================================
# Step 0: Banner
# ============================================================
clear
echo ""
banner "╔═══════════════════════════════════════════════════════════╗"
banner "║                                                           ║"
banner "║        📚 小说管理系统 - Docker 一键安装                 ║"
banner "║        Novel Management System - One-Click Installer      ║"
banner "║                                                           ║"
banner "║        Repo: github.com/u4399com-beep/novel-admin-1.0.0  ║"
banner "║                                                           ║"
banner "╚═══════════════════════════════════════════════════════════╝"
echo ""

# ============================================================
# Step 1: Install / Verify Docker
# ============================================================
step "Step 1/6: Checking Docker environment..."

install_docker() {
    info "Docker not found. Installing Docker..."
    if command -v apt-get &> /dev/null; then
        # Debian/Ubuntu
        apt-get update -qq
        apt-get install -y -qq ca-certificates curl gnupg > /dev/null 2>&1
        install -m 0755 -d /etc/apt/keyrings
        curl -fsSL https://download.docker.com/linux/$(. /etc/os-release && echo "$ID")/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg 2>/dev/null
        chmod a+r /etc/apt/keyrings/docker.gpg
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$(. /etc/os-release && echo "$ID") $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
        apt-get update -qq
        apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin > /dev/null 2>&1
    elif command -v yum &> /dev/null; then
        # CentOS/RHEL
        yum install -y -q yum-utils > /dev/null 2>&1
        yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo > /dev/null 2>&1
        yum install -y -q docker-ce docker-ce-cli containerd.io docker-compose-plugin > /dev/null 2>&1
    elif command -v apk &> /dev/null; then
        # Alpine
        apk add --no-cache docker docker-compose > /dev/null 2>&1
    else
        error "Unsupported OS. Please install Docker manually:"
        echo "  curl -fsSL https://get.docker.com | sh"
        exit 1
    fi
    systemctl start docker 2>/dev/null || true
    systemctl enable docker 2>/dev/null || true
    ok "Docker installed and started"
}

if ! command -v docker &> /dev/null; then
    read -p "Docker is not installed. Install it now? (Y/n): " INSTALL_DOCKER
    if [[ ! "$INSTALL_DOCKER" =~ ^[Nn]$ ]]; then
        install_docker
    else
        error "Docker is required. Please install it first:"
        echo "  curl -fsSL https://get.docker.com | sh"
        exit 1
    fi
fi
ok "Docker $(docker --version | grep -oP '\d+\.\d+\.\d+' | head -1)"

# Check Docker Compose
if docker compose version &> /dev/null; then
    COMPOSE_CMD="docker compose"
elif command -v docker-compose &> /dev/null; then
    COMPOSE_CMD="docker-compose"
else
    error "Docker Compose not found!"
    echo "  Reinstall Docker: curl -fsSL https://get.docker.com | sh"
    exit 1
fi
ok "Docker Compose $(docker compose version --short 2>/dev/null || docker-compose --version | grep -oP '\d+\.\d+\.\d+' | head -1)"

# Check Docker daemon
if ! docker info &> /dev/null; then
    warn "Docker daemon not running, attempting to start..."
    systemctl start docker 2>/dev/null || service docker start 2>/dev/null || true
    sleep 2
    if ! docker info &> /dev/null; then
        error "Docker daemon failed to start!"
        exit 1
    fi
fi
ok "Docker daemon is running"

# ─── Configure Docker Mirror (for China / blocked Docker Hub) ───
step "Configuring Docker registry mirror..."

# Test if Docker Hub is reachable (quick HTTP probe, no image pull)
HUB_REACHABLE=false
if curl -sf --connect-timeout 5 https://registry-1.docker.io/v2/ > /dev/null 2>&1; then
    HUB_REACHABLE=true
fi

MIRRORS_CONFIGURED=false
DAEMON_JSON="/etc/docker/daemon.json"

# China mirror list (multi-source for redundancy)
MIRRORS_LINE='["https://docker.1ms.run","https://docker.xuanyuan.me","https://docker.m.daocloud.io","https://docker.nju.edu.cn","https://hub.rat.dev","https://docker.chenby.cn","https://docker.mirrors.ustc.edu.cn"]'

if [ "$HUB_REACHABLE" = false ]; then
    warn "Docker Hub (registry-1.docker.io) is NOT reachable."
    info "Configuring China mirror accelerators..."

    # Backup existing config
    if [ -f "$DAEMON_JSON" ]; then
        cp "$DAEMON_JSON" "${DAEMON_JSON}.bak.$(date +%s)"
    fi

    # Write mirror config (single-line JSON for maximum compatibility)
    mkdir -p /etc/docker
    echo "{\"registry-mirrors\": ${MIRRORS_LINE}}" > "$DAEMON_JSON"

    # Restart Docker to apply
    systemctl daemon-reload 2>/dev/null || true
    systemctl restart docker 2>/dev/null || service docker restart 2>/dev/null || true
    sleep 3

    # Verify
    if docker info 2>/dev/null | grep -q "Registry Mirrors"; then
        ok "China mirrors configured and active"
        MIRRORS_CONFIGURED=true
    else
        warn "Mirror config written but may not be active (check ${DAEMON_JSON})"
        MIRRORS_CONFIGURED=true
    fi
else
    ok "Docker Hub is reachable, no mirror needed"
fi

# Check disk space
AVAILABLE_GB=$(df -BG /opt 2>/dev/null | awk 'NR==2 {print $4}' | tr -d 'G')
[ -z "$AVAILABLE_GB" ] && AVAILABLE_GB=$(df -BG . | awk 'NR==2 {print $4}' | tr -d 'G')
if [ -n "$AVAILABLE_GB" ] && [ "$AVAILABLE_GB" -lt 5 ]; then
    error "Insufficient disk space: ${AVAILABLE_GB}GB (need at least 5GB)"
    exit 1
fi
ok "Disk space: ${AVAILABLE_GB}GB available"

# ============================================================
# Step 2: Clone or Update Project
# ============================================================
step "Step 2/6: Preparing project files..."

if [ -d "${INSTALL_DIR}/.git" ]; then
    # Already cloned, pull latest
    warn "Project directory ${INSTALL_DIR} already exists."
    read -p "Update to latest version? (Y/n): " DO_PULL
    if [[ ! "$DO_PULL" =~ ^[Nn]$ ]]; then
        cd "$INSTALL_DIR"
        git pull --ff-only 2>&1 || warn "Git pull failed (may be detached HEAD), continuing..."
        ok "Project updated"
    fi
    cd "$INSTALL_DIR"
else
    if [ -d "$INSTALL_DIR" ]; then
        warn "Directory ${INSTALL_DIR} exists but is not a git repo."
        read -p "Remove and re-clone? (Y/n): " DO_REMOVE
        if [[ ! "$DO_REMOVE" =~ ^[Nn]$ ]]; then
            rm -rf "$INSTALL_DIR"
        else
            error "Cannot proceed. Please manually remove ${INSTALL_DIR} or choose a different directory."
            exit 1
        fi
    fi

    info "Cloning from ${REPO_URL} ..."
    # Try git clone, fallback to downloading zip
    if command -v git &> /dev/null; then
        git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" 2>&1
        ok "Project cloned to ${INSTALL_DIR}"
    else
        info "Git not found, downloading via curl..."
        mkdir -p "$INSTALL_DIR"
        curl -fsSL "${REPO_RAW}/archive/refs/heads/main.tar.gz" -o /tmp/novel-admin.tar.gz
        tar xzf /tmp/novel-admin.tar.gz -C /tmp/
        cp -r /tmp/novel-admin-1.0.0-*/* "$INSTALL_DIR/" 2>/dev/null || \
        cp -r /tmp/novel-admin-1.0.0-*/. "$INSTALL_DIR/" 2>/dev/null
        rm -f /tmp/novel-admin.tar.gz
        rm -rf /tmp/novel-admin-1.0.0-*
        ok "Project downloaded to ${INSTALL_DIR}"
    fi
    cd "$INSTALL_DIR"
fi

# Verify key files exist
for f in Dockerfile docker-compose.yml docker-entrypoint.sh .env.production; do
    if [ ! -f "$f" ]; then
        error "Required file missing: $f"
        error "The repository may be incomplete. Try deleting ${INSTALL_DIR} and re-running this script."
        exit 1
    fi
done
ok "All required files present"

# ============================================================
# Step 3: Generate Configuration
# ============================================================
step "Step 3/6: Generating secure configuration..."

# Generate random hex string
generate_hex() {
    local length=${1:-32}
    if command -v openssl &> /dev/null; then
        openssl rand -hex "$length"
    else
        tr -dc 'a-f0-9' < /dev/urandom | head -c "$((length * 2))"
    fi
}

# Generate random password (alphanumeric)
generate_password() {
    local length=${1:-16}
    if command -v openssl &> /dev/null; then
        openssl rand -base64 "$((length * 3 / 4 + 1))" | tr -d '/+=' | head -c "$length"
    else
        tr -dc 'A-Za-z0-9' < /dev/urandom | head -c "$length"
    fi
}

# Detect server IP
detect_ip() {
    local ip
    ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    if [ -z "$ip" ] || [[ "$ip" == "127."* ]]; then
        ip=$(curl -s --connect-timeout 3 ifconfig.me 2>/dev/null || echo "")
    fi
    if [ -z "$ip" ] || [[ "$ip" == "127."* ]]; then
        ip=$(curl -s --connect-timeout 3 ip.sb 2>/dev/null || echo "")
    fi
    echo "${ip:-YOUR_SERVER_IP}"
}

# Check existing .env
CREATE_ENV=false
if [ -f ".env" ]; then
    # Extract current values for reuse
    source .env 2>/dev/null || true
    warn ".env already exists (created $(grep 'Generated:' .env 2>/dev/null | cut -d: -f2- || echo 'previously'))."
    echo ""
    echo "  Current config:"
    echo "    Port:       ${APP_PORT:-3000}"
    echo "    Admin:      ${ADMIN_USERNAME:-admin}"
    echo "    App URL:    ${APP_URL:-http://localhost:3000}"
    echo ""
    read -p "  Reconfigure? (y/N): " CONFIRM
    if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
        info "Keeping existing .env. Skipping to build."
        echo ""
        SKIP_ENV=true
    else
        cp .env ".env.backup.$(date +%Y%m%d_%H%M%S)"
        ok "Old .env backed up"
        CREATE_ENV=true
    fi
else
    CREATE_ENV=true
fi

if [ "$CREATE_ENV" = true ] && [ "$SKIP_ENV" != true ]; then
    # Generate secrets
    NEXTAUTH_SECRET=$(generate_hex 32)
    SCRAPER_TOKEN=$(generate_hex 32)
    DB_PASSWORD=$(generate_hex 16)
    AUTO_PASS=$(generate_password 14)

    echo ""
    info "Configure your installation (press Enter for defaults):"
    echo ""

    # Port
    read -p "  App port [3000]: " INPUT_PORT
    APP_PORT="${INPUT_PORT:-3000}"

    # Validate port is numeric and available
    if ! [[ "$APP_PORT" =~ ^[0-9]+$ ]] || [ "$APP_PORT" -lt 1 ] || [ "$APP_PORT" -gt 65535 ]; then
        warn "Invalid port, using 3000"
        APP_PORT=3000
    fi

    # Admin username
    read -p "  Admin username [admin]: " INPUT_USER
    ADMIN_USER="${INPUT_USER:-admin}"

    # Admin password
    read -p "  Admin password [auto: ${AUTO_PASS}]: " INPUT_PASS
    ADMIN_PASS="${INPUT_PASS:-$AUTO_PASS}"

    # Server IP / domain
    AUTO_IP=$(detect_ip)
    read -p "  Server IP or domain [${AUTO_IP}]: " INPUT_URL
    SERVER_ADDR="${INPUT_URL:-$AUTO_IP}"

    # Build APP_URL
    if [[ "$SERVER_ADDR" =~ ^https?:// ]]; then
        APP_URL="$SERVER_ADDR"
    else
        APP_URL="http://${SERVER_ADDR}:${APP_PORT}"
    fi

    # Timezone
    read -p "  Timezone [Asia/Shanghai]: " INPUT_TZ
    TZ="${INPUT_TZ:-Asia/Shanghai}"

    echo ""

    # Write .env
    cat > .env << ENVEOF
# ============================================================
# Novel Management System - Auto-generated by install.sh
# Generated: $(date '+%Y-%m-%d %H:%M:%S')
# Source: ${REPO_URL}
# ============================================================

# ─── Database ────────────────────────────────────────────
POSTGRES_USER=novel
POSTGRES_PASSWORD=${DB_PASSWORD}
POSTGRES_DB=novel_admin
DB_PORT=5432

# ─── App Config ──────────────────────────────────────────
APP_PORT=${APP_PORT}
APP_NAME=小说管理系统
APP_URL=${APP_URL}
TZ=${TZ}

# ─── Authentication ──────────────────────────────────────
NEXTAUTH_SECRET=${NEXTAUTH_SECRET}

# ─── Admin Account ───────────────────────────────────────
ADMIN_USERNAME=${ADMIN_USER}
ADMIN_PASSWORD=${ADMIN_PASS}

# ─── Service-to-Service Auth ─────────────────────────────
SCRAPER_SERVICE_TOKEN=${SCRAPER_TOKEN}

# ─── Optional: External Scraping Services ────────────────
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
    ok ".env created (chmod 600)"
fi

echo ""

# Always source .env for remaining steps (in case of skip)
source .env 2>/dev/null || true

# ============================================================
# Step 4: Build Docker Images
# ============================================================
step "Step 4/6: Building Docker images..."
info "First build may take 5-10 minutes depending on your server."
echo ""

BUILD_START=$(date +%s)

# Run build and capture output
set +e
$COMPOSE_CMD build 2>&1 | tee /tmp/novel-build.log | while IFS= read -r line; do
    if echo "$line" | grep -qiE "(step [0-9]|=> (=>|RUN|COPY|FROM)|sending build|DONE|successfully tagged|ERROR|failed|WARN)" || [ -z "$line" ]; then
        echo "  $line"
    fi
done
BUILD_EXIT=${PIPESTATUS[0]}
set -e

BUILD_ELAPSED=$(( $(date +%s) - BUILD_START ))
BUILD_MIN=$((BUILD_ELAPSED / 60))
BUILD_SEC=$((BUILD_ELAPSED % 60))

echo ""
if [ "$BUILD_EXIT" -ne 0 ]; then
    error "Docker build failed after ${BUILD_MIN}m${BUILD_SEC}s!"
    echo ""
    echo "  Common fixes:"
    echo "    1. Check network: curl -I https://registry-1.docker.io"
    echo "    2. Check disk:    df -h"
    echo "    3. Retry clean:   $COMPOSE_CMD build --no-cache"
    echo "    4. Full log:      cat /tmp/novel-build.log"
    exit 1
fi
ok "Build completed in ${BUILD_MIN}m${BUILD_SEC}s"

# ============================================================
# Step 5: Start Services
# ============================================================
step "Step 5/6: Starting services..."
echo ""

set +e
$COMPOSE_CMD up -d 2>&1
UP_EXIT=$?
set -e

if [ "$UP_EXIT" -ne 0 ]; then
    error "Failed to start services!"
    echo ""
    echo "  Check logs: $COMPOSE_CMD logs"
    echo "  Common cause: port ${APP_PORT:-3000} already in use"
    echo "    Fix: change APP_PORT in .env, then re-run this script"
    exit 1
fi
ok "Services started"

echo ""

# ============================================================
# Step 6: Health Check & Show Result
# ============================================================
step "Step 6/6: Waiting for system to be ready..."
echo ""

source .env 2>/dev/null || true
PORT="${APP_PORT:-3000}"
MAX_WAIT=180
ELAPSED=0
HEALTHY=false

while [ $ELAPSED -lt $MAX_WAIT ]; do
    # Check containers are alive
    if ! $COMPOSE_CMD ps 2>/dev/null | grep -q "Up\|running\|healthy"; then
        error "Containers crashed! Showing logs:"
        echo ""
        $COMPOSE_CMD logs --tail=30 2>&1
        exit 1
    fi

    # Try health endpoint
    if curl -sf "http://localhost:${PORT}/api/auth/csrf" > /dev/null 2>&1; then
        HEALTHY=true
        break
    fi

    # Progress bar
    PCT=$(( ELAPSED * 100 / MAX_WAIT ))
    FILLED=$(( PCT / 5 ))
    EMPTY=$(( 20 - FILLED ))
    BAR=$(printf '%*s' "$FILLED" | tr ' ' '█')
    DOT=$(printf '%*s' "$EMPTY" | tr ' ' '░')
    printf "\r  [%s%s] %3d%% (%ds/%ds)" "$BAR" "$DOT" "$PCT" "$ELAPSED" "$MAX_WAIT"

    sleep 3
    ELAPSED=$((ELAPSED + 3))
done

echo ""

if [ "$HEALTHY" = true ]; then
    echo ""
    echo -e "${GREEN}${BOLD}╔═══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}${BOLD}║                                                           ║${NC}"
    echo -e "${GREEN}${BOLD}║            ✅ 安装成功！系统已就绪                      ║${NC}"
    echo -e "${GREEN}${BOLD}║            Installation Complete!                         ║${NC}"
    echo -e "${GREEN}${BOLD}║                                                           ║${NC}"
    echo -e "${GREEN}${BOLD}╚═══════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  🌐  ${BOLD}访问地址:${NC}"
    echo -e "      ${CYAN}${APP_URL:-http://localhost:${PORT}}${NC}"
    echo ""
    echo -e "  👤  ${BOLD}管理员登录:${NC}"
    echo -e "      Username: ${BOLD}${ADMIN_USERNAME:-admin}${NC}"
    echo -e "      Password: ${BOLD}${ADMIN_PASSWORD:-<check .env file>}${NC}"
    echo ""
    echo -e "  📋  ${BOLD}常用命令:${NC}"
    echo -e "      日志:     ${CYAN}cd ${INSTALL_DIR} && $COMPOSE_CMD logs -f${NC}"
    echo -e "      停止:     ${CYAN}cd ${INSTALL_DIR} && $COMPOSE_CMD stop${NC}"
    echo -e "      重启:     ${CYAN}cd ${INSTALL_DIR} && $COMPOSE_CMD restart${NC}"
    echo -e "      状态:     ${CYAN}cd ${INSTALL_DIR} && $COMPOSE_CMD ps${NC}"
    echo -e "      卸载:     ${CYAN}cd ${INSTALL_DIR} && $COMPOSE_CMD down -v && rm -rf ${INSTALL_DIR}${NC}"
    echo -e "      备份数据: ${CYAN}cd ${INSTALL_DIR} && mkdir -p backups && $COMPOSE_CMD exec -T postgres pg_dump -U novel novel_admin > backups/db_\$(date +%Y%m%d).sql${NC}"
    echo ""
    echo -e "  📁  ${BOLD}文件位置:${NC}"
    echo -e "      项目目录: ${DIM}${INSTALL_DIR}${NC}"
    echo -e "      配置文件: ${DIM}${INSTALL_DIR}/.env${NC}"
    echo -e "      备份目录: ${DIM}${INSTALL_DIR}/backups/${NC}"
    echo ""
    echo -e "  🔄  ${BOLD}更新升级:${NC}"
    echo -e "      cd ${INSTALL_DIR} && git pull && $COMPOSE_CMD up -d --build"
    echo ""
    echo -e "  ${YELLOW}⚠️  请立即保存以上信息！关闭终端后密码不再显示。${NC}"
    echo ""
else
    echo ""
    warn "Health check timed out (${MAX_WAIT}s). This may be normal on slow servers."
    echo ""
    echo "  Check status:"
    echo "    cd ${INSTALL_DIR} && $COMPOSE_CMD ps"
    echo ""
    echo "  View logs:"
    echo "    cd ${INSTALL_DIR} && $COMPOSE_CMD logs -f"
    echo ""
    echo "  If containers show 'Up', the system is likely ready."
    echo "  Try accessing: ${APP_URL:-http://localhost:${PORT}}"
    echo ""
    echo "  Login credentials are in ${INSTALL_DIR}/.env"
    echo ""
fi

# Cleanup
rm -f /tmp/novel-build.log 2>/dev/null