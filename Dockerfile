# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS dependencies
WORKDIR /app

# Native SQLite bindings are compiled for the target architecture during install.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY . .
RUN npm run build

FROM dependencies AS production-dependencies
# Better Auth declares drizzle-kit as an optional peer. npm otherwise retains
# that development-only CLI and its legacy esbuild chain in the runtime image.
RUN npm prune --omit=dev --legacy-peer-deps

FROM node:24-bookworm-slim AS runtime
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates gosu tini \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000 \
    PUID=1000 \
    PGID=1000

COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY drizzle ./drizzle
COPY backup-cli.js ./
COPY server.js ./
COPY package.json package-lock.json ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint

# Keep the Linux entrypoint executable even if a Windows-origin build context
# has converted its line endings despite the repository's LF policy.
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint \
    && chmod 0755 /usr/local/bin/docker-entrypoint

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health/ready').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint"]
CMD ["node", "server.js"]
