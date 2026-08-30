ARG NODE_IMAGE=node:24.18.1-alpine
FROM ${NODE_IMAGE}

ENV NODE_ENV=production
WORKDIR /app

# CREWON_CONTROL_BFF_TOKEN is required at runtime and intentionally has no
# build argument or image default. Inject it through the deployment secret store.

COPY --chown=node:node apps/web-bff/package.json ./package.json
COPY --chown=node:node apps/web-bff/src/ ./src/

USER node
CMD ["node", "--experimental-strip-types", "src/main.ts"]
