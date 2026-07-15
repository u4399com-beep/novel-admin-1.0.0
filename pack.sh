#!/bin/bash
# ============================================================
# Novel Management System - Release Packager
# ============================================================
# Creates a self-contained tar.gz package that users can
# download, extract, and run install.sh to deploy.
#
# Usage:
#   chmod +x pack.sh
#   ./pack.sh
#
# Output: novel-admin-<version>-<date>.tar.gz
# ============================================================
set -e

# ─── Config ───
VERSION=$(grep '"version"' package.json 2>/dev/null | head -1 | grep -oP '\d+\.\d+\.\d+' || echo "1.0.0")
DATE=$(date +%Y%m%d)
PACK_NAME="novel-admin-${VERSION}-${DATE}"
TEMP_DIR="/tmp/${PACK_NAME}"

# ─── Colors ───
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'
BOLD='\033[1m'

info()  { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC} $*"; }

echo ""
echo -e "${BOLD}📦 Packaging Novel Admin v${VERSION}...${NC}"
echo ""

# ─── Clean old temp dir ───
rm -rf "$TEMP_DIR"
mkdir -p "$TEMP_DIR"

# ─── Copy project files ───
info "Copying project files..."

# Core app files
cp -r src/ "$TEMP_DIR/src/"
cp -r prisma/ "$TEMP_DIR/prisma/"
cp -r public/ "$TEMP_DIR/public/"
# Copy scraper service (exclude node_modules - Docker installs them)
mkdir -p "$TEMP_DIR/mini-services/scraper-service/src"
cp -r mini-services/scraper-service/src/ "$TEMP_DIR/mini-services/scraper-service/src/"
cp mini-services/scraper-service/package.json "$TEMP_DIR/mini-services/scraper-service/"
cp mini-services/scraper-service/bun.lock "$TEMP_DIR/mini-services/scraper-service/" 2>/dev/null || true
cp -r components.json "$TEMP_DIR/" 2>/dev/null || true

# Config files
cp package.json "$TEMP_DIR/"
cp bun.lock "$TEMP_DIR/" 2>/dev/null || true
cp tsconfig.json "$TEMP_DIR/"
cp next.config.ts "$TEMP_DIR/"
cp postcss.config.mjs "$TEMP_DIR/"
cp tailwind.config.ts "$TEMP_DIR/" 2>/dev/null || true
cp eslint.config.mjs "$TEMP_DIR/" 2>/dev/null || true

# Docker files
cp Dockerfile "$TEMP_DIR/"
cp docker-compose.yml "$TEMP_DIR/"
cp docker-entrypoint.sh "$TEMP_DIR/"
cp .dockerignore "$TEMP_DIR/"
cp .env.example "$TEMP_DIR/"
cp .env.production "$TEMP_DIR/"
cp install.sh "$TEMP_DIR/"
cp pack.sh "$TEMP_DIR/" 2>/dev/null || true

# Documentation
cp DEPLOY.md "$TEMP_DIR/" 2>/dev/null || true

# Make scripts executable
chmod +x "$TEMP_DIR/install.sh" "$TEMP_DIR/docker-entrypoint.sh"

# Create empty directories needed at runtime
mkdir -p "$TEMP_DIR/db"
mkdir -p "$TEMP_DIR/backups"

# ─── Remove unnecessary files ───
info "Cleaning up..."
cd "$TEMP_DIR"

# Remove test files
find . -name "*.test.*" -delete 2>/dev/null || true
find . -name "*.spec.*" -delete 2>/dev/null || true

# Remove any stray db files
rm -f db/*.db db/*.db-journal 2>/dev/null || true

# Remove search JSON artifacts
rm -f search_*.json 2>/dev/null || true

# Remove large binary files
rm -f *.deb 2>/dev/null || true

cd - > /dev/null

# ─── Calculate size ───
SRC_SIZE=$(du -sh "$TEMP_DIR" | cut -f1)

# ─── Create tarball ───
info "Creating archive (${SRC_SIZE})..."
tar czf "${PACK_NAME}.tar.gz" -C /tmp "$PACK_NAME"

# ─── Calculate final size ───
FINAL_SIZE=$(du -sh "${PACK_NAME}.tar.gz" | cut -f1)

# ─── Cleanup ───
rm -rf "$TEMP_DIR"

# ─── Done ───
echo ""
ok "Package created: ${BOLD}${PACK_NAME}.tar.gz${NC} (${FINAL_SIZE})"
echo ""
echo -e "  Deploy to server:"
echo -e "    scp ${PACK_NAME}.tar.gz user@server:/opt/"
echo -e "    ssh user@server"
echo -e "    cd /opt && tar xzf ${PACK_NAME}.tar.gz && cd ${PACK_NAME}"
echo -e "    chmod +x install.sh && ./install.sh"
echo ""