#!/bin/bash
# ============================================================
# Novel Management System - One-Click Docker Installer
# ============================================================
# Usage:
#   chmod +x install.sh
#   ./install.sh
#
# This script will:
#   1. Check prerequisites (Docker, Docker Compose)
#   2. Auto-generate secure random passwords and secrets
#   3. Create .env from template
#   4. Build and start all services
#   5. Wait for health check and show login URL
# ============================================================
set -e

# ─── Colors ───
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color
BOLD='\033[1m'

# ─── Helper Functions ───
info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; }
banner()  { echo -e "${CYAN}${BOLD}$*${NC}"; }

# ─── Script Directory ───
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ============================================================
# Step 0: Banner
# ============================================================
clear
echo ""
banner "╔══════════════════════════════════════════════════╗"
banner "║                                                  ║"
banner "║     📚 小说管理系统 - Docker 一键安装            ║"
banner "║     Novel Management System Installer             ║"
banner "║                                                  ║"
banner "╚══════════════════════════════════════════════════╝"
echo ""

# ============================================================
# Step 1: Check Prerequisites
# ============================================================
info "Step 1/5: Checking prerequisites..."

# Check Docker
if ! command -v docker &> /dev/null; then
    error "Docker is not installed!"
    echo ""
    echo "Please install Docker first:"
    echo "  curl -fsSL https://get.docker.com | sh"
    echo "  systemctl start docker"
    echo "  systemctl enable docker"
    echo ""
    exit 1
fi
success "Docker $(docker --version | grep -oP '\d+\.\d+\.\d+')"

# Check Docker Compose (v2 plugin)
if docker compose version &> /dev/null; then
    COMPOSE_CMD="docker compose"
    success "Docker Compose $(docker compose version --short 2>/dev/null || echo 'v2')"
elif command -v docker-compose &> /dev/null; then
    COMPOSE_CMD="docker-compose"
    success "Docker Compose (standalone) $(docker-compose --version | grep -oP '\d+\.\d+\.\d+')"
else
    error "Docker Compose is not installed!"
    echo ""
    echo "Docker Compose v2 is included with Docker. Try reinstalling Docker:"
    echo "  curl -fsSL https://get.docker.com | sh"
    echo ""
    exit 1
fi

# Check Docker daemon is running
if ! docker info &> /dev/null; then
    error "Docker daemon is not running!"
    echo ""
    echo "Please start Docker:"
    echo "  systemctl start docker"
    echo ""
    exit 1
fi
success "Docker daemon is running"

# Check available disk space (need at least 3GB)
AVAILABLE_GB=$(df -BG "$SCRIPT_DIR" | awk 'NR==2 {print $4}' | tr -d 'G')
if [ -n "$AVAILABLE_GB" ] && [ "$AVAILABLE_GB" -lt 3 ]; then
    warn "Low disk space: ${AVAILABLE_GB}GB available (recommended: 10GB+)"
    read -p "Continue anyway? (y/N): " CONFIRM
    if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
        exit 1
    fi
else
    success "Disk space: ${AVAILABLE_GB}GB available"
fi

echo ""

# ============================================================
# Step 2: Generate Secrets & Create .env
# ============================================================
info "Step 2/5: Generating secure configuration..."

# Generate random hex string
generate_hex() {
    local length=${1:-32}
    if command -v openssl &> /dev/null; then
        openssl rand -hex "$length"
    else
        head -c "$((length * 2))" /dev/urandom | xxd -p -c "$((length * 2))"
    fi
}

# Generate random alphanumeric password
generate_password() {
    local length=${1:-16}
    if command -v openssl &> /dev/null; then
        openssl rand -base64 "$((length * 3 / 4))" | tr -d '/+=' | head -c "$length"
    else
        head -c "$length" /dev/urandom | base64 | tr -d '/+=' | head -c "$length"
    fi
}

# Check if .env already exists
if [ -f ".env" ]; then
    warn ".env already exists!"
    read -p "Overwrite with new generated secrets? (y/N): " CONFIRM
    if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
        info "Keeping existing .env file."
        echo ""
    else
        # Backup old .env
        cp .env ".env.backup.$(date +%Y%m%d_%H%M%S)"
        warn "Old .env backed up as .env.backup.$(date +%Y%m%d_%H%M%S)"
        # Fall through to create new .env
        CREATE_ENV=true
    fi
fi

if [ ! -f ".env" ] || [ "$CREATE_ENV" = true ]; then
    # Generate secrets
    NEXTAUTH_SECRET=$(generate_hex 32)
    SCRAPER_TOKEN=$(generate_hex 32)
    DB_PASSWORD=$(generate_hex 16)
    ADMIN_PASS=$(generate_password 12)
    ADMIN_USER="admin"

    # Ask for custom port
    DEFAULT_PORT=3000
    read -p "Which port should the app listen on? (default: ${DEFAULT_PORT}): " CUSTOM_PORT
    APP_PORT="${CUSTOM_PORT:-$DEFAULT_PORT}"

    # Ask for admin username
    read -p "Admin username (default: admin): " CUSTOM_USER
    ADMIN_USER="${CUSTOM_USER:-$ADMIN_USER}"

    # Ask for admin password (or use generated)
    read -p "Admin password (press Enter to use auto-generated: ${ADMIN_PASS}): " CUSTOM_PASS
    ADMIN_PASS="${CUSTOM_PASS:-$ADMIN_PASS}"

    # Ask for app URL
    detect_ip() {
        # Try to get the server's main IP
        local ip
        ip=$(hostname -I 2>/dev/null | awk '{print $1}')
        if [ -z "$ip" ]; then
            ip=$(curl -s --connect-timeout 2 ifconfig.me 2>/dev/null || echo "YOUR_SERVER_IP")
        fi
        echo "$ip"
    }
    SERVER_IP=$(detect_ip)
    read -p "Server IP or domain (default: ${SERVER_IP}): " CUSTOM_URL
    if [ -n "$CUSTOM_URL" ]; then
        APP_URL="http://${CUSTOM_URL}:${APP_PORT}"
    else
        APP_URL="http://${SERVER_IP}:${APP_PORT}"
    fi

    # Create .env
    cat > .env << ENVEOF
# ============================================================
# Novel Management System - Auto-generated by install.sh
# Generated: $(date '+%Y-%m-%d %H:%M:%S')
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
TZ=Asia/Shanghai

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
    success ".env created with secure random values"
    echo ""
fi

echo ""

# ============================================================
# Step 3: Build Docker Images
# ============================================================
info "Step 3/5: Building Docker images (this may take 5-10 minutes on first run)..."
echo ""

$COMPOSE_CMD build 2>&1 | while IFS= read -r line; do
    # Show progress but suppress overly verbose output
    if echo "$line" | grep -qE "(Step|=>|DONE|ERROR|WARN|=> =>)" || [ -z "$line" ]; then
        echo "  $line"
    fi
done

BUILD_EXIT=${PIPESTATUS[0]}
if [ "$BUILD_EXIT" -ne 0 ]; then
    error "Docker build failed! Check the output above for errors."
    echo ""
    echo "Common fixes:"
    echo "  1. Check network connectivity (need to download base images)"
    echo "  2. Ensure enough disk space: df -h"
    echo "  3. Try again: $COMPOSE_CMD build --no-cache"
    exit 1
fi

echo ""
success "Docker images built successfully!"
echo ""

# ============================================================
# Step 4: Start Services
# ============================================================
info "Step 4/5: Starting services..."
echo ""

$COMPOSE_CMD up -d 2>&1
if [ $? -ne 0 ]; then
    error "Failed to start services!"
    echo ""
    echo "Check logs with: $COMPOSE_CMD logs"
    exit 1
fi

echo ""
success "Services started!"
echo ""

# ============================================================
# Step 5: Wait for Health Check
# ============================================================
info "Step 5/5: Waiting for system to be ready..."
echo ""

MAX_WAIT=180  # 3 minutes max
ELAPSED=0
HEALTHY=false

while [ $ELAPSED -lt $MAX_WAIT ]; do
    # Check container status
    STATUS=$($COMPOSE_CMD ps --format json 2>/dev/null | docker compose ps --format "table {{.Name}}\t{{.Status}}" 2>/dev/null || true)

    # Try health endpoint
    if curl -sf "http://localhost:${APP_PORT:-3000}/api/auth/csrf" > /dev/null 2>&1; then
        HEALTHY=true
        break
    fi

    # Check if containers are still running
    if ! $COMPOSE_CMD ps 2>/dev/null | grep -q "Up\|running\|healthy"; then
        error "Containers stopped unexpectedly! Check logs:"
        echo "  $COMPOSE_CMD logs"
        exit 1
    fi

    printf "\r  Waiting... %ds / %ds" "$ELAPSED" "$MAX_WAIT"
    sleep 5
    ELAPSED=$((ELAPSED + 5))
done

echo ""

if [ "$HEALTHY" = true ]; then
    # Extract login info from .env
    source .env 2>/dev/null || true

    echo ""
    echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}${BOLD}║                                                  ║${NC}"
    echo -e "${GREEN}${BOLD}║           ✅ 安装成功！系统已就绪                ║${NC}"
    echo -e "${GREEN}${BOLD}║           Installation Complete!                  ║${NC}"
    echo -e "${GREEN}${BOLD}║                                                  ║${NC}"
    echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  🌐 ${BOLD}访问地址 / URL:${NC}"
    echo -e "     ${CYAN}${APP_URL:-http://localhost:${APP_PORT:-3000}}${NC}"
    echo ""
    echo -e "  👤 ${BOLD}管理员账号 / Admin Login:${NC}"
    echo -e "     Username: ${BOLD}${ADMIN_USERNAME:-admin}${NC}"
    echo -e "     Password: ${BOLD}${ADMIN_PASSWORD:-<see .env file>}${NC}"
    echo ""
    echo -e "  📋 ${BOLD}常用命令 / Common Commands:${NC}"
    echo -e "     View logs:    ${CYAN}$COMPOSE_CMD logs -f${NC}"
    echo -e "     Stop:         ${CYAN}$COMPOSE_CMD stop${NC}"
    echo -e "     Restart:      ${CYAN}$COMPOSE_CMD restart${NC}"
    echo -e "     Status:       ${CYAN}$COMPOSE_CMD ps${NC}"
    echo -e "     Full uninstall: ${CYAN}$COMPOSE_CMD down -v${NC}"
    echo ""
    echo -e "  📁 ${BOLD}重要文件 / Important Files:${NC}"
    echo -e "     Config:       ${CYAN}.env${NC}  (所有密码和配置都在这里)"
    echo -e "     Data backup:  ${CYAN}backups/${NC}  (数据库备份目录)"
    echo ""
    echo -e "  ⚠️  ${YELLOW}请保存以上信息！关闭此窗口后密码将不再显示。${NC}"
    echo -e "  ⚠️  ${YELLOW}Save this info! Password won't be shown again.${NC}"
    echo ""
else
    echo ""
    warn "System is starting but health check timed out."
    warn "This is normal on slow servers. Check status with:"
    echo ""
    echo "  $COMPOSE_CMD ps"
    echo "  $COMPOSE_CMD logs -f"
    echo ""
    echo "If the app container shows 'Up', try accessing:"
    echo "  ${APP_URL:-http://localhost:${APP_PORT:-3000}}"
    echo ""
    echo "Login credentials are in .env:"
    echo "  ADMIN_USERNAME and ADMIN_PASSWORD"
    echo ""
fi