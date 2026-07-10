#!/bin/sh
set -e

echo "=========================================="
echo "  Novel Management System - Starting"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "=========================================="

# Ensure data directory exists
mkdir -p /app/data/db

# Initialize database
if [ ! -f "/app/data/db/custom.db" ]; then
    echo "[Init] Creating database schema..."
    cd /app && bunx prisma db push --skip-generate 2>&1
    echo "[Init] Database created successfully."
else
    echo "[Init] Database exists, checking schema updates..."
    cd /app && bunx prisma db push --skip-generate 2>&1 || echo "[Init] Schema push completed with warnings (non-fatal)."
    echo "[Init] Schema check complete."
fi

# Start scraper service in background
echo "[Scraper] Starting scraper service on port 3099..."
cd /app/scraper-service && bun index.ts &
SCRAPER_PID=$!
echo "[Scraper] PID: $SCRAPER_PID"

# Wait for scraper to initialize
sleep 2

# Verify scraper is running
if kill -0 "$SCRAPER_PID" 2>/dev/null; then
    echo "[Scraper] Service started successfully."
else
    echo "[Scraper] WARNING: Scraper service failed to start. Continuing without scraper."
fi

# Start Next.js application
echo "[App] Starting Next.js application on port 3000..."
cd /app && HOSTNAME="0.0.0.0" PORT=3000 bun .next/standalone/server.js &
APP_PID=$!
echo "[App] PID: $APP_PID"

# Graceful shutdown handler
cleanup() {
    echo ""
    echo "[Shutdown] Received shutdown signal, stopping services gracefully..."
    kill -TERM "$APP_PID" 2>/dev/null
    kill -TERM "$SCRAPER_PID" 2>/dev/null

    # Wait up to 15 seconds for graceful shutdown
    TIMEOUT=15
    while [ $TIMEOUT -gt 0 ]; do
        if ! kill -0 "$APP_PID" 2>/dev/null && ! kill -0 "$SCRAPER_PID" 2>/dev/null; then
            break
        fi
        sleep 1
        TIMEOUT=$((TIMEOUT - 1))
    done

    # Force kill if still running
    kill -9 "$APP_PID" 2>/dev/null || true
    kill -9 "$SCRAPER_PID" 2>/dev/null || true

    echo "[Shutdown] All services stopped."
    exit 0
}

trap cleanup SIGTERM SIGINT SIGQUIT

# Wait for either process to exit
wait -n "$APP_PID" "$SCRAPER_PID" 2>/dev/null

# If one exits, shut down the other
EXIT_CODE=$?
echo "[Error] A service process exited unexpectedly (code: $EXIT_CODE). Shutting down..."
kill -TERM "$APP_PID" 2>/dev/null
kill -TERM "$SCRAPER_PID" 2>/dev/null
wait 2>/dev/null
exit 1