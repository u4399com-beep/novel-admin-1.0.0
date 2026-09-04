#!/bin/bash
# ============================================================
# 📚 小说管理系统 — Docker 一键部署脚本 v3
# ============================================================
#
# 一键安装命令:
#   bash <(curl -fsSL https://raw.githubusercontent.com/u4399com-beep/novel-admin-1.0.0/main/quick-docker.sh)
#   # 国内加速:
#   bash <(curl -fsSL https://ghfast.top/https://raw.githubusercontent.com/u4399com-beep/novel-admin-1.0.0/main/quick-docker.sh)
#
# 本地: chmod +x quick-docker.sh && ./quick-docker.sh
# ============================================================

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()  { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
fatal() { echo -e "${RED}[FATAL]${NC} $*" >&2; exit 1; }
step()  { echo -e "\n${BOLD}${CYAN}━━━ Step $1 ━━━${NC} ${BOLD}$2${NC}\n"; }

AUTO_YES=false; CUSTOM_PORT=""; CUSTOM_DIR=""
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
echo -e "${BOLD}${CYAN}║${NC}  ${BOLD}📚 小说管理系统 — Docker 一键部署 v3${NC}           ${BOLD}${CYAN}║${NC}"
echo -e "${BOLD}${CYAN}║${NC}  9 引擎采集 · 反反爬 · 硬件自适应               ${BOLD}${CYAN}║${NC}"
echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════════════╝${NC}"
echo ""

# ─── Step 1: Docker 环境 ───
step 1 "检查 Docker 环境"
command -v docker >/dev/null 2>&1 || {
  info "Docker 未安装，正在自动安装..."
  curl -fsSL https://get.docker.com | sh 2>/dev/null || fatal "Docker 安装失败！"
  systemctl start docker 2>/dev/null || service start docker 2>/dev/null || true
  ok "Docker 安装完成"
}
if ! docker compose version >/dev/null 2>&1; then
  info "安装 Docker Compose 插件..."
  apt-get update -qq && apt-get install -y -qq docker-compose-plugin 2>/dev/null || \
    fatal "Docker Compose 安装失败！"
fi
docker info >/dev/null 2>&1 || fatal "Docker daemon 未运行！"
DOCKER_VER=$(docker --version 2>&1 | grep -oP 'Docker version \K[^,]+')
COMPOSE_VER=$(docker compose version --short 2>/dev/null || echo "unknown")
ok "Docker $DOCKER_VER + Compose $COMPOSE_VER"

# ─── Step 2: 获取代码 ───
step 2 "获取项目代码"
REPO="u4399com-beep/novel-admin-1.0.0"
GIT_RAW="https://raw.githubusercontent.com/${REPO}/main"
if [ -f "docker-compose.yml" ] && [ -f "Dockerfile" ]; then
  ok "项目文件已存在，跳过下载"
else
  INSTALL_DIR="${CUSTOM_DIR:-.}"; mkdir -p "$INSTALL_DIR"; cd "$INSTALL_DIR"
  if command -v git >/dev/null 2>&1; then
    info "git clone 获取代码..."
    git clone --depth 1 "https://github.com/${REPO}.git" . 2>/dev/null || \
    git clone --depth 1 "https://gitclone.com/github.com/${REPO}" . 2>/dev/null || \
    git clone --depth 1 "https://kkgithub.com/${REPO}" . 2>/dev/null || \
    fatal "git clone 失败！请检查网络"
    ok "代码获取完成"
  else
    info "git 不可用，下载必要文件..."
    for f in Dockerfile docker-compose.yml docker-entrypoint.sh .env.docker .dockerignore; do
      curl -fsSL "${GIT_RAW}/${f}" -o "$f" 2>/dev/null || \
      curl -fsSL "https://ghfast.top/${GIT_RAW}/${f}" -o "$f" 2>/dev/null || \
      warn "$f 下载失败"
    done
    mkdir -p mini-services/scraper-service/src/scrape-rules
    ok "关键文件下载完成"
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
[ -f .env.docker ] || fatal ".env.docker 模板不存在！"
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

# ─── Step 6: Docker 镜像加速 ───
step 6 "配置 Docker 镜像加速"
if ! curl -s -m 3 https://www.google.com >/dev/null 2>&1; then
  _DAEMON_JSON="/etc/docker/daemon.json"
  if [ ! -f "$_DAEMON_JSON" ] || [ ! -s "$_DAEMON_JSON" ]; then
    echo '{"registry-mirrors":["https://docker.1ms.run"]}' | sudo tee "$_DAEMON_JSON" >/dev/null 2>&1 || true
    sudo systemctl restart docker 2>/dev/null || true
    ok "Docker 镜像加速已配置"
  else
    ok "Docker 镜像加速已存在"
  fi
else
  ok "海外网络，跳过镜像加速"
fi

# ─── Step 7: 构建启动 ───
step 7 "构建并启动服务"
[ "$TIER" = "tiny" ] || [ "$TIER" = "small" ] && export DOCKER_BUILDKIT=0 || export DOCKER_BUILDKIT=1
info "构建镜像中...（首次约 5-10 分钟）"; echo ""
docker compose build 2>&1 || { warn "构建失败，清除缓存重试..."; docker compose build --no-cache 2>&1 || fatal "构建失败！"; }
echo ""; info "启动服务..."
docker compose up -d 2>&1 || fatal "启动失败！"

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
[ "$_status" = "healthy" ] && ok "服务已就绪！" || warn "健康检查超时，查看日志: docker compose logs -f novel-manager"

# ─── Step 9: 结果 ───
echo ""
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${GREEN}║${NC}  ${BOLD}✅ 部署完成！${NC}                                  ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}╠══════════════════════════════════════════════════╣${NC}"
echo -e "${BOLD}${GREEN}║${NC}  🌐 访问地址:  http://localhost:${APP_PORT}          ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}  👤 用户名:    admin                            ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}  🔑 密码:      ${ADMIN_PASSWORD}    ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${YELLOW}║${NC}  ⚠️  请立即保存以上密码！                       ${BOLD}${YELLOW}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}  📋 常用:                                      ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}    日志: docker compose logs -f                ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}    停止: docker compose stop                  ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}    重启: docker compose restart               ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""

cat > .deploy-info << EOF
# 部署时间: $(date '+%Y-%m-%d %H:%M:%S')
# 档位: $TIER | 内存: ${_avail_mb}MB | CPU: ${_cpu_cores}核
ADMIN_USERNAME=admin
ADMIN_PASSWORD=${ADMIN_PASSWORD}
APP_PORT=${APP_PORT}
EOF
ok "部署信息已保存到 .deploy-info"
