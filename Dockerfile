# ============================================================
# Novel Management System - Production Docker Build
# Multi-stage: deps → build → scraper-build → runner
# Database: PostgreSQL (auto-switched from SQLite at build time)
# ============================================================
# Build:  docker compose build
# Run:    docker compose up -d
# Logs:   docker compose logs -f
# ============================================================

# ============ Base Stage ============
FROM oven/bun:1 AS base
WORKDIR /app
ENV BUN_INSTALL="/usr/local/bun"

# ============ Dependencies Stage ============
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ============ Build Stage ============
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# --- Switch Prisma schema to PostgreSQL ---
RUN sed -i 's/provider = "sqlite"/provider = "postgresql"/' prisma/schema.prisma

# Generate Prisma client for PostgreSQL
RUN bun run db:generate

# Build Next.js (standalone output)
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
# Limit V8 heap to prevent OOM on low-memory servers (1-2GB)
ENV NODE_OPTIONS="--max-old-space-size=1024"
RUN bun run build

# ============ Scraper Service Builder ============
FROM oven/bun:1 AS scraper-builder
WORKDIR /scraper
COPY mini-services/scraper-service/package.json mini-services/scraper-service/bun.lock ./
RUN bun install --frozen-lockfile
COPY mini-services/scraper-service/ ./

# Replace SQLite queue with PostgreSQL queue
RUN rm -f src/queue.ts && mv src/queue.pg.ts src/queue.ts

# Install Chromium system dependencies explicitly
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libatspi2.0-0 \
    libx11-6 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
    libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# ── Download Playwright Chromium (LOW MEMORY) ──
# WHY NOT `bunx playwright install chromium`:
#   bunx loads the 73K-line playwright-core bundle into memory,
#   then downloads + extracts a ~150MB zip — total ~1.5GB RAM spike.
#   On 2GB servers this causes OOM during docker build.
#
# SOLUTION: Pure curl + unzip — constant ~20MB RAM, works on 512MB servers.
#
# How it works:
#   1. Read chromium revision + browserVersion from browsers.json
#   2. Construct the CDN URL (same logic as playwright-core's registry)
#   3. curl the zip, unzip to the exact directory playwright expects
#   4. Create the INSTALLATION_COMPLETE marker file
#
# Supports: debian x64 (cftUrl format) + debian arm64 (legacy format)

ENV PLAYWRIGHT_BROWSERS_PATH=/scraper/.playwright-browsers

RUN set -ex && \
    ARCH=$(uname -m) && \
    BROWSERS_JSON="node_modules/playwright-core/browsers.json" && \
    REVISION=$(grep -A1 '"name": "chromium"' "$BROWSERS_JSON" | grep '"revision"' | head -1 | grep -o '[0-9]*') && \
    BROWSER_VERSION=$(grep -A1 '"name": "chromium"' "$BROWSERS_JSON" | grep '"browserVersion"' | head -1 | grep -o '[0-9][^"]*') && \
    echo "Chromium revision=${REVISION} version=${BROWSER_VERSION} arch=${ARCH}" && \
    BROWSER_DIR="${PLAYWRIGHT_BROWSERS_PATH}/chromium-${REVISION}" && \
    mkdir -p "$BROWSER_DIR" && \
    if [ "$ARCH" = "x86_64" ]; then \
        # Debian x64 uses CFT (Chrome for Testing) URLs
        ZIP_NAME="chrome-linux64.zip" && \
        EXTRACT_DIR="chrome-linux64" && \
        URLS="https://cdn.playwright.dev/builds/cft/${BROWSER_VERSION}/linux64/${ZIP_NAME} \
              https://playwright.download.prss.microsoft.com/dbazure/download/playwright/builds/cft/${BROWSER_VERSION}/linux64/${ZIP_NAME}"; \
    elif [ "$ARCH" = "aarch64" ]; then \
        # ARM64 uses legacy playwright build URLs
        ZIP_NAME="chromium-linux-arm64.zip" && \
        EXTRACT_DIR="chrome-linux" && \
        URLS="https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/${REVISION}/${ZIP_NAME} \
              https://playwright.download.prss.microsoft.com/dbazure/download/playwright/builds/chromium/${REVISION}/${ZIP_NAME}"; \
    else \
        echo "[WARN] Unsupported arch ${ARCH} for Playwright Chromium" && exit 0; \
    fi && \
    DOWNLOADED=false && \
    for URL in $URLS; do \
        echo "Trying ${URL}..." && \
        if curl -fsSL --connect-timeout 15 --max-time 600 "$URL" -o /tmp/pw-chromium.zip; then \
            echo "Download OK ($(du -h /tmp/pw-chromium.zip | cut -f1))" && \
            unzip -qo /tmp/pw-chromium.zip -d "$BROWSER_DIR" && \
            DOWNLOADED=true && \
            break; \
        fi; \
    done && \
    rm -f /tmp/pw-chromium.zip && \
    if $DOWNLOADED && [ -f "${BROWSER_DIR}/${EXTRACT_DIR}/chrome" ]; then \
        touch "${BROWSER_DIR}/INSTALLATION_COMPLETE" && \
        echo "Chromium installed: ${BROWSER_DIR}/${EXTRACT_DIR}/chrome" && \
        ls -lh "${BROWSER_DIR}/${EXTRACT_DIR}/chrome"; \
    else \
        echo "[WARN] Chromium download/extract failed - headless scraping will be unavailable at runtime" && \
        echo "[WARN] The container will attempt to download it on first start"; \
    fi

# ============ Production Runner ============
FROM oven/bun:1 AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV BUN_NO_UPDATE_NOTIF=1
ENV DB_PROVIDER=postgresql

# Install runtime dependencies: curl for healthchecks, ca-certificates for HTTPS,
# libssl3 for Prisma/PostgreSQL, + Chromium system libs for Playwright
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    libssl3 \
    libnss3 \
    libnspr4 \
    libdbus-1-3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libatspi2.0-0 \
    libx11-6 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user (groupadd/useradd from passwd pkg, always available)
RUN groupadd --system --gid 1001 appuser && \
    useradd --system --uid 1001 --gid appuser --no-create-home --shell /usr/sbin/nologin appuser

# Copy Next.js standalone output
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Copy Prisma schema and client (needed for db push on first start)
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma

# Copy scraper service (PostgreSQL queue already swapped)
COPY --from=scraper-builder /scraper ./scraper-service

# Copy Playwright browser cache (under /app so chown covers it)
COPY --from=scraper-builder /scraper/.playwright-browsers /app/.playwright-browsers
ENV PLAYWRIGHT_BROWSERS_PATH=/app/.playwright-browsers

# Create data directories and set ownership
RUN mkdir -p /app/data/covers /app/data/downloads /app/data/chapters /app/backups && \
    chown -R appuser:appuser /app

# Copy and set permissions for entrypoint BEFORE switching user
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh && \
    chown appuser:appuser /app/docker-entrypoint.sh

# Switch to non-root user
USER appuser

# Expose port
EXPOSE 3000

# Default environment (overridden by docker-compose)
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Health check
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=60s \
    CMD curl -f http://localhost:3000/api/auth/csrf || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]