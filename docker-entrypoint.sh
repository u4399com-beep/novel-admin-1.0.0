#!/bin/bash
# ============================================================
# Novel Management System - Docker Entrypoint (Production)
# PostgreSQL + Next.js + Scraper Service
# ============================================================
set -e

echo "=========================================="
echo "  Novel Management System (Production)"
echo "  Database: PostgreSQL"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "=========================================="

# ─── Validate required secrets (docker-compose :? validates at start, but double-check) ───
for _var in NEXTAUTH_SECRET ADMIN_PASSWORD SCRAPER_SERVICE_TOKEN; do
    _val="${!_var:-}"
    if [ ${#_val} -lt 32 ] || echo "$_val" | grep -q "change-this"; then
        echo "[FATAL] $_var is not properly configured (too short or still default)."
        echo "[FATAL] Edit your .env file and set a strong random value."
        exit 1
    fi
done

# ─── Helper: log with timestamp ───
log() { echo "[$(date '+%H:%M:%S')] $*"; }

# ─── Wait for PostgreSQL to be ready ───
log "[DB] Waiting for PostgreSQL..."
MAX_RETRIES=60
RETRY_COUNT=0

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    if bunx prisma db execute --stdin <<< "SELECT 1" >/dev/null 2>&1; then
        log "[DB] PostgreSQL is ready!"
        break
    fi
    RETRY_COUNT=$((RETRY_COUNT + 1))
    [ $((RETRY_COUNT % 10)) -eq 0 ] && log "[DB] Attempt $RETRY_COUNT/$MAX_RETRIES..."
    sleep 2
done

if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
    log "[DB] ERROR: PostgreSQL unavailable after $((MAX_RETRIES * 2))s"
    log "[DB] Check DATABASE_URL and that the postgres container is running."
    exit 1
fi

# ─── Sync Database Schema ───
log "[DB] Syncing schema..."
cd /app
bunx prisma db push --skip-generate --accept-data-loss 2>&1 || \
    log "[DB] Schema sync had warnings (usually safe)."

# ─── Create pg_trgm extension + performance indexes ───
log "[DB] Creating extensions and indexes..."
bunx prisma db execute --stdin <<< "CREATE EXTENSION IF NOT EXISTS pg_trgm;" 2>/dev/null || true
bunx prisma db execute --stdin <<< "
CREATE INDEX IF NOT EXISTS idx_novel_title_trgm ON \"Novel\" USING gin(title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_novel_author_trgm ON \"Novel\" USING gin(author gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_scrape_rule_enabled ON \"ScrapeRule\"(enabled);
CREATE INDEX IF NOT EXISTS idx_scrape_rule_engine ON \"ScrapeRule\"(engine);
CREATE INDEX IF NOT EXISTS idx_ai_rule_created ON \"AiRuleGeneration\"(\"createdAt\");
" 2>/dev/null || true
log "[DB] Database ready."

# ─── Ensure data directories ───
mkdir -p /app/data/covers /app/data/downloads /app/data/chapters /app/backups

# ─── Start Scraper Service ───
log "[Scraper] Starting on port 3099..."
cd /app/scraper-service
nohup bun index.ts > /app/scraper-service.log 2>&1 &
SCRAPER_PID=$!
log "[Scraper] PID: $SCRAPER_PID"

sleep 3

if kill -0 "$SCRAPER_PID" 2>/dev/null; then
    log "[Scraper] Started."
    HAS_SCRAPER=true
else
    log "[Scraper] WARNING: Failed to start. Headless scraping unavailable."
    log "[Scraper] See /app/scraper-service.log"
    SCRAPER_PID=""
    HAS_SCRAPER=false
fi

# ─── Start Next.js ───
log "[App] Starting on port 3000..."
cd /app
nohup bun .next/standalone/server.js > /app/app.log 2>&1 &
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