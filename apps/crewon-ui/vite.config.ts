import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { agentPlatformBuildConfig } from "./agent-platform-build-config";
// @ts-expect-error Vite runs this file in Node while the browser tsconfig excludes Node globals.
import { writeFile } from "node:fs/promises";

const AGENT_PLATFORM_UNAVAILABLE_BODY = JSON.stringify({
  error: "agent-platform unavailable",
  message: "账号服务暂时不可用，请稍后重试。",
});
const MERMAID_CHUNK_PACKAGES = new Set([
  "@braintree/sanitize-url",
  "@iconify/utils",
  "@mermaid-js/parser",
  "@upsetjs/venn.js",
  "cytoscape",
  "cytoscape-cose-bilkent",
  "cytoscape-fcose",
  "cose-base",
  "d3",
  "d3-sankey",
  "dagre-d3-es",
  "dayjs",
  "dompurify",
  "es-toolkit",
  "katex",
  "khroma",
  "layout-base",
  "lodash-es",
  "marked",
  "mermaid",
  "roughjs",
  "stylis",
  "ts-dedent",
  "uuid",
]);
const REACT_CHUNK_PACKAGES = new Set(["react", "react-dom", "scheduler"]);
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

type WebSocketProxy = {
  on(
    event: "proxyReqWs",
    callback: (proxyReq: { removeHeader: (name: string) => void }) => void,
  ): void;
};

type HttpProxyResponse = {
  end?: (body?: string) => void;
  headersSent?: boolean;
  writeHead?: (statusCode: number, headers?: Record<string, string>) => void;
};

type HttpProxy = {
  on(
    event: "proxyReq",
    callback: (proxyReq: {
      removeHeader: (name: string) => void;
      setHeader: (name: string, value: string) => void;
    }) => void,
  ): void;
  on(
    event: "error",
    callback: (
      error: Error,
      request: unknown,
      response: HttpProxyResponse,
    ) => void,
  ): void;
};

function controlSessionPlugin(config: {
  csrfToken?: string;
  sessionToken?: string;
}): Plugin {
  const configured = Boolean(config.csrfToken && config.sessionToken);
  return {
    name: "crewon-control-session",
    configureServer(server) {
      server.middlewares.use("/control-api/session", (request, response) => {
        const method = (request as { method?: string }).method;
        if (method !== "GET") {
          response.statusCode = 405;
          response.end();
          return;
        }
        if (!configured) {
          response.statusCode = 503;
          response.setHeader("Cache-Control", "no-store");
          response.end();
          return;
        }
        response.statusCode = 200;
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({ baseUrl: "/", csrfToken: config.csrfToken }),
        );
      });
      if (!configured) {
        server.middlewares.use("/api/v1", (_request, response) => {
          response.statusCode = 503;
          response.end();
        });
      }
    },
  };
}

function localBackendRecoveryPlugin(requestFile: string | undefined): Plugin {
  return {
    name: "crewon-local-backend-recovery",
    configureServer(server) {
      if (!requestFile) {
        return;
      }
      server.middlewares.use(
        "/__crewon/dev/restart-app-server",
        (request, response) => {
          const localRequest = request as unknown as {
            headers: Record<string, string | string[] | undefined>;
            method?: string;
            socket: { remoteAddress?: string };
          };
          if (localRequest.method !== "POST") {
            response.statusCode = 405;
            response.end();
            return;
          }
          if (
            !LOOPBACK_ADDRESSES.has(localRequest.socket.remoteAddress ?? "") ||
            localRequest.headers["x-crewon-recovery-request"] !==
              "office-catalog"
          ) {
            response.statusCode = 403;
            response.end();
            return;
          }
          void writeFile(requestFile, `${Date.now()}\n`, "utf8").then(
            () => {
              response.statusCode = 202;
              response.setHeader("Content-Type", "application/json");
              response.end(JSON.stringify({ status: "restart-requested" }));
            },
            () => {
              response.statusCode = 500;
              response.end();
            },
          );
        },
      );
    },
  };
}

function nodeModulePackageName(id: string): string | null {
  const normalized = id.replace(/\\/g, "/");
  const marker = "/node_modules/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) {
    return null;
  }

  const parts = normalized.slice(markerIndex + marker.length).split("/");
  if (parts[0]?.startsWith("@")) {
    return parts[1] ? `${parts[0]}/${parts[1]}` : null;
  }
  return parts[0] ?? null;
}

function isMermaidChunkModule(id: string): boolean {
  const packageName = nodeModulePackageName(id);
  return Boolean(
    packageName &&
      (MERMAID_CHUNK_PACKAGES.has(packageName) ||
        packageName.startsWith("d3-")),
  );
}

function isMermaidChunkDependency(dependency: string): boolean {
  const filename =
    dependency.replace(/\\/g, "/").split("/").pop() ?? dependency;
  return filename.startsWith("mermaid-") && filename.endsWith(".js");
}

function appServerHttpTarget(target: string): string {
  const url = new URL(target);
  if (url.protocol === "ws:") {
    url.protocol = "http:";
  } else if (url.protocol === "wss:") {
    url.protocol = "https:";
  }
  return url.toString();
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const appServerTarget = env.CREWON_APP_SERVER_TARGET ?? "ws://127.0.0.1:6176";
  const appServerDisabled = env.CREWON_APP_SERVER_DISABLED === "1";
  const {
    proxyTarget: agentPlatformTarget,
    runtimeBaseUrl: agentPlatformRuntimeBaseUrl,
    accountBaseUrl: agentPlatformAccountBaseUrl,
  } = agentPlatformBuildConfig(mode, env);
  const controlTarget = env.CREWON_CONTROL_TARGET ?? "http://127.0.0.1:3210";
  const controlSessionToken = env.CREWON_CONTROL_SESSION_TOKEN;
  const controlCsrfToken = env.CREWON_CONTROL_CSRF_TOKEN;
  // control-api requires an Origin allow-list match and rejects requests with
  // no Origin header, which is exactly what same-origin browser GETs send.
  // Local devs pair the UI with a desktop-started control-api whose allow list
  // contains the desktop origin, so let the dev env opt into an Origin
  // override supplied by the desktop dev launcher.
  const controlOrigin = env.CREWON_CONTROL_ORIGIN;
  const backendRestartRequestFile = env.CREWON_DEV_BACKEND_RESTART_REQUEST_FILE;

  return {
    base: "./",
    define: {
      "import.meta.env.VITE_AGENT_PLATFORM_RUNTIME_BASE_URL": JSON.stringify(
        agentPlatformRuntimeBaseUrl.replace(/\/+$/, ""),
      ),
    },
    resolve: {
      alias: {
        "@": "/src",
      },
    },
    plugins: [
      {
        name: "crewon-desktop-account-endpoint",
        generateBundle() {
          if (mode !== "desktop") return;
          this.emitFile({
            type: "asset",
            fileName: "desktop-account-endpoint.json",
            source: JSON.stringify({
              schemaVersion: 1,
              accountOrigin: new URL(agentPlatformAccountBaseUrl).origin,
            }),
          });
        },
      },
      localBackendRecoveryPlugin(backendRestartRequestFile),
      controlSessionPlugin({
        csrfToken: controlCsrfToken,
        sessionToken: controlSessionToken,
      }),
      tailwindcss(),
      react(),
    ],
    server: {
      port: 5175,
      strictPort: false,
      proxy: {
        ...(appServerDisabled
          ? {}
          : {
              "/app-server/principal-session": {
                target: appServerHttpTarget(appServerTarget),
                changeOrigin: false,
                configure(proxy) {
                  (proxy as unknown as HttpProxy).on(
                    "proxyReq",
                    (proxyReq: { removeHeader: (name: string) => void }) => {
                      proxyReq.removeHeader("origin");
                    },
                  );
                },
                rewrite: (path) => path.replace(/^\/app-server/, ""),
              },
              "/app-server": {
                target: appServerTarget,
                ws: true,
                changeOrigin: false,
                configure(proxy) {
                  (proxy as unknown as WebSocketProxy).on(
                    "proxyReqWs",
                    (proxyReq) => {
                      proxyReq.removeHeader("origin");
                    },
                  );
                },
              },
            }),
        "/agent-platform-api": {
          target: agentPlatformTarget,
          changeOrigin: true,
          configure(proxy) {
            (proxy as unknown as HttpProxy).on(
              "error",
              (_error, _request, response) => {
                if (!response?.writeHead || response.headersSent) {
                  return;
                }
                response.writeHead(503, {
                  "Content-Type": "application/json",
                });
                response.end?.(AGENT_PLATFORM_UNAVAILABLE_BODY);
              },
            );
          },
          rewrite: (path) => path.replace(/^\/agent-platform-api/, ""),
        },
        "/api/v1": {
          target: controlTarget,
          changeOrigin: false,
          configure(proxy) {
            (proxy as unknown as HttpProxy).on("proxyReq", (proxyReq) => {
              if (controlSessionToken) {
                proxyReq.setHeader(
                  "authorization",
                  `Bearer ${controlSessionToken}`,
                );
              }
              if (controlOrigin) {
                proxyReq.setHeader("origin", controlOrigin);
              }
            });
          },
        },
      },
    },
    build: {
      modulePreload: {
        resolveDependencies(_url, deps) {
          return deps.filter((dep) => !isMermaidChunkDependency(dep));
        },
      },
      target: "es2022",
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id === "\0vite/preload-helper.js") {
              return "vendor";
            }
            if (!id.includes("node_modules")) {
              return undefined;
            }
            const packageName = nodeModulePackageName(id);
            if (isMermaidChunkModule(id)) {
              return "mermaid";
            }
            if (packageName === "lucide-react") {
              return "icons";
            }
            if (packageName && REACT_CHUNK_PACKAGES.has(packageName)) {
              return "react";
            }
            return "vendor";
          },
        },
      },
    },
  };
});
