ARG NODE_IMAGE=node:24.18.1-alpine
FROM ${NODE_IMAGE}

ENV NODE_ENV=production
WORKDIR /app

# CREWON_CONTROL_BFF_TOKEN is required at runtime and intentionally has no
# build argument or image default. Inject it through the deployment secret store.

COPY --chown=node:node apps/web-bff/package.json ./package.json
COPY --chown=node:node apps/web-bff/src/ ./src/
# Only the browser-safe domain subpath is imported by BFF. Keep its real path
# outside node_modules because Node's TypeScript stripper rejects files there.
COPY --chown=node:node packages/domain/package.json ./packages/domain/package.json
COPY --chown=node:node packages/domain/src/ ./packages/domain/src/
RUN mkdir -p node_modules/@crewon && ln -s ../../packages/domain node_modules/@crewon/domain

USER node
CMD ["node", "--experimental-strip-types", "src/main.ts"]
