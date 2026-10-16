// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "vite";
import {
  createServer as createHttpServer,
  request,
  type Agent,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  createServer as createHttpsServer,
  type AgentOptions,
} from "node:https";
import {
  createServer as createTcpServer,
  type Server as TcpServer,
  type Socket,
} from "node:net";
import { createAgentPlatformDevProxy } from "../dev/agentPlatformDevProxy.ts";
import {
  PROXY_TLS_CERT,
  PROXY_TLS_KEY,
} from "./fixtures/agent-platform-proxy-tls.ts";

const cleanups: (() => Promise<void>)[] = [];
type ProxyAgent = Agent & { options: AgentOptions };
afterEach(async () => {
  await Promise.allSettled(
    cleanups
      .splice(0)
      .reverse()
      .map((close) => close()),
  );
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function listen(server: Server | TcpServer, secure = false) {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_port");
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return {
    origin: `${secure ? "https" : "http"}://127.0.0.1:${address.port}`,
    sockets,
  };
}

async function proxyFor(
  target: string,
  configureTrust?: (agent: ProxyAgent) => void,
) {
  const pool = createAgentPlatformDevProxy(target);
  const agent = pool.proxy.agent as ProxyAgent;
  configureTrust?.(agent);
  const server = await createServer({
    configFile: false,
    envFile: false,
    logLevel: "silent",
    plugins: [pool.lifecycle],
    optimizeDeps: { noDiscovery: true, include: [] },
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: true,
      watch: null,
      hmr: false,
      proxy: { "/agent-platform-api": pool.proxy },
    },
  });
  await server.listen();
  cleanups.push(() => server.close());
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("proxy_port");
  return {
    agent,
    server,
    url: (path = "/api/v1/auth/me") =>
      `http://127.0.0.1:${address.port}/agent-platform-api${path}`,
  };
}

function send(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
) {
  const response = deferred<IncomingMessage>();
  const client = request(
    url,
    {
      agent: false,
      method: options.method ?? "GET",
      headers: { connection: "close", ...options.headers },
    },
    response.resolve,
  );
  client.once("error", response.reject);
  // Attach the handler before waiting for upstream evidence.
  response.promise.catch(() => {});
  client.end(options.body);
  return { client, response: response.promise };
}

async function body(response: IncomingMessage) {
  let text = "";
  for await (const chunk of response) text += String(chunk);
  return { status: response.statusCode, text };
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("fixture_condition_timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function poolCount(
  agent: Agent,
  field: "sockets" | "freeSockets" | "requests",
) {
  return Object.values(agent[field]).reduce(
    (sum, entries) => sum + entries.length,
    0,
  );
}

describe("account dev proxy connection ownership", () => {
  it.each([
    "ftp://example.test",
    "file:///tmp/example",
    "ws://example.test",
    "wss://example.test",
  ])("rejects unsupported target protocol %s", (target) => {
    expect(() => createAgentPlatformDevProxy(target)).toThrow(
      "agent_platform_proxy_target_protocol_invalid",
    );
  });
  it("reuses HTTP connections while keeping every request's authorization independent", async () => {
    const seen: {
      socket: Socket;
      authorization: string | undefined;
      path: string | undefined;
    }[] = [];
    const upstream = await listen(
      createHttpServer((req, res) => {
        seen.push({
          socket: req.socket,
          authorization: req.headers.authorization,
          path: req.url,
        });
        res.end("ok");
      }),
    );
    const proxy = await proxyFor(upstream.origin);
    for (const authorization of [
      "Bearer fixture-A",
      "Bearer fixture-B",
      undefined,
    ]) {
      const sent = send(proxy.url(), {
        headers: authorization ? { authorization } : {},
      });
      expect(await body(await sent.response)).toEqual({
        status: 200,
        text: "ok",
      });
    }
    expect(seen.map((entry) => entry.authorization)).toEqual([
      "Bearer fixture-A",
      "Bearer fixture-B",
      undefined,
    ]);
    expect(new Set(seen.map((entry) => entry.socket)).size).toBe(1);
    expect(seen.every((entry) => entry.path === "/api/v1/auth/me")).toBe(true);
    expect(poolCount(proxy.agent, "freeSockets")).toBe(1);
  });

  it("reuses a verified HTTPS connection without weakening the production trust settings", async () => {
    const upstreamServer = createHttpsServer(
      { key: PROXY_TLS_KEY, cert: PROXY_TLS_CERT },
      (_req, res) => res.end("tls-ok"),
    );
    let handshakes = 0;
    upstreamServer.on("secureConnection", () => handshakes++);
    const upstream = await listen(upstreamServer, true);
    const proxy = await proxyFor(upstream.origin, (agent) => {
      // Only this loopback fixture trusts its synthetic certificate. Neither
      // production factory nor proxy configuration disables verification.
      agent.options.ca = PROXY_TLS_CERT;
    });
    expect(proxy.agent.options.rejectUnauthorized).not.toBe(false);
    for (let index = 0; index < 3; index++) {
      expect(await body(await send(proxy.url()).response)).toEqual({
        status: 200,
        text: "tls-ok",
      });
    }
    expect(handshakes).toBe(1);
  });

  it("rejects an untrusted TLS server with the existing 503 account protocol", async () => {
    let delivered = 0;
    const upstream = await listen(
      createHttpsServer(
        { key: PROXY_TLS_KEY, cert: PROXY_TLS_CERT },
        (_req, res) => {
          delivered++;
          res.end("must-not-reach");
        },
      ),
      true,
    );
    const proxy = await proxyFor(upstream.origin);
    const result = await body(await send(proxy.url()).response);
    expect(result.status).toBe(503);
    expect(JSON.parse(result.text)).toEqual({
      error: "agent-platform unavailable",
      message: "账号服务暂时不可用，请稍后重试。",
    });
    expect(delivered).toBe(0);
  });

  it("physically cancels a fully sent POST while waiting for response headers", async () => {
    const accepted = deferred<{
      req: IncomingMessage;
      res: ServerResponse;
      text: string;
    }>();
    const closed = deferred<void>();
    const upstream = await listen(
      createHttpServer((req, res) => {
        if (req.method !== "POST") {
          res.end("after-abort");
          return;
        }
        let text = "";
        req.on("data", (chunk) => (text += String(chunk)));
        req.on("end", () => accepted.resolve({ req, res, text }));
        res.once("close", () => closed.resolve());
      }),
    );
    const proxy = await proxyFor(upstream.origin);
    let incomingAborted: boolean | undefined;
    proxy.server.httpServer?.on("request", (req, res) => {
      if (req.method === "POST")
        res.once("close", () => (incomingAborted = req.aborted));
    });
    const sent = send(proxy.url("/api/v1/auth/login"), {
      method: "POST",
      body: "fixture-body",
    });
    expect((await accepted.promise).text).toBe("fixture-body");
    sent.client.destroy();
    await expect(sent.response).rejects.toThrow();
    await closed.promise;
    expect(incomingAborted).toBe(false);
    await waitFor(() => poolCount(proxy.agent, "sockets") === 0);
    expect(await body(await send(proxy.url()).response)).toEqual({
      status: 200,
      text: "after-abort",
    });
  });

  it("physically cancels an unfinished response body and then accepts another request", async () => {
    const closed = deferred<void>();
    const upstream = await listen(
      createHttpServer((req, res) => {
        if (req.url === "/slow") {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.write("first-chunk");
          res.once("close", () => closed.resolve());
        } else res.end("complete");
      }),
    );
    const proxy = await proxyFor(upstream.origin);
    const sent = send(proxy.url("/slow"));
    const response = await sent.response;
    const chunk = deferred<string>();
    response.once("data", (value) => chunk.resolve(String(value)));
    expect(await chunk.promise).toBe("first-chunk");
    response.destroy();
    await closed.promise;
    await waitFor(() => poolCount(proxy.agent, "sockets") === 0);
    expect(await body(await send(proxy.url()).response)).toEqual({
      status: 200,
      text: "complete",
    });
  });

  it("physically cancels a pending upstream TLS handshake after the POST was sent", async () => {
    const handshakeStarted = deferred<void>();
    const closed = deferred<void>();
    // Accept the real TCP connection and TLS ClientHello without responding.
    const upstream = await listen(
      createTcpServer((socket) => {
        socket.once("data", () => handshakeStarted.resolve());
        socket.once("close", () => closed.resolve());
      }),
      true,
    );
    const proxy = await proxyFor(upstream.origin);
    const sent = send(proxy.url("/api/v1/auth/login"), {
      method: "POST",
      body: "already-sent",
    });
    await handshakeStarted.promise;
    sent.client.destroy();
    await expect(sent.response).rejects.toThrow();
    await closed.promise;
    await waitFor(() => poolCount(proxy.agent, "sockets") === 0);
    expect(upstream.sockets.size).toBe(0);
  });

  it("never replays a failed POST and permits an explicit second attempt", async () => {
    let attempts = 0;
    const upstream = await listen(
      createHttpServer((req, res) => {
        req.resume();
        req.once("end", () => {
          attempts++;
          if (attempts === 1) req.socket.destroy();
          else res.end("second-attempt");
        });
      }),
    );
    const proxy = await proxyFor(upstream.origin);
    const first = await body(
      await send(proxy.url("/api/v1/auth/login"), {
        method: "POST",
        body: "synthetic",
      }).response,
    );
    expect(first.status).toBe(503);
    expect(attempts).toBe(1);
    const second = await body(
      await send(proxy.url("/api/v1/auth/login"), {
        method: "POST",
        body: "synthetic",
      }).response,
    );
    expect(second).toEqual({ status: 200, text: "second-attempt" });
    expect(attempts).toBe(2);
  });

  it("does not replay a POST after its first TLS connection fails", async () => {
    let connections = 0;
    let delivered = 0;
    const upstreamServer = createHttpsServer(
      { key: PROXY_TLS_KEY, cert: PROXY_TLS_CERT },
      (req, res) => {
        req.resume();
        req.once("end", () => {
          delivered++;
          res.end("manual-second-attempt");
        });
      },
    );
    upstreamServer.on("connection", (socket) => {
      connections++;
      if (connections === 1) socket.destroy();
    });
    const upstream = await listen(upstreamServer, true);
    const proxy = await proxyFor(
      upstream.origin,
      (agent) => (agent.options.ca = PROXY_TLS_CERT),
    );
    const sendLogin = () =>
      send(proxy.url("/api/v1/auth/login"), {
        method: "POST",
        body: "synthetic",
      });
    expect((await body(await sendLogin().response)).status).toBe(503);
    expect(connections).toBe(1);
    expect(delivered).toBe(0);
    expect(await body(await sendLogin().response)).toEqual({
      status: 200,
      text: "manual-second-attempt",
    });
    expect(connections).toBe(2);
    expect(delivered).toBe(1);
  });

  it("destroys idle connections when Vite closes and creates a usable new pool", async () => {
    const upstream = await listen(
      createHttpServer((_req, res) => res.end("ok")),
    );
    const first = await proxyFor(upstream.origin);
    await body(await send(first.url()).response);
    expect(upstream.sockets.size).toBe(1);
    await first.server.close();
    await first.server.close();
    await waitFor(() => upstream.sockets.size === 0);
    expect(poolCount(first.agent, "freeSockets")).toBe(0);
    const second = await proxyFor(upstream.origin);
    expect(second.agent).not.toBe(first.agent);
    expect(await body(await send(second.url()).response)).toEqual({
      status: 200,
      text: "ok",
    });
  });

  it("retires excess idle sockets after concurrent requests finish", async () => {
    const upstream = await listen(
      createHttpServer((_req, res) =>
        setTimeout(() => res.end("parallel"), 10),
      ),
    );
    const proxy = await proxyFor(upstream.origin);
    expect(proxy.agent.options.timeout).toBeUndefined();
    const outcomes = await Promise.all(
      Array.from({ length: 16 }, async () =>
        body(await send(proxy.url()).response),
      ),
    );
    expect(outcomes.every((result) => result.status === 200)).toBe(true);
    await waitFor(() => upstream.sockets.size === proxy.agent.maxFreeSockets);
    expect(poolCount(proxy.agent, "freeSockets")).toBe(
      proxy.agent.maxFreeSockets,
    );
  });

  it.each([false, true])(
    "cancels queued and active requests when Vite closes (TLS=%s)",
    async (secure) => {
      let delivered = 0;
      let connections = 0;
      const onRequest = (req: IncomingMessage) => {
        delivered++;
        req.resume();
      };
      const upstreamServer = secure
        ? createHttpsServer(
            { key: PROXY_TLS_KEY, cert: PROXY_TLS_CERT },
            onRequest,
          )
        : createHttpServer(onRequest);
      upstreamServer.on("connection", () => connections++);
      const upstream = await listen(upstreamServer, secure);
      const proxy = await proxyFor(
        upstream.origin,
        secure ? (agent) => (agent.options.ca = PROXY_TLS_CERT) : undefined,
      );
      const queuedRequests = 17;
      const sends = Array.from(
        { length: proxy.agent.maxSockets + queuedRequests },
        () => send(proxy.url("/pending"), { method: "POST", body: "sent" }),
      );
      await waitFor(
        () =>
          delivered === proxy.agent.maxSockets &&
          poolCount(proxy.agent, "requests") === queuedRequests,
      );
      await proxy.server.close();
      await Promise.all(sends.map((sent) => sent.response.catch(() => {})));
      await waitFor(
        () =>
          upstream.sockets.size === 0 &&
          poolCount(proxy.agent, "sockets") === 0 &&
          poolCount(proxy.agent, "requests") === 0 &&
          poolCount(proxy.agent, "freeSockets") === 0,
      ).catch(() => {
        throw new Error(
          JSON.stringify({
            upstreamSockets: upstream.sockets.size,
            sockets: poolCount(proxy.agent, "sockets"),
            queued: poolCount(proxy.agent, "requests"),
            freeSockets: poolCount(proxy.agent, "freeSockets"),
            delivered,
            connections,
          }),
        );
      });
      expect(delivered).toBe(proxy.agent.maxSockets);
      expect(connections).toBe(proxy.agent.maxSockets);
    },
  );
});
