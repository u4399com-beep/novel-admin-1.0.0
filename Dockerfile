# ============================================================
# Novel Management System - Production Docker Build (PostgreSQL)
# ============================================================
# Usage:
#   docker compose up -d          # Start everything (PostgreSQL + App)
#   docker compose logs -f        # View logs
#   docker compose down           # Stop everything
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

# ============ Production Runner ============
FROM oven/bun:1 AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV BUN_NO_UPDATE_NOTIF=1
ENV DB_PROVIDER=postgresql

# Install curl for health checks + ca-certificates for HTTPS
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

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

# Create data directories
RUN mkdir -p /app/data/covers /app/data/downloads /app/data/chapters && \
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