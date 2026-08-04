#!/usr/bin/env bash
# Start the Translate micro-service on port 3032
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="/home/z/.venv/bin/python3"

echo "Starting translate-service on port 3032..."
exec "$PYTHON" "$SCRIPT_DIR/app.py"
