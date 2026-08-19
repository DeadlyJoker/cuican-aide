ARG NODE_IMAGE=node:24.18.1-alpine
FROM ${NODE_IMAGE} AS builder

WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/control-api/package.json apps/control-api/package.json
COPY packages/ packages/
RUN pnpm install --frozen-lockfile --filter @crewon/control-api...

COPY apps/control-api/src/ apps/control-api/src/
RUN pnpm --filter @crewon/control-api exec esbuild src/main.ts \
    --bundle \
    --format=esm \
    --platform=node \
    --target=node24 \
    --outfile=/out/control-api.mjs && \
    ! grep -aEi "deterministic[ _-]?fake|device[ _-]?gateway|app[ _-]?server|6176" /out/control-api.mjs

FROM ${NODE_IMAGE}

LABEL org.opencontainers.image.title="CrewON Control API" \
      com.crewon.component="control-api" \
      com.crewon.runtime="typescript"
ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder --chown=node:node /out/control-api.mjs ./control-api.mjs
RUN mkdir -p /var/lib/crewon/artifacts && chown node:node /var/lib/crewon/artifacts

USER node
CMD ["node", "/app/control-api.mjs"]
