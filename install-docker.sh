#!/usr/bin/env bash
# ============================================================
# 小说阁 - Docker 一键安装脚本 v9.0
# Novel Admin Platform - Docker One-Click Installation
#
# Key v9 changes:
#   - HOST-LEVEL swap before build (more reliable than Docker-internal)
#   - SSH OOM protection (oom_score_adj=-1000) to prevent connection drops
#   - Swap+Build merged into single RUN in Dockerfile (v9)
#   - Turbopack disabled (Webpack uses less memory)
#   - proxy.ts instead of middleware.ts (Next.js 16 convention)
#   - .env.production fix (matchAll TypeError)
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
#   --calibrate     Run rate calibration after deploy
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
SKIP_ENV=false; CUSTOM_PORT=""; CUSTOM_DIR=""; AUTO_YES=false; NO_PULL=false; RUN_CALIBRATE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-env)  SKIP_ENV=true; shift ;;
    --port)      CUSTOM_PORT="${2:-}"; shift 2 ;;
    --dir)       CUSTOM_DIR="${2:-}"; shift 2 ;;
    -y|--yes)    AUTO_YES=true; shift ;;
    --no-pull)   NO_PULL=true; shift ;;
    --calibrate) RUN_CALIBRATE=true; shift ;;
    *) shift ;;
  esac
done

# ─── Banner ────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${CYAN}║${NC}  ${BOLD}📚 小说阁 — Docker 一键安装 v9.0${NC}              ${BOLD}${CYAN}║${NC}"
echo -e "${BOLD}${CYAN}║${NC}  容器化部署 · 反反爬增强 · 内容去重 · 管线监控 ${BOLD}${CYAN}║${NC}"
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
  # Try to pull latest code (ignore errors — may be offline or no git)
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    info "项目已存在，拉取最新代码..."
    git fetch --all 2>/dev/null || true
    git reset --hard origin/main 2>/dev/null || git pull --ff-only 2>/dev/null || info "git pull 失败，使用现有代码"
  else
    ok "项目文件已存在，跳过下载"
  fi
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
_total_kb=$(awk '/MemTotal/{print $2}' /proc/meminfo 2>/dev/null || echo 2097152)
_total_mb=$((_total_kb / 1024))

if [ "$_avail_mb" -lt 1536 ]; then TIER="tiny"
elif [ "$_avail_mb" -lt 3072 ]; then TIER="small"
else TIER="normal"; fi

case "$TIER" in
  tiny)   N=768;B="50mb";SWAP=1024;HOST_SWAP=2048;PGL="128M";PGR="32M";PGS="32MB";PGW="2MB";PGM="16MB";PGE="64MB";PGC=10;PGWAL="16MB";PGWL="2MB";PGCPU="0.3";APPL="768M";APPR="256M";APPS="64m";APPCPU="0.7" ;;
  small)  N=768;B="100mb";SWAP=512;HOST_SWAP=1024;PGL="192M";PGR="64M";PGS="64MB";PGW="4MB";PGM="32MB";PGE="128MB";PGC=20;PGWAL="32MB";PGWL="4MB";PGCPU="0.5";APPL="896M";APPR="256M";APPS="128m";APPCPU="0.8" ;;
  normal) N=1024;B="100mb";SWAP=0;HOST_SWAP=0;PGL="256M";PGR="64M";PGS="128MB";PGW="8MB";PGM="64MB";PGE="256MB";PGC=30;PGWAL="64MB";PGWL="8MB";PGCPU="1.0";APPL="1024M";APPR="256M";APPS="256m";APPCPU="1.0" ;;
esac

ok "档位: $TIER (可用${_avail_mb}MB / 总${_total_mb}MB / ${_cpu_cores}核)"

# ─── Step 5: Host Swap + SSH OOM Protection ──────────────
step 5 "内存保护（主机Swap + SSH防杀）"

# ── Host-level swap ──
# Docker build inherits host memory. Creating swap on the HOST ensures ALL
# processes (Docker daemon, build containers, SSH) have overflow capacity.
# This is MORE reliable than Docker-internal swap (which doesn't persist
# across RUN steps and may fail on overlay2 filesystem).
_HOST_SWAP_CREATED=false
if [ "$HOST_SWAP" -gt 0 ] 2>/dev/null; then
  # Check if swap already exists
  _current_swap_mb=$(awk '/SwapTotal/{print $2}' /proc/meminfo 2>/dev/null || echo 0)
  _current_swap_mb=$((_current_swap_mb / 1024))

  if [ "$_current_swap_mb" -gt 100 ]; then
    ok "主机已有 ${_current_swap_mb}MB swap，跳过创建"
  else
    info "创建 ${HOST_SWAP}MB 主机swap（防止构建OOM）..."
    # Find available path for swap file
    _SWAP_FILE=""
    for _sf in /swapfile /swap.img /var/swap.img; do
      if [ ! -f "$_sf" ]; then _SWAP_FILE="$_sf"; break; fi
    done

    if [ -n "$_SWAP_FILE" ]; then
      if fallocate -l "${HOST_SWAP}m" "$_SWAP_FILE" 2>/dev/null || \
         dd if=/dev/zero of="$_SWAP_FILE" bs=1M count=${HOST_SWAP} 2>/dev/null; then
        chmod 600 "$_SWAP_FILE" 2>/dev/null
        if mkswap "$_SWAP_FILE" 2>/dev/null && swapon "$_SWAP_FILE" 2>/dev/null; then
          ok "主机swap已启用 (${HOST_SWAP}MB at $_SWAP_FILE)"
          _HOST_SWAP_CREATED=true
          # Add to fstab for persistence across reboots
          if ! grep -q "$_SWAP_FILE" /etc/fstab 2>/dev/null; then
            echo "$_SWAP_FILE none swap sw 0 0" >> /etc/fstab 2>/dev/null || true
          fi
        else
          warn "swapon 失败（可能需要sudo或内核不支持）"
        fi
      else
        warn "swap文件创建失败（磁盘空间不足？）"
      fi
    else
      warn "未找到可用路径创建swap文件"
    fi
  fi
else
  ok "主机swap无需创建（档位: $TIER）"
fi

# ── SSH OOM protection ──
# On low-memory servers, the kernel OOM killer may kill SSH to free memory
# for the Docker build, causing "连接断开" (connection broken).
# Setting oom_score_adj=-1000 makes SSH nearly unkillable by OOM killer.
_SSH_PROTECTED=false
for _ssh_pid in $(pgrep -x sshd 2>/dev/null || true); do
  if [ -f "/proc/$_ssh_pid/oom_score_adj" ]; then
    if echo -1000 > "/proc/$_ssh_pid/oom_score_adj" 2>/dev/null; then
      _SSH_PROTECTED=true
    fi
  fi
done
# Also protect the SSH main listener process (parent of all sshd sessions)
_SSHD_MAIN_PID=$(cat /var/run/sshd.pid 2>/dev/null || true)
if [ -n "$_SSHD_MAIN_PID" ] && [ -f "/proc/$_SSHD_MAIN_PID/oom_score_adj" ]; then
  echo -1000 > "/proc/$_SSHD_MAIN_PID/oom_score_adj" 2>/dev/null && _SSH_PROTECTED=true
fi

if $_SSH_PROTECTED; then
  ok "SSH OOM保护已启用 (oom_score_adj=-1000，防止连接断开)"
else
  info "SSH OOM保护未启用（可能需要root权限，非root用户请使用sudo运行脚本）"
fi

# ── Memory diagnostics ──
info "当前内存状态:"
free -m 2>/dev/null || true

# ─── Step 6: Generate .env ────────────────────────────────
step 6 "生成 .env 配置文件"

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
  sed -i "s|^BUILD_SWAP_MB=.*|BUILD_SWAP_MB=${SWAP}|" .env
  ok ".env 已生成（档位: $TIER）"
else
  # Generate .env from scratch if no template
  _APP_PORT="${CUSTOM_PORT:-3000}"
  cat > .env << ENVEOF
# ============================================================
# 小说阁 - Docker 生产环境配置
# Auto-generated by install-docker.sh v9.0 on $(date '+%Y-%m-%d %H:%M:%S')
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
BUILD_SWAP_MB=${SWAP}
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

# ─── Pipeline Features (v8) ──────────────────────────────
CONTENT_DEDUP_ENABLED=true
PIPELINE_METRICS_ENABLED=true
ADAPTIVE_ENGINE_ENABLED=true
ENVEOF
  ok ".env 已生成（从零创建，档位: $TIER）"
fi

# ─── Step 7: Docker Mirror (China) ────────────────────────
step 7 "配置 Docker 镜像加速"

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

# ─── Step 8: Build & Start ────────────────────────────────
step 8 "构建并启动服务"

# Free Docker build cache before building (reclaim memory on low-mem servers)
info "清理Docker缓存（释放内存）..."
docker builder prune -f 2>/dev/null || true

[ "$TIER" = "tiny" ] || [ "$TIER" = "small" ] && export DOCKER_BUILDKIT=0 || export DOCKER_BUILDKIT=1

info "构建镜像中...（首次约 5-10 分钟）"
info "  构建模式: Webpack (Turbopack已禁用，节省内存)"
info "  Docker内Swap: ${SWAP}MB (与build同RUN步骤)"
info "  主机Swap: ${HOST_SWAP}MB (全局保护)"
echo ""

# Build with build args for swap and memory settings
_BUILD_ARGS="--build-arg BUILD_SWAP_MB=${SWAP} --build-arg NODE_MAX_OLD_SPACE_SIZE=${N}"

# IMPORTANT: Always use --no-cache for build to avoid stale layers
# from old Dockerfile versions (e.g., old 64-step Dockerfile with
# `bun run build` that uses Turbopack). Cached layers cause:
#   - Old .env.production (matchAll TypeError)
#   - Old middleware.ts (deprecation warning)
#   - Old build command (Turbopack panic on low-mem)
#   - Old swap logic (separate RUN steps — swap doesn't persist!)
info "使用 --no-cache 构建（确保使用最新Dockerfile v9）..."

# Build with --no-cache always to avoid stale layer issues
if docker compose build --no-cache ${_BUILD_ARGS} 2>&1; then
  ok "镜像构建成功"
else
  warn "构建失败，清理Docker缓存后重试..."
  # Prune builder cache to free memory before retry
  docker builder prune -f 2>/dev/null || true
  docker system prune -f 2>/dev/null || true
  sleep 3
  info "内存状态:"
  free -m 2>/dev/null || true
  if docker compose build --no-cache ${_BUILD_ARGS} 2>&1; then
    ok "镜像构建成功（第二次尝试）"
  else
    echo ""
    fatal "构建失败！请检查:
  1. 服务器内存是否充足 (free -h, 建议至少1.5GB + swap)
  2. 磁盘空间是否充足 (df -h, 建议至少5GB)
  3. SSH连接是否稳定 (如果断开，确保以root运行脚本启用OOM保护)
  4. 运行详细日志: docker compose build --progress=plain --no-cache ${_BUILD_ARGS} 2>&1 | tee build.log"
  fi
fi

echo ""
info "启动服务..."
docker compose up -d 2>&1 || fatal "启动失败！"

# ─── Step 9: Wait for Healthy ─────────────────────────────
step 9 "等待服务就绪"

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

# ─── Step 10: Post-start Health Checks (v9) ─────────────────
step 10 "健康检查 + 管线特性验证"

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

# Pipeline Metrics health check
info "Pipeline features (v9):"
_SCRAPER_HEALTH=$(curl -s -m 5 "http://localhost:3099/health" 2>/dev/null || echo "not reachable")
if [ "$_SCRAPER_HEALTH" != "not reachable" ]; then
  ok "Scraper service healthy — pipeline-metrics, content-dedup, adaptive-engine available"
else
  warn "Scraper service not reachable for pipeline health check"
fi

# Rate calibration check
if [ -f "mini-services/scraper-service/src/scrape-rules/rate-calibration.json" ]; then
  ok "Rate calibration data found"
else
  info "No rate calibration data — run with --calibrate to generate"
fi

# ─── Step 11: Result ──────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${GREEN}║${NC}  ${BOLD}✅ Docker 部署完成！${NC}                            ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}╠══════════════════════════════════════════════════╣${NC}"
echo -e "${BOLD}${GREEN}║${NC}  🌐 访问地址:  http://localhost:${APP_PORT}          ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}  👤 用户名:    admin                            ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}  🔑 密码:      ${ADMIN_PASSWORD}    ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${YELLOW}║${NC}  ⚠️  请立即保存以上密码！                       ${BOLD}${YELLOW}║${NC}"
echo -e "${BOLD}${GREEN}╠══════════════════════════════════════════════════╣${NC}"
echo -e "${BOLD}${GREEN}║${NC}  📋 服务架构 (v9):                             ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}    App:       http://localhost:${APP_PORT}         ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}    Scraper:   http://localhost:3099 (内部)       ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}    Pipeline:  /pipeline-metrics (管线监控)       ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}    PostgreSQL: 5432 (内部)                      ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}    档位:      $TIER (${_avail_mb}MB可用 + ${HOST_SWAP}MB swap)${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}╠══════════════════════════════════════════════════╣${NC}"
echo -e "${BOLD}${GREEN}║${NC}  🔧 常用命令:                                  ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}    日志:  docker compose logs -f               ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}    停止:  docker compose stop                  ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}    重启:  docker compose restart               ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}    状态:  docker compose ps                    ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}    标定:  bash install-docker.sh --calibrate   ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}    备份:  docker compose exec postgres          ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}          pg_dump -U novel novel_admin > bk.sql  ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""

# Save deploy info
cat > .deploy-info << EOF
# 部署时间: $(date '+%Y-%m-%d %H:%M:%S')
# 安装脚本: install-docker.sh v9.0
# 档位: $TIER | 可用内存: ${_avail_mb}MB | 总内存: ${_total_mb}MB | CPU: ${_cpu_cores}核
# 主机Swap: ${HOST_SWAP}MB | Docker内Swap: ${SWAP}MB
ADMIN_USERNAME=admin
ADMIN_PASSWORD=${ADMIN_PASSWORD}
APP_PORT=${APP_PORT}
NEXTAUTH_SECRET=${NEXTAUTH_SECRET}
SCRAPER_SERVICE_TOKEN=${SCRAPER_SERVICE_TOKEN}
EOF
chmod 600 .deploy-info

ok "部署信息已保存到 .deploy-info (权限 600)"
