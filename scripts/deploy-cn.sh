#!/usr/bin/env bash
# =============================================================================
# deploy-cn.sh —— 国内服务器一键部署（novel-admin 全 Go 架构）R127 重生成
# =============================================================================
# 适用：全新 Ubuntu 22.04+/Debian 12+/CentOS Stream 9+/Rocky/Alma 9（x86_64/arm64）
#   ——预构建快速路径需 glibc >= 2.34；更低版本（Debian 11/Ubuntu 20.04）自动回退
#   源码构建路线（行为与 R126 前一致），无需任何手工干预。
# 做什么（全程国内镜像加速，可重复执行=幂等升级）：
#   [1/8] 系统依赖     git/curl/tar（apt/dnf 自动装，缺什么补什么）
#   [2/8] Go 工具链    >=1.22，阿里云镜像 mirrors.aliyun.com/golang，装 /usr/local/go
#                      （预构建快速路径命中时整个跳过——Go 都不用装）
#   [3/8] Go 模块代理  GOPROXY=https://goproxy.cn,direct（sumdb 校验经代理透传不降级）
#   [4/8] 部署双服务   backend-go.bin(:3000 页面+API+采集runner) + scraper-go.bin(:3030 引擎)
#                      ★ R127 预构建快速路径：repo 自带 bin/{backend-go,scraper-go}
#                      （与源码原子同步提交），架构+glibc 匹配即直接取用，零编译秒级起服务；
#                      不匹配/过低 glibc/--build 显式指定 → 走源码构建（goproxy.cn）
#   [5/8] 反反爬军火   curl-impersonate 21 二进制 → ~/.local/bin（GitHub 镜像候选链；
#                      快速路径下仍会安装——引擎运行时依赖，与构建无关）
#   [6/8] stealth 侧车 R131 新增（可选，失败不阻塞）：venv + cloakbrowser/iv8 依赖
#                      （PyPI 镜像链 aliyun→官方）+ CloakBrowser chromium 二进制
#                      （GitHub 镜像候选链+断点续传）；CF 挑战站渲染能力，
#                      缺失时引擎自动跳过 cloak/iv8 策略不阻塞主链路
#   [7/8] 启动 + 看护  默认 nohup+watchdog 自愈循环；--systemd 用 systemd 托管（推荐生产）
#   [8/8] 健康检查     /api/health + /api/strategies，空库首次启动自动建表+播种
# 数据安全：DB(db/custom.db)、封面(public/covers)、TXT(download/novels) 全在 repo 内，
#   重复执行 / git pull 升级均不触碰数据。
#
# ★ 一键部署（零前提，服务器连 git 都不用，curl/wget 有了就能跑）：
#   bash -c "$(curl -fsSL https://ghfast.top/https://raw.githubusercontent.com/u4399com-beep/novel-admin-1.0.0/main/scripts/bootstrap-cn.sh)"
#   ★ wget 变体 / ghfast.top 失效时换镜像（实测可用：gh-proxy.com / ghproxy.net）：
#   bash -c "$(wget -qO- https://gh-proxy.com/https://raw.githubusercontent.com/u4399com-beep/novel-admin-1.0.0/main/scripts/bootstrap-cn.sh)"
#   ★ 指定安装目录（默认 ~/novel-admin）：
#   BOOTSTRAP_TARGET=/opt/novel-admin bash -c "$(curl -fsSL https://ghfast.top/https://raw.githubusercontent.com/u4399com-beep/novel-admin-1.0.0/main/scripts/bootstrap-cn.sh)"
#
# 有 git 时的等价路线（clone 到任意路径均可）：
#   git clone https://ghfast.top/https://github.com/u4399com-beep/novel-admin-1.0.0.git ~/novel-admin \
#     && cd ~/novel-admin && bash scripts/deploy-cn.sh
#
# 日常升级（推荐）：cd ~/novel-admin && bash scripts/upgrade.sh
#              （= git 拉取 + 构建/预构建部署 + 重启 + 健康检查 + 失败自动回滚；
#               glibc>=2.34 时同样走预构建快速路径，升级零编译）
#              无 git 的 tarball 服务器：重跑 bootstrap 一键命令（数据目录自动保留）
# 卸载看护：--systemd 模式 systemctl disable --now novel-backend novel-scraper；
#           默认模式 pkill -f watchdog-loop.sh
# =============================================================================
set -euo pipefail

# ---------- 参数 ----------
INSTALL_SYSTEMD=0
PORT=3000
SKIP_BUILD=0
FORCE_BUILD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --systemd)   INSTALL_SYSTEMD=1 ;;
    --port)      PORT="${2:?--port 需要端口号}"; shift ;;
    --skip-build) SKIP_BUILD=1 ;;
    --build)     FORCE_BUILD=1 ;;
    -h|--help)   sed -n '2,37p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数: $1（--help 查看用法）" >&2; exit 2 ;;
  esac
  shift
done

# ---------- 输出与通用 ----------
if [ -t 1 ]; then
  C_G=$'\033[32m'; C_Y=$'\033[33m'; C_R=$'\033[31m'; C_B=$'\033[36m'; C_0=$'\033[0m'
else
  C_G=""; C_Y=""; C_R=""; C_B=""; C_0=""
fi
step()  { echo "${C_B}==>[$1]${C_0} $2"; }
ok()    { echo "${C_G}  OK${C_0} $1"; }
warn()  { echo "${C_Y}  WARN${C_0} $1"; }
die()   { echo "${C_R}  FAIL${C_0} $1" >&2; exit 1; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
ARCH=$(uname -m)  # x86_64 / aarch64
case "$ARCH" in
  x86_64)  GOARCH=amd64; CI_ARCH="x86_64" ;;
  aarch64|arm64) GOARCH=arm64; CI_ARCH="aarch64" ;;
  *) die "不支持的架构: $ARCH（仅支持 x86_64 / aarch64）" ;;
esac

echo ""
echo "${C_B}==============================================${C_0}"
echo " novel-admin 国内一键部署  repo=$ROOT  arch=$ARCH"
echo "==============================================${C_0}"
echo ""

# ---------- [1/7] 系统依赖 ----------
step "1/8" "系统依赖检测（git/curl/tar）"
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  SUDO="$(command -v sudo 2>/dev/null || true)"
  [ -n "$SUDO" ] || warn "非 root 且无 sudo：跳过系统包安装（假设 git/curl/tar 已就绪）"
fi
PKG_MGR=""
command -v apt-get >/dev/null 2>&1 && PKG_MGR="apt-get"
command -v dnf     >/dev/null 2>&1 && PKG_MGR="dnf"
command -v yum     >/dev/null 2>&1 && PKG_MGR="yum"

need_pkgs=()
command -v git  >/dev/null 2>&1 || need_pkgs+=(git)
command -v curl >/dev/null 2>&1 || need_pkgs+=(curl)
command -v tar  >/dev/null 2>&1 || need_pkgs+=(tar)
if [ ${#need_pkgs[@]} -gt 0 ] && [ -n "$SUDO" ] && [ -n "$PKG_MGR" ]; then
  echo "  安装缺失依赖: ${need_pkgs[*]}"
  if [ "$PKG_MGR" = "apt-get" ]; then
    $SUDO apt-get update -y >/dev/null 2>&1 || warn "apt-get update 失败（继续尝试安装）"
    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y "${need_pkgs[@]}" >/dev/null
  else
    $SUDO "$PKG_MGR" install -y "${need_pkgs[@]}" >/dev/null
  fi
fi
command -v curl >/dev/null 2>&1 && command -v tar >/dev/null 2>&1 \
  || die "git/curl/tar 不可用且无法自动安装，请手动安装后重试"
ok "依赖就绪 (git=$(command -v git >/dev/null 2>&1 && echo yes || echo no) curl=$(command -v curl >/dev/null 2>&1 && echo yes || echo no))"

# ---------- 预构建快速路径检测（R127） ----------
# repo 自带 bin/{backend-go,scraper-go}（R126 起与源码原子同步提交，即官方发布物）。
# 满足「双 bin 存在 + ELF 架构匹配本机 + glibc>=2.34」时直接取用：
#   跳过 Go 工具链下载与全部编译，一键安装 ~6 分钟 → ~1 分钟。
# 不满足或 --build 显式指定 → 自动回退源码构建（与 R126 前行为一致）。
USE_PREBUILT=0
GLIBC_VER=""
if [ "$FORCE_BUILD" -eq 0 ] && [ "$SKIP_BUILD" -eq 0 ] \
   && [ -x "$ROOT/mini-services/backend-go/bin/backend-go" ] \
   && [ -x "$ROOT/mini-services/scraper-go/bin/scraper-go" ]; then
  # ELF e_machine（小端 offset 18）：3e 00=x86-64 / b7 00=aarch64
  em="$(od -An -tx1 -j18 -N2 "$ROOT/mini-services/backend-go/bin/backend-go" 2>/dev/null | tr -d ' \n')"
  case "$em" in
    3e00) PREBUILT_ARCH=amd64 ;;
    b700) PREBUILT_ARCH=arm64 ;;
    *)    PREBUILT_ARCH=unknown ;;
  esac
  # glibc 地板：bin 依赖 GLIBC_2.34 符号；getconf 无输出（musl/Alpine 等）视为不满足
  GLIBC_VER="$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}')"
  if [ "$PREBUILT_ARCH" = "$GOARCH" ] && [ -n "$GLIBC_VER" ] \
     && awk -v a="$GLIBC_VER" 'BEGIN{exit !(a>=2.34)}'; then
    USE_PREBUILT=1
  fi
fi

# ---------- [2/7] Go 工具链 ----------
if [ "$USE_PREBUILT" -eq 1 ]; then
  step "2/8" "Go 工具链（预构建快速路径：跳过）"
  ok "仓库预构建二进制可用（arch=$GOARCH glibc=$GLIBC_VER）——Go 无需安装，稍后直接部署"
else
  step "2/8" "Go 工具链（需 >= 1.22）"
go_ver_ge() { # go1.22.12 -> 1 22 ；与 1.22 比较
  local v
  v="$("$1" version 2>/dev/null | sed -n 's/^go version go\([0-9]*\)\.\([0-9]*\).*/\1 \2/p')"
  [ -z "$v" ] && return 1
  set -- $v
  [ "$1" -gt 1 ] && return 0
  [ "$1" -eq 1 ] && [ "$2" -ge 22 ] && return 0
  return 1
}
GO_BIN=""
go_locate() { # 探测顺序：PATH → /usr/local/go → ~/.local/go → 沙箱 /home/z/go-sdk（R90 部署演练环境兼容）
  if command -v go >/dev/null 2>&1; then command -v go; return 0; fi
  for cand in /usr/local/go/bin "$HOME/.local/go/bin" /home/z/go-sdk/go/bin; do
    [ -x "$cand/go" ] && { echo "$cand/go"; return 0; }
  done
  return 1
}
if GO_BIN="$(go_locate)" && go_ver_ge "$GO_BIN"; then
  export PATH="$PATH:$(dirname "$GO_BIN")"
  ok "系统 Go 可用: $GO_BIN ($($GO_BIN version))"
else
  # 安装目标：root → /usr/local/go；无 sudo 用户 → ~/.local/go
  if [ -n "$SUDO" ] || [ "$(id -u)" -eq 0 ]; then
    GO_PREFIX="/usr/local/go"; DL_TMP="/tmp/go1.22.12.tgz"
    DL_CMD=(curl -fsSL --max-time 600 -o "$DL_TMP")
  else
    GO_PREFIX="$HOME/.local/go"; DL_TMP="/tmp/go1.22.12.tgz"
    DL_CMD=(curl -fsSL --max-time 600 -o "$DL_TMP")
  fi
  # 国内镜像候选链：阿里云 → 官方中国站 → 官方直连
  GO_URLS=(
    "https://mirrors.aliyun.com/golang/go1.22.12.linux-${GOARCH}.tar.gz"
    "https://golang.google.cn/dl/go1.22.12.linux-${GOARCH}.tar.gz"
    "https://go.dev/dl/go1.22.12.linux-${GOARCH}.tar.gz"
  )
  got=0
  for u in "${GO_URLS[@]}"; do
    echo "  下载: $u"
    if "${DL_CMD[@]}" "$u" && tar -tzf "$DL_TMP" >/dev/null 2>&1; then got=1; break; fi
    rm -f "$DL_TMP"
  done
  [ "$got" -eq 1 ] || die "Go 下载全部镜像源失败，请手动安装 Go >= 1.22 后重跑"
  # 覆盖安装（旧版/半残工具链先清）
  if [ -d "$GO_PREFIX" ]; then
    if [ "$(id -u)" -eq 0 ]; then rm -rf "$GO_PREFIX"; else rm -rf "$GO_PREFIX"; fi
  fi
  mkdir -p "$(dirname "$GO_PREFIX")"
  tar -C "$(dirname "$GO_PREFIX")" -xzf "$DL_TMP"
  # 解压结果校验（防半截解压/目录竞态，失败即明示重试）
  [ -x "$GO_PREFIX/bin/go" ] || die "Go 解压异常（$GO_PREFIX/bin/go 不存在），请重跑本脚本"
  rm -f "$DL_TMP"
  GO_BIN="$GO_PREFIX/bin/go"
  export PATH="$PATH:$(dirname "$GO_BIN")"
  ok "Go 安装完成: $($GO_BIN version) → $GO_PREFIX"
  # PATH 持久化提示（当前会话已注入；shell 重启由 profile 兜底）
  if ! grep -qs "$GO_PREFIX/bin" "$HOME/.profile" 2>/dev/null && [ "$(id -u)" -ne 0 ]; then
    echo "export PATH=\"\$PATH:$GO_PREFIX/bin\"" >> "$HOME/.profile"
  elif [ "$(id -u)" -eq 0 ] && ! grep -qs "$GO_PREFIX/bin" /root/.profile 2>/dev/null; then
    echo "export PATH=\"\$PATH:$GO_PREFIX/bin\"" >> /root/.profile 2>/dev/null || true
  fi
fi
if ! go_ver_ge "$GO_BIN"; then die "Go 版本过低（需 >= 1.22）"; fi
export GOPATH="${GOPATH:-$HOME/go}"
export GOPROXY="${GOPROXY:-https://goproxy.cn,direct}"
export GOTOOLCHAIN=local   # 防 go 命令运行期自动下载工具链（国内网络卡死点）
ok "模块代理: GOPROXY=$GOPROXY  GOPATH=$GOPATH"
fi  # end 非预构建路径（Go 工具链）

# ---------- [3/7]+[4/7] 部署双服务二进制 ----------
if [ "$USE_PREBUILT" -eq 1 ]; then
  step "3/8,4/8" "部署仓库预构建二进制（bin/ → .bin，零编译）"
  cp -f "$ROOT/mini-services/backend-go/bin/backend-go" "$ROOT/mini-services/backend-go/backend-go.bin"
  cp -f "$ROOT/mini-services/scraper-go/bin/scraper-go" "$ROOT/mini-services/scraper-go/scraper-go.bin"
  ok "backend-go.bin / scraper-go.bin = 仓库预构建版（与源码原子同步，~10 秒完成）"
elif [ "$SKIP_BUILD" -eq 1 ]; then
  step "3/8,4/8" "跳过构建（--skip-build）"
  [ -x "$ROOT/mini-services/backend-go/backend-go.bin" ] || die "--skip-build 但 backend-go.bin 不存在"
  [ -x "$ROOT/mini-services/scraper-go/scraper-go.bin" ] || die "--skip-build 但 scraper-go.bin 不存在"
  ok "使用既有二进制"
else
  step "3/8,4/8" "构建 backend-go + scraper-go（goproxy.cn 加速，首次 1-3 分钟）"
  bash "$ROOT/scripts/build-go.sh"
  ok "backend-go.bin / scraper-go.bin 构建完成"
fi

# ---------- [5/8] curl-impersonate ----------
step "5/8" "反反爬军火 curl-impersonate（TLS/JA3 指纹伪装二进制）"
if [ "$GOARCH" != "amd64" ]; then
  warn "arm64 服务器无官方 v0.6.1 构建：curl-impersonate 策略自动降级不可用（引擎策略链仍有 got-scraping 等多车道，不影响部署）"
elif [ "$(ls "$HOME/.local/bin" 2>/dev/null | grep -c '^curl_' || true)" -ge 10 ]; then
  ok "已安装 $(ls "$HOME/.local/bin" | grep -c '^curl_') 个 curl_chrome/ff/safari 二进制，跳过"
else
  bash "$ROOT/scripts/install-curl-impersonate.sh" || warn "curl-impersonate 安装失败（引擎多车道降级可用，可稍后重跑 scripts/install-curl-impersonate.sh）"
fi

# ---------- [6/8] stealth 侧车（R131 新增，可选，失败不阻塞） ----------
step "6/8" "stealth 侧车（可选：CF 挑战站 cloakbrowser/iv8 渲染能力）"
STEALTH_DIR="$ROOT/mini-services/stealth-service"
if [ ! -f "$STEALTH_DIR/requirements.txt" ]; then
  warn "stealth-service 目录缺失，跳过（引擎自动跳过 cloak/iv8 策略，不阻塞主链路）"
elif ! command -v python3 >/dev/null 2>&1; then
  [ -n "$SUDO" ] && [ -n "$PKG_MGR" ] && $SUDO "$PKG_MGR" install -y python3 >/dev/null 2>&1
  command -v python3 >/dev/null 2>&1 || warn "python3 不可用且自动安装失败：跳过 stealth 侧车（引擎自动降级，可重跑本脚本补装）"
fi
if [ -f "$STEALTH_DIR/requirements.txt" ] && command -v python3 >/dev/null 2>&1; then
  # ① venv 模块（Debian/Ubuntu 需显式 python3-venv 包）
  if ! python3 -c "import venv" >/dev/null 2>&1 && [ -n "$SUDO" ] && [ -n "$PKG_MGR" ]; then
    $SUDO "$PKG_MGR" install -y python3-venv >/dev/null 2>&1 || true
  fi
  # ② venv + 依赖（幂等：已可导入则跳过；PyPI 镜像链 aliyun → 官方，R128 实证清华源 403）
  [ -x "$STEALTH_DIR/venv/bin/python" ] || python3 -m venv "$STEALTH_DIR/venv" >/dev/null 2>&1 \
    || warn "venv 创建失败（stealth 将尝试以系统 python 运行）"
  PYPY="$STEALTH_DIR/venv/bin/python"
  if [ -x "$PYPY" ]; then
    if "$PYPY" -c "import cloakbrowser, iv8" >/dev/null 2>&1; then
      ok "stealth 依赖已就绪（cloakbrowser+iv8），跳过"
    elif [ -x "$STEALTH_DIR/venv/bin/pip" ]; then
      echo "  安装 stealth 依赖（cloakbrowser/iv8+playwright 链，PyPI 镜像链）..."
      "$STEALTH_DIR/venv/bin/pip" install -q -i https://mirrors.aliyun.com/pypi/simple/ -r "$STEALTH_DIR/requirements.txt" >/dev/null 2>&1 \
        || "$STEALTH_DIR/venv/bin/pip" install -q -r "$STEALTH_DIR/requirements.txt" >/dev/null 2>&1
      "$PYPY" -c "import cloakbrowser, iv8" >/dev/null 2>&1 \
        && ok "stealth 依赖就绪（cloakbrowser+iv8）" \
        || warn "stealth 依赖安装失败（/health cloak/iv8 将为 false，引擎自动降级；可重跑本脚本补装）"
    fi
    # ③ CloakBrowser chromium 二进制（R131：GitHub 镜像候选链+断点续传；按架构选包）
    CB_VER="$($PYPY -c "import cloakbrowser.download as dl; print(dl.get_chromium_version())" 2>/dev/null || true)"
    case "$(uname -m)" in x86_64) CB_ARCH=linux-x64 ;; aarch64|arm64) CB_ARCH=linux-arm64 ;; *) CB_ARCH="" ;; esac
    CB_DIR="$HOME/.cloakbrowser/chromium-$CB_VER"
    if [ -n "$CB_VER" ] && [ -x "$CB_DIR/chrome" ]; then
      ok "CloakBrowser chromium 已就绪"
    elif [ -n "$CB_VER" ] && [ -n "$CB_ARCH" ]; then
      echo "  下载 CloakBrowser chromium $CB_VER（~216MB，镜像候选链+断点续传，最长数分钟）..."
      mkdir -p "$CB_DIR"; CB_OK=0
      for CB_MIR in "https://ghfast.top/" "https://gh-proxy.com/" "https://ghproxy.net/" ""; do
        for CB_TRY in 1 2 3; do
          timeout 560 curl -fsSL -C - -o /tmp/cb.tar.gz \
            "${CB_MIR}https://github.com/CloakHQ/cloakbrowser/releases/download/chromium-v${CB_VER}/cloakbrowser-${CB_ARCH}.tar.gz" >/dev/null 2>&1
          tar -tzf /tmp/cb.tar.gz >/dev/null 2>&1 && { CB_OK=1; break 2; }
        done
      done
      if [ "$CB_OK" = 1 ] && tar -xzf /tmp/cb.tar.gz -C "$CB_DIR" 2>/dev/null && chmod +x "$CB_DIR/chrome" 2>/dev/null \
         && [ -x "$CB_DIR/chrome" ]; then
        ok "chromium $CB_VER 就绪（cloak 过盾可用）"
      else
        warn "chromium 下载失败（cloak 渲染不可用，其余能力不受影响；可重跑本脚本补装）"
      fi
    elif [ -n "$CB_VER" ]; then
      warn "非常见架构（$(uname -m)）：无预编译 chromium 包，cloak 渲染降级不可用"
    fi
  fi
fi

# ---------- [7/8] 启动 ----------
step "7/8" "启动服务（端口 $PORT，模式: $([ "$INSTALL_SYSTEMD" -eq 1 ] && echo systemd || echo nohup+watchdog)）"
# 数据/运行时目录（幂等）
mkdir -p "$ROOT/db" "$ROOT/public/covers" "$ROOT/download/novels"

# 清旧进程（幂等重启；DB 是 SQLite WAL，进程级安全）
pkill -f 'backend-go[.]bin'  2>/dev/null || true
pkill -f 'scraper-[g]o.bin'  2>/dev/null || true
sleep 1

# R135 P0：管理面写保护令牌（operations-readiness §E）。
# 公网部署默认安全：优先复用既有 token（幂等重部署不换锁钥），首次生成随机值。
# 自用/内网不想启用：部署后从 env 行删掉 ADMIN_TOKEN 即可（缺省空=关闭，行为同历史）。
ADMIN_TOKEN_VAL=""
if [ -f "$ROOT/.admin-token" ]; then
  ADMIN_TOKEN_VAL="$(cat "$ROOT/.admin-token")"
else
  if command -v openssl >/dev/null 2>&1; then
    ADMIN_TOKEN_VAL="$(openssl rand -hex 16)"
  else
    ADMIN_TOKEN_VAL="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
  printf '%s' "$ADMIN_TOKEN_VAL" > "$ROOT/.admin-token" && chmod 600 "$ROOT/.admin-token"
fi

ENV_LINES=(BACKEND_PORT=$PORT BACKEND_MODE=all
  DB_PATH=$ROOT/db/custom.db
  TXT_ROOT=$ROOT/download/novels
  COVERS_DIR=$ROOT/public/covers
  ADMIN_TOKEN=$ADMIN_TOKEN_VAL)

if [ "$INSTALL_SYSTEMD" -eq 1 ]; then
  [ "$(id -u)" -eq 0 ] || [ -n "$SUDO" ] || die "--systemd 需要 root 或 sudo"
  # systemd 托管：Restart=always 兜底，同时清掉遗留 watchdog 循环防双看护
  pkill -f 'watchdog-loop[.]sh' 2>/dev/null || true
  write_unit() { # $1=unit名 $2=WorkingDir $3=Exec
    cat > "/tmp/$1.service" <<UNIT
[Unit]
Description=novel-admin $1 ($2)
After=network.target

[Service]
Type=simple
WorkingDirectory=$2
Environment=BACKEND_PORT=$PORT
Environment=BACKEND_MODE=all
Environment=DB_PATH=$ROOT/db/custom.db
Environment=TXT_ROOT=$ROOT/download/novels
Environment=COVERS_DIR=$ROOT/public/covers
Environment=ADMIN_TOKEN=$ADMIN_TOKEN_VAL
ExecStart=$3
Restart=always
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
UNIT
    ${SUDO:+$SUDO }cp "/tmp/$1.service" "/etc/systemd/system/$1.service"
    rm -f "/tmp/$1.service"
  }
  write_unit "novel-backend" "$ROOT/mini-services/backend-go" "$ROOT/mini-services/backend-go/backend-go.bin"
  write_unit "novel-scraper" "$ROOT/mini-services/scraper-go" "$ROOT/mini-services/scraper-go/scraper-go.bin"
  ${SUDO:+$SUDO }systemctl daemon-reload
  ${SUDO:+$SUDO }systemctl enable --now novel-backend novel-scraper
  ok "systemd 单元已安装并启动: novel-backend / novel-scraper"
else
  # 默认模式：setsid 托孤 + watchdog 自愈循环（60s/轮，复用 ensure-services.sh）
  cd "$ROOT/mini-services/backend-go"
  # 注意：必须用 env 前缀传递环境变量——nohup 会把 "VAR=value" 当成命令名
  # （历史 bug: nohup: failed to run command 'BACKEND_PORT=3000': No such file or directory）
  setsid nohup env "${ENV_LINES[@]}" ./backend-go.bin >> /tmp/backend-go-api.log 2>&1 </dev/null &
  cd "$ROOT/mini-services/scraper-go"
  setsid nohup ./scraper-go.bin >> /tmp/engine.log 2>&1 </dev/null &
  cd "$ROOT"
  # watchdog 循环（幂等：先清旧）
  pkill -f 'watchdog-loop[.]sh' 2>/dev/null || true
  cat > "$ROOT/.watchdog-loop.sh" <<'EOF'
#!/bin/bash
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
while true; do
  bash "$ROOT/scripts/ensure-services.sh" >> /tmp/watchdog.log 2>&1
  sleep 60
done
EOF
  chmod +x "$ROOT/.watchdog-loop.sh"
  setsid nohup bash "$ROOT/.watchdog-loop.sh" >> /tmp/watchdog-loop.log 2>&1 </dev/null &
  ok "双服务已启动 + watchdog 自愈循环运行中（可选: crontab 加 '* * * * * bash $ROOT/scripts/ensure-services.sh' 三重保险）"
fi
ok "管理面写保护已启用（ADMIN_TOKEN 存于 $ROOT/.admin-token，写接口需 X-Admin-Token 头或 ?token= 参数；公开读接口不受影响；自用模式删除该文件与 env 行可关闭）"

# ---------- [8/8] 健康检查 ----------
step "8/8" "健康检查（空库首次启动含建表+播种，稍等）"
health_ok=0
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$PORT/api/health" || true)
  [ "$code" = "200" ] && { health_ok=1; break; }
  sleep 2
done
[ "$health_ok" -eq 1 ] || { echo "  最近日志:"; tail -20 /tmp/backend-go-api.log 2>/dev/null || true; die "backend-go 健康检查未通过（端口 $PORT）"; }
ok "backend-go :$PORT /api/health = 200"
eng_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3030/api/strategies || true)
if [ "$eng_code" = "200" ]; then
  ok "scraper-go :3030 /api/strategies = 200"
else
  warn "引擎 :3030 未就绪（$eng_code）——watchdog/互监护会自动拉起，稍后 curl http://127.0.0.1:3030/api/strategies 复查"
fi

# ---------- 汇总 ----------
echo ""
echo "${C_G}==============================================${C_0}"
echo " 部署完成 ✓"
echo "----------------------------------------------"
echo " 站点入口    : http://<服务器IP>:$PORT/"
echo " 管理后台    : http://<服务器IP>:$PORT/admin"
echo " 健康检查    : curl http://127.0.0.1:$PORT/api/health"
echo " 数据目录    : $ROOT/db/custom.db（SQLite，升级/迁移整目录拷走即备份）"
echo " 日志        : /tmp/backend-go-api.log / /tmp/engine.log / /tmp/watchdog.log"
echo " 部署形态    : $([ "$USE_PREBUILT" -eq 1 ] && echo '仓库预构建二进制（R127 快速路径，零编译）' || echo '源码构建')"
echo " 对外发布    : 建议前置 Nginx/Caddy 80/443 反代 127.0.0.1:$PORT（见 docs/deployment.md §8）"
echo " 日常升级    : cd $ROOT && bash scripts/upgrade.sh（git 拉取+部署+重启+失败回滚）"
echo "==============================================${C_0}"
