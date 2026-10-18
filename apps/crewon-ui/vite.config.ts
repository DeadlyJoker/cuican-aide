import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { normalizePluginUiViteImportPath } from "./src/lib/plugins/pluginUiViteImportPath";
import { createAgentPlatformDevProxy } from "./dev/agentPlatformDevProxy";
// @ts-expect-error Vite runs this file in Node while the browser tsconfig excludes Node globals.
import { writeFile } from "node:fs/promises";

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

type HttpProxy = {
  on(
    event: "proxyReq",
    callback: (proxyReq: {
      removeHeader: (name: string) => void;
      setHeader: (name: string, value: string) => void;
    }) => void,
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
        for (const prefix of ["/api/v1", "/api/v2"]) {
          server.middlewares.use(prefix, (_request, response) => {
            response.statusCode = 503;
            response.end();
          });
        }
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
  const agentPlatformTarget =
    env.CREWON_AGENT_PLATFORM_TARGET ?? "http://127.0.0.1:8000";
  const agentPlatformProxy = createAgentPlatformDevProxy(agentPlatformTarget);
  const agentPlatformRuntimeBaseUrl =
    env.VITE_AGENT_PLATFORM_RUNTIME_BASE_URL ?? agentPlatformTarget;
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
      "import.meta.env.VITE_CREWON_EXPERIMENTAL_DURABLE_TEAM_TASKS":
        JSON.stringify(env.CREWON_EXPERIMENTAL_DURABLE_TEAM_TASKS ?? ""),
    },
    resolve: {
      alias: {
        "@": "/src",
      },
    },
    plugins: [
      {
        name: "crewon-native-module-loading",
        // Vite rebuilds module script tags and drops attributes from the source
        // tag. Mark its generated entry after that pass so Rocket Loader does
        // not rewrite ES module loading or top-level await ordering.
        transformIndexHtml: {
          order: "post",
          handler: (html) =>
            html.replace(
              /<script\b(?=[^>]*\btype="module")/gu,
              '<script data-cfasync="false"',
            ),
        },
      },
      agentPlatformProxy.lifecycle,
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
      strictPort: true,
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
        "/agent-platform-api": agentPlatformProxy.proxy,
        "^/api/v[12](?:/|$)": {
          target: controlTarget,
          changeOrigin: false,
          rewrite: normalizePluginUiViteImportPath,
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
              // Keep the shared preload helper out of lazy feature chunks.
              // Otherwise the small login entry eagerly imports all Mermaid code.
              return "runtime";
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
            // Let Rollup separate lazy workbench dependencies from the login entry.
            return undefined;
          },
        },
      },
    },
  };
});
