#!/usr/bin/env bash
# ============================================================
# 小说阁 - Docker 一键安装脚本 v6.0
# Novel Admin Platform - Docker One-Click Installation
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/u4399com-beep/novel-admin-1.0.0/main/install-docker.sh | bash
#   OR
#   bash install-docker.sh
#
# Options:
#   --skip-env      Skip .env configuration
#   --port PORT     Custom port (default: 3000)
#   --dir DIR       Custom install directory
#   -y / --yes      Auto-accept all prompts
#   --no-pull       Don't pull images (use local)
# ============================================================

set -euo pipefail

# ─── Colors & Helpers ─────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()      { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
fatal()   { echo -e "${RED}[FATAL]${NC} $*" >&2; exit 1; }
step()    { echo -e "\n${BOLD}${CYAN}━━━ Step $1 ━━━${NC} ${BOLD}$2${NC}\n"; }
spinner() {
  local pid=$1 msg="$2"
  while kill -0 "$pid" 2>/dev/null; do
    for s in ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏; do
      printf "\r  %s %s" "$s" "$msg"
      sleep 0.1
    done
  done
  printf "\r  %s" "$(printf ' %.0s' $(seq 1 50))"
}

# ─── Parse Options ─────────────────────────────────────────
SKIP_ENV=false; CUSTOM_PORT=""; CUSTOM_DIR=""; AUTO_YES=false; NO_PULL=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-env)  SKIP_ENV=true; shift ;;
    --port)      CUSTOM_PORT="${2:-}"; shift 2 ;;
    --dir)       CUSTOM_DIR="${2:-}"; shift 2 ;;
    -y|--yes)    AUTO_YES=true; shift ;;
    --no-pull)   NO_PULL=true; shift ;;
    *) shift ;;
  esac
done

# ─── Banner ────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${CYAN}║${NC}  ${BOLD}📚 小说阁 — Docker 一键安装 v6.0${NC}              ${BOLD}${CYAN}║${NC}"
echo -e "${BOLD}${CYAN}║${NC}  容器化部署 · 自动健康检查 · 硬件自适应        ${BOLD}${CYAN}║${NC}"
echo -e "${BOLD}${CYAN}║${NC}  App + Scraper + LogStream + PostgreSQL         ${BOLD}${CYAN}║${NC}"
echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════════════╝${NC}"
echo ""

# ─── Step 1: Docker Environment ───────────────────────────
step 1 "检查 Docker 环境"

# Install Docker if missing
if ! command -v docker >/dev/null 2>&1; then
  info "Docker 未安装，正在自动安装..."
  if ! curl -s -m 5 https://www.google.com >/dev/null 2>&1; then
    info "检测到国内网络，使用阿里云 Docker 安装源..."
    curl -fsSL https://get.docker.com | bash -s -- --mirror Aliyun 2>/dev/null || \
    curl -fsSL https://get.docker.com | sh 2>/dev/null || fatal "Docker 安装失败！"
  else
    curl -fsSL https://get.docker.com | sh 2>/dev/null || fatal "Docker 安装失败！"
  fi
  systemctl start docker 2>/dev/null || service start docker 2>/dev/null || true
  ok "Docker 安装完成"
fi

# Docker Compose
if ! docker compose version >/dev/null 2>&1; then
  info "安装 Docker Compose 插件..."
  apt-get update -qq && apt-get install -y -qq docker-compose-plugin 2>/dev/null || \
    fatal "Docker Compose 安装失败！"
fi

docker info >/dev/null 2>&1 || fatal "Docker daemon 未运行！"
DOCKER_VER=$(docker --version 2>&1 | grep -oP 'Docker version \K[^,]+' || echo "unknown")
COMPOSE_VER=$(docker compose version --short 2>/dev/null || echo "unknown")
ok "Docker $DOCKER_VER + Compose $COMPOSE_VER"

# ─── Step 2: Get Project Code ─────────────────────────────
step 2 "获取项目代码"

REPO="u4399com-beep/novel-admin-1.0.0"
GIT_RAW="https://raw.githubusercontent.com/${REPO}/main"
ARCHIVE_URL="https://github.com/${REPO}/archive/refs/heads/main.tar.gz"
CODE_OBTAINED=false

# Check if already in project dir
if [ -f "docker-compose.yml" ] && [ -f "Dockerfile" ]; then
  ok "项目文件已存在，跳过下载"
  CODE_OBTAINED=true
fi

if [ "$CODE_OBTAINED" = "false" ]; then
  INSTALL_DIR="${CUSTOM_DIR:-.}"
  mkdir -p "$INSTALL_DIR"
  cd "$INSTALL_DIR"

  # Detect China network
  _IS_CHINA=false
  if ! curl -s -m 5 https://www.google.com >/dev/null 2>&1; then
    _IS_CHINA=true
    info "检测到国内网络环境，优先使用镜像加速"
  fi

  # Method 1: git clone (with mirrors)
  if [ "$CODE_OBTAINED" = "false" ] && command -v git >/dev/null 2>&1; then
    _GIT_MIRRORS=(
      "https://github.com/${REPO}.git"
      "https://ghfast.top/https://github.com/${REPO}.git"
      "https://kkgithub.com/${REPO}.git"
      "https://gitclone.com/github.com/${REPO}.git"
    )
    if [ "$_IS_CHINA" = "true" ]; then
      _GIT_MIRRORS=(
        "https://ghfast.top/https://github.com/${REPO}.git"
        "https://kkgithub.com/${REPO}.git"
        "https://gitclone.com/github.com/${REPO}.git"
        "https://github.com/${REPO}.git"
      )
    fi

    info "尝试 git clone..."
    for _mirror in "${_GIT_MIRRORS[@]}"; do
      printf "  尝试: %s ... " "${_mirror%%/u4399*}"
      if git clone --depth 1 "$_mirror" . 2>/dev/null; then
        echo "成功!"
        CODE_OBTAINED=true
        git remote set-url origin "https://github.com/${REPO}.git" 2>/dev/null || true
        break
      else
        echo "失败"
        rm -rf .git 2>/dev/null || true
      fi
    done

    [ "$CODE_OBTAINED" = "true" ] && ok "代码获取完成 (git clone)"
  fi

  # Method 2: Download tar.gz
  if [ "$CODE_OBTAINED" = "false" ]; then
    info "下载项目压缩包..."
    _ARCHIVE_MIRRORS=(
      "$ARCHIVE_URL"
      "https://ghfast.top/${ARCHIVE_URL}"
      "https://gh-proxy.com/${ARCHIVE_URL}"
    )
    _dl_ok=false
    for _mirror in "${_ARCHIVE_MIRRORS[@]}"; do
      printf "  尝试: %s ... " "${_mirror%%/https://github*}"
      if curl -fsSL --connect-timeout 15 --max-time 300 "$_mirror" -o /tmp/novel-admin.tar.gz 2>/dev/null; then
        _dl_ok=true; echo "成功!"; break
      else
        echo "失败"
      fi
    done

    if $_dl_ok && [ -s /tmp/novel-admin.tar.gz ]; then
      if tar xzf /tmp/novel-admin.tar.gz --strip-components=1 2>/dev/null; then
        CODE_OBTAINED=true
        ok "代码获取完成 (压缩包)"
      else
        warn "压缩包解压失败"
        rm -f /tmp/novel-admin.tar.gz
      fi
    fi
    rm -f /tmp/novel-admin.tar.gz 2>/dev/null || true
  fi

  # Method 3: Individual file download
  if [ "$CODE_OBTAINED" = "false" ]; then
    info "尝试逐文件下载关键部署文件..."
    _FILE_MIRRORS=("" "https://ghfast.top/" "https://gh-proxy.com/")
    _dl_count=0; _dl_total=0
    for f in Dockerfile docker-compose.yml docker-entrypoint.sh .env.docker .dockerignore; do
      _dl_total=$((_dl_total + 1))
      for _proxy in "${_FILE_MIRRORS[@]}"; do
        _url="${_proxy}${GIT_RAW}/${f}"
        if curl -fsSL --connect-timeout 10 --max-time 60 "$_url" -o "$f" 2>/dev/null; then
          _dl_count=$((_dl_count + 1)); break
        fi
      done
    done
    mkdir -p mini-services/scraper-service/src/scrape-rules backups
    if [ "$_dl_count" -ge 3 ]; then
      CODE_OBTAINED=true
      ok "关键文件下载完成 (${_dl_count}/${_dl_total})"
    fi
  fi

  if [ "$CODE_OBTAINED" = "false" ]; then
    fatal "无法获取项目代码！请手动下载: https://github.com/${REPO}/archive/refs/heads/main.zip"
  fi
fi

# ─── Step 3: Generate Secrets ─────────────────────────────
step 3 "生成安全密钥和密码"

generate_hex64() { openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | xxd -p -c 64; }
generate_password() { openssl rand -base64 16 2>/dev/null | tr -d '=/+' | head -c 16 || head -c 24 /dev/urandom | base64 | tr -d '=/+' | head -c 16; }

NEXTAUTH_SECRET=$(generate_hex64)
SCRAPER_SERVICE_TOKEN=$(generate_hex64)
ADMIN_PASSWORD=$(generate_password)
POSTGRES_PASSWORD=$(generate_hex64)

ok "密钥生成完成"
info "  ADMIN_PASSWORD: ${ADMIN_PASSWORD:0:4}****"

# ─── Step 4: Hardware Tier ────────────────────────────────
step 4 "检测硬件并选择配置档位"

_avail_kb=$(awk '/MemAvailable/{print $2}' /proc/meminfo 2>/dev/null || echo 2097152)
_avail_mb=$((_avail_kb / 1024))
_cpu_cores=$(nproc 2>/dev/null || echo 1)

if [ "$_avail_mb" -lt 1536 ]; then TIER="tiny"
elif [ "$_avail_mb" -lt 3072 ]; then TIER="small"
else TIER="normal"; fi

case "$TIER" in
  tiny)   N=384;B="50mb";PGL="128M";PGR="32M";PGS="32MB";PGW="2MB";PGM="16MB";PGE="64MB";PGC=10;PGWAL="16MB";PGWL="2MB";PGCPU="0.3";APPL="512M";APPR="128M";APPS="64m";APPCPU="0.7" ;;
  small)  N=512;B="100mb";PGL="192M";PGR="64M";PGS="64MB";PGW="4MB";PGM="32MB";PGE="128MB";PGC=20;PGWAL="32MB";PGWL="4MB";PGCPU="0.5";APPL="640M";APPR="256M";APPS="128m";APPCPU="0.8" ;;
  normal) N=1024;B="100mb";PGL="256M";PGR="64M";PGS="128MB";PGW="8MB";PGM="64MB";PGE="256MB";PGC=30;PGWAL="64MB";PGWL="8MB";PGCPU="1.0";APPL="1024M";APPR="256M";APPS="256m";APPCPU="1.0" ;;
esac

ok "档位: $TIER (${_avail_mb}MB / ${_cpu_cores}核)"

# ─── Step 5: Generate .env ────────────────────────────────
step 5 "生成 .env 配置文件"

mkdir -p backups

if [ -f ".env.docker" ]; then
  cp .env.docker .env
  sed -i "s|change-this-to-a-strong-db-password-16chars|${POSTGRES_PASSWORD}|g" .env
  sed -i "s|change-this-to-a-random-secret-min-32-chars|${NEXTAUTH_SECRET}|g" .env
  sed -i "s|change-this-to-a-strong-password|${ADMIN_PASSWORD}|g" .env
  sed -i "s|change-this-to-another-random-string-min-32|${SCRAPER_SERVICE_TOKEN}|g" .env
  [ -n "$CUSTOM_PORT" ] && sed -i "s|^APP_PORT=.*|APP_PORT=${CUSTOM_PORT}|" .env
  sed -i "s|^NODE_MAX_OLD_SPACE_SIZE=.*|NODE_MAX_OLD_SPACE_SIZE=${N}|" .env
  sed -i "s|^BUN_GC_THRESHOLD=.*|BUN_GC_THRESHOLD=${B}|" .env
  sed -i "s|^PG_MEMORY_LIMIT=.*|PG_MEMORY_LIMIT=${PGL}|" .env
  sed -i "s|^PG_MEMORY_RESERVATION=.*|PG_MEMORY_RESERVATION=${PGR}|" .env
  sed -i "s|^PG_SHARED_BUFFERS=.*|PG_SHARED_BUFFERS=${PGS}|" .env
  sed -i "s|^PG_WORK_MEM=.*|PG_WORK_MEM=${PGW}|" .env
  sed -i "s|^PG_MAINTENANCE_WORK_MEM=.*|PG_MAINTENANCE_WORK_MEM=${PGM}|" .env
  sed -i "s|^PG_EFFECTIVE_CACHE_SIZE=.*|PG_EFFECTIVE_CACHE_SIZE=${PGE}|" .env
  sed -i "s|^PG_MAX_CONNECTIONS=.*|PG_MAX_CONNECTIONS=${PGC}|" .env
  sed -i "s|^PG_MAX_WAL_SIZE=.*|PG_MAX_WAL_SIZE=${PGWAL}|" .env
  sed -i "s|^PG_MIN_WAL_SIZE=.*|PG_MIN_WAL_SIZE=${PGWL}|" .env
  sed -i "s|^PG_CPU_LIMIT=.*|PG_CPU_LIMIT=${PGCPU}|" .env
  sed -i "s|^APP_MEMORY_LIMIT=.*|APP_MEMORY_LIMIT=${APPL}|" .env
  sed -i "s|^APP_MEMORY_RESERVATION=.*|APP_MEMORY_RESERVATION=${APPR}|" .env
  sed -i "s|^APP_SHM_SIZE=.*|APP_SHM_SIZE=${APPS}|" .env
  sed -i "s|^APP_CPU_LIMIT=.*|APP_CPU_LIMIT=${APPCPU}|" .env
  ok ".env 已生成（档位: $TIER）"
else
  # Generate .env from scratch if no template
  _APP_PORT="${CUSTOM_PORT:-3000}"
  cat > .env << ENVEOF
# ============================================================
# 小说阁 - Docker 生产环境配置
# Auto-generated by install-docker.sh v6.0 on $(date '+%Y-%m-%d %H:%M:%S')
# Tier: $TIER | RAM: ${_avail_mb}MB | CPU: ${_cpu_cores}核
# ============================================================

POSTGRES_USER=novel
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_DB=novel_admin
DB_PORT=5432
APP_PORT=${_APP_PORT}
APP_NAME=小说管理系统
APP_URL=http://localhost:${_APP_PORT}
TZ=Asia/Shanghai
BACKUP_DIR=./backups
NEXTAUTH_SECRET=${NEXTAUTH_SECRET}
NEXTAUTH_URL=http://localhost:${_APP_PORT}
ADMIN_USERNAME=admin
ADMIN_PASSWORD=${ADMIN_PASSWORD}
SCRAPER_SERVICE_TOKEN=${SCRAPER_SERVICE_TOKEN}

NODE_MAX_OLD_SPACE_SIZE=${N}
BUN_GC_THRESHOLD=${B}
PG_MEMORY_LIMIT=${PGL}
PG_MEMORY_RESERVATION=${PGR}
PG_SHARED_BUFFERS=${PGS}
PG_WORK_MEM=${PGW}
PG_MAINTENANCE_WORK_MEM=${PGM}
PG_EFFECTIVE_CACHE_SIZE=${PGE}
PG_MAX_CONNECTIONS=${PGC}
PG_MAX_WAL_SIZE=${PGWAL}
PG_MIN_WAL_SIZE=${PGWL}
PG_CPU_LIMIT=${PGCPU}
APP_MEMORY_LIMIT=${APPL}
APP_MEMORY_RESERVATION=${APPR}
APP_SHM_SIZE=${APPS}
APP_CPU_LIMIT=${APPCPU}
ENVEOF
  ok ".env 已生成（从零创建，档位: $TIER）"
fi

# ─── Step 6: Docker Mirror (China) ────────────────────────
step 6 "配置 Docker 镜像加速"

if ! curl -s -m 5 https://www.google.com >/dev/null 2>&1; then
  _DAEMON_JSON="/etc/docker/daemon.json"
  _NEED_RESTART=false
  if [ ! -f "$_DAEMON_JSON" ] || [ ! -s "$_DAEMON_JSON" ]; then
    cat > /tmp/daemon.json << 'DAEMONJSON'
{
  "registry-mirrors": [
    "https://docker.1ms.run",
    "https://docker.xuanyuanhaiwai.com",
    "https://docker.m.daocloud.io"
  ]
}
DAEMONJSON
    if sudo cp /tmp/daemon.json "$_DAEMON_JSON" 2>/dev/null; then
      _NEED_RESTART=true
      ok "Docker 镜像加速已配置 (3个镜像源)"
    else
      warn "无法写入 daemon.json (需要 sudo 权限)"
    fi
    rm -f /tmp/daemon.json
  else
    ok "Docker 镜像加速已存在"
  fi
  if $_NEED_RESTART; then
    info "重启 Docker daemon..."
    sudo systemctl restart docker 2>/dev/null || sudo service docker restart 2>/dev/null || true
    sleep 3
    docker info >/dev/null 2>&1 || warn "Docker 重启后异常"
  fi
else
  ok "海外网络，跳过镜像加速"
fi

# ─── Step 7: Build & Start ────────────────────────────────
step 7 "构建并启动服务"

[ "$TIER" = "tiny" ] || [ "$TIER" = "small" ] && export DOCKER_BUILDKIT=0 || export DOCKER_BUILDKIT=1

info "构建镜像中...（首次约 5-10 分钟）"
echo ""

# Build with progress
if docker compose build 2>&1; then
  ok "镜像构建成功"
else
  warn "构建失败，清除缓存重试..."
  docker compose build --no-cache 2>&1 || {
    echo ""
    fatal "构建失败！请检查:
  1. 网络连接是否正常
  2. 磁盘空间是否充足 (df -h)
  3. 运行详细日志: docker compose build --progress=plain 2>&1 | tee build.log"
  }
fi

echo ""
info "启动服务..."
docker compose up -d 2>&1 || fatal "启动失败！"

# ─── Step 8: Wait for Healthy ─────────────────────────────
step 8 "等待服务就绪"

APP_PORT=$(grep '^APP_PORT=' .env 2>/dev/null | head -1 | cut -d= -f2)
APP_PORT=${APP_PORT:-3000}

WAITED=0
while [ $WAITED -lt 180 ]; do
  _status=$(docker inspect --format='{{.State.Health.Status}}' novel-manager 2>/dev/null || echo "starting")
  [ "$_status" = "healthy" ] && break
  printf "\r  等待中... %ds/180s (状态: %s)  " "$WAITED" "$_status"
  sleep 5
  WAITED=$((WAITED + 5))
done
echo ""

if [ "$_status" = "healthy" ]; then
  ok "服务已就绪！"
else
  warn "健康检查超时"
  info "查看日志: docker compose logs -f novel-manager"
  info "手动检查: curl -s http://localhost:${APP_PORT}/api/auth/csrf"
fi

# ─── Step 9: Post-start Health Checks ─────────────────────
step 9 "健康检查"

# Check each service
_SERVICES=(novel-manager novel-postgres)
for _svc in "${_SERVICES[@]}"; do
  _up=$(docker compose ps "$_svc" --format json 2>/dev/null | grep -o '"Running"' || echo "")
  if [ -n "$_up" ] || docker compose ps "$_svc" 2>/dev/null | grep -q "Up"; then
    ok "$_svc: running"
  else
    warn "$_svc: not running — check: docker compose logs $_svc"
  fi
done

# Quick endpoint check
sleep 5
if curl -s -m 10 "http://localhost:${APP_PORT}/api/auth/csrf" >/dev/null 2>&1; then
  ok "App endpoint: http://localhost:${APP_PORT} ✓"
else
  warn "App endpoint not responding yet — may still be initializing"
fi

# ─── Step 10: Result ──────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${GREEN}║${NC}  ${BOLD}✅ Docker 部署完成！${NC}                            ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}╠══════════════════════════════════════════════════╣${NC}"
echo -e "${BOLD}${GREEN}║${NC}  🌐 访问地址:  http://localhost:${APP_PORT}          ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}  👤 用户名:    admin                            ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}  🔑 密码:      ${ADMIN_PASSWORD}    ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${YELLOW}║${NC}  ⚠️  请立即保存以上密码！                       ${BOLD}${YELLOW}║${NC}"
echo -e "${BOLD}${GREEN}╠══════════════════════════════════════════════════╣${NC}"
echo -e "${BOLD}${GREEN}║${NC}  📋 服务架构:                                  ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}    App:       http://localhost:${APP_PORT}         ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}    Scraper:   http://localhost:3099 (内部)       ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}    PostgreSQL: 5432 (内部)                      ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}    档位:      $TIER ($_avail_mb MB)             ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}╠══════════════════════════════════════════════════╣${NC}"
echo -e "${BOLD}${GREEN}║${NC}  🔧 常用命令:                                  ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}    日志:  docker compose logs -f               ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}    停止:  docker compose stop                  ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}    重启:  docker compose restart               ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}    状态:  docker compose ps                    ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}    备份:  docker compose exec postgres          ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}          pg_dump -U novel novel_admin > bk.sql  ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""

# Save deploy info
cat > .deploy-info << EOF
# 部署时间: $(date '+%Y-%m-%d %H:%M:%S')
# 安装脚本: install-docker.sh v6.0
# 档位: $TIER | 内存: ${_avail_mb}MB | CPU: ${_cpu_cores}核
ADMIN_USERNAME=admin
ADMIN_PASSWORD=${ADMIN_PASSWORD}
APP_PORT=${APP_PORT}
NEXTAUTH_SECRET=${NEXTAUTH_SECRET}
SCRAPER_SERVICE_TOKEN=${SCRAPER_SERVICE_TOKEN}
EOF
chmod 600 .deploy-info

ok "部署信息已保存到 .deploy-info (权限 600)"
