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
# Use Chinese npm mirror by default (can be overridden via --build-arg)
ARG NPM_REGISTRY=https://registry.npmmirror.com
ENV BUN_CONFIG_REGISTRY=${NPM_REGISTRY}
RUN bun install --frozen-lockfile

# ============ Stage 2: Build ============
FROM oven/bun:1 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Switch Prisma schema to PostgreSQL
RUN if grep -q 'provider = "sqlite"' prisma/schema.prisma; then \
      sed -i 's/provider = "sqlite"/provider = "postgresql"/' prisma/schema.prisma; \
    else \
      echo "WARNING: Expected 'provider = sqlite' in schema.prisma, skipping provider swap"; \
    fi

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

# IMPORTANT: oven/bun:1 ships with a stale Debian Trixie snapshot in its
# sources.list (e.g. trixie-2024XXXXX). That snapshot gets removed from mirrors,
# causing "404 Not Found" on apt-get update and build failure.
# We rewrite sources.list BEFORE any apt-get to use a Chinese mirror (default:
# mirrors.aliyun.com) because the target audience is Chinese servers where
# deb.debian.org is unreachable.
# DEBIAN_MIRROR can be overridden via --build-arg for non-Chinese environments.
ARG DEBIAN_MIRROR=mirrors.aliyun.com
RUN rm -f /etc/apt/sources.list.d/*.sources \
    && printf "deb http://${DEBIAN_MIRROR}/debian trixie main\ndeb http://${DEBIAN_MIRROR}/debian trixie-updates main\n" > /etc/apt/sources.list \
    && printf 'Acquire::Retries "3";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\n' > /etc/apt/apt.conf.d/99timeout

# tini as PID 1 init — reaps zombie processes, handles signals correctly.
# Without tini, bash as PID 1 does NOT reap orphans, eventually exhausting
# the container's PID limit and causing fork(2) failures.
# Minimal runtime deps: curl (healthcheck) + SSL (PostgreSQL) + netcat (DB check)
# All installed in a SINGLE apt-get after rewriting sources.list.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       tini \
       curl \
       ca-certificates \
       netcat-openbsd \
       unzip \
       chromium \
       fonts-wqy-zenhei \
    # libssl3 renamed to libssl3t64 in Debian Trixie (oven/bun:1 has its own OpenSSL)
    && apt-get install -y --no-install-recommends libssl3t64 2>/dev/null || true \
    && rm -rf /var/lib/apt/lists/* /etc/apt/apt.conf.d/99timeout

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
# c12 depends on perfect-debounce and pathe at runtime (used by @prisma/config)
COPY --from=builder /app/node_modules/perfect-debounce ./node_modules/perfect-debounce
COPY --from=builder /app/node_modules/pathe ./node_modules/pathe
# CRITICAL: @prisma/engines contains the native query engine (.so.node) and
# schema-engine binary needed by 'prisma db push'. Without these, Prisma CLI fails.
COPY --from=builder /app/node_modules/@prisma/engines ./node_modules/@prisma/engines
# effect depends on @standard-schema/spec at runtime
COPY --from=builder /app/node_modules/@standard-schema ./node_modules/@standard-schema
# NOTE: If Prisma CLI at runtime reports "Cannot find package 'X'",
# add: COPY --from=builder /app/node_modules/X ./node_modules/X
# Common c12/effect transitive deps already copied above.

# Copy scraper service package files FIRST (for layer caching)
# NOTE: bun install needs network — use Chinese npm registry for Chinese servers
# NPM_REGISTRY is stage-scoped; must be re-declared here even if set in deps stage.
ARG NPM_REGISTRY=https://registry.npmmirror.com
COPY mini-services/scraper-service/package.json /tmp/scraper-deps/
COPY mini-services/scraper-service/bun.lock /tmp/scraper-deps/

# Install scraper deps (layer-cached by lockfile hash, invalidated only if package.json/bun.lock change)
RUN cd /tmp/scraper-deps && \
    if BUN_CONFIG_REGISTRY=${NPM_REGISTRY} bun install --frozen-lockfile --production 2>&1; then \
        if [ -d node_modules ]; then cp -r node_modules /app/scraper-service/; fi; \
    else echo "[WARN] Scraper deps install failed, headless scraping will be unavailable"; fi; \
    rm -rf /tmp/scraper-deps

# THEN copy scraper source (only invalidated by source code changes)
COPY mini-services/scraper-service/ ./scraper-service/

# Swap scraper queue to PostgreSQL version
RUN cd /app/scraper-service && \
    rm -f src/queue.ts && \
    if [ -f src/queue.pg.ts ]; then mv src/queue.pg.ts src/queue.ts; \
    else echo "FATAL: src/queue.pg.ts not found"; exit 1; fi

# Create data directories and set ownership
# NOTE: docker-compose.yml mounts backup volume at /backups (not /app/backups)
RUN mkdir -p /app/data/covers /app/data/downloads /app/data/chapters /backups && \
    chown -R appuser:appuser /app

# Copy and set permissions for entrypoint
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh && \
    chown appuser:appuser /app/docker-entrypoint.sh

# Switch to non-root user
USER appuser

EXPOSE 3000

# PORT is set here for the main Next.js app (server.js).
# CRITICAL: The scraper service MUST override this with PORT=3099
# when started in docker-entrypoint.sh, otherwise it steals port 3000.
ENV PORT=3000
# Next.js standalone reads HOSTNAME as the bind address (default: 0.0.0.0).
# NOTE: This shadows the POSIX $HOSTNAME (machine hostname), but Next.js
# explicitly checks process.env.HOSTNAME, so this is intentional and required.
ENV HOSTNAME="0.0.0.0"
# Tell Playwright to use system Chromium (installed via apt-get) instead of
# downloading its own bundled browser at runtime.
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# HEALTHCHECK is defined in docker-compose.yml with start_period.
# Not defined here to avoid confusion (compose overrides Dockerfile HEALTHCHECK).

ENTRYPOINT ["tini", "--", "/app/docker-entrypoint.sh"]