# ============================================================
# Novel Management System - LOW MEMORY Docker Build
# Optimized for 1H1G servers
#
# Key optimizations vs standard Dockerfile:
#   1. Chromium NOT downloaded at build time (runtime-only, saves ~200MB build RAM)
#   2. V8 heap capped at 512MB (was 1024MB)
#   3. Minimal runtime deps (no Chromium libs in image)
#   4. 3 stages instead of 4 (scraper deps installed in runner)
# ============================================================

# ============ Stage 1: Dependencies ============
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ============ Stage 2: Build ============
FROM oven/bun:1 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Switch Prisma schema to PostgreSQL
RUN sed -i 's/provider = "sqlite"/provider = "postgresql"/' prisma/schema.prisma

# Generate Prisma client
RUN bun run db:generate

# Build Next.js — LOW MEMORY settings
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
# 512MB heap cap: enough for this small app, prevents OOM on 1GB servers
ENV NODE_OPTIONS="--max-old-space-size=512"
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

# Minimal runtime deps: curl (healthcheck) + SSL (PostgreSQL) + basic libs
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    libssl3 \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
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

# Copy scraper service source + deps
COPY mini-services/scraper-service/package.json /tmp/scraper-deps/
COPY mini-services/scraper-service/bun.lock /tmp/scraper-deps/
COPY mini-services/scraper-service/ ./scraper-service/

# Install scraper deps in-place (no separate build stage)
RUN cd /tmp/scraper-deps && bun install --frozen-lockfile --production 2>/dev/null || true && \
    cp -r node_modules /app/scraper-service/ && \
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

HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=90s \
    CMD curl -f http://localhost:3000/api/auth/csrf || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]