# ============================================================
# Log Stream Service - Docker Image
# Socket.io based real-time log streaming
# ============================================================

FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1 AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV BUN_NO_UPDATE_NOTIF=1

# Fix Debian sources
ARG DEBIAN_MIRROR=mirrors.aliyun.com
RUN rm -f /etc/apt/sources.list.d/*.sources \
    && printf "deb http://${DEBIAN_MIRROR}/debian trixie main\ndeb http://${DEBIAN_MIRROR}/debian trixie-updates main\n" > /etc/apt/sources.list

# Install curl for healthcheck
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY . .

EXPOSE 3004
ENV PORT=3004
ENV HOSTNAME="0.0.0.0"

# Health check
HEALTHCHECK --start-period=10s --interval=15s --timeout=3s --retries=3 \
  CMD curl -f http://localhost:3004/health || exit 1

ENTRYPOINT ["tini", "--"]
CMD ["bun", "run", "index.ts"]
