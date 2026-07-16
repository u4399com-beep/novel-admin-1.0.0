#!/usr/bin/env bash
# ╔═══════════════════════════════════════════════════════════════════╗
# ║  📚 小说管理系统 — 生产环境一键部署脚本                         ║
# ║  Novel Admin — Production Deployment Script                      ║
# ║                                                                 ║
# ║  支持场景:                                                       ║
# ║    • tar.gz 压缩包解压后直接运行 (离线部署)                      ║
# ║    • git clone 后运行 (在线部署)                                  ║
# ║    • curl | bash 远程安装                                        ║
# ║                                                                 ║
# ║  兼容系统:                                                       ║
# ║    Debian/Ubuntu · CentOS/RHEL/Rocky/Alma · Alpine · Amazon Linux║
# ║                                                                 ║
# ║  用法:                                                          ║
# ║    chmod +x deploy.sh && ./deploy.sh             交互式安装       ║
# ║    ./deploy.sh -y                              全部默认值         ║
# ║    ./deploy.sh -d /data/novel-admin             自定义目录        ║
# ║    ./deploy.sh --uninstall                      卸载              ║
# ║    ./deploy.sh --upgrade                        升级              ║
# ║    ./deploy.sh --backup                         备份数据库        ║
# ║    ./deploy.sh --rollback                       回滚到上一版本    ║
# ╚═══════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ═══════════════════════════════════════════════════════════════
#  CONSTANTS
# ═══════════════════════════════════════════════════════════════
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="u4399com-beep/novel-admin-1.0.0"
GIT_URL="https://github.com/${REPO}.git"
ARCHIVE_URL="https://github.com/${REPO}/archive/refs/heads/main.tar.gz"
GIT_PROXIES=(
    "https://ghfast.top/https://github.com"
    "https://mirror.ghproxy.com/https://github.com"
    "https://gh-proxy.com/https://github.com"
)
RAW_PROXIES=("https://ghfast.top" "https://mirror.ghproxy.com")
DOCKER_MIRRORS=(
    "https://docker.1ms.run" "https://docker.xuanyuan.me"
    "https://docker.m.daocloud.io" "https://docker.nju.edu.cn"
    "https://hub.rat.dev" "https://docker.chenby.cn"
    "https://docker.mirrors.ustc.edu.cn"
)
REQUIRED_FILES=(Dockerfile docker-compose.yml docker-entrypoint.sh .env.production)
LOG_FILE="/tmp/novel-deploy-$(date +%Y%m%d_%H%M%S).log"

# ═══════════════════════════════════════════════════════════════
#  PARSE ARGUMENTS
# ═══════════════════════════════════════════════════════════════
MODE="install"; AUTO_YES=false; INSTALL_DIR="/opt/novel-admin"
for arg in "$@"; do
    case "$arg" in
        -y|--yes)      AUTO_YES=true ;;
        -d)            shift; INSTALL_DIR="${1:-/opt/novel-admin}" ;;
        --uninstall)   MODE="uninstall" ;;
        --upgrade)     MODE="upgrade" ;;
        --backup)      MODE="backup" ;;
        --rollback)    MODE="rollback" ;;
        --status)      MODE="status" ;;
        -h|--help)
            sed -n '2,/^ ╚/p' "$0" | sed 's/^ ║  \?//'; exit 0 ;;
        *)             echo "Unknown: $arg"; exit 1 ;;
    esac
done

# ═══════════════════════════════════════════════════════════════
#  LOGGING — all output goes to both terminal and log file
# ═══════════════════════════════════════════════════════════════
exec > >(tee -a "$LOG_FILE" 2>/dev/null) 2>&1

if [ -t 1 ]; then
    R='\033[0;31m' G='\033[0;32m' Y='\033[1;33m'
    B='\033[0;34m' C='\033[0;36m' P='\033[0;35m'
    BD='\033[1m' DM='\033[2m' N='\033[0m'
else R= G= Y= B= C= P= BD= DM= N=; fi

info()  { echo -e "${B}[INFO]${N} $*"; }
ok()    { echo -e "${G}  ✓${N} $*"; }
warn()  { echo -e "${Y}[WARN]${N} $*"; }
err()   { echo -e "${R}[ERROR]${N} $*"; }
step()  { echo -e "\n${P}${BD}▶ $*${N}"; }
die()   { err "$*"; echo "  完整日志: ${LOG_FILE}"; exit 1; }

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
        openssl rand -hex "${1:-32}" 2>/dev/null && return; fi
    tr -dc 'a-f0-9' </dev/urandom | head -c "$(( ${1:-32} * 2 ))"; echo
}
rand_pass() {
    if command -v openssl &>/dev/null; then
        openssl rand -base64 12 2>/dev/null | tr -d '=/+' | head -c 14 && echo && return; fi
    tr -dc 'A-Za-z0-9!@#%' </dev/urandom | head -c 14; echo
}
my_ip() {
    _ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    [[ "$_ip" != 127.* && -n "$_ip" ]] && { echo "$_ip"; return; }
    for s in ifconfig.me ip.sb ipinfo.io/ip; do
        _ip=$(curl -sf --connect-timeout 3 "https://$s" 2>/dev/null) && \
        [[ "$_ip" =~ ^[0-9.]+$ ]] && { echo "$_ip"; return; }
    done
    echo "YOUR_SERVER_IP"
}

# Detect package manager
PKG_MGR=""
if command -v apt-get &>/dev/null; then PKG_MGR="apt"
elif command -v dnf &>/dev/null; then PKG_MGR="dnf"
elif command -v yum &>/dev/null; then PKG_MGR="yum"
elif command -v apk &>/dev/null; then PKG_MGR="apk"
fi

# Install packages (auto-detect manager)
pkg_install() {
    for pkg in "$@"; do
        command -v "$pkg" &>/dev/null && continue
        info "安装 ${pkg}..."
        case "$PKG_MGR" in
            apt)  export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq "$pkg" >/dev/null 2>&1 ;;
            dnf)  dnf install -y -q "$pkg" >/dev/null 2>&1 ;;
            yum)  yum install -y -q "$pkg" >/dev/null 2>&1 ;;
            apk)  apk add --no-cache "$pkg" >/dev/null 2>&1 ;;
            *)    return 1 ;;
        esac
    done
}

# Install Docker via package manager (must be defined before first call for curl|bash compat)
_install_docker_pkg() {
    case "$PKG_MGR" in
        apt)
            export DEBIAN_FRONTEND=noninteractive
            apt-get update -qq >/dev/null 2>&1
            apt-get install -y -qq ca-certificates curl gnupg lsb-release >/dev/null 2>&1
            _os_id=$(. /etc/os-release 2>/dev/null && echo "$ID")
            _os_ver=$(. /etc/os-release 2>/dev/null && echo "$VERSION_CODENAME")
            mkdir -p /etc/apt/keyrings
            curl -fsSL "https://download.docker.com/linux/${_os_id:-debian}/gpg" 2>/dev/null | \
                gpg --dearmor -o /etc/apt/keyrings/docker.gpg 2>/dev/null || true
            chmod a+r /etc/apt/keyrings/docker.gpg 2>/dev/null || true
            echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/${_os_id:-debian} ${_os_ver:-stable} stable" \
                > /etc/apt/sources.list.d/docker.list 2>/dev/null || true
            apt-get update -qq >/dev/null 2>&1
            apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null 2>&1
            ;;
        dnf|yum)
            ${PKG_MGR} install -y -q yum-utils >/dev/null 2>&1
            ${PKG_MGR}-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo >/dev/null 2>&1
            ${PKG_MGR} install -y -q docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null 2>&1
            ;;
        apk)
            apk add --no-cache docker docker-compose docker-cli-compose >/dev/null 2>&1
            ;;
        *) die "不支持的系统，手动安装: curl -fsSL https://get.docker.com | sh" ;;
    esac
    systemctl enable --now docker 2>/dev/null || service docker start 2>/dev/null || true
    sleep 2
}

# ═══════════════════════════════════════════════════════════════
#  MODE: STATUS
# ═══════════════════════════════════════════════════════════════
if [ "$MODE" = "status" ]; then
    [ ! -d "${INSTALL_DIR}" ] && { echo "未安装"; exit 1; }
    cd "$INSTALL_DIR"
    docker compose ps 2>/dev/null || docker-compose ps 2>/dev/null
    echo ""
    echo "目录: ${INSTALL_DIR}"
    echo "磁盘: $(du -sh . 2>/dev/null | cut -f1)"
    echo "日志: ${LOG_FILE}"
    exit 0
fi

# ═══════════════════════════════════════════════════════════════
#  MODE: BACKUP
# ═══════════════════════════════════════════════════════════════
if [ "$MODE" = "backup" ]; then
    [ ! -f "${INSTALL_DIR}/docker-compose.yml" ] && die "未找到安装"
    cd "$INSTALL_DIR"
    _bf="backups/backup_$(date +%Y%m%d_%H%M%S).sql"
    mkdir -p backups
    info "备份数据库 → ${_bf}..."
    docker compose exec -T postgres pg_dump -U novel novel_admin > "$_bf" 2>/dev/null && \
        ok "备份完成: ${INSTALL_DIR}/${_bf} ($(du -h "$_bf" | cut -f1))" || \
        err "备份失败（容器可能未运行）"
    exit 0
fi

# ═══════════════════════════════════════════════════════════════
#  MODE: UNINSTALL
# ═══════════════════════════════════════════════════════════════
if [ "$MODE" = "uninstall" ]; then
    [ ! -f "${INSTALL_DIR}/docker-compose.yml" ] && die "未找到安装"
    echo ""
    warn "将永久删除: ${INSTALL_DIR} + 容器 + 数据库数据!"
    ask_y "确认？" || { echo "已取消"; exit 0; }
    cd "$INSTALL_DIR"
    docker compose down -v --rmi local 2>/dev/null || true
    cd /; rm -rf "$INSTALL_DIR"
    ok "已卸载"; exit 0
fi

# ═══════════════════════════════════════════════════════════════
#  MODE: ROLLBACK
# ═══════════════════════════════════════════════════════════════
if [ "$MODE" = "rollback" ]; then
    _rollback_dir="${INSTALL_DIR}.rollback"
    [ ! -d "$_rollback_dir" ] && die "未找到回滚备份 (${_rollback_dir})"
    cd "$INSTALL_DIR"
    docker compose down 2>/dev/null || true
    cd /; rm -rf "${INSTALL_DIR}.bak2"
    mv "$INSTALL_DIR" "${INSTALL_DIR}.bak2"
    mv "$_rollback_dir" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
    docker compose up -d 2>/dev/null
    ok "已回滚。旧版本备份在 ${INSTALL_DIR}.bak2"
    exit 0
fi

# ═══════════════════════════════════════════════════════════════
#  MODE: UPGRADE
# ═══════════════════════════════════════════════════════════════
if [ "$MODE" = "upgrade" ]; then
    [ ! -f "${INSTALL_DIR}/docker-compose.yml" ] && die "未找到安装"
    cd "$INSTALL_DIR"

    # Backup current
    info "备份当前版本..."
    _ts=$(date +%Y%m%d_%H%M%S)
    mkdir -p backups
    docker compose exec -T postgres pg_dump -U novel novel_admin > "backups/pre_upgrade_${_ts}.sql" 2>/dev/null || true

    # Replace files from script's directory (tarball)
    if [ "$SCRIPT_DIR" != "$INSTALL_DIR" ] && [ -f "${SCRIPT_DIR}/Dockerfile" ]; then
        info "从 ${SCRIPT_DIR} 复制新文件..."
        rm -rf "${INSTALL_DIR}.rollback"
        cp -a "$INSTALL_DIR" "${INSTALL_DIR}.rollback"
        for f in src prisma public mini-services Dockerfile docker-compose.yml docker-entrypoint.sh \
                 docker-entrypoint.sh .dockerignore .env.production tsconfig.json next.config.ts \
                 postcss.config.mjs package.json bun.lock components.json; do
            [ -e "${SCRIPT_DIR}/$f" ] && rm -rf "${INSTALL_DIR:?}/$f" && cp -a "${SCRIPT_DIR}/$f" "${INSTALL_DIR}/$f" 2>/dev/null || true
        done
    elif [ -d .git ]; then
        info "git pull..."
        git pull --ff-only 2>&1 || warn "git pull 失败"
    else
        die "无法升级：非 git 仓库，也找不到新文件"
    fi

    info "重新构建..."
    docker compose up -d --build 2>&1
    ok "升级完成"
    echo "  如有问题回滚: $0 --rollback"
    exit 0
fi

# ═══════════════════════════════════════════════════════════════
#  MODE: INSTALL (main flow)
# ═══════════════════════════════════════════════════════════════

# ── Banner ──
[ -t 1 ] && clear 2>/dev/null || true
echo ""
echo -e "${C}${BD}╔═══════════════════════════════════════════════╗${N}"
echo -e "${C}${BD}║    📚 小说管理系统 · 生产环境一键部署         ║${N}"
echo -e "${C}${BD}╚═══════════════════════════════════════════════╝${N}"
echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  STEP 1: System Detection & Prerequisites
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
step "[1/8] 系统检测与前置依赖"

# OS info
if [ -f /etc/os-release ]; then
    . /etc/os-release
    info "系统: ${NAME:-Unknown} (${ID:-unknown}) ${VERSION_ID:-}"
else
    warn "无法检测系统版本"
fi
info "架构: $(uname -m)"
info "内核: $(uname -r)"

# Install essential tools
info "检查前置工具..."
pkg_install curl
pkg_install git
pkg_install ca-certificates
ok "前置工具就绪"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  STEP 2: Resource Check
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
step "[2/8] 资源检查"

# Memory
_mem_mb=$(free -m 2>/dev/null | awk '/Mem:/{print $2}' || echo "0")
if [ "${_mem_mb:-0}" -lt 1500 ]; then
    warn "内存仅 ${_mem_mb}MB（建议 2GB+）"
    # Check for swap
    _swap_mb=$(free -m 2>/dev/null | awk '/Swap:/{print $2}' || echo "0")
    if [ "${_swap_mb:-0}" -eq 0 ]; then
        warn "无 Swap，低内存可能导致构建 OOM"
        if ask_y "自动创建 2GB swap 文件？"; then
            _swapfile="/swapfile"
            [ -f "$_swapfile" ] || dd if=/dev/zero of="$_swapfile" bs=1M count=2048 2>/dev/null
            chmod 600 "$_swapfile"
            mkswap "$_swapfile" >/dev/null 2>&1
            swapon "$_swapfile" 2>/dev/null
            # Persist
            grep -q 'swapfile' /etc/fstab 2>/dev/null || echo "$_swapfile none swap sw 0 0" >> /etc/fstab
            _swap_now=$(free -m 2>/dev/null | awk '/Swap:/{print $2}')
            ok "Swap 已创建: ${_swap_now}MB"
        fi
    else
        ok "已有 Swap: ${_swap_mb}MB"
    fi
else
    ok "内存 ${_mem_mb}MB"
fi

# Disk
_disk_gb=$(df -BG "$(dirname "$INSTALL_DIR" 2>/dev/null || echo /)" 2>/dev/null | awk 'NR==2{print $4}' | tr -d 'G')
_disk_gb=${_disk_gb:-0}
[ "$_disk_gb" -lt 5 ] && die "磁盘不足: ${_disk_gb}GB (需 5GB+)"
ok "磁盘 ${_disk_gb}GB 可用"

# CPU cores (affects build time)
_cores=$(nproc 2>/dev/null || echo "1")
[ "$_cores" -lt 2 ] && warn "仅 ${_cores} 核 CPU，构建可能较慢"
ok "CPU ${_cores} 核"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  STEP 3: Docker
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
step "[3/8] Docker 环境"

if ! command -v docker &>/dev/null; then
    ask_y "Docker 未安装，自动安装？" || die "手动: curl -fsSL https://get.docker.com | sh"
    info "安装 Docker（需要几分钟）..."
    # Try official script first (most universal)
    if curl -fsSL --connect-timeout 10 "https://get.docker.com" -o /tmp/get-docker.sh 2>/dev/null; then
        sh /tmp/get-docker.sh >/dev/null 2>&1 && ok "Docker 已安装" || {
            warn "官方脚本失败，尝试包管理器..."
            _install_docker_pkg
        }
        rm -f /tmp/get-docker.sh
    else
        warn "无法下载官方脚本，尝试包管理器..."
        _install_docker_pkg
    fi
else
    _dv=$(docker version --format '{{.Server.Version}}' 2>/dev/null | head -1)
    ok "Docker ${_dv:-已安装}"
fi

# Ensure running
if ! docker info &>/dev/null; then
    systemctl start docker 2>/dev/null || service docker start 2>/dev/null || true
    sleep 3
    docker info &>/dev/null || die "Docker 启动失败: systemctl start docker"
fi

# Compose
if docker compose version &>/dev/null; then COMPOSE_CMD="docker compose"
elif command -v docker-compose &>/dev/null; then COMPOSE_CMD="docker-compose"
else die "未找到 Docker Compose"
fi
ok "Docker 运行中"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  STEP 4: Network & Mirror
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
step "[4/8] 网络与镜像加速"

if curl -sf --connect-timeout 5 "https://registry-1.docker.io/v2/" &>/dev/null; then
    ok "Docker Hub 直连正常"
else
    warn "Docker Hub 不可达，配置国内镜像..."
    [ -f /etc/docker/daemon.json ] && cp /etc/docker/daemon.json "/etc/docker/daemon.json.bak.$(date +%s)"
    _mj='['; _mf=""
    for _m in "${DOCKER_MIRRORS[@]}"; do _mj="${_mj}${_mf}\"${_m}\""; _mf=","; done; _mj="${_mj}]"
    mkdir -p /etc/docker
    echo "{\"registry-mirrors\":${_mj}}" > /etc/docker/daemon.json
    systemctl daemon-reload 2>/dev/null; systemctl restart docker 2>/dev/null || service docker restart 2>/dev/null || true
    sleep 3
    if docker info 2>/dev/null | grep -q "Registry Mirrors"; then
        ok "镜像加速已配置 (${#DOCKER_MIRRORS[@]} 个源)"
    else
        warn "镜像配置已写入但可能未生效，构建时如果报网络错误请重启: systemctl restart docker"
    fi
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  STEP 5: Get Project Files
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
step "[5/8] 获取项目文件"

_got=false

# Case A: Script is running INSIDE the project directory (tarball extract)
if [ -f "${SCRIPT_DIR}/Dockerfile" ] && [ -f "${SCRIPT_DIR}/docker-compose.yml" ]; then
    if [ "$SCRIPT_DIR" != "$INSTALL_DIR" ]; then
        if [ -d "$INSTALL_DIR" ]; then
            # Existing install detected
            if [ -f "${INSTALL_DIR}/docker-compose.yml" ]; then
                info "检测到已有安装，将备份后替换"
                rm -rf "${INSTALL_DIR}.rollback" 2>/dev/null
                mv "$INSTALL_DIR" "${INSTALL_DIR}.rollback"
            else
                ask_y "${INSTALL_DIR} 已存在，删除重建？" || die "请手动处理"
                rm -rf "$INSTALL_DIR"
            fi
        fi
        info "复制项目文件到 ${INSTALL_DIR}..."
        mkdir -p "$INSTALL_DIR"
        cp -a "$SCRIPT_DIR/." "$INSTALL_DIR/"
        _got=true
    else
        _got=true  # Already in the right place
    fi
fi

# Case B: Existing git install
if ! $_got && [ -d "${INSTALL_DIR}/.git" ]; then
    cd "$INSTALL_DIR"
    if ask_y "已有 Git 安装(${INSTALL_DIR})，更新？"; then
        git pull --ff-only 2>&1 && ok "已更新" || warn "pull 失败"
    fi
    _got=true
fi

# Case C: Git clone
if ! $_got && command -v git &>/dev/null; then
    [ -d "$INSTALL_DIR" ] && { ask_y "${INSTALL_DIR} 已存在，删除重建？" || die ""; rm -rf "$INSTALL_DIR"; }
    info "git clone..."
    git clone --depth 1 "$GIT_URL" "$INSTALL_DIR" 2>&1 && { _got=true; ok "克隆成功"; }
    if ! $_got; then
        for _px in "${GIT_PROXIES[@]}"; do
            info "尝试代理 ${_px%%/*}..."
            if git clone --depth 1 "${_px}/${REPO}.git" "$INSTALL_DIR" 2>&1; then
                cd "$INSTALL_DIR" && git remote set-url origin "$GIT_URL" 2>/dev/null || true
                _got=true; ok "通过代理克隆成功"; break
            fi
        done
    fi
fi

# Case D: curl download
if ! $_got; then
    [ -d "$INSTALL_DIR" ] && rm -rf "$INSTALL_DIR"
    info "下载压缩包..."
    for _u in "$ARCHIVE_URL" "${RAW_PROXIES[0]}/${ARCHIVE_URL}" "${RAW_PROXIES[1]}/${ARCHIVE_URL}"; do
        info "  ${_u%%\?*}..."
        if curl -fsSL --connect-timeout 15 --max-time 180 "$_u" -o /tmp/novel.tar.gz 2>/dev/null; then
            mkdir -p /tmp/novel-tmp && rm -rf /tmp/novel-tmp/*
            if tar xzf /tmp/novel.tar.gz -C /tmp/novel-tmp 2>/dev/null; then
                _ed=$(find /tmp/novel-tmp -maxdepth 1 -type d -name "novel-admin*" | head -1)
                if [ -n "$_ed" ]; then
                    cp -a "$_ed/." "$INSTALL_DIR/" 2>/dev/null || { mkdir -p "$INSTALL_DIR" && cp -a "$_ed/." "$INSTALL_DIR/"; }
                    _got=true; ok "下载成功"
                fi
            fi
            rm -rf /tmp/novel.tar.gz /tmp/novel-tmp
            $_got && break
        fi
    done
fi

$_got || die "获取代码失败！请手动下载: ${GIT_URL}"

cd "$INSTALL_DIR"

# Verify files
_missing=""
for _f in "${REQUIRED_FILES[@]}"; do
    [ ! -f "$_f" ] && _missing="$_missing $_f"
done
[ -n "$_missing" ] && die "缺少文件:$_missing"
ok "项目文件就绪"

# Make scripts executable
chmod +x deploy.sh docker-entrypoint.sh 2>/dev/null || true

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  STEP 6: Firewall
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
step "[6/8] 防火墙"

# We need the port before checking firewall, peek at .env or use default
_port_peek="${APP_PORT:-3000}"
[ -f .env ] && _port_peek=$(grep '^APP_PORT=' .env 2>/dev/null | head -1 | cut -d= -f2)
_port_peek=${_port_peek:-3000}

_firewall_opened=false
if command -v ufw &>/dev/null && ufw status 2>/dev/null | grep -q "active"; then
    if ! ufw status | grep -q "${_port_peek}"; then
        ufw allow ${_port_peek}/tcp >/dev/null 2>&1 && ok "ufw 已放行 ${_port_peek}" && _firewall_opened=true
    fi
fi
if command -v firewall-cmd &>/dev/null && systemctl is-active --quiet firewalld 2>/dev/null; then
    if ! firewall-cmd --list-ports 2>/dev/null | grep -q "${_port_peek}"; then
        firewall-cmd --permanent --add-port=${_port_peek}/tcp >/dev/null 2>&1
        firewall-cmd --reload >/dev/null 2>&1
        ok "firewalld 已放行 ${_port_peek}" && _firewall_opened=true
    fi
fi
$_firewall_opened || ok "无需防火墙配置"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  STEP 7: Configuration
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
step "[7/8] 生成配置"

NEED_ENV=true
if [ -f .env ]; then
    source .env 2>/dev/null || true
    _port_peek="${APP_PORT:-3000}"
    if $AUTO_YES || ! ask_y ".env 已存在(端口=${APP_PORT:-3000}, 用户=${ADMIN_USERNAME:-admin})，重新配置？"; then
        info "保留现有 .env"; NEED_ENV=false
    else
        cp .env ".env.bak.$(date +%Y%m%d_%H%M%S)"
        ok "已备份旧 .env"
    fi
fi

if $NEED_ENV; then
    _dbpw=$(rand_hex 16); _secret=$(rand_hex 32); _token=$(rand_hex 32); _apw=$(rand_pass 14)
    $AUTO_YES || { echo ""; info "配置参数（回车=默认）:"; echo ""; }

    _port=$(ask "  端口" "3000")
    [[ "$_port" =~ ^[0-9]+$ ]] && [ "$_port" -ge 1 ] && [ "$_port" -le 65535 ] || _port=3000
    if ss -tlnp 2>/dev/null | grep -q ":${_port} " || lsof -i :"$_port" &>/dev/null; then
        warn "端口 ${_port} 已被占用"; _port=$(ask "  换个端口" "$((_port+1))")
    fi

    _user=$(ask "  管理员用户名" "admin")
    _pass=$(ask "  管理员密码" "$_apw")
    [ -z "$_pass" ] && _pass="$_apw"
    _addr=$(ask "  服务器IP/域名" "$(my_ip)")
    [[ "$_addr" =~ ^https?:// ]] && _url="$_addr" || _url="http://${_addr}:${_port}"
    _tz=$(ask "  时区" "Asia/Shanghai")

    cat > .env <<EOF
# Novel Admin — Auto-generated $(date '+%Y-%m-%d %H:%M:%S')
# ⚠️ Contains secrets — do not commit to git

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
    chmod 600 .env; ok ".env 已生成"
    SAVE_USER="$_user"; SAVE_PASS="$_pass"; SAVE_URL="$_url"; SAVE_PORT="$_port"
else
    source .env 2>/dev/null || true
    SAVE_USER="${ADMIN_USERNAME:-admin}"; SAVE_PASS="${ADMIN_PASSWORD}"
    SAVE_URL="${APP_URL:-http://localhost:${APP_PORT:-3000}}"; SAVE_PORT="${APP_PORT:-3000}"
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  STEP 8: Build, Start, Verify
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
step "[8/8] 构建、启动、验证"
info "首次构建约 5-10 分钟..."
echo ""

# ── Build ──
T0=$(date +%s)
set +e
$COMPOSE_CMD build 2>&1 | tee /tmp/novel-build.log | while IFS= read -r _l; do
    echo "$_l" | grep -qiE '(^Step |=> (RUN|COPY|FROM)|ERROR|fail|successfully tag)' && echo "  $_l"
done
RC=${PIPESTATUS[0]}
set -e
DT=$(( $(date +%s) - T0 ))
echo ""

if [ $RC -ne 0 ]; then
    echo ""
    err "构建失败！(${DT}s)"
    echo ""
    # Analyze build log for common issues
    _bl=/tmp/novel-build.log
    if grep -qi "OOM\|killed\|cannot allocate" "$_bl" 2>/dev/null; then
        err "  → 内存不足 (OOM)。解决:"
        err "    1. 增加 Swap: fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile"
        err "    2. 在 docker-compose.yml 降低 memory limits"
    elif grep -qi "timeout\|TLS\|connection refused\|network\|dial tcp" "$_bl" 2>/dev/null; then
        err "  → 网络问题。解决:"
        err "    1. 检查 Docker Hub 镜像: docker info | grep -A5 Mirror"
        err "    2. 重启 Docker: systemctl restart docker"
        err "    3. 重试: cd ${INSTALL_DIR} && $COMPOSE_CMD build --no-cache"
    elif grep -qi "error:.*script.*build\|Failed to compile\|Type error" "$_bl" 2>/dev/null; then
        err "  → 代码编译错误。解决:"
        err "    1. 更新代码: cd ${INSTALL_DIR} && git pull"
        err "    2. 查看完整错误: grep -A5 'Type error' ${_bl}"
    else
        err "  → 未知错误。查看日志:"
    fi
    echo ""
    err "完整日志: cat ${_bl}"
    echo ""
    err "重试: cd ${INSTALL_DIR} && $COMPOSE_CMD build --no-cache 2>&1 | tee build.log"
    exit 1
fi
ok "构建完成 (${DT}s)"

# ── Start ──
echo ""
set +e
$COMPOSE_CMD up -d 2>&1
RC=$?
set -e
[ $RC -ne 0 ] && die "启动失败！端口 ${SAVE_PORT} 可能被占用。修改 .env 中 APP_PORT 后重试: $COMPOSE_CMD up -d"
ok "容器已启动"

# ── Health Check ──
echo ""
info "等待服务启动..."
ELAPSED=0; MAX=180; HEALTHY=false
while [ $ELAPSED -lt $MAX ]; do
    # Check container alive
    if ! $COMPOSE_CMD ps 2>/dev/null | grep -qE 'Up|healthy|running'; then
        echo ""; err "容器异常退出！"; $COMPOSE_CMD logs --tail=40 2>&1; exit 1
    fi
    if curl -sf --connect-timeout 2 "http://localhost:${SAVE_PORT}/api/auth/csrf" &>/dev/null; then
        HEALTHY=true; break
    fi
    _pct=$(( ELAPSED * 100 / MAX )); _f=$(( _pct * 30 / 100 )); _e=$(( 30 - _f ))
    _bar=$(printf '%*s' "$_f" | tr ' ' '█')$(printf '%*s' "$_e" | tr ' ' '░')
    printf "\r  [%s] %3d%% " "$_bar" "$_pct" >&2
    sleep 3; ELAPSED=$((ELAPSED+3))
done
echo ""

# ── Save credentials ──
cat > "${INSTALL_DIR}/.credentials.txt" <<EOF
===========================================
  📚 小说管理系统 — 登录凭据
  $(date '+%Y-%m-%d %H:%M:%S')
===========================================
访问:  ${SAVE_URL}
用户:  ${SAVE_USER}
密码:  ${SAVE_PASS}
⚠️ 妥善保管，建议保存后删除此文件。
EOF
chmod 600 "${INSTALL_DIR}/.credentials.txt"

# ── Final Result ──
echo ""
if $HEALTHY; then
    echo -e "${G}${BD}╔═══════════════════════════════════════════╗${N}"
    echo -e "${G}${BD}║         ✅ 部署成功！系统已就绪            ║${N}"
    echo -e "${G}${BD}╚═══════════════════════════════════════════╝${N}"
    echo ""
    echo -e "  🌐  ${BD}地址:${N}  ${C}${SAVE_URL}${N}"
    echo -e "  👤  ${BD}用户:${N}  ${BD}${SAVE_USER}${N}"
    echo -e "  🔑  ${BD}密码:${N}  ${BD}${SAVE_PASS}${N}"
    echo ""
    echo -e "  📋  ${BD}常用命令:${N}"
    echo -e "    日志:    ${C}cd ${INSTALL_DIR} && ${COMPOSE_CMD} logs -f${N}"
    echo -e "    停止:    ${C}cd ${INSTALL_DIR} && ${COMPOSE_CMD} stop${N}"
    echo -e "    启动:    ${C}cd ${INSTALL_DIR} && ${COMPOSE_CMD} start${N}"
    echo -e "    重启:    ${C}cd ${INSTALL_DIR} && ${COMPOSE_CMD} restart${N}"
    echo -e "    状态:    ${C}cd ${INSTALL_DIR} && ${COMPOSE_CMD} ps${N}"
    echo -e "    备份DB:  ${C}cd ${INSTALL_DIR} && ${COMPOSE_CMD} exec -T postgres pg_dump -U novel novel_admin > backup.sql${N}"
    echo ""
    echo -e "  🔄  ${BD}升级:${N}    ${C}./deploy.sh --upgrade${N}"
    echo -e "  ⏪  ${BD}回滚:${N}    ${C}./deploy.sh --rollback${N}"
    echo -e "  💾  ${BD}备份:${N}    ${C}./deploy.sh --backup${N}"
    echo -e "  📊  ${BD}状态:${N}    ${C}./deploy.sh --status${N}"
    echo -e "  🗑️  ${BD}卸载:${N}    ${C}./deploy.sh --uninstall${N}"
    echo ""
    echo -e "  📁  ${BD}文件:${N}"
    echo -e "    目录: ${DM}${INSTALL_DIR}${N}"
    echo -e "    配置: ${DM}${INSTALL_DIR}/.env${N}"
    echo -e "    凭据: ${DM}${INSTALL_DIR}/.credentials.txt${N}"
    echo -e "    日志: ${DM}${LOG_FILE}${N}"
    echo ""
    echo -e "  ${Y}${BD}⚠️ 请立即保存以上信息！${N}"
else
    echo -e "${Y}⏳ 健康检查超时(${MAX}s)，但服务可能仍在启动。${N}"
    echo ""
    echo -e "  检查: ${C}cd ${INSTALL_DIR} && ${COMPOSE_CMD} ps${N}"
    echo -e "  日志: ${C}cd ${INSTALL_DIR} && ${COMPOSE_CMD} logs -f${N}"
    echo -e "  凭据: ${C}cat ${INSTALL_DIR}/.credentials.txt${N}"
    echo -e "  部署日志: ${C}${LOG_FILE}${N}"
fi
echo ""

rm -f /tmp/novel-build.log 2>/dev/null