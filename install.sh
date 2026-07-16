#!/usr/bin/env bash
# ============================================================
# Legacy wrapper — redirects to deploy.sh
# ============================================================
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "${SCRIPT_DIR}/deploy.sh" ]; then
    exec bash "${SCRIPT_DIR}/deploy.sh" "$@"
else
    echo "[ERROR] deploy.sh not found in ${SCRIPT_DIR}" >&2
    exit 1
fi