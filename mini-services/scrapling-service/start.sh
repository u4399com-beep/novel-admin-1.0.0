#!/usr/bin/env bash
# Start the Scrapling micro-service on port 3031
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="/home/z/.venv/bin/python3"

echo "Starting scrapling-service on port 3031..."
exec "$PYTHON" "$SCRIPT_DIR/app.py"
