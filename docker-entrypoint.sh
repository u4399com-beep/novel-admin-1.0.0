#!/bin/bash
# ============================================================
# Novel Management System - Docker Entrypoint (Production)
# PostgreSQL + Next.js + Scraper Service
# Optimized for low-memory servers (1H1G)
# ============================================================

# CRITICAL: Merge stderr into stdout ASAP so ALL output is visible in docker logs.
# Without this, errors from command substitutions may go to a separate stream
# that Docker's json-file driver buffers independently, causing "silent crashes".
exec 2>&1

# Persistent crash log — written to the volume-mounted /app/data/ so it
# survives container restarts and can be read by deploy.sh for diagnostics.
_DEBUG_LOG="/app/data/entrypoint-debug.log"

# Log a message to both stdout and the persistent debug file
log_debug() {
    local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
    echo "$msg"
    echo "$msg" >> "$_DEBUG_LOG" 2>/dev/null || true
}

# Initialize debug log
: > "$_DEBUG_LOG" 2>/dev/null || true
log_debug "=== Entrypoint started (PID: $$) ==="

# Use set -e but with explicit error trapping for visibility.
# We keep set -e to catch unexpected failures, but the trap below
# ensures we always log WHAT failed before exiting.
set -e

# ─── Crash diagnostics: print info when the script exits unexpectedly ───
_trap_exit() {
    local _code=$?
    log_debug "=== EXIT TRIGGERED (code: $_code) ==="
    if [ "$_code" -ne 0 ] 2>/dev/null; then
        log_debug "[FATAL] Entrypoint exited with code $_code"
        log_debug "[FATAL] Available memory: $(cat /proc/meminfo 2>/dev/null | awk '/MemAvailable/{print $2}')KB"
        log_debug "[FATAL] Container memory limit: $(cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || echo 'unknown')"
        log_debug "[FATAL] Last 20 lines of app log:"
        tail -20 /app/app.log 2>/dev/null | while IFS= read -r _line; do
            log_debug "  $_line"
        done || true
        log_debug "[FATAL] Environment check (secrets redacted):"
        log_debug "  NEXTAUTH_SECRET set: $(test -n "$NEXTAUTH_SECRET" && echo 'yes (${#NEXTAUTH_SECRET} chars)' || echo 'NO')"
        log_debug "  SCRAPER_SERVICE_TOKEN set: $(test -n "$SCRAPER_SERVICE_TOKEN" && echo 'yes (${#SCRAPER_SERVICE_TOKEN} chars)' || echo 'NO')"
        log_debug "  ADMIN_PASSWORD set: $(test -n "$ADMIN_PASSWORD" && echo 'yes (${#ADMIN_PASSWORD} chars)' || echo 'NO')"
        log_debug "  DATABASE_URL set: $(test -n "$DATABASE_URL" && echo 'yes' || echo 'NO')"
        log_debug "  NODE_ENV=$NODE_ENV"
        log_debug "  DB_PROVIDER=$DB_PROVIDER"
    fi
}
trap _trap_exit EXIT

echo "=========================================="
echo "  Novel Management System (Production)"
echo "  Database: PostgreSQL"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "=========================================="
log_debug "Banner printed successfully"

# ─── Startup diagnostics (safe under set -e — all guarded) ───
_DIAG_MEM=$(cat /proc/meminfo 2>/dev/null | awk '/MemAvailable/{print $2}') || _DIAG_MEM="?"
echo "[DIAG] Memory available: ${_DIAG_MEM}KB"
log_debug "DIAG: Memory=${_DIAG_MEM}KB"

echo "[DIAG] Prisma CLI path: /app/node_modules/prisma/build/index.js"
log_debug "DIAG: Prisma CLI exists: $(test -f /app/node_modules/prisma/build/index.js && echo YES || echo NO)"
log_debug "DIAG: Schema exists: $(test -f /app/prisma/schema.prisma && echo YES || echo NO)"
log_debug "DIAG: server.js exists: $(test -f /app/server.js && echo YES || echo NO)"
log_debug "DIAG: @prisma/engines exists: $(test -d /app/node_modules/@prisma/engines && echo YES || echo NO)"
log_debug "DIAG: libquery_engine exists: $(test -f /app/node_modules/@prisma/engines/libquery_engine-debian-openssl-3.0.x.so.node && echo YES || echo NO)"
log_debug "DIAG: schema-engine exists: $(test -f /app/node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x && echo YES || echo NO)"
log_debug "DIAG: DATABASE_URL set: $(test -n "$DATABASE_URL" && echo YES || echo NO)"
echo "[DIAG] DATABASE_URL set: $(test -n "$DATABASE_URL" && echo YES || echo NO)"

# ─── Helper: log with timestamp ───
log() { log_debug "$*"; }

# ─── Prisma CLI — use LOCAL binary, NEVER bunx (which downloads latest) ───
# bunx prisma resolves to Prisma 7.x (latest) from npm, breaking our v6 schema.
# The Dockerfile copies node_modules/prisma from the builder stage.
_PRISMA="/app/node_modules/prisma/build/index.js"
if [ ! -f "$_PRISMA" ]; then
    log "[FATAL] Prisma CLI not found at $_PRISMA"
    log "[FATAL] The Dockerfile must COPY --from=builder /app/node_modules/prisma"
    exit 1
fi

# Check for critical @prisma/engines binaries
if [ ! -d "/app/node_modules/@prisma/engines" ]; then
    log "[FATAL] @prisma/engines directory not found!"
    log "[FATAL] The Dockerfile must COPY --from=builder /app/node_modules/@prisma/engines"
    exit 1
fi

log "[Prisma] Checking CLI version..."
_PRISMA_VER=$(bun "$_PRISMA" --version 2>&1 | head -1 || echo "FAILED")
log "[Prisma] Using local CLI: ${_PRISMA_VER:-unknown}"

# ─── Validate required secrets ───
# Machine secrets need ≥32 chars; admin password needs ≥8 chars
for _var in NEXTAUTH_SECRET SCRAPER_SERVICE_TOKEN; do
    _val="${!_var:-}"
    _val_len=${#_val}
    log "[Auth] Checking $_var (length: $_val_len)..."
    if [ "$_val_len" -lt 32 ]; then
        echo "[FATAL] $_var is not properly configured (too short: ${_val_len} chars, need ≥32)."
        echo "[FATAL] Edit your .env file and set a strong random value."
        exit 1
    fi
done
_val="${ADMIN_PASSWORD:-}"
_val_len=${#_val}
log "[Auth] ADMIN_PASSWORD length: $_val_len"
if [ "$_val_len" -lt 8 ]; then
    echo "[FATAL] ADMIN_PASSWORD is too short (${_val_len} chars, need ≥8)."
    echo "[FATAL] Edit your .env file and set a strong password."
    exit 1
fi
log "[Auth] All secrets validated."

# ─── Detect available memory and adjust runtime behavior ───
_AVAIL_MEM_KB=$(cat /proc/meminfo 2>/dev/null | awk '/MemAvailable/{print $2}')
_AVAIL_MEM_KB=${_AVAIL_MEM_KB:-524288}
_AVAIL_MEM_MB=$(( _AVAIL_MEM_KB / 1024 ))
log "[MEM] ${_AVAIL_MEM_MB}MB available"

if [ "$_AVAIL_MEM_MB" -lt 600 ]; then
    log "[MEM] Low memory detected, using sequential startup"
    _LOW_MEM=true
else
    _LOW_MEM=false
fi

# ─── Wait for PostgreSQL to be ready ───
# Extract host:port from DATABASE_URL (format: postgresql://user:pass@host:port/db)
_DB_HOST=$(echo "$DATABASE_URL" | sed -n 's|.*@\([^:]*\):\([0-9]*\)/.*|\1|p')
_DB_PORT=$(echo "$DATABASE_URL" | sed -n 's|.*@\([^:]*\):\([0-9]*\)/.*|\2|p')
_DB_HOST=${_DB_HOST:-postgres}
_DB_PORT=${_DB_PORT:-5432}
log "[DB] Waiting for PostgreSQL at ${_DB_HOST}:${_DB_PORT}..."

# TCP port check
_db_tcp_check() {
    # Method 1: nc (netcat-openbsd, installed in Dockerfile) — clean check
    nc -z -w2 "$1" "$2" 2>/dev/null && return 0
    # Method 2: bash /dev/tcp (built-in fallback, may cause PG log spam)
    (echo > /dev/tcp/"$1"/"$2") 2>/dev/null && return 0
    return 1
}

MAX_RETRIES=60
RETRY_COUNT=0

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    if _db_tcp_check "$_DB_HOST" "$_DB_PORT"; then
        log "[DB] PostgreSQL port is open!"
        break
    fi
    RETRY_COUNT=$((RETRY_COUNT + 1))
    [ $((RETRY_COUNT % 10)) -eq 0 ] && log "[DB] Attempt $RETRY_COUNT/$MAX_RETRIES..."
    sleep 2
done

if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
    log "[DB] ERROR: PostgreSQL unavailable after $((MAX_RETRIES * 2))s"
    log "[DB] Target: ${_DB_HOST}:${_DB_PORT}"
    log "[DB] Check that the postgres container is running: docker compose ps postgres"
    exit 1
fi

# ─── Sync Database Schema ───
log "[DB] Syncing schema with: bun $_PRISMA db push --accept-data-loss --schema ./prisma/schema.prisma"
cd /app
# NOTE: --skip-generate was removed in Prisma 6+. Omit it for compatibility.
if ! bun "$_PRISMA" db push --accept-data-loss --schema ./prisma/schema.prisma 2>&1; then
    log "[DB] Schema sync had warnings (usually safe, continuing)."
fi

# ─── Create pg_trgm extension + performance indexes ───
log "[DB] Creating extensions and indexes..."
echo "CREATE EXTENSION IF NOT EXISTS pg_trgm;" | bun "$_PRISMA" db execute --stdin --schema ./prisma/schema.prisma 2>/dev/null || true
echo "
CREATE INDEX IF NOT EXISTS idx_novel_title_trgm ON \"Novel\" USING gin(title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_novel_author_trgm ON \"Novel\" USING gin(author gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_scrape_rule_enabled ON \"ScrapeRule\"(enabled);
CREATE INDEX IF NOT EXISTS idx_scrape_rule_engine ON \"ScrapeRule\"(engine);
CREATE INDEX IF NOT EXISTS idx_ai_rule_created ON \"AiRuleGeneration\"(\"createdAt\");
" | bun "$_PRISMA" db execute --stdin --schema ./prisma/schema.prisma 2>/dev/null || true
log "[DB] Database ready."

# ─── Ensure data directories ───
mkdir -p /app/data/logs /app/data/covers /app/data/downloads /app/data/chapters /app/backups

# ─── Release Prisma/Bun memory before starting app processes ───
if $_LOW_MEM; then
    log "[MEM] Releasing memory after DB init..."
    sync 2>/dev/null || true
fi

# ─── Lazy-download Playwright Chromium (if build-time download failed) ───
_pw_chrome=$(find /app/.playwright-browsers -name chrome -type f 2>/dev/null | head -1)
if [ -z "$_pw_chrome" ]; then
    log "[Chromium] Not found in image, downloading at runtime..."
    _pw_json="/app/scraper-service/node_modules/playwright-core/browsers.json"
    if [ -f "$_pw_json" ]; then
        _pw_rev=$(grep -A1 '"name": "chromium"' "$_pw_json" | grep '"revision"' | head -1 | grep -o '[0-9]*')
        _pw_ver=$(grep -A1 '"name": "chromium"' "$_pw_json" | grep '"browserVersion"' | head -1 | grep -o '[0-9][^"]*')
        _pw_arch=$(uname -m)
        _pw_dir="/app/.playwright-browsers/chromium-${_pw_rev}"
        mkdir -p "$_pw_dir"
        if [ "$_pw_arch" = "x86_64" ]; then
            _pw_zip="chrome-linux64.zip"
            _pw_urls="https://cdn.playwright.dev/builds/cft/${_pw_ver}/linux64/${_pw_zip} https://playwright.download.prss.microsoft.com/dbazure/download/playwright/builds/cft/${_pw_ver}/linux64/${_pw_zip}"
        elif [ "$_pw_arch" = "aarch64" ]; then
            _pw_zip="chromium-linux-arm64.zip"
            _pw_urls="https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/${_pw_rev}/${_pw_zip} https://playwright.download.prss.microsoft.com/dbazure/download/playwright/builds/chromium/${_pw_rev}/${_pw_zip}"
        fi
        if [ -n "${_pw_urls:-}" ]; then
            for _pw_url in $_pw_urls; do
                log "[Chromium] Trying $_pw_url..."
                if curl -fsSL --connect-timeout 15 --max-time 600 "$_pw_url" -o /tmp/pw-chromium.zip 2>/dev/null; then
                    unzip -qo /tmp/pw-chromium.zip -d "$_pw_dir" 2>/dev/null && \
                        touch "$_pw_dir/INSTALLATION_COMPLETE" && \
                        log "[Chromium] Downloaded and installed" && \
                        break
                fi
                log "[Chromium] Failed, trying next mirror..."
            done
            rm -f /tmp/pw-chromium.zip 2>/dev/null
        fi
    else
        log "[Chromium] WARNING: browsers.json not found, cannot auto-download"
    fi
    _pw_chrome=$(find /app/.playwright-browsers -name chrome -type f 2>/dev/null | head -1)
    if [ -z "$_pw_chrome" ]; then
        log "[Chromium] WARNING: All download attempts failed. Headless scraping will be unavailable."
        log "[Chromium] To fix: docker exec novel-manager bash -c 'curl -fsSL https://cdn.playwright.dev/builds/cft/149.0.7827.55/linux64/chrome-linux64.zip -o /tmp/c.zip && unzip -qo /tmp/c.zip -d /app/.playwright-browsers/chromium-1228 && rm /tmp/c.zip'"
    else
        log "[Chromium] Ready: $_pw_chrome"
    fi
else
    log "[Chromium] Found in image: $_pw_chrome"
fi

# ─── Start Scraper Service ───
log "[Scraper] Starting on port 3099..."
cd /app/scraper-service
nohup bun index.ts > /app/data/logs/scraper-service.log 2>&1 &
SCRAPER_PID=$!
log "[Scraper] PID: $SCRAPER_PID"

sleep 2

if kill -0 "$SCRAPER_PID" 2>/dev/null; then
    log "[Scraper] Started."
    HAS_SCRAPER=true
else
    log "[Scraper] WARNING: Failed to start. Headless scraping unavailable."
    log "[Scraper] See /app/data/logs/scraper-service.log"
    SCRAPER_PID=""
    HAS_SCRAPER=false
fi

# ─── On low-mem: release memory before starting Next.js ───
if $_LOW_MEM; then
    sync 2>/dev/null || true
    # Try to drop page cache to free memory for Next.js
    # NOTE: Requires root — silently no-ops as appuser (non-root container).
    echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true
fi

# ─── Start Next.js ───
log "[App] Starting on port 3000..."
cd /app

# On low-mem servers, set runtime NODE_OPTIONS to limit V8 heap
_APP_NODE_OPTS=""
if $_LOW_MEM; then
    _APP_NODE_OPTS="--max-old-space-size=256"
    log "[MEM] Low-mem mode: NODE_OPTIONS=--max-old-space-size=256"
fi

log "[App] Running: env NODE_OPTIONS=\"$_APP_NODE_OPTS\" bun server.js"
nohup env NODE_OPTIONS="$_APP_NODE_OPTS" bun server.js > /app/app.log 2>&1 &
APP_PID=$!
log "[App] PID: $APP_PID"

sleep 3

if ! kill -0 "$APP_PID" 2>/dev/null; then
    log "[App] ERROR: Failed to start!"
    log "[App] Last 20 lines of app.log:"
    tail -20 /app/app.log 2>/dev/null | while IFS= read -r _line; do
        log "  $_line"
    done || true
    exit 1
fi

echo ""
echo "=========================================="
echo "  ✓ System is running!"
echo "  App:     http://0.0.0.0:3000"
if [ "$HAS_SCRAPER" = "true" ]; then echo "  Scraper: http://localhost:3099"; fi
echo "  DB:      PostgreSQL"
echo "  Memory:  ${_AVAIL_MEM_MB}MB available at start"
echo "=========================================="
log_debug "=== System running successfully ==="

# Disable the crash diagnostics trap — we're now running normally
trap - EXIT

# ─── Graceful Shutdown ───
cleanup() {
    echo ""
    log "[Shutdown] Stopping services (graceful, 15s timeout)..."
    kill -TERM "$APP_PID" 2>/dev/null || true
    [ -n "$SCRAPER_PID" ] && kill -TERM "$SCRAPER_PID" 2>/dev/null || true

    local timeout=15
    while [ $timeout -gt 0 ]; do
        local alive=false
        kill -0 "$APP_PID" 2>/dev/null && alive=true
        [ -n "$SCRAPER_PID" ] && kill -0 "$SCRAPER_PID" 2>/dev/null && alive=true
        $alive || break
        sleep 1
        timeout=$((timeout - 1))
    done

    kill -9 "$APP_PID" 2>/dev/null || true
    [ -n "$SCRAPER_PID" ] && kill -9 "$SCRAPER_PID" 2>/dev/null || true
    log "[Shutdown] Done."
    exit 0
}

trap cleanup SIGTERM SIGINT SIGQUIT

# ─── Main Loop: wait for the APP (primary) process ───
# Only watch APP_PID. If scraper dies, that's non-fatal.
wait "$APP_PID"
EXIT_CODE=$?
log "[App] Exited with code $EXIT_CODE"

# Try to stop scraper if still running
[ -n "$SCRAPER_PID" ] && kill -TERM "$SCRAPER_PID" 2>/dev/null || true
wait 2>/dev/null || true
exit $EXIT_CODE
