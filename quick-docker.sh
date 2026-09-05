#!/bin/bash
# ============================================================
# 📚 小说管理系统 — Docker 一键部署脚本 v7
# ============================================================
#
# 一键安装命令 (海外):
#   bash <(curl -fsSL https://raw.githubusercontent.com/u4399com-beep/novel-admin-1.0.0/main/quick-docker.sh)
#
# 国内一行安装 (推荐，自动加速):
#   bash <(curl -fsSL https://ghfast.top/https://raw.githubusercontent.com/u4399com-beep/novel-admin-1.0.0/main/quick-docker.sh)
#
# 国内备选加速:
#   bash <(curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/u4399com-beep/novel-admin-1.0.0/main/quick-docker.sh)
#   bash <(curl -fsSL https://mirror.ghproxy.com/https://raw.githubusercontent.com/u4399com-beep/novel-admin-1.0.0/main/quick-docker.sh)
#
# 本地: chmod +x quick-docker.sh && ./quick-docker.sh
#
# Options:
#   -y/--yes    Auto-accept all prompts
#   -p/--port   Custom port (default: 3000)
#   -d/--dir    Custom install directory
# ============================================================

set -euo pipefail

# ─── Colors & Helpers ─────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()      { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
fatal()   { echo -e "${RED}[FATAL]${NC} $*" >&2; exit 1; }
step()    { echo -e "\n${BOLD}${CYAN}━━━ Step $1 ━━━${NC} ${BOLD}$2${NC}\n"; }
progress(){ printf "  %-50s " "$1"; }
progress_ok(){ echo -e "${GREEN}✓${NC}"; }
progress_fail(){ echo -e "${RED}✗${NC}"; }

# Spinner for long operations
run_with_spinner() {
  local msg="$1"; shift
  "$@" &>/dev/null &
  local pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    for s in ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏; do
      printf "\r  %s %s" "$s" "$msg"
      sleep 0.08
    done
  done
  wait "$pid"
  printf "\r  %s %s\n" "✓" "$msg"
}

# ─── Parse Options ─────────────────────────────────────────
AUTO_YES=false; CUSTOM_PORT=""; CUSTOM_DIR=""; NO_CALIBRATE=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    -y|--yes) AUTO_YES=true; shift ;;
    -p|--port) CUSTOM_PORT="${2:-}"; shift 2 ;;
    -d|--dir) CUSTOM_DIR="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done

echo ""
echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${CYAN}║${NC}  ${BOLD}📚 小说管理系统 — Docker 一键部署 v7${NC}           ${BOLD}${CYAN}║${NC}"
echo -e "${BOLD}${CYAN}║${NC}  9引擎 · 反反爬增强 · 内容去重 · 管线监控               ${BOLD}${CYAN}║${NC}"
echo -e "${BOLD}${CYAN}║${NC}  国内加速 · 多重回退 · 自动健康检查             ${BOLD}${CYAN}║${NC}"
echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════════════╝${NC}"
echo ""

# ─── Step 1: Docker 环境 ───
step 1 "检查 Docker 环境"

progress "Docker 命令"
if command -v docker >/dev/null 2>&1; then
  progress_ok
else
  progress_fail
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

progress "Docker Compose"
if docker compose version >/dev/null 2>&1; then
  progress_ok
else
  progress_fail
  info "安装 Docker Compose 插件..."
  apt-get update -qq && apt-get install -y -qq docker-compose-plugin 2>/dev/null || \
    fatal "Docker Compose 安装失败！"
fi

progress "Docker daemon"
if docker info >/dev/null 2>&1; then
  progress_ok
else
  progress_fail
  fatal "Docker daemon 未运行！启动: sudo systemctl start docker"
fi

DOCKER_VER=$(docker --version 2>&1 | grep -oP 'Docker version \K[^,]+' || echo "unknown")
COMPOSE_VER=$(docker compose version --short 2>/dev/null || echo "unknown")
ok "Docker $DOCKER_VER + Compose $COMPOSE_VER"

# ─── Step 2: 获取代码 ───
step 2 "获取项目代码"
REPO="u4399com-beep/novel-admin-1.0.0"
GIT_RAW="https://raw.githubusercontent.com/${REPO}/main"
ARCHIVE_URL="https://github.com/${REPO}/archive/refs/heads/main.tar.gz"
CODE_OBTAINED=false

if [ -f "docker-compose.yml" ] && [ -f "Dockerfile" ]; then
  ok "项目文件已存在，跳过下载"
  CODE_OBTAINED=true
fi

if [ "$CODE_OBTAINED" = "false" ]; then
  INSTALL_DIR="${CUSTOM_DIR:-.}"; mkdir -p "$INSTALL_DIR"; cd "$INSTALL_DIR"

  _IS_CHINA=false
  if ! curl -s -m 5 https://www.google.com >/dev/null 2>&1; then
    _IS_CHINA=true
    info "检测到国内网络环境，优先使用镜像加速"
  fi

  # Method 1: git clone
  if [ "$CODE_OBTAINED" = "false" ] && command -v git >/dev/null 2>&1; then
    _GIT_MIRRORS=(
      "https://github.com/${REPO}.git"
      "https://ghfast.top/https://github.com/${REPO}.git"
      "https://kkgithub.com/${REPO}.git"
      "https://gitclone.com/github.com/${REPO}.git"
      "https://hub.fastgit.xyz/${REPO}.git"
      "https://github.com.cnpmjs.org/${REPO}.git"
    )

    if [ "$_IS_CHINA" = "true" ]; then
      _GIT_MIRRORS=(
        "https://ghfast.top/https://github.com/${REPO}.git"
        "https://kkgithub.com/${REPO}.git"
        "https://gitclone.com/github.com/${REPO}.git"
        "https://github.com.cnpmjs.org/${REPO}.git"
        "https://hub.fastgit.xyz/${REPO}.git"
        "https://github.com/${REPO}.git"
      )
    fi

    info "尝试 git clone 获取代码..."
    for _mirror in "${_GIT_MIRRORS[@]}"; do
      _mirror_name="${_mirror%%/u4399*}"
      _mirror_name="${_mirror_name%/}"
      printf "  尝试: %s ... " "$_mirror_name"
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

  # Method 2: tar.gz
  if [ "$CODE_OBTAINED" = "false" ]; then
    info "下载项目压缩包..."
    _ARCHIVE_MIRRORS=(
      "$ARCHIVE_URL"
      "https://ghfast.top/${ARCHIVE_URL}"
      "https://gh-proxy.com/${ARCHIVE_URL}"
      "https://mirror.ghproxy.com/${ARCHIVE_URL}"
      "https://gh.idayer.com/${ARCHIVE_URL}"
    )

    _dl_ok=false
    for _mirror in "${_ARCHIVE_MIRRORS[@]}"; do
      _mirror_name="${_mirror%%/https://github*}"
      _mirror_name="${_mirror_name%/}"
      printf "  尝试: %s ... " "${_mirror_name:-direct}"
      if command -v curl >/dev/null 2>&1; then
        if curl -fsSL --connect-timeout 15 --max-time 300 "$_mirror" -o /tmp/novel-admin.tar.gz 2>/dev/null; then
          _dl_ok=true; echo "成功!"; break
        else
          echo "失败"
        fi
      elif command -v wget >/dev/null 2>&1; then
        if wget -q --timeout=300 -O /tmp/novel-admin.tar.gz "$_mirror" 2>/dev/null; then
          _dl_ok=true; echo "成功!"; break
        else
          echo "失败"
        fi
      fi
    done

    if $_dl_ok && [ -s /tmp/novel-admin.tar.gz ]; then
      if tar xzf /tmp/novel-admin.tar.gz --strip-components=1 2>/dev/null; then
        CODE_OBTAINED=true
        ok "代码获取完成 (压缩包)"
      else
        warn "压缩包解压失败，文件可能已损坏"
        rm -f /tmp/novel-admin.tar.gz
      fi
    fi
    rm -f /tmp/novel-admin.tar.gz 2>/dev/null || true
  fi

  # Method 3: 逐文件下载
  if [ "$CODE_OBTAINED" = "false" ]; then
    info "尝试逐文件下载关键部署文件..."
    _FILE_MIRRORS=("" "https://ghfast.top/" "https://gh-proxy.com/" "https://mirror.ghproxy.com/")
    _dl_count=0; _dl_total=0
    for f in Dockerfile docker-compose.yml docker-entrypoint.sh .env.docker .dockerignore pack.sh; do
      _dl_total=$((_dl_total + 1))
      for _proxy in "${_FILE_MIRRORS[@]}"; do
        _url="${_proxy}${GIT_RAW}/${f}"
        if command -v curl >/dev/null 2>&1; then
          curl -fsSL --connect-timeout 10 --max-time 60 "$_url" -o "$f" 2>/dev/null && _dl_count=$((_dl_count + 1)) && break
        elif command -v wget >/dev/null 2>&1; then
          wget -q --timeout=60 -O "$f" "$_url" 2>/dev/null && _dl_count=$((_dl_count + 1)) && break
        fi
      done
    done
    mkdir -p mini-services/scraper-service/src/scrape-rules backups

    if [ "$_dl_count" -ge 4 ]; then
      CODE_OBTAINED=true
      ok "关键文件下载完成 (${_dl_count}/${_dl_total})"
    else
      warn "仅下载 ${_dl_count}/${_dl_total} 个文件"
    fi
  fi

  if [ "$CODE_OBTAINED" = "false" ]; then
    echo ""
    fatal "无法获取项目代码！请尝试以下方法之一：

  方法1: 手动下载压缩包
    浏览器打开: https://github.com/${REPO}/archive/refs/heads/main.zip
    解压后运行: bash quick-docker.sh

  方法2: 配置 git 代理
    git config --global http.proxy socks5://127.0.0.1:1080
    git clone https://github.com/${REPO}.git && cd novel-admin-1.0.0 && bash quick-docker.sh

  方法3: 离线部署
    在有网络的机器上运行: bash pack.sh
    将生成的 .tar.gz 传到服务器，解压后运行: bash deploy.sh"
  fi
fi

# ─── Step 3: 生成密钥 ───
step 3 "生成安全密钥和密码"
generate_hex64() { openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | xxd -p -c 64; }
generate_password() { openssl rand -base64 16 2>/dev/null | tr -d '=/+' | head -c 16 || head -c 24 /dev/urandom | base64 | tr -d '=/+' | head -c 16; }
NEXTAUTH_SECRET=$(generate_hex64)
SCRAPER_SERVICE_TOKEN=$(generate_hex64)
ADMIN_PASSWORD=$(generate_password)
POSTGRES_PASSWORD=$(generate_hex64)
ok "密钥生成完成"
info "  ADMIN_PASSWORD: ${ADMIN_PASSWORD:0:4}****"

# ─── Step 4: 硬件档位 ───
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

# ─── Step 5: 生成 .env ───
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
  # Fallback: generate from scratch
  _APP_PORT="${CUSTOM_PORT:-3000}"
  cat > .env << ENVEOF
# Auto-generated by quick-docker.sh v7 on $(date '+%Y-%m-%d %H:%M:%S')
# Tier: $TIER | RAM: ${_avail_mb}MB | CPU: ${_cpu_cores}核
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

# ─── Pipeline Features (v7) ──────────────────────────────
CONTENT_DEDUP_ENABLED=true
PIPELINE_METRICS_ENABLED=true
ADAPTIVE_ENGINE_ENABLED=true
ENVEOF
  ok ".env 已生成（从零创建，档位: $TIER）"
fi

# ─── Step 6: Docker 镜像加速 ───
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
    docker info >/dev/null 2>&1 || warn "Docker 重启后异常，请检查: systemctl status docker"
  fi
else
  ok "海外网络，跳过镜像加速"
fi

# ─── Step 7: 构建启动 ───
step 7 "构建并启动服务"
[ "$TIER" = "tiny" ] || [ "$TIER" = "small" ] && export DOCKER_BUILDKIT=0 || export DOCKER_BUILDKIT=1

if ! curl -s -m 5 https://www.google.com >/dev/null 2>&1; then
  info "国内环境: Dockerfile 已内置阿里云镜像源"
fi

info "构建镜像中...（首次约 5-10 分钟，国内可能稍长）"
echo ""

# Build with retry and auto-recovery
_BUILD_OK=false
for _build_attempt in 1 2; do
  if [ "$_build_attempt" = "1" ]; then
    if docker compose build 2>&1; then
      _BUILD_OK=true
      break
    fi
  else
    warn "构建失败(第1次)，清除缓存重试(第2次)..."
    # Auto-recovery: clean up and retry
    docker system prune -f 2>/dev/null || true
    if docker compose build --no-cache 2>&1; then
      _BUILD_OK=true
      break
    fi
  fi
done

if ! $_BUILD_OK; then
  fatal "构建失败！请检查:
  1. 网络连接: curl -I https://registry.npmmirror.com
  2. 磁盘空间: df -h (需要 10GB+ 可用)
  3. Docker 状态: docker info
  4. 详细日志: docker compose build --progress=plain 2>&1 | tee build.log"
fi

echo ""
info "启动服务..."
docker compose up -d 2>&1 || {
  # Auto-recovery: check for port conflict
  _APP_PORT=$(grep '^APP_PORT=' .env 2>/dev/null | head -1 | cut -d= -f2)
  _APP_PORT=${_APP_PORT:-3000}
  if ss -tlnp 2>/dev/null | grep -q ":${_APP_PORT} "; then
    warn "端口 ${_APP_PORT} 被占用，尝试使用 ${_APP_PORT}1..."
    sed -i "s|^APP_PORT=.*|APP_PORT=${_APP_PORT}1|" .env
    docker compose up -d 2>&1 || fatal "启动失败！"
  else
    fatal "启动失败！检查: docker compose logs"
  fi
}

# ─── Step 8: 等待就绪 ───
step 8 "等待服务就绪"
APP_PORT=$(grep '^APP_PORT=' .env 2>/dev/null | head -1 | cut -d= -f2); APP_PORT=${APP_PORT:-3000}
WAITED=0
while [ $WAITED -lt 180 ]; do
  _status=$(docker inspect --format='{{.State.Health.Status}}' novel-manager 2>/dev/null || echo "starting")
  [ "$_status" = "healthy" ] && break
  printf "\r  等待中... %ds/180s (状态: %s)  " "$WAITED" "$_status"
  sleep 5; WAITED=$((WAITED + 5))
done; echo ""

if [ "$_status" = "healthy" ]; then
  ok "服务已就绪！"
else
  warn "健康检查超时"
  info "这可能是因为首次启动较慢，尝试手动验证:"
  info "  curl -s http://localhost:${APP_PORT}/api/auth/csrf"
  info "  docker compose logs -f novel-manager"
fi

# ─── Step 9: 服务健康检查 ───
step 9 "服务状态验证"

# Check each container
_CONTAINERS=(novel-manager novel-postgres)
for _c in "${_CONTAINERS[@]}"; do
  progress "$_c"
  _c_status=$(docker inspect --format='{{.State.Status}}' "$_c" 2>/dev/null || echo "missing")
  if [ "$_c_status" = "running" ]; then
    progress_ok
  else
    progress_fail
    warn "  $_c 状态: $_c_status"
  fi
done

# Quick endpoint check
sleep 3
progress "API endpoint :${APP_PORT}"
if curl -s -m 10 "http://localhost:${APP_PORT}/api/auth/csrf" >/dev/null 2>&1; then
  progress_ok
else
  progress_fail
  warn "  端点未响应，可能仍在初始化"
fi

# ─── Step 10: 结果 ───
echo ""
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${GREEN}║${NC}  ${BOLD}✅ 部署完成！${NC}                                  ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}╠══════════════════════════════════════════════════╣${NC}"
echo -e "${BOLD}${GREEN}║${NC}  🌐 访问地址:  http://localhost:${APP_PORT}          ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}  👤 用户名:    admin                            ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}  🔑 密码:      ${ADMIN_PASSWORD}    ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${YELLOW}║${NC}  ⚠️  请立即保存以上密码！                       ${BOLD}${YELLOW}║${NC}"
echo -e "${BOLD}${GREEN}╠══════════════════════════════════════════════════╣${NC}"
echo -e "${BOLD}${GREEN}║${NC}  📋 常用:                                      ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}    日志: docker compose logs -f                ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}    停止: docker compose stop                  ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}    重启: docker compose restart               ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}    状态: docker compose ps                    ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}    备份: docker compose exec postgres          ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}          pg_dump -U novel novel_admin > bk.sql  ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""

cat > .deploy-info << EOF
# 部署时间: $(date '+%Y-%m-%d %H:%M:%S')
# 脚本版本: quick-docker.sh v7
# 档位: $TIER | 内存: ${_avail_mb}MB | CPU: ${_cpu_cores}核
ADMIN_USERNAME=admin
ADMIN_PASSWORD=${ADMIN_PASSWORD}
APP_PORT=${APP_PORT}
NEXTAUTH_SECRET=${NEXTAUTH_SECRET}
SCRAPER_SERVICE_TOKEN=${SCRAPER_SERVICE_TOKEN}
EOF
chmod 600 .deploy-info

ok "部署信息已保存到 .deploy-info (权限 600)"
