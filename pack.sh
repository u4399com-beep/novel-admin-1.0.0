#!/usr/bin/env bash
# ============================================================
# Novel Admin - Release Packager
# ============================================================
# Creates a self-contained tar.gz for offline deployment.
#
# Usage:
#   chmod +x pack.sh && ./pack.sh
#
# Output: novel-admin-<version>-<date>.tar.gz
# ============================================================
set -e

VERSION=$(grep '"version"' package.json 2>/dev/null | head -1 | grep -oP '\d+\.\d+\.\d+' || echo "1.0.0")
DATE=$(date +%Y%m%d)
PACK_NAME="novel-admin-${VERSION}-${DATE}"
TEMP_DIR="/tmp/${PACK_NAME}"

G='\033[0;32m' B='\033[0;34m' BD='\033[1m' N='\033[0m'
info() { echo -e "${B}[INFO]${N} $*"; }
ok()   { echo -e "${G}  ✓${N} $*"; }

echo ""
echo -e "${BD}📦 打包 Novel Admin v${VERSION}...${N}"
echo ""

rm -rf "$TEMP_DIR"; mkdir -p "$TEMP_DIR"

# ── Copy files ──
info "复制项目文件..."

# App source
cp -r src/ "$TEMP_DIR/src/"
cp -r prisma/ "$TEMP_DIR/prisma/"
cp -r public/ "$TEMP_DIR/public/"

# Scraper (no node_modules)
mkdir -p "$TEMP_DIR/mini-services/scraper-service/src"
cp -r mini-services/scraper-service/src/ "$TEMP_DIR/mini-services/scraper-service/src/"
cp mini-services/scraper-service/package.json "$TEMP_DIR/mini-services/scraper-service/"
cp mini-services/scraper-service/bun.lock "$TEMP_DIR/mini-services/scraper-service/" 2>/dev/null || true

# Config
for f in package.json bun.lock tsconfig.json next.config.ts postcss.config.mjs \
         tailwind.config.ts eslint.config.mjs components.json .env.example .env.production; do
    [ -f "$f" ] && cp "$f" "$TEMP_DIR/"
done

# Docker
for f in Dockerfile docker-compose.yml docker-entrypoint.sh .dockerignore; do
    [ -f "$f" ] && cp "$f" "$TEMP_DIR/"
done

# Deploy scripts (PRIMARY = deploy.sh)
cp deploy.sh "$TEMP_DIR/"
cp install.sh "$TEMP_DIR/" 2>/dev/null || true
cp DEPLOY.md "$TEMP_DIR/" 2>/dev/null || true

chmod +x "$TEMP_DIR/deploy.sh" "$TEMP_DIR/install.sh" 2>/dev/null || true
chmod +x "$TEMP_DIR/docker-entrypoint.sh" 2>/dev/null || true

mkdir -p "$TEMP_DIR/db" "$TEMP_DIR/backups"

# ── Clean ──
info "清理..."
cd "$TEMP_DIR"
find . -name "*.test.*" -delete 2>/dev/null || true
find . -name "*.spec.*" -delete 2>/dev/null || true
rm -f db/*.db db/*.db-journal search_*.json *.deb 2>/dev/null || true
cd - > /dev/null

# ── Pack ──
SRC_SIZE=$(du -sh "$TEMP_DIR" | cut -f1)
info "压缩 (${SRC_SIZE})..."
tar czf "${PACK_NAME}.tar.gz" -C /tmp "$PACK_NAME"
FINAL_SIZE=$(du -sh "${PACK_NAME}.tar.gz" | cut -f1)
rm -rf "$TEMP_DIR"

echo ""
ok "打包完成: ${BD}${PACK_NAME}.tar.gz${N} (${FINAL_SIZE})"
echo ""
echo -e "  部署到服务器:"
echo -e "    ${B}scp${N} ${PACK_NAME}.tar.gz user@server:/tmp/"
echo -e "    ${B}ssh${N} user@server"
echo -e "    cd /opt && tar xzf /tmp/${PACK_NAME}.tar.gz && cd ${PACK_NAME}"
echo -e "    chmod +x deploy.sh && ${B}./deploy.sh${N}"
echo ""
echo -e "  全部默认值:  ${B}./deploy.sh -y${N}"
echo -e "  自定义目录:   ${B}./deploy.sh -d /data/novel-admin${N}"
echo ""