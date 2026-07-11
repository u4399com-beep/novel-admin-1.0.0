#!/bin/bash
# ============================================================
# switch-to-postgres.sh - Switch from SQLite to PostgreSQL
# ============================================================
# Usage:  bash scripts/switch-to-postgres.sh
# This script modifies source files for PostgreSQL development.
# To revert:  bash scripts/switch-to-sqlite.sh
# ============================================================

set -e

echo "=========================================="
echo "  Switching to PostgreSQL..."
echo "=========================================="

cd "$(dirname "$0")/.."
PROJECT_ROOT=$(pwd)

# ─── 1. Update Prisma schema ───
echo "[1/4] Updating prisma/schema.prisma..."
if grep -q 'provider = "sqlite"' prisma/schema.prisma; then
    sed -i 's/provider = "sqlite"/provider = "postgresql"/' prisma/schema.prisma
    echo "  ✓ Changed provider to postgresql"
else
    echo "  ℹ Already using postgresql, skipping."
fi

# ─── 2. Update .env ───
echo "[2/4] Updating .env..."
if [ -f .env ]; then
    if grep -q '^DATABASE_URL=.*file:' .env; then
        # Ask for PostgreSQL connection string
        echo ""
        echo "  Enter your PostgreSQL connection string."
        echo "  Format: postgresql://user:password@host:5432/dbname"
        echo "  Example: postgresql://novel:novel123@localhost:5432/novel_admin"
        echo ""
        read -rp "  DATABASE_URL: " PG_URL

        if [ -z "$PG_URL" ]; then
            echo "  ✗ No URL provided. Using default: postgresql://novel:novel123@localhost:5432/novel_admin"
            PG_URL="postgresql://novel:novel123@localhost:5432/novel_admin"
        fi

        # Add connection pool params if not present
        if ! echo "$PG_URL" | grep -q "connection_limit"; then
            PG_URL="${PG_URL}?connection_limit=10&pool_timeout=30"
        fi

        sed -i "s|^DATABASE_URL=.*|DATABASE_URL=\"${PG_URL}\"|" .env
        echo "  ✓ DATABASE_URL updated"

        # Update DB_PROVIDER
        if grep -q '^DB_PROVIDER=' .env; then
            sed -i 's|^DB_PROVIDER=.*|DB_PROVIDER="postgresql"|' .env
        else
            echo 'DB_PROVIDER="postgresql"' >> .env
        fi
        echo "  ✓ DB_PROVIDER=postgresql"
    else
        echo "  ℹ DATABASE_URL already points to PostgreSQL, skipping."
    fi
else
    echo "  ✗ .env file not found! Copy .env.example to .env first."
    echo "    cp .env.example .env"
    exit 1
fi

# ─── 3. Regenerate Prisma client ───
echo "[3/4] Regenerating Prisma client for PostgreSQL..."
bunx prisma generate
echo "  ✓ Prisma client regenerated"

# ─── 4. Switch scraper queue to PostgreSQL ───
echo "[4/4] Switching scraper-service queue to PostgreSQL..."
QUEUE_FILE="mini-services/scraper-service/src/queue.ts"
QUEUE_PG="mini-services/scraper-service/src/queue.pg.ts"
QUEUE_SQLITE_BACKUP="mini-services/scraper-service/src/queue.sqlite.ts"

if [ -f "$QUEUE_FILE" ] && [ -f "$QUEUE_PG" ]; then
    # Check if current queue.ts is the SQLite version (contains 'bun:sqlite')
    if grep -q 'bun:sqlite' "$QUEUE_FILE"; then
        # Backup SQLite version
        cp "$QUEUE_FILE" "$QUEUE_SQLITE_BACKUP"
        # Replace with PostgreSQL version
        cp "$QUEUE_PG" "$QUEUE_FILE"
        echo "  ✓ Queue switched to PostgreSQL"
        echo "    (SQLite version backed up to queue.sqlite.ts)"
    else
        echo "  ℹ Queue already using PostgreSQL, skipping."
    fi
elif [ -f "$QUEUE_SQLITE_BACKUP" ] && [ -f "$QUEUE_PG" ]; then
    cp "$QUEUE_PG" "$QUEUE_FILE"
    echo "  ✓ Queue restored from queue.pg.ts"
else
    echo "  ✗ Missing queue files. Cannot switch."
    exit 1
fi

# ─── Push schema to database ───
echo ""
echo "[DB] Pushing schema to PostgreSQL..."
echo "  Make sure your PostgreSQL server is running before proceeding."
read -rp "  Push schema now? (y/N): " PUSH_NOW
if [ "$PUSH_NOW" = "y" ] || [ "$PUSH_NOW" = "Y" ]; then
    bunx prisma db push
    echo "  ✓ Schema pushed successfully"
fi

echo ""
echo "=========================================="
echo "  ✓ Switched to PostgreSQL!"
echo "=========================================="
echo ""
echo "  Next steps:"
echo "  1. Make sure PostgreSQL is running"
echo "  2. bun run dev       (start dev server)"
echo "  3. To revert:        bash scripts/switch-to-sqlite.sh"
echo ""