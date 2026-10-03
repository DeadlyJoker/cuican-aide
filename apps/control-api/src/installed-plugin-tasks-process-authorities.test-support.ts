import assert from "node:assert/strict";
import {
  createServer as createHttpServer,
  request as httpRequest,
} from "node:http";
import { createServer, request as httpsRequest } from "node:https";
import type { TestContext } from "node:test";
import {
  TEST_CA_CERT,
  TEST_SERVER_CERT,
  TEST_SERVER_KEY,
} from "../../device-gateway/src/mtls-test-certificates.test-support.ts";
import {
  installedProcessActor as actor,
  installedProcessScope as scope,
} from "../../runtime-worker/src/installed-plugin-worker-process.test-support.ts";

export const taskProcessServiceToken =
  "named-task-process-authority-" + "a".repeat(32);
export const taskProcessBffToken = "named-task-process-bff-" + "b".repeat(32);
export const taskProcessAccessToken =
  "named-task-process-user-access-" + "c".repeat(32);
export const taskProcessPeerToken = "named-task-process-peer-" + "d".repeat(32);
export const taskProcessCookie =
  "crewon_test_session=approved-installed-task-process";
export const taskProcessCreditScope = Object.freeze({
  tenantId: actor.tenantId,
  principalId: actor.principalId,
  poolId: "named-process-test-funding-only",
});

/** Real HTTPS test authorities. They are neither enterprise identity nor product funding defaults. */
export async function taskProcessAuthorities(t: TestContext) {
  const state = {
    identityAllowed: true,
    uiAllowed: true,
    packagesAllowed: true,
    quoteAvailable: true,
    foreignProfile: false,
    epoch: "named-process-test-ui-epoch-1",
    beforePolicy: null as (() => Promise<void>) | null,
    requests: [] as { path: string; body: Record<string, unknown> }[],
    failures: [] as unknown[],
  };
  const server = createServer(
    { key: TEST_SERVER_KEY, cert: TEST_SERVER_CERT, minVersion: "TLSv1.3" },
    (request, response) => {
      void (async () => {
        assert.equal(request.method, "POST");
        assert.equal(
          request.headers.authorization,
          `Bearer ${taskProcessServiceToken}`,
        );
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          size += Buffer.byteLength(chunk);
          assert.ok(size <= 128 * 1024);
          chunks.push(Buffer.from(chunk));
        }
        const bytes = Buffer.concat(chunks);
        const body =
          bytes.length === 0 ? {} : JSON.parse(bytes.toString("utf8"));
        const path = request.url!;
        state.requests.push({ path, body });
        response.setHeader("content-type", "application/json");
        let output: unknown;
        switch (path) {
          case "/session":
            assert.equal(request.headers.cookie, taskProcessCookie);
            if (!state.identityAllowed) {
              response.statusCode = 401;
              output = {};
              break;
            }
            output = {
              controlAccessToken: taskProcessAccessToken,
              sessionId: "named-real-process-session-" + "s".repeat(32),
              expiresAt: new Date(Date.now() + 300_000).toISOString(),
            };
            break;
          case "/verify":
            assert.deepEqual(body, { accessToken: taskProcessAccessToken });
            if (!state.identityAllowed) {
              response.statusCode = 401;
              output = {};
              break;
            }
            output = {
              ...actor,
              issuer: "https://named-process-identity.example",
              audience: "crewon-control",
              issuedAt: new Date(Date.now() - 1000).toISOString(),
              expiresAt: new Date(Date.now() + 300_000).toISOString(),
            };
            break;
          case "/profile":
            assert.deepEqual(body, { actor });
            output = state.foreignProfile
              ? { ...scope, profileId: "other-test-profile" }
              : scope;
            break;
          case "/policy":
            assert.deepEqual(body.actor, actor);
            if (String(body.action).startsWith("pluginUi:")) {
              await state.beforePolicy?.();
              output = state.uiAllowed
                ? { outcome: "allow", authorityEpoch: state.epoch }
                : { outcome: "deny", reasonCode: "named_test_ui_withdrawn" };
            } else output = { outcome: "allow" };
            break;
          case "/package":
            assert.equal(
              body.schemaVersion,
              "crewon.plugin-execution-package.v1",
            );
            assert.deepEqual(body.scope, scope);
            assert.ok(body.purpose === "read" || body.purpose === "submit");
            assert.deepEqual(Object.keys(body.identity as object).sort(), [
              "packageDigest",
              "pluginId",
              "publisherId",
              "version",
            ]);
            output = { outcome: state.packagesAllowed ? "allow" : "deny" };
            break;
          case "/quote":
            assert.deepEqual(body.actor, actor);
            assert.deepEqual(Object.keys(body).sort(), [
              "actor",
              "binding",
              "commandRequestDigest",
              "input",
            ]);
            if (!state.quoteAvailable) {
              response.statusCode = 503;
              output = { fixture: "named_quote_unavailable" };
              break;
            }
            output = {
              poolId: taskProcessCreditScope.poolId,
              priceRevision: 7,
              quotedCredits: "30",
            };
            break;
          default:
            throw new Error("named_task_authority_unknown_route");
        }
        response.end(JSON.stringify(output));
      })().catch((error: unknown) => {
        state.failures.push(error);
        response.statusCode = 500;
        response.end('{"fixture":"failed"}');
      });
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.deepEqual(state.failures, []);
  });
  return { state, origin: `https://localhost:${address.port}` };
}

/** Only a TLS edge: all routes, sessions, CSRF and proxy decisions come from the actual BFF child. */
export async function taskProcessBrowserEdge(t: TestContext) {
  let target: string | null = null;
  const state = {
    beforeActionDelivery: null as (() => Promise<void>) | null,
  };
  const server = createServer(
    { key: TEST_SERVER_KEY, cert: TEST_SERVER_CERT, minVersion: "TLSv1.3" },
    (incoming, outgoing) => {
      if (target === null) {
        outgoing.writeHead(503).end();
        return;
      }
      const upstream = httpRequest(
        new URL(incoming.url!, target),
        {
          method: incoming.method,
          headers: incoming.headers,
        },
        (response) => {
          if (
            incoming.url?.endsWith("/actions") &&
            state.beforeActionDelivery !== null
          ) {
            // Delay only delivery of the real upstream response after it has completed. This
            // makes a late authority withdrawal observable without replacing its receipt.
            const chunks: Buffer[] = [];
            let size = 0;
            response.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > 128 * 1024) {
                upstream.destroy();
                outgoing.destroy();
                return;
              }
              chunks.push(chunk);
            });
            response.once("end", () => {
              void state.beforeActionDelivery!()
                .then(() => {
                  outgoing.writeHead(response.statusCode!, response.headers);
                  outgoing.end(Buffer.concat(chunks));
                })
                .catch(() => outgoing.destroy());
            });
            response.once("error", () => outgoing.destroy());
            return;
          }
          outgoing.writeHead(response.statusCode!, response.headers);
          response.pipe(outgoing);
        },
      );
      incoming.once("aborted", () => upstream.destroy());
      outgoing.once("close", () => {
        if (!outgoing.writableEnded) upstream.destroy();
      });
      upstream.once("error", () => {
        if (!outgoing.headersSent) outgoing.writeHead(502);
        outgoing.end();
      });
      incoming.pipe(upstream);
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `https://localhost:${address.port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    origin,
    state,
    target(origin: string) {
      target = origin;
    },
    request(
      path: string,
      input: Readonly<{
        method?: string;
        body?: unknown;
        csrfToken?: string;
        idempotencyKey?: string;
        extraHeaders?: Record<string, string>;
      }> = {},
    ): Promise<{ status: number; text: string; body: Record<string, any> }> {
      return new Promise((resolve, reject) => {
        const body =
          input.body === undefined ? null : JSON.stringify(input.body);
        const request = httpsRequest(
          new URL(path, origin),
          {
            method: input.method ?? "GET",
            ca: TEST_CA_CERT,
            family: 4,
            headers: {
              accept: "application/json",
              cookie: taskProcessCookie,
              origin,
              ...(body === null ? {} : { "content-type": "application/json" }),
              ...(input.csrfToken === undefined
                ? {}
                : { "x-csrf-token": input.csrfToken }),
              ...(input.idempotencyKey === undefined
                ? {}
                : { "idempotency-key": input.idempotencyKey }),
              ...input.extraHeaders,
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            let size = 0;
            response.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > 512 * 1024) {
                response.destroy();
                reject(new Error("named_browser_response_bound"));
              }
              chunks.push(chunk);
            });
            response.once("error", reject);
            response.once("end", () => {
              const text = Buffer.concat(chunks).toString("utf8");
              try {
                resolve({
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
          () => request.destroy(new Error("named_browser_deadline")),
          30_000,
        );
        timer.unref();
        request.once("close", () => clearTimeout(timer));
        request.once("error", reject);
        request.end(body);
      });
    },
  };
}

export async function taskProcessFreePort(): Promise<number> {
  const server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
