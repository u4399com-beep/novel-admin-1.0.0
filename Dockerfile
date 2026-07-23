# ============================================================
# Novel Management System - LOW MEMORY Docker Build
# Hardware-adaptive: build args control memory usage per tier
#
# Key optimizations vs standard Dockerfile:
#   1. Chromium NOT downloaded at build time (runtime-only, saves ~200MB build RAM)
#   2. V8 heap capped via BUILD_ARG (default 512MB, deploy.sh sets lower for 1H1G)
#   3. NEXT_WORKER_THREADS=1 for single-threaded build
#   4. BUN_GC_THRESHOLD for aggressive GC during bun install
#   5. Minimal runtime deps (no Chromium libs in image)
#   6. 3 stages: deps → builder → runner
#
# Build Args (set by deploy.sh based on detected hardware):
#   NODE_MAX_OLD_SPACE_SIZE  — V8 heap cap during Next.js build
#   BUN_GC_THRESHOLD        — Bun GC threshold during bun install
# ============================================================

# ============ Stage 1: Dependencies ============
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
# Lower GC threshold so Bun releases memory more aggressively on low-mem servers
ARG BUN_GC_THRESHOLD=100mb
ENV BUN_GC_THRESHOLD=${BUN_GC_THRESHOLD}
RUN bun install --frozen-lockfile

# ============ Stage 2: Build ============
FROM oven/bun:1 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Switch Prisma schema to PostgreSQL
RUN sed -i 's/provider = "sqlite"/provider = "postgresql"/' prisma/schema.prisma

# Generate Prisma client
# CRITICAL: Use the LOCAL prisma binary directly (./node_modules/prisma/build/index.js).
# 'bun run db:generate' expands to 'npx prisma generate', and npx/bunx
# downloads the LATEST prisma CLI (7.x) from npm, overwriting our v6 install.
# Prisma 7 breaks schema.prisma 'url' property → build failure.
RUN ./node_modules/prisma/build/index.js generate --schema ./prisma/schema.prisma

# Build Next.js — LOW MEMORY settings
# NODE_MAX_OLD_SPACE_SIZE is passed as build-arg by deploy.sh based on hardware tier
ARG NODE_MAX_OLD_SPACE_SIZE=512
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=${NODE_MAX_OLD_SPACE_SIZE}"
# Single-threaded build to reduce peak memory
ENV NEXT_WORKER_THREADS=1
RUN bun run build

# ============ Stage 3: Production Runner ============
FROM oven/bun:1 AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV BUN_NO_UPDATE_NOTIF=1
ENV DB_PROVIDER=postgresql

# Minimal runtime deps: curl (healthcheck) + SSL (PostgreSQL) + netcat (DB check)
# IMPORTANT FIX: oven/bun:1 ships with a stale Debian Trixie snapshot in its
# sources.list (e.g. trixie-2024XXXXX). That snapshot gets removed from mirrors,
# causing "404 Not Found" on apt-get update and build failure.
# We rewrite sources.list to the live codename repos before installing.
RUN rm -f /etc/apt/sources.list.d/*.sources \
    && printf 'deb http://deb.debian.org/debian trixie main\ndeb http://deb.debian.org/debian trixie-updates main\n' > /etc/apt/sources.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
       curl \
       ca-certificates \
       libssl3 \
       netcat-openbsd \
       unzip \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd --system --gid 1001 appuser && \
    useradd --system --uid 1001 --gid appuser --no-create-home --shell /usr/sbin/nologin appuser

# Copy Next.js standalone output
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Copy Prisma schema and client (needed for db push on first start)
# Also copy ALL transitive runtime deps of the Prisma CLI.
# @prisma/config dynamically imports several packages at runtime.
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/node_modules/effect ./node_modules/effect
# effect/dist/cjs/index.js eagerly requires ./FastCheck.js → require("fast-check") → require("pure-rand")
COPY --from=builder /app/node_modules/fast-check ./node_modules/fast-check
COPY --from=builder /app/node_modules/pure-rand ./node_modules/pure-rand
COPY --from=builder /app/node_modules/c12 ./node_modules/c12
COPY --from=builder /app/node_modules/deepmerge-ts ./node_modules/deepmerge-ts
COPY --from=builder /app/node_modules/empathic ./node_modules/empathic

# Copy scraper service source + deps
COPY mini-services/scraper-service/package.json /tmp/scraper-deps/
COPY mini-services/scraper-service/bun.lock /tmp/scraper-deps/
COPY mini-services/scraper-service/ ./scraper-service/

# Install scraper deps in-place (no separate build stage)
RUN cd /tmp/scraper-deps && \
    (bun install --frozen-lockfile --production 2>&1 || echo "[WARN] Scraper deps install failed, headless scraping will be unavailable"); \
    if [ -d node_modules ]; then cp -r node_modules /app/scraper-service/; else echo "[WARN] No scraper node_modules produced"; fi; \
    rm -rf /tmp/scraper-deps

# Swap scraper queue to PostgreSQL version
RUN cd /app/scraper-service && \
    rm -f src/queue.ts && \
    mv src/queue.pg.ts src/queue.ts

# Create data directories and set ownership
RUN mkdir -p /app/data/covers /app/data/downloads /app/data/chapters /app/backups && \
    chown -R appuser:appuser /app

# Copy and set permissions for entrypoint
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh && \
    chown appuser:appuser /app/docker-entrypoint.sh

# Switch to non-root user
USER appuser

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# HEALTHCHECK is defined in docker-compose.yml with start_period.
# Not defined here to avoid confusion (compose overrides Dockerfile HEALTHCHECK).

ENTRYPOINT ["/app/docker-entrypoint.sh"]