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

# ─── Helper: log with timestamp ───
log() {
    echo "[$(date '+%H:%M:%S')] $*"
}

# ─── Wait for PostgreSQL to be ready ───
log "[DB] Waiting for PostgreSQL to be ready..."
MAX_RETRIES=60
RETRY_COUNT=0
DB_HOST=$(echo "$DATABASE_URL" | sed -n 's|.*/@\([^:]*\):.*|\1|p')

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    # Try to connect using the DATABASE_URL
    if bunx prisma db execute --stdin <<< "SELECT 1" > /dev/null 2>&1; then
        log "[DB] PostgreSQL is ready!"
        break
    fi

    # Fallback: check if host is resolvable
    if getent hosts "$DB_HOST" > /dev/null 2>&1; then
        if command -v pg_isready > /dev/null 2>&1; then
            if pg_isready -h "$DB_HOST" -t 2 > /dev/null 2>&1; then
                log "[DB] PostgreSQL port is reachable!"
                break
            fi
        fi
    fi

    RETRY_COUNT=$((RETRY_COUNT + 1))
    if [ $((RETRY_COUNT % 10)) -eq 0 ]; then
        log "[DB] Attempt $RETRY_COUNT/$MAX_RETRIES - PostgreSQL not ready, waiting..."
    fi
    sleep 2
done

if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
    log "[DB] ERROR: PostgreSQL is not available after $((MAX_RETRIES * 2)) seconds."
    log "[DB] Please check your DATABASE_URL and ensure the PostgreSQL container is running."
    exit 1
fi

# ─── Initialize / Update Database Schema ───
log "[DB] Syncing database schema..."
cd /app
if bunx prisma db push --skip-generate --accept-data-loss 2>&1; then
    log "[DB] Schema sync completed successfully."
else
    log "[DB] Schema sync encountered warnings (this is usually safe)."
fi

# ─── Create pg_trgm extension for search (if PostgreSQL) ───
log "[DB] Ensuring pg_trgm extension is enabled..."
bunx prisma db execute --stdin <<< "CREATE EXTENSION IF NOT EXISTS pg_trgm;" 2>/dev/null || true

# ─── Create performance indexes ───
log "[DB] Creating performance indexes..."
bunx prisma db execute --stdin <<< "
CREATE INDEX IF NOT EXISTS idx_novel_title_trgm ON \"Novel\" USING gin(title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_novel_author_trgm ON \"Novel\" USING gin(author gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_scrape_rule_enabled ON \"ScrapeRule\"(enabled);
CREATE INDEX IF NOT EXISTS idx_scrape_rule_engine ON \"ScrapeRule\"(engine);
CREATE INDEX IF NOT EXISTS idx_ai_rule_created ON \"AiRuleGeneration\"(\"createdAt\");
" 2>/dev/null || log "[DB] Some indexes may already exist (non-fatal)."
log "[DB] Database initialization complete."

# ─── Ensure data directories exist ───
mkdir -p /app/data/covers /app/data/downloads /app/data/chapters /app/backups

# ─── Start Scraper Service ───
log "[Scraper] Starting scraper service on port 3099..."
cd /app/scraper-service
SCRAPER_PID=""
nohup bun index.ts > /app/scraper-service.log 2>&1 &
SCRAPER_PID=$!
log "[Scraper] PID: $SCRAPER_PID"

# Wait for scraper to initialize
sleep 3

if kill -0 "$SCRAPER_PID" 2>/dev/null; then
    log "[Scraper] Service started successfully."
else
    log "[Scraper] WARNING: Scraper service failed to start. Continuing without scraper."
    log "[Scraper] Check /app/scraper-service.log for details."
fi

# ─── Start Next.js Application ───
log "[App] Starting Next.js application on port 3000..."
cd /app
APP_PID=""
nohup bun .next/standalone/server.js > /app/app.log 2>&1 &
APP_PID=$!
log "[App] PID: $APP_PID"

# Wait a moment for Next.js to start
sleep 3

if kill -0 "$APP_PID" 2>/dev/null; then
    echo ""
    echo "=========================================="
    echo "  ✓ System is running!"
    echo "  App:     http://0.0.0.0:3000"
    echo "  Scraper: http://localhost:3099"
    echo "  DB:      PostgreSQL"
    echo "=========================================="
else
    log "[App] ERROR: Next.js failed to start! Check /app/app.log"
    # Show last 20 lines of app log for debugging
    tail -20 /app/app.log 2>/dev/null || true
    exit 1
fi

# ─── Graceful Shutdown Handler ───
cleanup() {
    echo ""
    log "[Shutdown] Received shutdown signal, stopping services..."
    log "[Shutdown] Waiting for active requests to complete (max 15s)..."

    kill -TERM "$APP_PID" 2>/dev/null || true
    kill -TERM "$SCRAPER_PID" 2>/dev/null || true

    TIMEOUT=15
    while [ $TIMEOUT -gt 0 ]; do
        APP_ALIVE=false
        SCRAPER_ALIVE=false
        kill -0 "$APP_PID" 2>/dev/null && APP_ALIVE=true
        kill -0 "$SCRAPER_PID" 2>/dev/null && SCRAPER_ALIVE=true

        if [ "$APP_ALIVE" = false ] && [ "$SCRAPER_ALIVE" = false ]; then
            break
        fi
        sleep 1
        TIMEOUT=$((TIMEOUT - 1))
    done

    # Force kill if still running
    kill -9 "$APP_PID" 2>/dev/null || true
    kill -9 "$SCRAPER_PID" 2>/dev/null || true

    log "[Shutdown] All services stopped. Goodbye!"
    exit 0
}

trap cleanup SIGTERM SIGINT SIGQUIT

# ─── Main Loop: Wait for either process to exit ───
wait -n "$APP_PID" "$SCRAPER_PID" 2>/dev/null

EXIT_CODE=$?
log "[Error] A service process exited unexpectedly (code: $EXIT_CODE). Shutting down..."
kill -TERM "$APP_PID" 2>/dev/null || true
kill -TERM "$SCRAPER_PID" 2>/dev/null || true
wait 2>/dev/null
exit 1