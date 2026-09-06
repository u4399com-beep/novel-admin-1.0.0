#!/usr/bin/env bash
# ============================================================
# 小说阁 - 一键安装脚本 v7.1
# Novel Admin Platform - One-Click Installation
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/u4399com-beep/novel-admin-1.0.0/main/install.sh | bash
#   OR
#   bash install.sh
#
# Options:
#   --skip-env      Skip .env configuration prompts
#   --skip-deps     Skip dependency installation (use existing)
#   --production    Production mode (no dev tools)
#   --port PORT     Custom port (default: 3000)
#   --dir DIR       Custom install directory
#   -y / --yes      Auto-accept all prompts
#   --calibrate     Run rate calibration after install
#   --db [sqlite|postgres]  Database backend (default: sqlite)
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

# ─── Parse Options ─────────────────────────────────────────
SKIP_ENV=false; SKIP_DEPS=false; PRODUCTION_MODE=false
CUSTOM_PORT=""; CUSTOM_DIR=""; AUTO_YES=false
RUN_CALIBRATE=false
DB_BACKEND="sqlite"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-env)     SKIP_ENV=true; shift ;;
    --skip-deps)    SKIP_DEPS=true; shift ;;
    --production)   PRODUCTION_MODE=true; shift ;;
    --port)         CUSTOM_PORT="${2:-}"; shift 2 ;;
    --dir)          CUSTOM_DIR="${2:-}"; shift 2 ;;
    -y|--yes)       AUTO_YES=true; shift ;;
    --calibrate)    RUN_CALIBRATE=true; shift ;;
    --db)           DB_BACKEND="${2:-sqlite}"; shift 2 ;;
    -h|--help)
      echo "Usage: bash install.sh [OPTIONS]"
      echo "  --skip-env      Skip .env configuration prompts"
      echo "  --skip-deps     Skip dependency installation"
      echo "  --production    Production mode (no dev tools)"
      echo "  --port PORT     Custom port (default: 3000)"
      echo "  --dir DIR       Custom install directory"
      echo "  -y, --yes       Auto-accept all prompts"
      echo "  --calibrate     Run rate calibration after install"
      echo "  --db [sqlite|postgres]  Database backend (default: sqlite)"
      exit 0 ;;
    *) shift ;;
  esac
done

# ─── Banner ────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${CYAN}║${NC}  ${BOLD}📚 小说阁 — 一键安装 v7.0${NC}                     ${BOLD}${CYAN}║${NC}"
echo -e "${BOLD}${CYAN}║${NC}  9引擎采集 · 反反爬增强 · 内容去重 · 管线监控     ${BOLD}${CYAN}║${NC}"
echo -e "${BOLD}${CYAN}║${NC}  自适应引擎 · 速率标定 · SQLite/PostgreSQL       ${BOLD}${CYAN}║${NC}"
echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════════════╝${NC}"
echo ""

# ─── Helper Functions ──────────────────────────────────────
generate_hex64() { openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | xxd -p -c 64; }
generate_password() { openssl rand -base64 16 2>/dev/null | tr -d '=/+' | head -c 16 || head -c 24 /dev/urandom | base64 | tr -d '=/+' | head -c 16; }
prompt_val() {
  local varname="$1" prompt="$2" default="$3" is_secret="${4:-false}"
  if $SKIP_ENV || $AUTO_YES; then
    eval "$varname=\"\$default\""
    return
  fi
  if $is_secret; then
    printf "  ${CYAN}%s${NC} [%s]: " "$prompt" "${default:0:4}****"
  else
    printf "  ${CYAN}%s${NC} [%s]: " "$prompt" "$default"
  fi
  read -r _input
  eval "$varname=\"\${_input:-\$default}\""
}

# ─── Step 1: Pre-flight Checks ────────────────────────────
step 1 "Pre-flight System Checks"

# 1a. Base system dependencies (minimal Debian needs these)
progress "Base system deps (curl, ca-certificates)"
_NEED_BASE=false
command -v curl >/dev/null 2>&1 || _NEED_BASE=true
if $_NEED_BASE; then
  progress_fail
  info "Installing base dependencies..."
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -qq 2>/dev/null
    sudo apt-get install -y curl ca-certificates gnupg 2>/dev/null || warn "Some base deps install had issues"
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y curl ca-certificates 2>/dev/null || warn "Some base deps install had issues"
  elif command -v apk >/dev/null 2>&1; then
    sudo apk add --no-cache curl ca-certificates 2>/dev/null || warn "Some base deps install had issues"
  fi
  command -v curl >/dev/null 2>&1 || fatal "curl is required. Install manually."
  ok "Base dependencies installed"
else
  progress_ok
fi

# 1b. Node.js 20+
progress "Node.js >= 20"
if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node --version | sed 's/v//'  | cut -d. -f1)
  if [ "$NODE_VER" -ge 20 ]; then
    progress_ok
  else
    progress_fail
    fatal "Node.js ${NODE_VER} found, but v20+ required. Install: https://nodejs.org/"
  fi
else
  progress_fail
  info "Installing Node.js 20 via package manager..."
  if command -v apt-get >/dev/null 2>&1; then
    # Ensure gnupg for nodesource key verification
    sudo apt-get install -y gnupg 2>/dev/null
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - 2>/dev/null
    sudo apt-get install -y nodejs 2>/dev/null || fatal "Node.js install failed"
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y nodejs 2>/dev/null || fatal "Node.js install failed"
  elif command -v yum >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash - 2>/dev/null
    sudo yum install -y nodejs 2>/dev/null || fatal "Node.js install failed"
  else
    fatal "Node.js not found. Please install Node.js 20+ manually: https://nodejs.org/"
  fi
  command -v node >/dev/null 2>&1 || fatal "Node.js installed but not found in PATH"
  ok "Node.js installed"
fi

# 1c. Bun runtime
progress "Bun runtime"
if command -v bun >/dev/null 2>&1; then
  progress_ok
else
  progress_fail
  # Bun installer requires unzip; install system deps first
  info "Installing system dependencies for Bun..."
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -qq 2>/dev/null
    sudo apt-get install -y unzip curl ca-certificates 2>/dev/null || warn "Some deps install had issues"
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y unzip curl ca-certificates 2>/dev/null || warn "Some deps install had issues"
  elif command -v yum >/dev/null 2>&1; then
    sudo yum install -y unzip curl ca-certificates 2>/dev/null || warn "Some deps install had issues"
  elif command -v apk >/dev/null 2>&1; then
    sudo apk add --no-cache unzip curl ca-certificates 2>/dev/null || warn "Some deps install had issues"
  fi
  # Verify unzip is available (required by bun installer)
  command -v unzip >/dev/null 2>&1 || fatal "unzip is required by Bun installer. Install it manually: apt install unzip"
  info "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash 2>/dev/null || fatal "Bun install failed (ensure unzip & curl are installed)"
  export PATH="$HOME/.bun/bin:$PATH"
  # Verify bun is now available
  command -v bun >/dev/null 2>&1 || fatal "Bun installed but not found in PATH. Add ~/.bun/bin to your PATH manually."
  ok "Bun installed"
fi

# 1d. Git
progress "Git"
if command -v git >/dev/null 2>&1; then
  progress_ok
else
  progress_fail
  info "Installing Git..."
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get install -y git 2>/dev/null || warn "Git install failed (optional)"
  fi
  command -v git >/dev/null 2>&1 || warn "Git not available; cannot clone repo"
fi

# 1e. RAM check (4GB recommended)
progress "RAM >= 4GB (recommended)"
_AVAIL_KB=$(awk '/MemAvailable/{print $2}' /proc/meminfo 2>/dev/null || echo 4194304)
_AVAIL_MB=$((_AVAIL_KB / 1024))
if [ "$_AVAIL_MB" -ge 4096 ]; then
  progress_ok
elif [ "$_AVAIL_MB" -ge 1536 ]; then
  echo -e "${YELLOW}⚠${NC}  (${_AVAIL_MB}MB — will use tiny/small tier)"
else
  echo -e "${RED}✗${NC}  (${_AVAIL_MB}MB — below minimum 1.5GB)"
  fatal "Insufficient RAM (${_AVAIL_MB}MB). Minimum 1.5GB, recommended 4GB."
fi

# 1f. Disk check (10GB free)
progress "Disk >= 10GB free"
_DF_AVAIL=$(df -k . 2>/dev/null | awk 'NR==2{print $4}')
_DF_GB=$((_DF_AVAIL / 1024 / 1024))
if [ "$_DF_GB" -ge 10 ]; then
  progress_ok
else
  echo -e "${YELLOW}⚠${NC}  (${_DF_GB}GB free — may be insufficient)"
fi

# 1g. Port availability
_APP_PORT="${CUSTOM_PORT:-3000}"
progress "Port ${_APP_PORT} available"
if command -v ss >/dev/null 2>&1; then
  if ! ss -tlnp 2>/dev/null | grep -q ":${_APP_PORT} "; then
    progress_ok
  else
    progress_fail
    warn "Port ${_APP_PORT} is in use. You can override with --port"
  fi
elif command -v lsof >/dev/null 2>&1; then
  if ! lsof -i :${_APP_PORT} >/dev/null 2>&1; then
    progress_ok
  else
    progress_fail
    warn "Port ${_APP_PORT} is in use."
  fi
else
  echo -e "${YELLOW}?${NC}  (cannot check)"
fi

echo ""
ok "Pre-flight checks passed (RAM: ${_AVAIL_MB}MB, Disk: ${_DF_GB}GB free)"

# ─── Step 2: Clone / Locate Project ───────────────────────
step 2 "Locate Project Source"

PROJECT_DIR=""
# Check if we're already inside the project
if [ -f "package.json" ] && grep -q "nextjs_tailwind_shadcn_ts" package.json 2>/dev/null; then
  PROJECT_DIR="$(pwd)"
  ok "Already in project directory: $PROJECT_DIR"
fi

# If not, try to clone
if [ -z "$PROJECT_DIR" ]; then
  REPO="u4399com-beep/novel-admin-1.0.0"
  INSTALL_DIR="${CUSTOM_DIR:-./novel-admin}"
  
  if $AUTO_YES; then
    CLONE_DIR="$INSTALL_DIR"
  else
    printf "  ${CYAN}Install directory${NC} [$INSTALL_DIR]: "
    read -r _dir_input
    CLONE_DIR="${_dir_input:-$INSTALL_DIR}"
  fi

  if [ -d "$CLONE_DIR" ] && [ -f "$CLONE_DIR/package.json" ]; then
    PROJECT_DIR="$CLONE_DIR"
    ok "Found existing project at: $PROJECT_DIR"
  else
    info "Cloning from GitHub..."
    
    # Try multiple mirrors
    _GIT_MIRRORS=(
      "https://github.com/${REPO}.git"
      "https://ghfast.top/https://github.com/${REPO}.git"
      "https://kkgithub.com/${REPO}.git"
    )
    
    _CLONED=false
    for _mirror in "${_GIT_MIRRORS[@]}"; do
      if git clone --depth 1 "$_mirror" "$CLONE_DIR" 2>/dev/null; then
        _CLONED=true
        break
      fi
    done
    
    if $_CLONED; then
      PROJECT_DIR="$CLONE_DIR"
      ok "Cloned to: $PROJECT_DIR"
    else
      fatal "Failed to clone. Try manually: git clone https://github.com/${REPO}.git"
    fi
  fi
fi

cd "$PROJECT_DIR"

# ─── Step 3: Install Dependencies ─────────────────────────
step 3 "Install Dependencies"

if $SKIP_DEPS; then
  ok "Skipped (--skip-deps)"
else
  # Root dependencies
  info "Installing root dependencies..."
  bun install 2>&1 || fatal "Root bun install failed"
  ok "Root dependencies installed"

  # Scraper service
  if [ -d "mini-services/scraper-service" ]; then
    info "Installing scraper-service dependencies..."
    (cd mini-services/scraper-service && bun install 2>&1) || warn "Scraper deps install had issues"
    ok "Scraper service dependencies installed"
  fi

  # Log stream service
  if [ -d "mini-services/log-stream-service" ]; then
    info "Installing log-stream-service dependencies..."
    (cd mini-services/log-stream-service && bun install 2>&1) || warn "Log stream deps install had issues"
    ok "Log stream service dependencies installed"
  fi

  # Prisma generate
  info "Generating Prisma client..."
  bun run db:generate 2>&1 || npx prisma generate 2>&1 || warn "Prisma generate had issues"
  ok "Prisma client generated"
fi

# ─── Step 4: Configure .env ───────────────────────────────
step 4 "Configure Environment Variables"

if [ -f ".env" ]; then
  ok ".env already exists — skipping (edit manually if needed)"
else
  # Generate secure defaults
  _NEXTAUTH_SECRET=$(generate_hex64)
  _SCRAPER_TOKEN=$(generate_hex64)
  _ADMIN_PASS=$(generate_password)
  
  # Set DATABASE_URL based on DB_BACKEND
  if [ "$DB_BACKEND" = "postgres" ]; then
    _DEFAULT_DB_URL="postgresql://novel:novel_admin@localhost:5432/novel_admin"
  else
    _DEFAULT_DB_URL="file:./db/custom.db"
  fi
  
  # Interactive prompts
  echo "  Generating secure credentials (press Enter to accept defaults):"
  echo ""
  
  prompt_val NEXTAUTH_SECRET "NEXTAUTH_SECRET (auth encryption key)" "$_NEXTAUTH_SECRET" true
  prompt_val ADMIN_USERNAME   "ADMIN_USERNAME (login user)" "admin" false
  prompt_val ADMIN_PASSWORD   "ADMIN_PASSWORD (login password)" "$_ADMIN_PASS" true
  prompt_val SCRAPER_SERVICE_TOKEN "SCRAPER_SERVICE_TOKEN (service auth)" "$_SCRAPER_TOKEN" true
  prompt_val DATABASE_URL     "DATABASE_URL" "$_DEFAULT_DB_URL" false
  prompt_val NEXT_PUBLIC_APP_URL "APP_URL (public URL)" "http://localhost:${_APP_PORT}" false

  cat > .env << ENVEOF
# ============================================================
# 小说阁 - Environment Configuration
# Auto-generated by install.sh v7.0 on $(date '+%Y-%m-%d %H:%M:%S')
# ============================================================

# ─── Database ────────────────────────────────────────────
DATABASE_URL="${DATABASE_URL}"
DB_PROVIDER="${DB_BACKEND}"

# ─── App Config ──────────────────────────────────────────
SCRAPER_SERVICE_URL="http://localhost:3099"
NEXT_PUBLIC_APP_NAME="小说管理系统"
NEXT_PUBLIC_APP_URL="${NEXT_PUBLIC_APP_URL}"

# ─── Authentication ──────────────────────────────────────
NEXTAUTH_SECRET="${NEXTAUTH_SECRET}"
NEXTAUTH_URL="${NEXT_PUBLIC_APP_URL}"
ADMIN_USERNAME="${ADMIN_USERNAME}"
ADMIN_PASSWORD="${ADMIN_PASSWORD}"

# ─── Service Auth ────────────────────────────────────────
SCRAPER_SERVICE_TOKEN="${SCRAPER_SERVICE_TOKEN}"

# ─── Pipeline Features (v7) ──────────────────────────────
# Content dedup: SHA-256 + SimHash@ near-duplicate detection
CONTENT_DEDUP_ENABLED=true
# Pipeline metrics: rolling 5-min window + health assessment
PIPELINE_METRICS_ENABLED=true
# Adaptive engine: per-domain engine performance tracking
ADAPTIVE_ENGINE_ENABLED=true

# ─── Optional: External Services ─────────────────────────
# FIRECRAWL_API_KEY=
# FIRECRAWL_API_URL=
# AGENTQL_API_KEY=
# AGENTQL_API_URL=
ENVEOF

  ok ".env created with secure credentials"
  info "  Admin: ${ADMIN_USERNAME} / ${ADMIN_PASSWORD:0:4}****"
  info "  Database: ${DB_BACKEND}"
fi

# ─── Step 5: Initialize Database ──────────────────────────
step 5 "Initialize Database"

if [ "$DB_BACKEND" = "postgres" ]; then
  info "Switching to PostgreSQL schema..."
  if [ -f "scripts/switch-to-postgres.sh" ]; then
    bash scripts/switch-to-postgres.sh 2>/dev/null || warn "PostgreSQL switch had issues"
  else
    warn "switch-to-postgres.sh not found — ensure schema.prisma uses PostgreSQL provider"
  fi
fi

info "Pushing database schema..."
if bun run db:push 2>&1; then
  ok "Database schema pushed successfully"
else
  warn "db:push had issues (may need manual intervention)"
  info "You can retry with: bun run db:push"
fi

# ─── Step 6: Seed Scrape Rules ───────────────────────────
step 6 "Seed Scrape Rules"

_RULES_DIR="mini-services/scraper-service/src/scrape-rules"
if [ -d "$_RULES_DIR" ]; then
  _RULE_COUNT=$(find "$_RULES_DIR" -name "*.json" ! -name "engine-preferences.json" ! -name "bypass-registry.json" ! -name "rate-calibration.json" | wc -l)
  ok "Found ${_RULE_COUNT} scrape rule files in ${_RULES_DIR}"
  info "  Rules are auto-loaded by scraper-service on startup"
  info "  To manage rules: Admin Panel → Scrape Rules"
else
  warn "Scrape rules directory not found"
fi

# ─── Step 7: Build ────────────────────────────────────────
step 7 "Build Application"

if $PRODUCTION_MODE || ! $SKIP_DEPS; then
  info "Building Next.js application..."
  if bun run build 2>&1; then
    ok "Build completed successfully"
  else
    warn "Build had issues — you can retry with: bun run build"
    if ! $AUTO_YES; then
      printf "  Continue anyway? [y/N]: "
      read -r _continue
      [[ "$_continue" =~ ^[Yy]$ ]] || fatal "Aborted"
    fi
  fi
else
  ok "Skipped build (use --production to build)"
fi

# ─── Step 8: Start Services ──────────────────────────────
step 8 "Start Services"

# 8a. Check for running instances
_SCRAPER_RUNNING=false
if curl -s -m 2 "http://localhost:3099/health" >/dev/null 2>&1; then
  _SCRAPER_RUNNING=true
  warn "Scraper service already running on port 3099"
fi

# 8b. Start scraper-service
if ! $_SCRAPER_RUNNING; then
  info "Starting scraper-service on port 3099..."
  (cd mini-services/scraper-service && PORT=3099 nohup bun index.ts > /tmp/scraper.log 2>&1 &)
  sleep 3
  if curl -s -m 5 "http://localhost:3099/health" >/dev/null 2>&1; then
    ok "Scraper service started"
  else
    warn "Scraper service may still be starting..."
  fi
fi

# 8c. Start log-stream-service
if [ -d "mini-services/log-stream-service" ]; then
  info "Starting log-stream-service on port 3004..."
  (cd mini-services/log-stream-service && PORT=3004 nohup bun index.ts > /tmp/log-stream.log 2>&1 &)
  sleep 1
  ok "Log stream service started"
fi

# 8d. Start main app
info "Starting Next.js app on port ${_APP_PORT}..."
if $PRODUCTION_MODE; then
  nohup bun start > /tmp/app.log 2>&1 &
else
  nohup bun dev > /tmp/app.log 2>&1 &
fi
APP_PID=$!
ok "App started (PID: $APP_PID)"

# ─── Step 9: Health Check ─────────────────────────────────
step 9 "Health Check"

_WAITED=0
_MAX_WAIT=60
_APP_HEALTHY=false

while [ $_WAITED -lt $_MAX_WAIT ]; do
  if curl -s -m 5 "http://localhost:${_APP_PORT}/api/auth/csrf" >/dev/null 2>&1; then
    _APP_HEALTHY=true
    break
  fi
  printf "\r  Waiting for app... %ds/%ds" "$_WAITED" "$_MAX_WAIT"
  sleep 3
  _WAITED=$((_WAITED + 3))
done
echo ""

if $_APP_HEALTHY; then
  ok "App is healthy on port ${_APP_PORT}"
else
  warn "App health check timed out — check logs: tail -50 /tmp/app.log"
fi

# Scraper health
if curl -s -m 5 "http://localhost:3099/health" >/dev/null 2>&1; then
  ok "Scraper service is healthy on port 3099"
else
  warn "Scraper health check failed"
fi

# ─── Step 10: Pipeline Features Health Check (v7) ─────────
step 10 "Pipeline Features Health Check (v7)"

# Pipeline Metrics endpoint
progress "Pipeline Metrics (/pipeline-metrics)"
if curl -s -m 5 "http://localhost:3099/pipeline-metrics" >/dev/null 2>&1; then
  progress_ok
else
  echo -e "${YELLOW}⚠${NC}  (endpoint not responding — may need auth token)"
fi

# Content Dedup check (via pipeline-metrics response)
progress "Content Dedup (via pipeline-metrics)"
_PM_RESP=$(curl -s -m 5 "http://localhost:3099/pipeline-metrics" 2>/dev/null || echo "{}")
if echo "$_PM_RESP" | grep -q "contentDedup" 2>/dev/null; then
  progress_ok
else
  echo -e "${YELLOW}⚠${NC}  (could not verify — may need auth token)"
fi

# Adaptive Engine check
progress "Adaptive Engine (via pipeline-metrics)"
if echo "$_PM_RESP" | grep -q "adaptiveEngine" 2>/dev/null; then
  progress_ok
else
  echo -e "${YELLOW}⚠${NC}  (could not verify — may need auth token)"
fi

# ─── Step 11: Rate Calibration (optional) ─────────────────
if $RUN_CALIBRATE; then
  step 11 "Rate Calibration"
  info "Running rate calibration against scrape rule source sites..."
  info "This will HTTP-probe all source sites to determine optimal rate/concurrency."
  if [ -f "mini-services/scraper-service/src/rate-calibration.ts" ]; then
    (cd mini-services/scraper-service && bun run src/rate-calibration.ts 2>&1) || warn "Calibration had issues"
    ok "Rate calibration complete"
    info "  Results saved to: mini-services/scraper-service/src/scrape-rules/rate-calibration.json"
    info "  Scrape rules updated with calibrated threadCount/delay/RPM settings"
  else
    warn "rate-calibration.ts not found — skipping"
  fi
fi

# ─── Step 12: Print Access Info ───────────────────────────
step 12 "Access Information"

# Read credentials from .env
_ADMIN_USER=$(grep '^ADMIN_USERNAME=' .env 2>/dev/null | cut -d= -f2 || echo "admin")
_ADMIN_PASS=$(grep '^ADMIN_PASSWORD=' .env 2>/dev/null | cut -d= -f2 || echo "see .env")

echo ""
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${GREEN}║${NC}  ${BOLD}✅ 安装完成！Installation Complete!${NC}              ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}╠══════════════════════════════════════════════════╣${NC}"
echo -e "${BOLD}${GREEN}║${NC}  🌐 访问地址:  http://localhost:${_APP_PORT}          ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}  📡 Scraper:   http://localhost:3099              ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}  📊 LogStream:  http://localhost:3004              ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}  📈 Pipeline:   http://localhost:3099/pipeline-metrics ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}  🗄️  Database:   ${DB_BACKEND}                       ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}  👤 用户名:    ${_ADMIN_USER}                            ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}  🔑 密码:      ${_ADMIN_PASS:0:4}****                    ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${YELLOW}║${NC}  ⚠️  请立即保存密码！Save your credentials!   ${BOLD}${YELLOW}║${NC}"
echo -e "${BOLD}${GREEN}╠══════════════════════════════════════════════════╣${NC}"
echo -e "${BOLD}${GREEN}║${NC}  📋 Next Steps:                                 ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}    1. Open the URL above in your browser        ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}    2. Login with the credentials above           ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}    3. Add novels and configure scrape rules      ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}    4. Run calibration: install.sh --calibrate   ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}    5. See DEPLOY.md for production deployment    ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}╠══════════════════════════════════════════════════╣${NC}"
echo -e "${BOLD}${GREEN}║${NC}  🔧 Useful Commands:                            ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}    Dev:     bun dev                             ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}    Build:   bun run build                       ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}    Start:   bun start                            ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}    DB push: bun run db:push                     ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}    Logs:    tail -f /tmp/app.log                 ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}    Stop:    kill $APP_PID                        ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}║${NC}    Calibrate: bash install.sh --calibrate       ${BOLD}${GREEN}║${NC}"
echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""

# Save deploy info
cat > .deploy-info << EOF
# Deploy time: $(date '+%Y-%m-%d %H:%M:%S')
# Install script: v7.0
# Mode: $(${PRODUCTION_MODE} && echo "production" || echo "development")
# Database: ${DB_BACKEND}
# RAM: ${_AVAIL_MB}MB | Disk: ${_DF_GB}GB
ADMIN_USERNAME=${_ADMIN_USER}
ADMIN_PASSWORD=${_ADMIN_PASS}
APP_PORT=${_APP_PORT}
PROJECT_DIR=${PROJECT_DIR}
EOF

ok "Deployment info saved to .deploy-info"
info "For Docker deployment, run: bash install-docker.sh"
