// Vite executes this module in Node; it is never imported by the renderer.
// @ts-expect-error The browser TypeScript project excludes Node runtime types.
import { Agent as HttpAgent } from "node:http";
// @ts-expect-error The browser TypeScript project excludes Node runtime types.
import { Agent as HttpsAgent } from "node:https";
// @ts-expect-error The browser TypeScript project excludes Node runtime types.
import { Socket } from "node:net";
import type { Plugin, ProxyOptions } from "vite";

const UNAVAILABLE_BODY = JSON.stringify({
  error: "agent-platform unavailable",
  message: "账号服务暂时不可用，请稍后重试。",
});
const POOL_OPTIONS = {
  keepAlive: true,
  maxSockets: 64,
  maxTotalSockets: 64,
  maxFreeSockets: 8,
  scheduling: "lifo" as const,
};

type ProxyResponse = {
  closed: boolean;
  destroy(): void;
  once(event: "close", listener: () => void): unknown;
};
type ProxyErrorResponse = {
  destroyed?: boolean;
  headersSent?: boolean;
  writableEnded?: boolean;
  writeHead?: (status: number, headers: Record<string, string>) => unknown;
  end?: (body: string) => unknown;
};
type HttpProxyEvents = {
  on(
    event: "start",
    listener: (request: unknown, response: ProxyResponse) => void,
  ): void;
  on(
    event: "error",
    listener: (
      error: Error,
      request: unknown,
      response: ProxyErrorResponse,
    ) => void,
  ): void;
};

/** One account proxy pool belongs to one Vite server, including its queued requests. */
export function createAgentPlatformDevProxy(target: string): {
  proxy: ProxyOptions;
  lifecycle: Plugin;
} {
  const protocol = new URL(target).protocol;
  if (protocol !== "http:" && protocol !== "https:")
    throw new Error("agent_platform_proxy_target_protocol_invalid");
  const agent =
    protocol === "https:"
      ? new HttpsAgent(POOL_OPTIONS)
      : new HttpAgent(POOL_OPTIONS);
  const responses = new Set<ProxyResponse>();
  let isClosing = false;
  let closing: Promise<void> | undefined;
  const createConnection = agent.createConnection.bind(agent);
  const keepSocketAlive = agent.keepSocketAlive.bind(agent);
  agent.createConnection = (...options: unknown[]) =>
    // Node may allocate a socket for a cancelled queued request while retiring
    // an active socket. Once closing, let that queue drain through an unconnected
    // socket instead of opening another TCP/TLS connection. Live requests retain
    // the native Agent implementation, DNS lookup and TLS verification.
    isClosing ? new Socket() : createConnection(...options);
  agent.keepSocketAlive = (socket: unknown) =>
    !isClosing && keepSocketAlive(socket);
  const close = (): Promise<void> => {
    if (closing) return closing;
    isClosing = true;
    // Agent.destroy() alone leaves its pending request queue. Destroying each
    // downstream response first lets http-proxy cancel the corresponding request,
    // including requests that have not yet acquired a pooled socket.
    closing = Promise.all(
      [...responses].map(
        (response) =>
          new Promise<void>((resolve) => {
            if (response.closed) {
              resolve();
              return;
            }
            response.once("close", resolve);
            response.destroy();
          }),
      ),
    ).then(() => agent.destroy());
    return closing;
  };
  const onServerClose = () => void close();

  return {
    proxy: {
      target,
      changeOrigin: true,
      agent,
      // Connection is hop-by-hop: a browser closing its connection must not
      // disable reuse of the independent connection between Vite and PIM.
      headers: { connection: "keep-alive" },
      configure(proxy) {
        const events = proxy as unknown as HttpProxyEvents;
        events.on("start", (_request, response) => {
          responses.add(response);
          response.once("close", () => responses.delete(response));
          if (isClosing) response.destroy();
        });
        events.on("error", (_error, _request, response) => {
          if (
            !response?.writeHead ||
            response.destroyed ||
            response.headersSent ||
            response.writableEnded
          )
            return;
          response.writeHead(503, { "Content-Type": "application/json" });
          response.end?.(UNAVAILABLE_BODY);
        });
      },
      rewrite: (path) => path.replace(/^\/agent-platform-api/, ""),
    },
    lifecycle: {
      name: "crewon-agent-platform-proxy-pool",
      apply: "serve",
      configureServer(server) {
        server.httpServer?.once("close", onServerClose);
      },
      configurePreviewServer(server) {
        server.httpServer.once("close", onServerClose);
      },
      closeBundle: close,
    },
  };
}
