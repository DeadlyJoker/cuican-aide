ARG NODE_IMAGE=node:24.18.1-alpine
FROM ${NODE_IMAGE} AS builder

WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web-bff/package.json apps/web-bff/package.json
RUN pnpm install --frozen-lockfile --filter @crewon/web-bff...

COPY apps/web-bff/src/ apps/web-bff/src/
RUN pnpm --filter @crewon/web-bff exec esbuild src/main.ts \
    --bundle \
    --format=esm \
    --platform=node \
    --target=node24 \
    --outfile=/out/web-bff.mjs && \
    ! grep -aEi "deterministic[ _-]?fake|device[ _-]?gateway|app[ _-]?server|6176" /out/web-bff.mjs

FROM ${NODE_IMAGE}

ENV NODE_ENV=production
WORKDIR /app

# CREWON_CONTROL_BFF_TOKEN is required at runtime and intentionally has no
# build argument or image default. Inject it through the deployment secret store.

LABEL org.opencontainers.image.title="CrewON Web BFF" \
      com.crewon.component="web-bff" \
      com.crewon.runtime="typescript"

COPY --from=builder --chown=node:node /out/web-bff.mjs ./web-bff.mjs

USER node
CMD ["node", "/app/web-bff.mjs"]
