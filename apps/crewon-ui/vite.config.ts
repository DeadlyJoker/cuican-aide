import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

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
  desktopDev?: boolean;
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
      if (!configured && !config.desktopDev) {
        server.middlewares.use("/api/v1", (_request, response) => {
          response.statusCode = 503;
          response.end();
        });
      }
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

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const controlTarget = env.CREWON_CONTROL_TARGET ?? "http://127.0.0.1:3210";
  const controlSessionToken = env.CREWON_CONTROL_SESSION_TOKEN;
  const controlCsrfToken = env.CREWON_CONTROL_CSRF_TOKEN;
  const desktopDev = env.CREWON_DESKTOP_DEV === "1";

  return {
    plugins: [
      controlSessionPlugin({
        csrfToken: controlCsrfToken,
        desktopDev,
        sessionToken: controlSessionToken,
      }),
      react(),
    ],
    server: {
      port: 5175,
      strictPort: false,
      proxy: {
        "/api/v1": {
          target: controlTarget,
          changeOrigin: false,
          configure(proxy) {
            (proxy as unknown as HttpProxy).on("proxyReq", (proxyReq) => {
              if (desktopDev) {
                proxyReq.setHeader("origin", "http://tauri.localhost");
              }
              if (controlSessionToken) {
                proxyReq.setHeader(
                  "authorization",
                  `Bearer ${controlSessionToken}`,
                );
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
