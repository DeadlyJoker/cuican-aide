FROM node:24.18.1-alpine@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3 AS build

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

FROM nginx:1.27.5-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10

COPY --from=build /workspace/apps/crewon-ui/dist/ /usr/share/nginx/html/
COPY deploy/crewon/nginx.conf /etc/nginx/conf.d/default.conf

# The public listener is unprivileged. Keep nginx's only process-owned state on
# the runtime /tmp tmpfs instead of requiring root-owned /var/run.
RUN sed -i '/^user  nginx;/d; s#^pid .*nginx\.pid;#pid /tmp/nginx.pid;#' \
      /etc/nginx/nginx.conf

USER nginx
