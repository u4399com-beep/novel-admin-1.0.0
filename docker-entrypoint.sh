#!/bin/bash
# ============================================================
# Novel Management System - Docker Entrypoint (Production)
# PostgreSQL + Next.js + Scraper Service
# Optimized for low-memory servers (1H1G)
# ============================================================
set -e

echo "=========================================="
echo "  Novel Management System (Production)"
echo "  Database: PostgreSQL"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "=========================================="

# ─── Helper: log with timestamp ───
log() { echo "[$(date '+%H:%M:%S')] $*"; }

# ─── Validate required secrets ───
# Machine secrets need ≥32 chars; admin password needs ≥8 chars
for _var in NEXTAUTH_SECRET SCRAPER_SERVICE_TOKEN; do
    _val="${!_var:-}"
    if [ ${#_val} -lt 32 ]; then
        echo "[FATAL] $_var is not properly configured (too short, need ≥32 chars)."
        echo "[FATAL] Edit your .env file and set a strong random value."
        exit 1
    fi
done
_val="${ADMIN_PASSWORD:-}"
if [ ${#_val} -lt 8 ]; then
    echo "[FATAL] ADMIN_PASSWORD is too short (need ≥8 chars)."
    echo "[FATAL] Edit your .env file and set a strong password."
    exit 1
fi

# ─── Detect available memory and adjust runtime behavior ───
_AVAIL_MEM_KB=$(cat /proc/meminfo 2>/dev/null | awk '/MemAvailable/{print $2}')
_AVAIL_MEM_KB=${_AVAIL_MEM_KB:-524288}
_AVAIL_MEM_MB=$(( _AVAIL_MEM_KB / 1024 ))

if [ "$_AVAIL_MEM_MB" -lt 600 ]; then
    log "[MEM] Low memory detected (${_AVAIL_MEM_MB}MB available)"
    log "[MEM] Using sequential startup with memory cleanup between services"
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
# IMPORTANT: Use nc -z FIRST — it does a clean TCP handshake without sending
# application data. The bash /dev/tcp method sends data to the port which causes
# PostgreSQL to log "incomplete startup packet" errors on every retry.
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
log "[DB] Syncing schema..."
cd /app
# NOTE: --skip-generate was removed in Prisma 6+. Omit it for compatibility.
bunx prisma db push --accept-data-loss --schema ./prisma/schema.prisma 2>&1 || \
    log "[DB] Schema sync had warnings (usually safe)."

# ─── Create pg_trgm extension + performance indexes ───
log "[DB] Creating extensions and indexes..."
echo "CREATE EXTENSION IF NOT EXISTS pg_trgm;" | bunx prisma db execute --stdin --schema ./prisma/schema.prisma 2>/dev/null || true
echo "
CREATE INDEX IF NOT EXISTS idx_novel_title_trgm ON \"Novel\" USING gin(title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_novel_author_trgm ON \"Novel\" USING gin(author gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_scrape_rule_enabled ON \"ScrapeRule\"(enabled);
CREATE INDEX IF NOT EXISTS idx_scrape_rule_engine ON \"ScrapeRule\"(engine);
CREATE INDEX IF NOT EXISTS idx_ai_rule_created ON \"AiRuleGeneration\"(\"createdAt\");
" | bunx prisma db execute --stdin --schema ./prisma/schema.prisma 2>/dev/null || true
log "[DB] Database ready."

# ─── Ensure data directories ───
mkdir -p /app/data/covers /app/data/downloads /app/data/chapters /app/backups

# ─── Release Prisma/Bun memory before starting app processes ───
if $_LOW_MEM; then
    log "[MEM] Releasing memory after DB init..."
    # Prisma generate keeps a lot in memory; the CLI process will exit naturally
    # but Bun's runtime may hold onto memory. This sync helps the OS reclaim it.
    sync 2>/dev/null || true
fi

# ─── Lazy-download Playwright Chromium (if build-time download failed) ───
# Uses the same curl+unzip logic as Dockerfile but runs at container start.
# This is the fallback — build-time download should succeed in most cases.
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
nohup bun index.ts > /app/scraper-service.log 2>&1 &
SCRAPER_PID=$!
log "[Scraper] PID: $SCRAPER_PID"

sleep 2

if kill -0 "$SCRAPER_PID" 2>/dev/null; then
    log "[Scraper] Started."
    HAS_SCRAPER=true
else
    log "[Scraper] WARNING: Failed to start. Headless scraping unavailable."
    log "[Scraper] See /app/scraper-service.log"
    SCRAPER_PID=""
    HAS_SCRAPER=false
fi

# ─── On low-mem: release memory before starting Next.js ───
if $_LOW_MEM; then
    sync 2>/dev/null || true
    # Try to drop page cache to free memory for Next.js
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

nohup env NODE_OPTIONS="$_APP_NODE_OPTS" bun .next/standalone/server.js > /app/app.log 2>&1 &
APP_PID=$!
log "[App] PID: $APP_PID"

sleep 3

if ! kill -0 "$APP_PID" 2>/dev/null; then
    log "[App] ERROR: Failed to start!"
    tail -20 /app/app.log 2>/dev/null || true
    exit 1
fi

echo ""
echo "=========================================="
echo "  ✓ System is running!"
echo "  App:     http://0.0.0.0:3000"
$HAS_SCRAPER && echo "  Scraper: http://localhost:3099"
echo "  DB:      PostgreSQL"
echo "  Memory:  ${_AVAIL_MEM_MB}MB available at start"
echo "=========================================="

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