ARG NODE_IMAGE=node:24.18.1-alpine
ARG BASE_IMAGE=nginx:1.27.5-alpine

FROM ${NODE_IMAGE} AS build

WORKDIR /workspace
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/crewon-ui/package.json apps/crewon-ui/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/control-client/package.json packages/control-client/package.json
RUN pnpm install --frozen-lockfile --filter @crewon/ui...

COPY apps/crewon-ui/ apps/crewon-ui/
COPY packages/contracts/ packages/contracts/
COPY packages/control-client/ packages/control-client/
RUN pnpm --filter @crewon/ui build

FROM ${BASE_IMAGE}

COPY --from=build /workspace/apps/crewon-ui/dist/ /usr/share/nginx/html/
COPY deploy/crewon/nginx.conf /etc/nginx/conf.d/default.conf
