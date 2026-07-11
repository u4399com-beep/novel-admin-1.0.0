#!/bin/bash
# ============================================================
# switch-to-sqlite.sh - Switch from PostgreSQL back to SQLite
# ============================================================
# Usage:  bash scripts/switch-to-sqlite.sh
# This script reverts source files back to SQLite for development.
# ============================================================

set -e

echo "=========================================="
echo "  Switching to SQLite (development mode)..."
echo "=========================================="

cd "$(dirname "$0")/.."
PROJECT_ROOT=$(pwd)

# ─── 1. Update Prisma schema ───
echo "[1/4] Updating prisma/schema.prisma..."
if grep -q 'provider = "postgresql"' prisma/schema.prisma; then
    sed -i 's/provider = "postgresql"/provider = "sqlite"/' prisma/schema.prisma
    echo "  ✓ Changed provider to sqlite"
else
    echo "  ℹ Already using sqlite, skipping."
fi

# ─── 2. Update .env ───
echo "[2/4] Updating .env..."
if [ -f .env ]; then
    sed -i 's|^DATABASE_URL=.*|DATABASE_URL="file:./db/custom.db"|' .env
    echo "  ✓ DATABASE_URL set to file:./db/custom.db"

    if grep -q '^DB_PROVIDER=' .env; then
        sed -i 's|^DB_PROVIDER=.*|DB_PROVIDER="sqlite"|' .env
    else
        echo 'DB_PROVIDER="sqlite"' >> .env
    fi
    echo "  ✓ DB_PROVIDER=sqlite"
else
    echo "  ✗ .env file not found!"
    exit 1
fi

# ─── 3. Regenerate Prisma client ───
echo "[3/4] Regenerating Prisma client for SQLite..."
bunx prisma generate
echo "  ✓ Prisma client regenerated"

# ─── 4. Switch scraper queue to SQLite ───
echo "[4/4] Switching scraper-service queue to SQLite..."
QUEUE_FILE="mini-services/scraper-service/src/queue.ts"
QUEUE_SQLITE_BACKUP="mini-services/scraper-service/src/queue.sqlite.ts"

if [ -f "$QUEUE_SQLITE_BACKUP" ]; then
    cp "$QUEUE_SQLITE_BACKUP" "$QUEUE_FILE"
    echo "  ✓ Queue restored to SQLite version"
elif grep -q 'bun:sqlite' "$QUEUE_FILE"; then
    echo "  ℹ Queue already using SQLite, skipping."
else
    echo "  ✗ SQLite queue backup not found at $QUEUE_SQLITE_BACKUP"
    echo "  You may need to manually restore the queue.ts file."
    exit 1
fi

# ─── Push schema to SQLite ───
echo ""
echo "[DB] Syncing SQLite schema..."
bunx prisma db push
echo "  ✓ Schema synced"

echo ""
echo "=========================================="
echo "  ✓ Switched to SQLite (development mode)!"
echo "=========================================="
echo ""
echo "  Run:  bun run dev"
echo ""