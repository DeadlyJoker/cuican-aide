import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const AGENT_PLATFORM_UNAVAILABLE_BODY = JSON.stringify({
  error: "agent-platform unavailable",
  message:
    "Local agent-platform is not running. CrewON Control conversations are still available.",
});
const AGENT_PLATFORM_REACHABILITY_TTL_MS = 2_000;
const AGENT_PLATFORM_REACHABILITY_TIMEOUT_MS = 8_000;
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

type ReachabilityCache = {
  available: boolean;
  checkedAt: number;
  pending: Promise<boolean> | null;
};

function parseReachabilityUrl(target: string): string | null {
  try {
    const url = new URL(target);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return `${url.origin}/__crewon_agent_platform_probe__`;
  } catch {
    return null;
  }
}

function isAgentPlatformReachable(
  reachabilityUrl: string,
  cache: ReachabilityCache,
): Promise<boolean> {
  const now = Date.now();
  if (
    !cache.pending &&
    now - cache.checkedAt < AGENT_PLATFORM_REACHABILITY_TTL_MS
  ) {
    return Promise.resolve(cache.available);
  }

  cache.pending ??= new Promise<boolean>((resolve) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      AGENT_PLATFORM_REACHABILITY_TIMEOUT_MS,
    );
    const finish = (available: boolean) => {
      clearTimeout(timeoutId);
      cache.available = available;
      cache.checkedAt = Date.now();
      cache.pending = null;
      resolve(available);
    };

    fetch(reachabilityUrl, {
      method: "HEAD",
      signal: controller.signal,
    }).then(
      () => finish(true),
      () => finish(false),
    );
  });

  return cache.pending;
}

function agentPlatformFallbackPlugin(target: string): Plugin {
  const reachabilityUrl = parseReachabilityUrl(target);
  const cache: ReachabilityCache = {
    available: false,
    checkedAt: 0,
    pending: null,
  };

  return {
    name: "crewon-agent-platform-fallback",
    configureServer(server) {
      server.middlewares.use(
        "/agent-platform-api",
        async (_request, response, next) => {
          if (
            !reachabilityUrl ||
            (await isAgentPlatformReachable(reachabilityUrl, cache))
          ) {
            next();
            return;
          }

          response.statusCode = 503;
          response.setHeader("Content-Type", "application/json");
          response.end(AGENT_PLATFORM_UNAVAILABLE_BODY);
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

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const agentPlatformTarget =
    env.CREWON_AGENT_PLATFORM_TARGET ?? "http://127.0.0.1:8000";
  const controlTarget = env.CREWON_CONTROL_TARGET ?? "http://127.0.0.1:3210";
  const controlSessionToken = env.CREWON_CONTROL_SESSION_TOKEN;
  const controlCsrfToken = env.CREWON_CONTROL_CSRF_TOKEN;

  return {
    plugins: [
      controlSessionPlugin({
        csrfToken: controlCsrfToken,
        sessionToken: controlSessionToken,
      }),
      agentPlatformFallbackPlugin(agentPlatformTarget),
      react(),
    ],
    server: {
      port: 5175,
      strictPort: false,
      proxy: {
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
