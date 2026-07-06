# ============================================================
# Novel Management System - Multi-stage Docker Build
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

# Generate Prisma client
RUN bun run db:generate

# Build Next.js
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
RUN bun run build

# ============ Scraper Service Builder ============
FROM oven/bun:1 AS scraper-builder
WORKDIR /scraper
COPY mini-services/scraper-service/package.json mini-services/scraper-service/bun.lock ./
RUN bun install --frozen-lockfile
COPY mini-services/scraper-service/ ./

# ============ Production Runner ============
FROM oven/bun:1 AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV BUN_NO_UPDATE_NOTIF=1

# Install curl for health check (Debian-based image)
RUN apt-get update && apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy Next.js standalone output
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Copy Prisma schema and client (CLI + engine + generated client)
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma

# Copy scraper service
COPY --from=scraper-builder /scraper ./scraper-service

# Create data directories with proper permissions
RUN mkdir -p /app/data/db /app/data/covers /app/data/downloads /app/data/chapters && \
    chown -R nextjs:nodejs /app

USER nextjs

# Expose port
EXPOSE 3000

# Environment variables (can be overridden in docker-compose)
ENV DATABASE_URL="file:/app/data/db/custom.db"
ENV SCRAPER_SERVICE_URL="http://localhost:3099"
ENV NEXT_PUBLIC_APP_NAME="小说管理系统"
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Health check
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=40s \
    CMD curl -f http://localhost:3000/api/health || exit 1

# Start both services via entrypoint script
COPY --from=builder /app/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

ENTRYPOINT ["/app/docker-entrypoint.sh"]