import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import type { ClientRequest } from "node:http";
import type { ViteDevServer } from "vite";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { ApplicationError } from "../../packages/application/src/index.ts";
import { registerPluginControlRoutes } from "../../apps/control-api/src/plugin-control-route.ts";
import { StandaloneIdentity } from "../../apps/control-api/src/standalone-adapters.ts";
import { errorResponse } from "../../apps/control-api/src/control-api-errors.ts";
import { createInstalledShortDramaFixture } from "./preview-fixture.ts";
import { previewRequestCategory } from "./preview-diagnostics.ts";
import { normalizePluginUiViteImportPath } from "../../apps/crewon-ui/src/lib/plugins/pluginUiViteImportPath.ts";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const uiRequire = createRequire(
  join(repository, "apps/crewon-ui/package.json"),
);
const controlRequire = createRequire(
  join(repository, "apps/control-api/package.json"),
);
type ControlServer = Parameters<typeof registerPluginControlRoutes>[0];
const Fastify = controlRequire("fastify") as (
  options: Readonly<{ logger: boolean; bodyLimit: number }>,
) => ControlServer;
const { createServer } = (await import(
  uiRequire.resolve("vite")
)) as typeof import("vite");
const { default: react } = await import(
  uiRequire.resolve("@vitejs/plugin-react")
);
const { default: tailwindcss } = await import(
  uiRequire.resolve("@tailwindcss/vite")
);
const source = process.argv[2];
const port = Number(process.argv[3] ?? "5720");
if (
  !source ||
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535 ||
  port === 5719
)
  throw new Error(
    "usage: preview-server.ts /absolute/prebuilt/short-drama/v1 [port-excluding-5719]",
  );
const fixture = await createInstalledShortDramaFixture(source);
const control = Fastify({ logger: false, bodyLimit: 32 * 1024 });
const frontendOrigin = `http://127.0.0.1:${port}`;
const sessionToken = randomBytes(32).toString("base64url");
const csrfToken = randomBytes(32).toString("base64url");
const identity = new StandaloneIdentity({
  actor: fixture.actor,
  sessionToken,
  csrfToken,
  allowedOrigins: [frontendOrigin],
});
let closing = false;
const readyPath = join(
  repository,
  "output/extensions/checks/installed-short-drama-preview-ready.json",
);
let vite: Awaited<ReturnType<typeof createServer>> | null = null;
const httpEvents: Array<
  Readonly<{ category: string; method: string; status: number; code?: string }>
> = [];
const httpCounts = new Map<string, number>();
const requestErrorCodes = new WeakMap<object, string>();
function recordHttp(
  method: string,
  url: string,
  status: number,
  code?: string,
) {
  const category = previewRequestCategory(url.split("?")[0]!, method);
  if (category === "other") return;
  const safeMethod = ["GET", "POST", "DELETE", "HEAD", "OPTIONS"].includes(
    method,
  )
    ? method
    : "OTHER";
  const key = `${category}:${safeMethod}:${status}`;
  if (httpCounts.has(key) || httpCounts.size < 64)
    httpCounts.set(key, (httpCounts.get(key) ?? 0) + 1);
  httpEvents.push({
    category,
    method: safeMethod,
    status,
    ...(code ? { code } : {}),
  });
  if (httpEvents.length > 32) httpEvents.shift();
}
control.addHook("onResponse", async (request, reply) => {
  recordHttp(
    request.method,
    request.url,
    reply.statusCode,
    requestErrorCodes.get(request),
  );
});

function authorizeNamedLoopback(
  input: Readonly<{
    remoteAddress: string;
    headers: Readonly<Record<string, string | string[] | undefined>>;
  }>,
) {
  const remote = input.remoteAddress;
  const origin = input.headers.origin;
  if (
    closing ||
    !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote) ||
    (origin !== undefined && origin !== frontendOrigin) ||
    input.headers["sec-fetch-site"] === "cross-site"
  )
    throw new ApplicationError("authorization", "named_loopback_preview_only");
}

control.setErrorHandler((error, request, reply) => {
  const mapped = errorResponse(error, request.id);
  requestErrorCodes.set(request, mapped.body.error.code);
  void reply.status(mapped.statusCode).send(mapped.body);
});
registerPluginControlRoutes(control, {
  identity: {
    resolveActor: async (request) => {
      authorizeNamedLoopback(request);
      return identity.resolveActor(request);
    },
  },
  pluginUi: fixture.service,
});
control.get("/__installed-short-drama-proof", async (request, reply) => {
  authorizeNamedLoopback({
    remoteAddress: request.ip,
    headers: request.headers,
  });
  await identity.resolveActor({
    method: request.method,
    url: request.url,
    remoteAddress: request.ip,
    headers: request.headers,
  });
  reply.header("cache-control", "no-store");
  return {
    ...fixture.proof(),
    http: {
      counts: Object.fromEntries(httpCounts),
      events: httpEvents.slice(),
    },
  };
});

async function close() {
  if (closing) return;
  closing = true;
  fixture.withdraw();
  await vite?.close();
  await control.close();
  await fixture.close();
  await writeFile(
    readyPath,
    JSON.stringify(
      {
        schemaVersion: "crewon.installed-short-drama-preview-process.v1",
        state: "closed",
        pid: process.pid,
        ownedRoot: fixture.ownedRoot,
        ownedRootRemoved: true,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "installed-short-drama-preview closed and owned resources removed",
  );
}

try {
  const controlUrl = await control.listen({ host: "127.0.0.1", port: 0 });
  // Bearer stays on the server; renderer receives only the existing web CSRF bootstrap.
  const authenticatedProxy = {
    target: controlUrl,
    changeOrigin: false,
    rewrite: normalizePluginUiViteImportPath,
    configure(proxy: {
      on(
        event: "proxyReq",
        listener: (request: ClientRequest) => void,
      ): unknown;
    }) {
      proxy.on("proxyReq", (request) => {
        request.setHeader("authorization", `Bearer ${sessionToken}`);
        request.setHeader("origin", frontendOrigin);
      });
    },
  };
  const entry = `/@fs${repository}artifacts/installed-short-drama-preview/preview.tsx`;
  vite = await createServer({
    configFile: false,
    root: join(repository, "apps/crewon-ui"),
    envDir: join(repository, "output/extensions/empty-preview-env"),
    resolve: {
      alias: { "@": join(repository, "apps/crewon-ui/src") },
      dedupe: ["react", "react-dom", "@crewon/control-client"],
    },
    optimizeDeps: {
      entries: [
        join(repository, "artifacts/installed-short-drama-preview/preview.tsx"),
      ],
    },
    server: {
      host: "127.0.0.1",
      port,
      strictPort: true,
      fs: { allow: [repository] },
      proxy: {
        "/api/v1/plugins": authenticatedProxy,
        "/__installed-short-drama-proof": authenticatedProxy,
      },
    },
    plugins: [
      tailwindcss(),
      react(),
      {
        name: "installed-short-drama-named-fixture",
        configureServer(server: ViteDevServer) {
          server.middlewares.use(async (request, response, next) => {
            const path = request.url?.split("?")[0];
            if (
              path === "/control-api/session" ||
              path === "/__installed-short-drama-proof" ||
              path?.startsWith("/api/v1/plugins")
            ) {
              try {
                authorizeNamedLoopback({
                  remoteAddress: request.socket.remoteAddress ?? "",
                  headers: request.headers,
                });
                // Reject rebinding/foreign-origin requests before proxy inserts credentials.
                if (request.headers.host !== `127.0.0.1:${port}`)
                  throw new ApplicationError(
                    "authorization",
                    "named_loopback_preview_only",
                  );
              } catch (error) {
                const mapped = errorResponse(error, "named-preview-edge");
                recordHttp(
                  request.method ?? "GET",
                  request.url ?? "",
                  mapped.statusCode,
                  mapped.body.error.code,
                );
                response.statusCode = mapped.statusCode;
                response.setHeader("Cache-Control", "no-store");
                response.setHeader("Content-Type", "application/json");
                response.end(JSON.stringify(mapped.body));
                return;
              }
            }
            if (path === "/control-api/session") {
              recordHttp(
                request.method ?? "GET",
                path,
                request.method === "GET" ? 200 : 405,
              );
              response.setHeader("Cache-Control", "no-store");
              response.setHeader("X-Content-Type-Options", "nosniff");
              if (request.method !== "GET") {
                response.statusCode = 405;
                response.setHeader("Allow", "GET");
                response.end();
                return;
              }
              response.setHeader("Content-Type", "application/json");
              response.end(JSON.stringify({ baseUrl: "/", csrfToken }));
              return;
            }
            if (request.url?.split("?")[0] !== "/") return next();
            const html = await server.transformIndexHtml(
              "/",
              `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>CrewON · 已安装短剧页面预览</title></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
            );
            response.setHeader("Content-Type", "text/html; charset=utf-8");
            response.end(html);
          });
        },
      },
    ],
  });
  await vite.listen();
  const ready = {
    schemaVersion: "crewon.installed-short-drama-preview-process.v1",
    state: "ready",
    pid: process.pid,
    previewUrl: frontendOrigin + "/?surface=desktop&platform=mac&os=mac",
    controlUrl,
    ownedRoot: fixture.ownedRoot,
    proof: fixture.proof(),
  };
  await writeFile(readyPath, JSON.stringify(ready, null, 2) + "\n");
  console.log(JSON.stringify(ready, null, 2));
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void close().catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
      });
    });
} catch (error) {
  await close();
  throw error;
}
