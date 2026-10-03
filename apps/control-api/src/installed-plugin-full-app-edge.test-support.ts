import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import {
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer, request as httpsRequest } from "node:https";
import { join, relative } from "node:path";
import {
  TEST_CA_CERT,
  TEST_SERVER_CERT,
  TEST_SERVER_KEY,
} from "../../device-gateway/src/mtls-test-certificates.test-support.ts";
import {
  taskProcessAccessToken,
  taskProcessCookie,
} from "./installed-plugin-tasks-process-authorities.test-support.ts";

export const fullAppLogin = Object.freeze({
  username: "installed-full-app-fixture",
  password: "named-full-app-password",
  displayName: "Named full Web App user",
});
const user = Object.freeze({
  id: 1701,
  username: fullAppLogin.username,
  display_name: fullAppLogin.displayName,
  nickname: fullAppLogin.displayName,
  email: "full-app-fixture@example.invalid",
  role: "user",
  approval_status: "approved",
  password_login_enabled: true,
  linked_providers: [],
});
export type FullAppBrowserRequest = Readonly<{
  method: string;
  path: string;
  status: number;
}>;
type ResponseData = Readonly<{
  status: number;
  text: string;
  body: Record<string, any>;
}>;

/** Exact final Web artifacts, named AgentPlatform protocol fixtures, and a transparent real BFF proxy. */
export async function createFullAppEdge(uiDirectory: string) {
  const root = await realpath(uiDirectory);
  const files = new Map<string, { bytes: Buffer; contentType: string }>();
  let total = 0;
  const collect = async (directory: string): Promise<void> => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      assert.ok(
        !item.isSymbolicLink(),
        "final UI artifacts must not contain links",
      );
      const path = join(directory, item.name);
      if (item.isDirectory()) await collect(path);
      else if (item.isFile()) {
        if (
          !/\.(?:html|js|css|svg|png|ico|woff2?|webp|json|webmanifest)$/u.test(
            item.name,
          )
        )
          continue;
        assert.ok(files.size < 2048);
        const bytes = await readFile(path);
        total += bytes.byteLength;
        assert.ok(
          bytes.byteLength <= 32 * 1024 * 1024 && total <= 128 * 1024 * 1024,
        );
        files.set("/" + relative(root, path).replaceAll("\\", "/"), {
          bytes,
          contentType: mime(path),
        });
      }
    }
  };
  await collect(root);
  const index = files.get("/index.html");
  assert.ok(index, "a final formal Web index.html is required");
  assert.match(index.bytes.toString("utf8"), /Content-Security-Policy/u);
  assert.match(index.bytes.toString("utf8"), /type="module"/u);
  const requests: FullAppBrowserRequest[] = [];
  const failures: string[] = [];
  const pending = new Set<Promise<void>>();
  let target: string | null = null;
  let closed = false;
  let closing: Promise<void> | null = null;
  const trace = (incoming: IncomingMessage, outgoing: ServerResponse) => {
    const path = new URL(
      incoming.url!,
      "https://fixture.invalid",
    ).pathname.replace(/\/mounts\/[^/]+/u, "/mounts/:mount");
    outgoing.once("finish", () => {
      if (requests.length < 1024)
        requests.push({
          method: incoming.method!,
          path,
          status: outgoing.statusCode,
        });
    });
  };
  const json = (outgoing: ServerResponse, status: number, body: unknown) => {
    outgoing.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    outgoing.end(JSON.stringify(body));
  };
  const cookieMatches = (incoming: IncomingMessage) =>
    incoming.headers.cookie?.split(/;\s*/u).includes(taskProcessCookie) ===
    true;
  const authenticated = (incoming: IncomingMessage) =>
    cookieMatches(incoming) &&
    incoming.headers.authorization === `Bearer ${taskProcessAccessToken}`;
  const forward = (incoming: IncomingMessage, outgoing: ServerResponse) =>
    new Promise<void>((accept) => {
      assert.ok(target);
      // No Origin, cookie, CSRF, Authorization or identity rewrite: actual BFF and Control decide access.
      const upstream = httpRequest(
        new URL(incoming.url!, target),
        {
          method: incoming.method,
          headers: incoming.headers,
        },
        (response) => {
          outgoing.writeHead(response.statusCode!, response.headers);
          response.once("error", () => outgoing.destroy());
          response.pipe(outgoing);
        },
      );
      incoming.once("aborted", () => upstream.destroy());
      outgoing.once("close", () => {
        if (!outgoing.writableEnded) upstream.destroy();
      });
      upstream.once("error", () => {
        if (!outgoing.headersSent && !outgoing.destroyed)
          json(outgoing, 502, { fixture: "full_app_upstream_unavailable" });
        else outgoing.destroy();
      });
      upstream.once("close", accept);
      incoming.pipe(upstream);
    });
  const server = createServer(
    { key: TEST_SERVER_KEY, cert: TEST_SERVER_CERT, minVersion: "TLSv1.3" },
    (incoming, outgoing) => {
      trace(incoming, outgoing);
      if (closed || pending.size >= 64) {
        json(outgoing, 503, { fixture: "full_app_edge_unavailable" });
        return;
      }
      const work = Promise.resolve()
        .then(async () => {
          const url = new URL(incoming.url!, "https://fixture.invalid");
          const method = incoming.method!;
          const path = url.pathname;
          if (
            path === "/control-api/session" ||
            path === "/api/v1" ||
            path.startsWith("/api/v1/")
          ) {
            if (target === null) {
              json(outgoing, 503, { fixture: "full_app_bff_unavailable" });
              return;
            }
            await forward(incoming, outgoing);
            return;
          }
          if (path.startsWith("/agent-platform-api/")) {
            const api = path.slice("/agent-platform-api".length);
            if (method === "GET" && api === "/api/v1/health") {
              json(outgoing, 200, {
                status: "ok",
                fixture: "named_agent_platform",
              });
              return;
            }
            if (method === "GET" && api === "/api/v1/auth/wecom/config") {
              json(outgoing, 200, {
                enabled: false,
                provider: "wecom",
                label: "企业微信",
                reason: "Named password-login fixture",
              });
              return;
            }
            if (method === "POST" && api === "/api/v1/auth/login") {
              const form = new URLSearchParams(await smallBody(incoming));
              if (
                form.get("username") !== fullAppLogin.username ||
                form.get("password") !== fullAppLogin.password
              ) {
                json(outgoing, 401, {
                  detail: "Named fixture credentials rejected",
                });
                return;
              }
              outgoing.setHeader(
                "set-cookie",
                `${taskProcessCookie}; Path=/; HttpOnly; Secure; SameSite=Strict`,
              );
              json(outgoing, 200, {
                access_token: taskProcessAccessToken,
                token_type: "bearer",
              });
              return;
            }
            if (!authenticated(incoming)) {
              json(outgoing, 401, { detail: "Named fixture session required" });
              return;
            }
            if (method === "GET" && api === "/api/v1/auth/me") {
              json(outgoing, 200, user);
              return;
            }
            if (
              method === "GET" &&
              [
                "/api/v1/agents/",
                "/api/v1/knowledge/",
                "/api/v1/skills",
                "/api/v1/mcp/servers",
                "/api/v1/mcp/tools",
                "/api/v1/workflows",
              ].includes(api)
            ) {
              json(outgoing, 200, { items: [], total: 0 });
              return;
            }
            if (method === "GET" && api === "/api/v1/crewon/catalog") {
              json(outgoing, 200, {
                source: { type: "live_database" },
                resources: {
                  agents: [],
                  knowledge_bases: [],
                  skills: [],
                  mcp_servers: [],
                },
              });
              return;
            }
            json(outgoing, 404, {
              fixture: "named_platform_route_not_configured",
            });
            return;
          }
          const file = files.get(path === "/" ? "/index.html" : path);
          if ((method === "GET" || method === "HEAD") && file) {
            outgoing.writeHead(200, {
              "content-type": file.contentType,
              "cache-control": "no-store",
              "x-content-type-options": "nosniff",
              "content-length": file.bytes.byteLength,
            });
            outgoing.end(method === "HEAD" ? undefined : file.bytes);
            return;
          }
          json(outgoing, 404, { fixture: "full_app_static_not_found" });
        })
        .catch(() => {
          if (failures.length < 16)
            failures.push("full_app_edge_request_failed");
          if (!outgoing.headersSent && !outgoing.destroyed)
            json(outgoing, 500, { fixture: "full_app_edge_request_failed" });
          else outgoing.destroy();
        })
        .finally(() => pending.delete(work));
      pending.add(work);
    },
  );
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `https://localhost:${address.port}`;
  const staticProof = Object.freeze({
    indexDigest: createHash("sha256").update(index.bytes).digest("hex"),
    assetCount: files.size,
    stylesheetCount: [...files.keys()].filter((path) => path.endsWith(".css"))
      .length,
    finalArtifactBytes: total,
    mutated: false,
  });
  return {
    origin,
    port: address.port,
    certificateFingerprint: new X509Certificate(TEST_SERVER_CERT)
      .fingerprint256,
    staticProof,
    requests: () => [...requests],
    failures: () => [...failures],
    target(next: string) {
      assert.equal(new URL(next).hostname, "127.0.0.1");
      target = next;
    },
    request(
      path: string,
      body?: unknown,
      method = body === undefined ? "GET" : "POST",
      csrfToken?: string,
      idempotencyKey?: string,
    ): Promise<ResponseData> {
      const bytes =
        body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      return new Promise((accept, reject) => {
        const request = httpsRequest(
          new URL(path, origin),
          {
            method,
            ca: TEST_CA_CERT,
            headers: {
              cookie: taskProcessCookie,
              origin,
              ...(bytes === undefined
                ? {}
                : {
                    "content-type": "application/json",
                    "content-length": bytes.byteLength,
                  }),
              ...(csrfToken === undefined ? {} : { "x-csrf-token": csrfToken }),
              ...(idempotencyKey === undefined
                ? {}
                : { "idempotency-key": idempotencyKey }),
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            let total = 0;
            response.on("data", (chunk: Buffer) => {
              total += chunk.byteLength;
              if (total > 512 * 1024)
                response.destroy(new Error("full_app_response_limit"));
              else chunks.push(chunk);
            });
            response.once("error", reject);
            response.once("end", () => {
              try {
                const text = Buffer.concat(chunks).toString("utf8");
                accept({
                  status: response.statusCode!,
                  text,
                  body: JSON.parse(text),
                });
              } catch (error) {
                reject(error);
              }
            });
          },
        );
        const timer = setTimeout(
          () => request.destroy(new Error("full_app_request_timeout")),
          30_000,
        );
        timer.unref();
        request.once("close", () => clearTimeout(timer));
        request.once("error", reject);
        request.end(bytes);
      });
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      server.closeAllConnections();
      const physical = new Promise<void>((accept, reject) =>
        server.close((error) => (error ? reject(error) : accept())),
      );
      return (closing = (async () => {
        await physical;
        await Promise.allSettled([...pending]);
      })());
    },
  };
}

async function smallBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const value of request) {
    const chunk = Buffer.from(value);
    length += chunk.byteLength;
    assert.ok(length <= 4096);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function mime(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".woff2")) return "font/woff2";
  if (path.endsWith(".woff")) return "font/woff";
  if (path.endsWith(".ico")) return "image/x-icon";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".webmanifest")) return "application/manifest+json";
  return "application/octet-stream";
}
