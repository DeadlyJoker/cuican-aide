ARG NODE_IMAGE=node:24.18.1-alpine
FROM ${NODE_IMAGE} AS builder

WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/runtime-worker/package.json apps/runtime-worker/package.json
COPY packages/ packages/
RUN pnpm install --frozen-lockfile --filter @crewon/runtime-worker...

COPY apps/runtime-worker/src/ apps/runtime-worker/src/
COPY scripts/server-release-tools.mjs scripts/production-backup-tools.mjs scripts/production-backup-main.mjs scripts/
RUN pnpm --filter @crewon/runtime-worker exec esbuild src/main.ts \
    --bundle \
    --format=esm \
    --platform=node \
    --target=node24 \
    --outfile=/out/runtime-worker.mjs && \
    pnpm --filter @crewon/runtime-worker exec esbuild src/release-main.ts \
    --bundle \
    --format=esm \
    --platform=node \
    --target=node24 \
    --outfile=/out/release-main.mjs && \
    pnpm --filter @crewon/runtime-worker exec esbuild src/release-rollback-main.ts \
    --bundle \
    --format=esm \
    --platform=node \
    --target=node24 \
    --outfile=/out/release-rollback-main.mjs && \
    pnpm --filter @crewon/runtime-worker exec esbuild ../../scripts/production-backup-main.mjs \
    --bundle \
    --format=esm \
    --platform=node \
    --target=node24 \
    --outfile=/out/production-backup-main.mjs

FROM ${NODE_IMAGE}

LABEL org.opencontainers.image.title="CrewON Runtime Worker" \
      com.crewon.component="runtime-worker" \
      com.crewon.runtime="typescript" \
      com.crewon.init-bundle="/app/init/release-main.mjs" \
      com.crewon.rollback-bundle="/app/init/release-rollback-main.mjs" \
      com.crewon.backup-bundle="/app/ops/production-backup-main.mjs"
ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder --chown=node:node /out/runtime-worker.mjs ./runtime-worker.mjs
COPY --from=builder --chown=node:node /out/release-main.mjs ./init/release-main.mjs
COPY --from=builder --chown=node:node /out/release-rollback-main.mjs ./init/release-rollback-main.mjs
COPY --from=builder --chown=node:node /out/production-backup-main.mjs ./ops/production-backup-main.mjs
RUN apk add --no-cache postgresql16-client && \
    mkdir -p /var/lib/crewon/artifacts && \
    chown node:node /var/lib/crewon/artifacts

USER node
CMD ["node", "/app/runtime-worker.mjs"]
