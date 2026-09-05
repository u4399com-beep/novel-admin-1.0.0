# ============================================================
# Scraper Service - Docker Image
# Bun runtime + Playwright + Chromium
#
# Standalone container for the scraper microservice.
# In the monolithic deploy, this runs inside novel-manager.
# In the multi-service deploy (docker-compose.multiservice.yml),
# this runs as its own container.
# ============================================================

# ============ Stage 1: Dependencies ============
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
ARG BUN_GC_THRESHOLD=100mb
ENV BUN_GC_THRESHOLD=${BUN_GC_THRESHOLD}
ARG NPM_REGISTRY=https://registry.npmmirror.com
ENV BUN_CONFIG_REGISTRY=${NPM_REGISTRY}
RUN bun install --frozen-lockfile

# ============ Stage 2: Build ============
FROM oven/bun:1 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Switch queue to PostgreSQL version if available
RUN if [ -f src/queue.pg.ts ]; then \
      rm -f src/queue.ts && mv src/queue.pg.ts src/queue.ts; \
    fi

# ============ Stage 3: Production ============
FROM oven/bun:1 AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV BUN_NO_UPDATE_NOTIF=1

# Fix Debian sources for oven/bun:1
ARG DEBIAN_MIRROR=mirrors.aliyun.com
RUN rm -f /etc/apt/sources.list.d/*.sources \
    && printf "deb http://${DEBIAN_MIRROR}/debian trixie main\ndeb http://${DEBIAN_MIRROR}/debian trixie-updates main\n" > /etc/apt/sources.list \
    && printf 'Acquire::Retries "3";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\n' > /etc/apt/apt.conf.d/99timeout

# Install runtime deps: curl (healthcheck), chromium (headless scraping), fonts
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       tini \
       curl \
       ca-certificates \
       netcat-openbsd \
       chromium \
       fonts-wqy-zenhei \
    && rm -rf /var/lib/apt/lists/* /etc/apt/apt.conf.d/99timeout

# Create non-root user
RUN groupadd --system --gid 1001 scraper && \
    useradd --system --uid 1001 --gid scraper --no-create-home --shell /usr/sbin/nologin scraper

# Copy application
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/index.ts ./index.ts
COPY --from=builder /app/proxy-config.json ./proxy-config.json

# Set ownership
RUN chown -R scraper:scraper /app

USER scraper

EXPOSE 3099

ENV PORT=3099
ENV HOSTNAME="0.0.0.0"
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Health check
HEALTHCHECK --start-period=30s --interval=15s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:3099/health || exit 1

ENTRYPOINT ["tini", "--"]
CMD ["bun", "run", "index.ts"]
