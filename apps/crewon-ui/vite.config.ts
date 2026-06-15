import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

type WebSocketProxy = {
  on(event: "proxyReqWs", callback: (proxyReq: { removeHeader: (name: string) => void }) => void): void;
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const appServerTarget = env.CREWON_APP_SERVER_TARGET ?? "ws://127.0.0.1:6176";

  return {
    plugins: [react()],
    server: {
      port: 5175,
      strictPort: false,
      proxy: {
        "/app-server": {
          target: appServerTarget,
          ws: true,
          changeOrigin: false,
          configure(proxy) {
            (proxy as unknown as WebSocketProxy).on("proxyReqWs", (proxyReq) => {
              proxyReq.removeHeader("origin");
            });
          },
        },
      },
    },
    build: {
      target: "es2022",
    },
  };
});
