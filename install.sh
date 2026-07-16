#!/usr/bin/env bash
# ╔═══════════════════════════════════════════════════════════════╗
# ║  📚 小说管理系统 — Docker 一键安装脚本                      ║
# ║  Novel Admin — One-Click Docker Installer                   ║
# ║                                                             ║
# ║  一键安装:                                                   ║
# ║    curl -fsSL https://raw.githubusercontent.com/              ║
# ║      u4399com-beep/novel-admin-1.0.0/main/install.sh | bash  ║
# ║                                                             ║
# ║  非交互(默认值):  ... | bash -s -- -y                       ║
# ║  自定义目录:     ... | bash -s -- -d /data/novel-admin      ║
# ║  卸载:           /opt/novel-admin/install.sh --uninstall     ║
# ╚═══════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── 常量 ──────────────────────────────────────────────────────
REPO="u4399com-beep/novel-admin-1.0.0"
GIT_URL="https://github.com/${REPO}.git"
ARCHIVE_URL="https://github.com/${REPO}/archive/refs/heads/main.tar.gz"
RAW_URL="https://raw.githubusercontent.com/${REPO}/main"
INSTALL_DIR="/opt/novel-admin"

# GitHub 加速代理
GIT_PROXIES=(
    "https://ghfast.top/https://github.com"
    "https://mirror.ghproxy.com/https://github.com"
    "https://gh-proxy.com/https://github.com"
)
RAW_PROXIES=(
    "https://ghfast.top"
    "https://mirror.ghproxy.com"
)

# Docker Hub 国内镜像
MIRRORS=(
    "https://docker.1ms.run"
    "https://docker.xuanyuan.me"
    "https://docker.m.daocloud.io"
    "https://docker.nju.edu.cn"
    "https://hub.rat.dev"
    "https://docker.chenby.cn"
    "https://docker.mirrors.ustc.edu.cn"
)

# ── 参数解析 ──────────────────────────────────────────────────
AUTO_YES=false
DO_UNINSTALL=false

for arg in "$@"; do
    case "$arg" in
        -y|--yes)    AUTO_YES=true ;;
        --uninstall) DO_UNINSTALL=true ;;
        -d)          shift; INSTALL_DIR="${1:-/opt/novel-admin}" ;;
        -h|--help)   sed -n '2,/^ ╚/p' "$0" | sed 's/^ ║  \?//'; exit 0 ;;
    esac
done

# ── 颜色 ──────────────────────────────────────────────────────
if [ -t 1 ]; then
    R='\033[0;31m' G='\033[0;32m' Y='\033[1;33m'
    B='\033[0;34m' C='\033[0;36m' P='\033[0;35m'
    BD='\033[1m'    DM='\033[2m'    N='\033[0m'
else
    R= G= Y= B= C= P= BD= DM= N=
fi

info()  { echo -e "${B}[INFO]${N} $*"; }
ok()    { echo -e "${G}  ✓${N} $*"; }
warn()  { echo -e "${Y}[WARN]${N} $*"; }
err()   { echo -e "${R}[ERROR]${N} $*" >&2; }
step()  { echo -e "\n${P}${BD}▶ $*${N}"; }
die()   { err "$*"; exit 1; }

ask() {
    if $AUTO_YES; then echo "${2:-}"; return; fi
    if [ -n "${2:-}" ]; then
        read -rp "$1 [${DM}${2}${N}]: " _r; echo "${_r:-$2}"
    else
        read -rp "$1: " _r; echo "$_r"
    fi
}

ask_y() {
    if $AUTO_YES; then return 0; fi
    read -rp "$1 (Y/n): " _a
    [ -z "${_a:-}" ] || [[ "$_a" =~ ^[Yy] ]]
}

rand_hex() {
    if command -v openssl &>/dev/null; then
        openssl rand -hex "${1:-32}" 2>/dev/null && return
    fi
    tr -dc 'a-f0-9' </dev/urandom | head -c "$(( ${1:-32} * 2 ))"; echo
}

rand_pass() {
    if command -v openssl &>/dev/null; then
        openssl rand -base64 12 2>/dev/null | tr -d '=/+' | head -c 14 && echo && return
    fi
    tr -dc 'A-Za-z0-9!@#%' </dev/urandom | head -c 14; echo
}

my_ip() {
    _ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    [[ "$_ip" != 127.* && -n "$_ip" ]] && { echo "$_ip"; return; }
    for s in ifconfig.me ip.sb; do
        _ip=$(curl -sf --connect-timeout 3 "https://$s" 2>/dev/null) && \
        [[ "$_ip" =~ ^[0-9.]+$ ]] && { echo "$_ip"; return; }
    done
    echo "YOUR_SERVER_IP"
}

# ── 卸载模式 ──────────────────────────────────────────────────
if $DO_UNINSTALL; then
    [ ! -d "$INSTALL_DIR" ] && [ -d "/opt/novel-admin" ] && INSTALL_DIR="/opt/novel-admin"
    [ ! -f "${INSTALL_DIR}/docker-compose.yml" ] && die "未找到安装: ${INSTALL_DIR}"
    echo ""
    warn "将删除: ${INSTALL_DIR} + Docker容器 + 数据库数据(永久)!"
    ask_y "确认卸载？" || { echo "已取消"; exit 0; }
    cd "$INSTALL_DIR"
    docker compose down -v --rmi local 2>/dev/null || true
    cd /; rm -rf "$INSTALL_DIR"
    ok "已卸载"
    exit 0
fi

# ── Banner ────────────────────────────────────────────────────
[ -t 1 ] && clear 2>/dev/null || true
echo ""
echo -e "${C}${BD}╔═══════════════════════════════════════════╗${N}"
echo -e "${C}${BD}║   📚 小说管理系统 · Docker 一键安装      ║${N}"
echo -e "${C}${BD}║   ${DM}${REPO}${N}"
echo -e "${C}${BD}╚═══════════════════════════════════════════╝${N}"
echo ""

# ═══════════════════════════════════════════════════════════════
#  [1/7] Docker 环境
# ═══════════════════════════════════════════════════════════════
step "[1/7] Docker 环境"

if ! command -v docker &>/dev/null; then
    ask_y "Docker 未安装，自动安装？" || die "手动安装: curl -fsSL https://get.docker.com | sh"
    info "安装 Docker（可能需要几分钟）..."
    if command -v apt-get &>/dev/null; then
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -qq >/dev/null 2>&1
        apt-get install -y -qq ca-certificates curl gnupg lsb-release >/dev/null 2>&1
        _os=$(. /etc/os-release 2>/dev/null && echo "$ID")
        _ver=$(. /etc/os-release 2>/dev/null && echo "$VERSION_CODENAME")
        mkdir -p /etc/apt/keyrings
        curl -fsSL "https://download.docker.com/linux/${_os:-debian}/gpg" 2>/dev/null | \
            gpg --dearmor -o /etc/apt/keyrings/docker.gpg 2>/dev/null || true
        chmod a+r /etc/apt/keyrings/docker.gpg 2>/dev/null || true
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/${_os:-debian} ${_ver:-stable} stable" \
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
        die "不支持的系统，手动安装: curl -fsSL https://get.docker.com | sh"
    fi
    systemctl enable --now docker 2>/dev/null || service docker start 2>/dev/null || true
    sleep 2
    ok "Docker 已安装"
fi

_dv=$(docker version --format '{{.Server.Version}}' 2>/dev/null | head -1)
ok "Docker ${_dv:-ok}"

# Docker Compose
if docker compose version &>/dev/null; then
    COMPOSE_CMD="docker compose"
elif command -v docker-compose &>/dev/null; then
    COMPOSE_CMD="docker-compose"
else
    die "未找到 Docker Compose，请重装 Docker"
fi

docker info &>/dev/null || { systemctl start docker 2>/dev/null || service docker start 2>/dev/null; sleep 3; docker info &>/dev/null || die "Docker 启动失败"; }
ok "Docker 运行中"

# ═══════════════════════════════════════════════════════════════
#  [2/7] 镜像加速
# ═══════════════════════════════════════════════════════════════
step "[2/7] 镜像加速"

if curl -sf --connect-timeout 5 "https://registry-1.docker.io/v2/" &>/dev/null; then
    ok "Docker Hub 直连正常"
else
    warn "Docker Hub 不可达，配置国内镜像..."
    [ -f /etc/docker/daemon.json ] && cp /etc/docker/daemon.json "/etc/docker/daemon.json.bak.$(date +%s)"
    _mj='['; _mf=""
    for _m in "${MIRRORS[@]}"; do _mj="${_mj}${_mf}\"${_m}\""; _mf=","; done; _mj="${_mj}]"
    mkdir -p /etc/docker
    echo "{\"registry-mirrors\":${_mj}}" > /etc/docker/daemon.json
    systemctl daemon-reload 2>/dev/null; systemctl restart docker 2>/dev/null || service docker restart 2>/dev/null || true
    sleep 3
    if docker info 2>/dev/null | grep -q "Registry Mirrors"; then
        ok "镜像加速已配置 (${#MIRRORS[@]} 个源)"
    else
        warn "已写入配置，Docker 可能未加载。手动检查: docker info | grep -A5 Mirror"
    fi
fi

# ═══════════════════════════════════════════════════════════════
#  [3/7] 磁盘
# ═══════════════════════════════════════════════════════════════
step "[3/7] 磁盘检查"
_gb=$(df -BG "$(dirname "$INSTALL_DIR")" 2>/dev/null | awk 'NR==2{print $4}' | tr -d 'G')
_gb=${_gb:-0}
[ "$_gb" -lt 5 ] && die "磁盘不足: ${_gb}GB (需 5GB+)"
ok "可用 ${_gb}GB"

# ═══════════════════════════════════════════════════════════════
#  [4/7] 获取代码
# ═══════════════════════════════════════════════════════════════
step "[4/7] 获取项目"

_got=false

# 已安装 → 更新
if [ -d "${INSTALL_DIR}/.git" ]; then
    cd "$INSTALL_DIR"
    if ask_y "已有安装(${INSTALL_DIR})，更新？"; then
        if git pull --ff-only 2>&1; then ok "已更新"; else warn "pull 失败，用现有代码"; fi
    fi
    _got=true
fi

if ! $_got; then
    # 如果目录存在但不是 git
    if [ -d "$INSTALL_DIR" ]; then
        ask_y "${INSTALL_DIR} 已存在，删除重建？" || die "请手动处理 ${INSTALL_DIR}"
        rm -rf "$INSTALL_DIR"
    fi

    # 策略1: git 直连
    if command -v git &>/dev/null; then
        info "git clone (直连)..."
        git clone --depth 1 "$GIT_URL" "$INSTALL_DIR" 2>&1 && _got=true
    fi

    # 策略2: git 代理
    if ! $_got && command -v git &>/dev/null; then
        for _px in "${GIT_PROXIES[@]}"; do
            info "git clone (代理: ${_px%%/*})..."
            if git clone --depth 1 "${_px}/${REPO}.git" "$INSTALL_DIR" 2>&1; then
                cd "$INSTALL_DIR" && git remote set-url origin "$GIT_URL" 2>/dev/null || true
                _got=true; break
            fi
        done
    fi

    # 策略3: curl 下载
    if ! $_got; then
        info "下载 tar.gz..."
        for _u in "$ARCHIVE_URL" "${RAW_PROXIES[0]}/${ARCHIVE_URL}" "${RAW_PROXIES[1]}/${ARCHIVE_URL}"; do
            info "  ${_u%%\?*}..."
            if curl -fsSL --connect-timeout 15 --max-time 120 "$_u" -o /tmp/novel.tar.gz 2>/dev/null; then
                mkdir -p /tmp/novel-tmp && rm -rf /tmp/novel-tmp/*
                if tar xzf /tmp/novel.tar.gz -C /tmp/novel-tmp 2>/dev/null; then
                    _ed=$(find /tmp/novel-tmp -maxdepth 1 -type d -name "novel-admin*" | head -1)
                    if [ -n "$_ed" ]; then
                        mkdir -p "$INSTALL_DIR" && cp -a "$_ed/." "$INSTALL_DIR/"
                        _got=true
                    fi
                fi
                rm -rf /tmp/novel.tar.gz /tmp/novel-tmp
                $_got && break
            fi
        done
    fi

    $_got || die "获取代码失败！请检查网络或手动: ${GIT_URL}"
fi

cd "$INSTALL_DIR"

# 验证
for _f in Dockerfile docker-compose.yml docker-entrypoint.sh .env.production; do
    [ -f "$_f" ] || die "缺少文件: $_f (仓库不完整)"
done
ok "代码就绪"

# ═══════════════════════════════════════════════════════════════
#  [5/7] 配置
# ═══════════════════════════════════════════════════════════════
step "[5/7] 生成配置"

NEED_ENV=true
if [ -f .env ]; then
    source .env 2>/dev/null || true
    if $AUTO_YES || ! ask_y ".env 已存在(端口=${APP_PORT:-3000}, 用户=${ADMIN_USERNAME:-admin})，重新配置？"; then
        info "保留现有 .env"; NEED_ENV=false
    else
        cp .env ".env.bak.$(date +%Y%m%d_%H%M%S)"
        ok "已备份旧 .env"
    fi
fi

if $NEED_ENV; then
    _dbpw=$(rand_hex 16)
    _secret=$(rand_hex 32)
    _token=$(rand_hex 32)
    _apw=$(rand_pass 14)

    $AUTO_YES || { echo ""; info "配置参数（回车=默认）:"; echo ""; }

    # 端口
    _port=$(ask "  端口" "3000")
    [[ "$_port" =~ ^[0-9]+$ ]] && [ "$_port" -ge 1 ] && [ "$_port" -le 65535 ] || _port=3000
    if ss -tlnp 2>/dev/null | grep -q ":${_port} " || lsof -i :"$_port" &>/dev/null; then
        warn "端口 ${_port} 被占用"
        _port=$(ask "  换个端口" "$((_port+1))")
    fi

    _user=$(ask "  管理员用户名" "admin")
    _pass=$(ask "  管理员密码" "$_apw")
    [ -z "$_pass" ] && _pass="$_apw"
    _addr=$(ask "  服务器IP/域名" "$(my_ip)")
    [[ "$_addr" =~ ^https?:// ]] && _url="$_addr" || _url="http://${_addr}:${_port}"
    _tz=$(ask "  时区" "Asia/Shanghai")

    cat > .env <<EOF
# Novel Admin - Generated $(date '+%Y-%m-%d %H:%M:%S') by install.sh
# ⚠️ Contains secrets - do not commit to git

POSTGRES_USER=novel
POSTGRES_PASSWORD=${_dbpw}
POSTGRES_DB=novel_admin
DB_PORT=5432

APP_PORT=${_port}
APP_NAME=小说管理系统
APP_URL=${_url}
TZ=${_tz}

NEXTAUTH_SECRET=${_secret}
NEXTAUTH_URL=${_url}

ADMIN_USERNAME=${_user}
ADMIN_PASSWORD=${_pass}

SCRAPER_SERVICE_TOKEN=${_token}

# Optional external services (uncomment to enable):
# FIRECRAWL_API_KEY=
# AGENTQL_API_KEY=
# BROWSERLESS_API_KEY=
# STEEL_API_KEY=
EOF
    chmod 600 .env
    ok ".env 已生成"

    SAVE_USER="$_user"; SAVE_PASS="$_pass"; SAVE_URL="$_url"; SAVE_PORT="$_port"
else
    source .env 2>/dev/null || true
    SAVE_USER="${ADMIN_USERNAME:-admin}"; SAVE_PASS="${ADMIN_PASSWORD}"; SAVE_URL="${APP_URL:-http://localhost:${APP_PORT:-3000}}"; SAVE_PORT="${APP_PORT:-3000}"
fi

# ═══════════════════════════════════════════════════════════════
#  [6/7] 构建 + 启动
# ═══════════════════════════════════════════════════════════════
step "[6/7] 构建并启动"
info "首次构建约 5-10 分钟，请耐心等待..."
echo ""

T0=$(date +%s)
set +e
$COMPOSE_CMD build 2>&1 | tee /tmp/novel-build.log | while IFS= read -r _l; do
    echo "$_l" | grep -qiE '(^Step |=> (RUN|COPY|FROM)|ERROR|fail|successfully tag)' && echo "  $_l"
done
RC=${PIPESTATUS[0]}
set -e
DT=$(( $(date +%s) - T0 ))
echo ""

[ $RC -ne 0 ] && die "
构建失败！(${DT}s)
常见原因:
  1. 网络 — Docker Hub/npm/bun registry 不可达
  2. 内存 — 需要至少 2GB 可用
  3. 磁盘 — 需要至少 5GB 可用
排查: cat /tmp/novel-build.log
重试: cd ${INSTALL_DIR} && $COMPOSE_CMD build --no-cache"

ok "构建完成 (${DT}s)"

echo ""
set +e
$COMPOSE_CMD up -d 2>&1
RC=$?
set -e
[ $RC -ne 0 ] && die "启动失败！端口 ${SAVE_PORT} 可能被占用，改 .env 中 APP_PORT 后重试"
ok "容器已启动"

# ═══════════════════════════════════════════════════════════════
#  [7/7] 健康检查
# ═══════════════════════════════════════════════════════════════
step "[7/7] 健康检查"
echo ""

ELAPSED=0; MAX=180; OK=false
while [ $ELAPSED -lt $MAX ]; do
    if ! $COMPOSE_CMD ps 2>/dev/null | grep -qE 'Up|healthy|running'; then
        echo ""; err "容器异常退出！"; $COMPOSE_CMD logs --tail=30 2>&1; exit 1
    fi
    if curl -sf --connect-timeout 2 "http://localhost:${SAVE_PORT}/api/auth/csrf" &>/dev/null; then
        OK=true; break
    fi
    _pct=$(( ELAPSED * 100 / MAX )); _f=$(( _pct * 30 / 100 )); _e=$(( 30 - _f ))
    _bar=$(printf '%*s' "$_f" | tr ' ' '█')$(printf '%*s' "$_e" | tr ' ' '░')
    printf "\r  [%s] %3d%% " "$_bar" "$_pct" >&2
    sleep 3; ELAPSED=$((ELAPSED+3))
done
echo ""

# 保存凭据
cat > "${INSTALL_DIR}/.credentials.txt" <<EOF
===========================================
  小说管理系统 — 登录凭据
  $(date '+%Y-%m-%d %H:%M:%S')
===========================================
访问:  ${SAVE_URL}
用户:  ${SAVE_USER}
密码:  ${SAVE_PASS}
⚠️ 妥善保管，建议保存后删除此文件。
EOF
chmod 600 "${INSTALL_DIR}/.credentials.txt"

# 结果
echo ""
if $OK; then
    echo -e "${G}${BD}╔═════════════════════════════════════════╗${N}"
    echo -e "${G}${BD}║         ✅ 安装成功！系统已就绪          ║${N}"
    echo -e "${G}${BD}╚═════════════════════════════════════════╝${N}"
    echo ""
    echo -e "  🌐  ${BD}地址:${N}  ${C}${SAVE_URL}${N}"
    echo -e "  👤  ${BD}用户:${N}  ${BD}${SAVE_USER}${N}"
    echo -e "  🔑  ${BD}密码:${N}  ${BD}${SAVE_PASS}${N}"
    echo ""
    echo -e "  📋  ${BD}常用命令:${N}"
    echo -e "    日志:  ${C}cd ${INSTALL_DIR} && ${COMPOSE_CMD} logs -f${N}"
    echo -e "    停止:  ${C}cd ${INSTALL_DIR} && ${COMPOSE_CMD} stop${N}"
    echo -e "    重启:  ${C}cd ${INSTALL_DIR} && ${COMPOSE_CMD} restart${N}"
    echo -e "    状态:  ${C}cd ${INSTALL_DIR} && ${COMPOSE_CMD} ps${N}"
    echo -e "    备份:  ${C}cd ${INSTALL_DIR} && ${COMPOSE_CMD} exec -T postgres pg_dump -U novel novel_admin > backup.sql${N}"
    echo ""
    echo -e "  🔄  ${BD}升级:${N}  ${C}cd ${INSTALL_DIR} && git pull && ${COMPOSE_CMD} up -d --build${N}"
    echo -e "  🗑️  ${BD}卸载:${N}  ${C}${INSTALL_DIR}/install.sh --uninstall${N}"
    echo ""
    echo -e "  ${Y}${BD}⚠️ 请保存以上信息！凭据: ${INSTALL_DIR}/.credentials.txt${N}"
else
    echo -e "${Y}⏳ 健康检查超时，但服务可能仍在启动。${N}"
    echo -e "  检查: ${C}cd ${INSTALL_DIR} && ${COMPOSE_CMD} ps${N}"
    echo -e "  日志: ${C}cd ${INSTALL_DIR} && ${COMPOSE_CMD} logs -f${N}"
fi
echo ""

rm -f /tmp/novel-build.log 2>/dev/null