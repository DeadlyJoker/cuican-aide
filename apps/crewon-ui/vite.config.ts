import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const AGENT_PLATFORM_UNAVAILABLE_BODY = JSON.stringify({
  error: "agent-platform unavailable",
  message:
    "Local agent-platform is not running. CrewON app-server conversations are still available.",
});
const AGENT_PLATFORM_REACHABILITY_TTL_MS = 2_000;
const AGENT_PLATFORM_REACHABILITY_TIMEOUT_MS = 250;

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
    event: "error",
    callback: (error: Error, request: unknown, response: HttpProxyResponse) => void,
  ): void;
};

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
      server.middlewares.use("/agent-platform-api", async (_request, response, next) => {
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
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const appServerTarget = env.CREWON_APP_SERVER_TARGET ?? "ws://127.0.0.1:6176";
  const agentPlatformTarget =
    env.CREWON_AGENT_PLATFORM_TARGET ?? "http://127.0.0.1:8000";

  return {
    plugins: [agentPlatformFallbackPlugin(agentPlatformTarget), react()],
    server: {
      port: 5175,
      strictPort: false,
      proxy: {
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
        "/agent-platform-api": {
          target: agentPlatformTarget,
          changeOrigin: true,
          configure(proxy) {
            (proxy as unknown as HttpProxy).on("error", (_error, _request, response) => {
              if (!response?.writeHead || response.headersSent) {
                return;
              }
              response.writeHead(503, {
                "Content-Type": "application/json",
              });
              response.end?.(AGENT_PLATFORM_UNAVAILABLE_BODY);
            });
          },
          rewrite: (path) => path.replace(/^\/agent-platform-api/, ""),
        },
      },
    },
    build: {
      target: "es2022",
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes("node_modules")) {
              return undefined;
            }
            if (id.includes("lucide-react")) {
              return "icons";
            }
            if (id.includes("react")) {
              return "react";
            }
            return "vendor";
          },
        },
      },
    },
  };
});
