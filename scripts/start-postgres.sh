#!/bin/bash
# PostgreSQL startup script for development environment
# Starts the local PostgreSQL instance before the Next.js app

export PGHOME="$HOME/.local/pgsql"
export PATH="$PGHOME/bin:$PATH"
export LD_LIBRARY_PATH="$PGHOME/lib:${LD_LIBRARY_PATH:-}"
export PGPORT=5432

# Check if PostgreSQL is already running
if $PGHOME/bin/pg_isready -h localhost -p $PGPORT >/dev/null 2>&1; then
  echo "✅ PostgreSQL is already running on port $PGPORT"
else
  echo "🚀 Starting PostgreSQL..."
  $PGHOME/bin/pg_ctl -D "$PGHOME/data" -l "$PGHOME/data/postgresql.log" start 2>&1
  
  # Wait for it to be ready
  for i in $(seq 1 10); do
    if $PGHOME/bin/pg_isready -h localhost -p $PGPORT >/dev/null 2>&1; then
      echo "✅ PostgreSQL started successfully on port $PGPORT"
      break
    fi
    sleep 0.5
  done
  
  if ! $PGHOME/bin/pg_isready -h localhost -p $PGPORT >/dev/null 2>&1; then
    echo "❌ Failed to start PostgreSQL. Check $PGHOME/data/postgresql.log"
    exit 1
  fi
fi

echo "📦 Database: novel_admin"
$PGHOME/bin/psql -h localhost -p $PGPORT -d novel_admin -c "SELECT 1" >/dev/null 2>&1 && echo "✅ Database connection verified" || echo "⚠️  Database 'novel_admin' not found. Run: createdb -h localhost novel_admin"