# syntax=docker/dockerfile:1
ARG BUN_VERSION=1.4.3
FROM oven/bun:${BUN_VERSION} AS base
WORKDIR /app

FROM base AS dependencies
COPY package.json bun.lock tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/dashboard/package.json ./apps/dashboard/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/db/package.json ./packages/db/package.json
RUN bun install --frozen-lockfile

FROM dependencies AS dashboard
COPY apps/dashboard ./apps/dashboard
# Same-origin live API; never ship the frontend's default mock mode.
RUN VITE_USE_MOCK=false VITE_API_URL= bun run build

FROM base AS production-dependencies
COPY package.json bun.lock tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/dashboard/package.json ./apps/dashboard/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/db/package.json ./packages/db/package.json
RUN bun install --frozen-lockfile --production

FROM base AS runtime
ENV NODE_ENV=production PORT=3000 WA_AUTH_DIR=/data/baileys TZ=Asia/Jakarta BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
# Preserve Bun's workspace symlinks and isolated dependency trees.
COPY --from=production-dependencies /app /app
COPY apps/api/src ./apps/api/src
COPY packages/core/src ./packages/core/src
COPY packages/db/src ./packages/db/src
COPY packages/db/drizzle ./packages/db/drizzle
COPY scripts/migrate.ts scripts/healthcheck.ts ./scripts/
COPY --from=dashboard /app/apps/dashboard/dist ./apps/dashboard/dist
RUN mkdir -p /data/baileys && chown -R bun:bun /data && chmod 700 /data/baileys
USER bun
VOLUME ["/data/baileys"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 CMD ["bun", "scripts/healthcheck.ts"]
ENTRYPOINT ["bun"]
CMD ["apps/api/src/index.ts"]
