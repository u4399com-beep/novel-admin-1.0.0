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
RUN bun run build

# ============ Scraper Service Builder ============
FROM oven/bun:1 AS scraper-builder
WORKDIR /scraper
COPY mini-services/scraper-service/package.json mini-services/scraper-service/bun.lock ./
RUN bun install --frozen-lockfile
COPY mini-services/scraper-service/ ./

# Replace SQLite queue with PostgreSQL queue
RUN rm -f src/queue.ts && mv src/queue.pg.ts src/queue.ts

# Install Chromium system dependencies explicitly (avoids --with-deps failures in China)
# These must match what playwright install --with-deps would install
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libatspi2.0-0 \
    libx11-6 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
    libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 \
    && rm -rf /var/lib/apt/lists/*

# Install Playwright Chromium browser
# If download fails (network), scraper will still start but headless mode won't work
ENV PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright
RUN bunx playwright install chromium || \
    (echo "[WARN] Playwright Chromium download failed - headless scraping unavailable" && \
     echo "[WARN] This usually means the download server is unreachable" && \
     mkdir -p /root/.cache/ms-playwright)

# ============ Production Runner ============
FROM oven/bun:1 AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV BUN_NO_UPDATE_NOTIF=1
ENV DB_PROVIDER=postgresql

# Install runtime dependencies: curl for health checks, ca-certificates for HTTPS,
# libssl for Prisma/PostgreSQL, and Playwright browser system libs for Chromium
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
    && rm -rf /var/lib/apt/lists/*

# Create non-root user for security (use groupadd/useradd — available on all Debian)
RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 --gid nodejs --no-create-home nextjs

# Copy Next.js standalone output
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Copy Prisma schema and client (needed for db push on first start)
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma

# Copy scraper service (with PostgreSQL queue already swapped)
COPY --from=scraper-builder /scraper ./scraper-service

# Copy Playwright browser cache for headless scraping
COPY --from=scraper-builder /root/.cache/ms-playwright /root/.cache/ms-playwright

# Set Playwright browser path
ENV PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright

# Create data directories
RUN mkdir -p /app/data/covers /app/data/downloads /app/data/chapters /app/backups && \
    chown -R nextjs:nodejs /app

USER nextjs

# Expose port
EXPOSE 3000

# Default environment (overridden by docker-compose)
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Health check
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=60s \
    CMD curl -f http://localhost:3000/api/auth/csrf || exit 1

# Start via entrypoint script
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

ENTRYPOINT ["/app/docker-entrypoint.sh"]