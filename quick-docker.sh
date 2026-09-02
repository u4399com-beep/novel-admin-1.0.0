#!/bin/bash
# ============================================================
# 小说管理系统 - Docker 一键部署脚本（快速版）
# ============================================================
#
# 适用场景：已安装 Docker 和 Docker Compose 的服务器
# 与 deploy.sh 的区别：本脚本不安装 Docker，不配置防火墙，
#   不创建 swap，专注于快速构建和启动。
#
# 用法：chmod +x quick-docker.sh && ./quick-docker.sh
# ============================================================

set -euo pipefail

# ─── 颜色输出 ──────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'  # No Color

info()  { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
fatal() { echo -e "${RED}[FATAL]${NC} $*" >&2; exit 1; }

# ─── Step 1: 检查 Docker 环境 ────────────────────────────────
info "检查 Docker 环境..."

command -v docker >/dev/null 2>&1 || fatal "Docker 未安装！请先运行: curl -fsSL https://get.docker.com | sh"
command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 || \
    fatal "Docker Compose 未安装！请安装: apt-get install docker-compose-plugin"

# 检查 Docker daemon 是否运行
docker info >/dev/null 2>&1 || fatal "Docker daemon 未运行！请执行: systemctl start docker"

ok "Docker $(docker --version | grep -oP 'Docker version \K[^,]+')"
ok "Docker Compose $(docker compose version --short 2>/dev/null || docker compose version 2>&1 | head -1)"

# ─── Step 2: 检查必要文件 ────────────────────────────────────
info "检查项目文件..."

[ -f docker-compose.yml ] || fatal "docker-compose.yml 不存在"
[ -f Dockerfile ]        || fatal "Dockerfile 不存在"
[ -f .env.docker ]       || fatal ".env.docker 模板不存在"

ok "项目文件完整"

# ─── Step 3: 生成安全密钥 ────────────────────────────────────
info "生成安全密钥和密码..."

# 生成 64 字符十六进制随机字符串
generate_hex64() {
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex 32
    else
        head -c 64 /dev/urandom | xxd -p -c 64
    fi
}

# 生成 12 字符随机密码（URL 安全）
generate_password() {
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -base64 12 | tr -d '=/+' | head -c 16
    else
        head -c 16 /dev/urandom | base64 | tr -d '=/+' | head -c 16
    fi
}

NEXTAUTH_SECRET=$(generate_hex64)
SCRAPER_SERVICE_TOKEN=$(generate_hex64)
ADMIN_PASSWORD=$(generate_password)
POSTGRES_PASSWORD=$(generate_hex64)

ok "密钥生成完成"

# ─── Step 4: 检测内存并选择硬件档位 ─────────────────────────
info "检测服务器硬件..."

# 获取可用内存（KB）
if [ -f /proc/meminfo ]; then
    _avail_kb=$(awk '/MemAvailable/{print $2}' /proc/meminfo 2>/dev/null || \
                 awk '/MemTotal/{print $2}' /proc/meminfo)
else
    # macOS 或其他系统
    _avail_kb=$(sysctl -n hw.memsize 2>/dev/null | awk '{print int($1/1024)}' || echo 2097152)
fi
_avail_mb=$((_avail_kb / 1024))

if [ "$_avail_mb" -lt 1536 ]; then
    TIER="tiny"
    warn "内存 ${_avail_mb}MB — 使用 tiny 档（最低配置）"
elif [ "$_avail_mb" -lt 3072 ]; then
    TIER="small"
    info "内存 ${_avail_mb}MB — 使用 small 档"
else
    TIER="normal"
    ok "内存 ${_avail_mb}MB — 使用 normal 档"
fi

# 设置档位参数
set_tier_vars() {
    case "$TIER" in
        tiny)
            NODE_MAX_OLD_SPACE_SIZE=384; BUN_GC_THRESHOLD="50mb"
            PG_MEMORY_LIMIT="128M"; PG_MEMORY_RESERVATION="32M"
            PG_SHARED_BUFFERS="32MB"; PG_WORK_MEM="2MB"; PG_MAINTENANCE_WORK_MEM="16MB"
            PG_EFFECTIVE_CACHE_SIZE="64MB"; PG_MAX_CONNECTIONS=10
            PG_MAX_WAL_SIZE="16MB"; PG_MIN_WAL_SIZE="2MB"; PG_CPU_LIMIT="0.3"
            APP_MEMORY_LIMIT="512M"; APP_MEMORY_RESERVATION="128M"
            APP_SHM_SIZE="64m"; APP_CPU_LIMIT="0.7"
            ;;
        small)
            NODE_MAX_OLD_SPACE_SIZE=512; BUN_GC_THRESHOLD="100mb"
            PG_MEMORY_LIMIT="192M"; PG_MEMORY_RESERVATION="64M"
            PG_SHARED_BUFFERS="64MB"; PG_WORK_MEM="4MB"; PG_MAINTENANCE_WORK_MEM="32MB"
            PG_EFFECTIVE_CACHE_SIZE="128MB"; PG_MAX_CONNECTIONS=20
            PG_MAX_WAL_SIZE="32MB"; PG_MIN_WAL_SIZE="4MB"; PG_CPU_LIMIT="0.5"
            APP_MEMORY_LIMIT="640M"; APP_MEMORY_RESERVATION="256M"
            APP_SHM_SIZE="128m"; APP_CPU_LIMIT="0.8"
            ;;
        normal)
            NODE_MAX_OLD_SPACE_SIZE=1024; BUN_GC_THRESHOLD="100mb"
            PG_MEMORY_LIMIT="256M"; PG_MEMORY_RESERVATION="64M"
            PG_SHARED_BUFFERS="128MB"; PG_WORK_MEM="8MB"; PG_MAINTENANCE_WORK_MEM="64MB"
            PG_EFFECTIVE_CACHE_SIZE="256MB"; PG_MAX_CONNECTIONS=30
            PG_MAX_WAL_SIZE="64MB"; PG_MIN_WAL_SIZE="8MB"; PG_CPU_LIMIT="1.0"
            APP_MEMORY_LIMIT="1024M"; APP_MEMORY_RESERVATION="256M"
            APP_SHM_SIZE="256m"; APP_CPU_LIMIT="1.0"
            ;;
    esac
}

set_tier_vars
ok "档位: $TIER"

# ─── Step 5: 生成 .env 文件 ──────────────────────────────────
info "生成 .env 配置文件..."

# 创建备份目录
mkdir -p backups

# 从模板生成 .env，替换占位符和资源限制参数
cp .env.docker .env

# 替换安全密钥
sed -i "s|change-this-to-a-strong-db-password-16chars|${POSTGRES_PASSWORD}|g" .env
sed -i "s|change-this-to-a-random-secret-min-32-chars|${NEXTAUTH_SECRET}|g" .env
sed -i "s|change-this-to-a-strong-password|${ADMIN_PASSWORD}|g" .env
sed -i "s|change-this-to-another-random-string-min-32|${SCRAPER_SERVICE_TOKEN}|g" .env

# 替换资源限制参数（替换默认的 normal 档值）
sed -i "s|^NODE_MAX_OLD_SPACE_SIZE=.*|NODE_MAX_OLD_SPACE_SIZE=${NODE_MAX_OLD_SPACE_SIZE}|" .env
sed -i "s|^BUN_GC_THRESHOLD=.*|BUN_GC_THRESHOLD=${BUN_GC_THRESHOLD}|" .env
sed -i "s|^PG_MEMORY_LIMIT=.*|PG_MEMORY_LIMIT=${PG_MEMORY_LIMIT}|" .env
sed -i "s|^PG_MEMORY_RESERVATION=.*|PG_MEMORY_RESERVATION=${PG_MEMORY_RESERVATION}|" .env
sed -i "s|^PG_SHARED_BUFFERS=.*|PG_SHARED_BUFFERS=${PG_SHARED_BUFFERS}|" .env
sed -i "s|^PG_WORK_MEM=.*|PG_WORK_MEM=${PG_WORK_MEM}|" .env
sed -i "s|^PG_MAINTENANCE_WORK_MEM=.*|PG_MAINTENANCE_WORK_MEM=${PG_MAINTENANCE_WORK_MEM}|" .env
sed -i "s|^PG_EFFECTIVE_CACHE_SIZE=.*|PG_EFFECTIVE_CACHE_SIZE=${PG_EFFECTIVE_CACHE_SIZE}|" .env
sed -i "s|^PG_MAX_CONNECTIONS=.*|PG_MAX_CONNECTIONS=${PG_MAX_CONNECTIONS}|" .env
sed -i "s|^PG_MAX_WAL_SIZE=.*|PG_MAX_WAL_SIZE=${PG_MAX_WAL_SIZE}|" .env
sed -i "s|^PG_MIN_WAL_SIZE=.*|PG_MIN_WAL_SIZE=${PG_MIN_WAL_SIZE}|" .env
sed -i "s|^PG_CPU_LIMIT=.*|PG_CPU_LIMIT=${PG_CPU_LIMIT}|" .env
sed -i "s|^APP_MEMORY_LIMIT=.*|APP_MEMORY_LIMIT=${APP_MEMORY_LIMIT}|" .env
sed -i "s|^APP_MEMORY_RESERVATION=.*|APP_MEMORY_RESERVATION=${APP_MEMORY_RESERVATION}|" .env
sed -i "s|^APP_SHM_SIZE=.*|APP_SHM_SIZE=${APP_SHM_SIZE}|" .env
sed -i "s|^APP_CPU_LIMIT=.*|APP_CPU_LIMIT=${APP_CPU_LIMIT}|" .env

# 验证没有遗留的 change-this
if rg -q 'change-this' .env 2>/dev/null; then
    warn ".env 中仍有 change-this 占位符，请手动检查"
fi

ok ".env 已生成（档位: $TIER）"

# ─── Step 6: 构建并启动 ──────────────────────────────────────
info "构建 Docker 镜像（首次约 5-10 分钟）..."
echo ""

# tiny/small 档位禁用 BuildKit 减少内存占用
export DOCKER_BUILDKIT=0
if [ "$TIER" = "tiny" ] || [ "$TIER" = "small" ]; then
    export DOCKER_BUILDKIT=0
    info "已禁用 BuildKit（低内存优化）"
else
    export DOCKER_BUILDKIT=1
fi

docker compose build 2>&1 || fatal "构建失败！查看上方错误信息"

echo ""
info "启动服务..."
docker compose up -d 2>&1 || fatal "启动失败！查看上方错误信息"

# ─── Step 7: 等待健康检查 ────────────────────────────────────
info "等待服务启动（健康检查最多 180 秒）..."
echo ""

APP_PORT=$(grep '^APP_PORT=' .env | head -1 | cut -d= -f2)
APP_PORT=${APP_PORT:-3000}

MAX_WAIT=180
WAITED=0
while [ $WAITED -lt $MAX_WAIT ]; do
    # 检查容器是否还在运行
    if ! docker compose ps --format '{{.Name}} {{.Status}}' 2>/dev/null | grep -q 'novel-manager'; then
        echo ""
        fatal "novel-manager 容器已退出！查看日志: docker compose logs novel-manager"
    fi
    
    # 检查健康状态
    _status=$(docker inspect --format='{{.State.Health.Status}}' novel-manager 2>/dev/null || echo "starting")
    if [ "$_status" = "healthy" ]; then
        break
    fi
    
    printf "\r  等待中... %ds/%ds (状态: %s)" "$WAITED" "$MAX_WAIT" "$_status"
    sleep 5
    WAITED=$((WAITED + 5))
done
echo ""

if [ "$_status" != "healthy" ]; then
    warn "健康检查超时，但容器可能仍在启动中"
    warn "查看日志: docker compose logs -f novel-manager"
fi

# ─── Step 8: 显示结果 ────────────────────────────────────────
echo ""
echo "=========================================="
echo -e "  ${GREEN}✓ 部署完成！${NC}"
echo "=========================================="
echo ""
echo "  访问地址:  http://localhost:${APP_PORT}"
echo "              (远程访问请把 localhost 换成服务器 IP)"
echo ""
echo "  用户名:    admin"
echo "  密码:      ${ADMIN_PASSWORD}"
echo ""
echo -e "  ${YELLOW}⚠️  请立即保存以上密码！${NC}"
echo ""
echo "  常用命令:"
echo "    查看日志:  docker compose logs -f"
echo "    停止服务:  docker compose stop"
echo "    重启服务:  docker compose restart"
echo "    查看状态:  docker compose ps"
echo ""
echo "  修改密码:  编辑 .env 中的 ADMIN_PASSWORD，然后 docker compose up -d"
echo "=========================================="

# 保存密码到文件
echo "# 部署时间: $(date '+%Y-%m-%d %H:%M:%S')" > .deploy-info
echo "# 档位: $TIER" >> .deploy-info
echo "ADMIN_USERNAME=admin" >> .deploy-info
echo "ADMIN_PASSWORD=${ADMIN_PASSWORD}" >> .deploy-info
echo "APP_PORT=${APP_PORT}" >> .deploy-info
echo "" >> .deploy-info
echo "密码已保存到 .deploy-info" >> .deploy-info
ok "密码已保存到 .deploy-info（请妥善保管，建议删除此文件）"
