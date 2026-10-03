import assert from "node:assert/strict";
import test from "node:test";
import { createWebBff } from "./web-bff.ts";
import {
  boundedPluginProxyResponse,
  pluginProxyPolicy,
  PLUGIN_ASSET_RESPONSE_MAX_BYTES,
  PLUGIN_CATALOG_RESPONSE_MAX_BYTES,
  PLUGIN_JSON_RESPONSE_MAX_BYTES,
  PLUGIN_LEASE_RESPONSE_MAX_BYTES,
} from "./plugin-proxy-policy.ts";

const origin = "https://plugins.example.test";
const ref = "mount_" + "a".repeat(32);
const base = "/api/v1/plugins";
const mount = `${base}/ui/mounts/${ref}`;
const digest = `sha256:${"a".repeat(64)}`;
const cookie = "crewon_session=real-identity-fixture";
const session = {
  sessionId: "plugin-browser-session-at-least-32-bytes",
  expiresAt: "2030-01-01T00:00:00.000Z",
  controlAccessToken: "plugin-user-control-credential-at-least-32",
};
const serviceToken = "plugin-bff-service-credential-at-least-32";
const controlCsrf = "plugin-control-csrf-credential-at-least-32";

function policy(path: string, method = "GET") {
  const offset = path.indexOf("?");
  return pluginProxyPolicy({
    pathname: offset < 0 ? path : path.slice(0, offset),
    search: offset < 0 ? "" : path.slice(offset),
    method,
  });
}
function app(fetch: typeof globalThis.fetch, onResolve?: () => void) {
  return createWebBff({
    publicOrigin: origin,
    controlTarget: "http://127.0.0.1:3210",
    controlBffToken: serviceToken,
    controlCsrfToken: controlCsrf,
    csrfSecret: "plugin-browser-csrf-secret-at-least-32",
    fetch,
    identity: {
      resolve: async ({ cookie: received }) => {
        onResolve?.();
        return received === cookie ? session : null;
      },
    },
  });
}
function request(path: string, init: RequestInit = {}) {
  return new Request(new URL(path, origin), {
    ...init,
    headers: { cookie, ...Object.fromEntries(new Headers(init.headers)) },
  });
}

test("declares every plugin route with exact method and finite response family", () => {
  for (const [path, method, kind, bytes] of [
    [`${base}/sources`, "GET", "json", PLUGIN_JSON_RESPONSE_MAX_BYTES],
    [`${base}/packages`, "GET", "json", PLUGIN_JSON_RESPONSE_MAX_BYTES],
    [
      `${base}/packages/${encodeURIComponent(digest)}`,
      "GET",
      "json",
      PLUGIN_JSON_RESPONSE_MAX_BYTES,
    ],
    [`${base}/selections`, "GET", "json", PLUGIN_JSON_RESPONSE_MAX_BYTES],
    [
      `${base}/selections/fixture.plugin`,
      "GET",
      "json",
      PLUGIN_JSON_RESPONSE_MAX_BYTES,
    ],
    [
      `${base}/selections/fixture.plugin`,
      "PUT",
      "json",
      PLUGIN_JSON_RESPONSE_MAX_BYTES,
    ],
    [`${base}/installations`, "POST", "json", PLUGIN_JSON_RESPONSE_MAX_BYTES],
    [`${base}/ui/catalog`, "GET", "json", PLUGIN_CATALOG_RESPONSE_MAX_BYTES],
    [`${base}/ui/mounts`, "POST", "json", PLUGIN_LEASE_RESPONSE_MAX_BYTES],
    [mount, "GET", "json", PLUGIN_LEASE_RESPONSE_MAX_BYTES],
    [mount, "DELETE", "json", PLUGIN_JSON_RESPONSE_MAX_BYTES],
    [`${mount}/actions`, "POST", "json", PLUGIN_JSON_RESPONSE_MAX_BYTES],
    [
      `${mount}/assets/dist/chunks/helper.mjs`,
      "GET",
      "asset",
      PLUGIN_ASSET_RESPONSE_MAX_BYTES,
    ],
  ] as const) {
    assert.deepEqual(policy(path, method), {
      outcome: "allow",
      responseKind: kind,
      responseMaxBytes: bytes,
    });
    assert.equal(
      policy(path, method === "GET" ? "POST" : "GET")?.outcome,
      path === mount && method === "DELETE"
        ? "allow"
        : path.includes("/selections/fixture") && method === "PUT"
          ? "allow"
          : "deny",
    );
    assert.equal(policy(path, "HEAD")?.outcome, "deny");
  }
});

test("source catalog permits only bounded own cursor queries and GET, without relaxing existing routes", () => {
  for (const cursor of ["opaque:source", "来源/版本", "x".repeat(128)])
    assert.equal(
      policy(
        `${base}/sources?afterSourceId=${encodeURIComponent(cursor)}&limit=50`,
      )?.outcome,
      "allow",
    );
  assert.equal(policy(`${base}/sources?limit=1`)?.outcome, "allow");
  for (const query of [
    "afterSourceId=",
    "afterSourceId=one&afterSourceId=two",
    `afterSourceId=${encodeURIComponent("x".repeat(129))}`,
    "afterSourceId=%20blank",
    "afterSourceId=%00",
    "afterSourceId=%E2%80%8B",
    "limit=0",
    "limit=01",
    "limit=51",
    "limit=1&limit=2",
    "profileId=forged",
    "actorId=forged",
    "path=%2Fprivate%2Fsource",
    "limit=1&&",
  ])
    assert.deepEqual(
      policy(`${base}/sources?${query}`),
      { outcome: "deny", status: 400, code: "plugin_query_invalid" },
      query,
    );
  for (const method of ["POST", "PUT", "DELETE", "HEAD"])
    assert.deepEqual(policy(`${base}/sources`, method), {
      outcome: "deny",
      status: 405,
      code: "method_not_allowed",
    });
  assert.equal(policy(`${base}/sources/private-id`)?.outcome, "deny");
  assert.equal(
    policy(`${base}/packages?afterSourceId=opaque`)?.outcome,
    "deny",
  );
  assert.equal(
    policy(`${base}/installations?afterSourceId=opaque`, "POST")?.outcome,
    "deny",
  );
});

test("source listing requires a fresh real session and forwards public JSON without renderer identity or credentials", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  let resolutions = 0;
  const response = { sources: [], next: null };
  const bff = app(
    async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return Response.json(response);
    },
    () => {
      resolutions++;
    },
  );
  for (let i = 0; i < 2; i++) {
    const result = await bff.handle(
      request(`${base}/sources?afterSourceId=approved%3Aone&limit=1`, {
        headers: {
          "authorization": "Bearer forged",
          "x-actor-id": "forged",
          "x-forwarded-tenant": "forged",
          "x-csrf-token": "forged",
        },
      }),
    );
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), response);
  }
  assert.equal(resolutions, 2);
  assert.equal(calls.length, 2);
  for (const { url, init } of calls) {
    const headers = new Headers(init.headers);
    assert.equal(
      url,
      `http://127.0.0.1:3210${base}/sources?afterSourceId=approved%3Aone&limit=1`,
    );
    assert.equal(init.method, "GET");
    assert.equal(init.body, undefined);
    assert.equal(init.redirect, "manual");
    assert.equal(
      headers.get("authorization"),
      `Bearer ${session.controlAccessToken}`,
    );
    assert.equal(headers.get("cookie"), null);
    assert.equal(headers.get("x-actor-id"), null);
    assert.equal(headers.get("x-forwarded-tenant"), null);
    assert.equal(headers.get("x-csrf-token"), null);
    assert.equal(headers.get("idempotency-key"), null);
  }
  const denied = await bff.handle(
    new Request(new URL(`${base}/sources`, origin)),
  );
  assert.equal(denied.status, 401);
  assert.equal(calls.length, 2);
});

test("rejects unknown families, raw and encoded traversal and undeclared path shapes", () => {
  for (const path of [
    base,
    `${base}/private`,
    `${base}/packages/`,
    `${mount}/events`,
    "/api/v1/%70lugins/ui/catalog",
    "/api/v1/%70lugins/ui/%ZZ",
    "/api/v1/plugins%2Fui/catalog",
    "/api/v1/plugins%ZZ/ui/catalog",
    `${base}/ui/../ui/catalog`,
    `${mount}/assets/../entry.mjs`,
    `${mount}/assets/%2e%2e/entry.mjs`,
    `${mount}/assets/a%2fb.mjs`,
    `${mount}/assets/a%5cb.mjs`,
    `${mount}/assets/%252e%252e/entry.mjs`,
    `${mount}/assets/a//b.mjs`,
    `${mount}/assets/%00.js`,
    `${mount}/assets/http%3Aevil.js`,
    `${mount}/assets/a%3Fquery.js`,
    `${mount}/assets/%E0%A4%A`,
    `${mount}/assets/${"a".repeat(257)}`,
    `${base}/../../control-api/health/live`,
  ])
    assert.deepEqual(
      policy(path),
      { outcome: "deny", status: 404, code: "route_not_found" },
      path,
    );
  for (const path of [
    "/api/v1/extensions",
    "/api/v1/threads",
    "/api/v1/runs/r/events",
  ])
    assert.equal(policy(path), null);
});

test("bounded list queries reject authority, duplicates and noncanonical limits", () => {
  assert.equal(
    policy(
      `${base}/packages?pluginId=fixture.plugin&afterPackageDigest=${encodeURIComponent(digest)}&limit=50`,
    )?.outcome,
    "allow",
  );
  assert.equal(
    policy(`${base}/ui/catalog?afterPluginId=fixture.plugin&limit=1`)?.outcome,
    "allow",
  );
  for (const path of [
    `${base}/packages?limit=0`,
    `${base}/packages?limit=01`,
    `${base}/packages?limit=51`,
    `${base}/packages?limit=1&limit=2`,
    `${base}/packages?tenantId=other`,
    `${base}/packages?profileId=other`,
    `${base}/packages?afterPackageDigest=no`,
    `${base}/packages?pluginId=Bad`,
    `${base}/selections?pluginId=fixture.plugin`,
    `${base}/ui/catalog?limit=1&&`,
    `${mount}?limit=1`,
    `${mount}/assets/entry.js?token=secret`,
  ])
    assert.deepEqual(
      policy(path),
      { outcome: "deny", status: 400, code: "plugin_query_invalid" },
      path,
    );
});

test("original raw target prevents URL-normalized paths bypassing plugin policy", async () => {
  let calls = 0;
  const bff = app(async () => {
    calls++;
    return Response.json({ ok: true });
  });
  for (const rawTarget of [
    `${base}/ui/../ui/catalog`,
    `${base}/../../control-api/health/live`,
    `${mount}/assets/%2e%2e/entry.mjs`,
  ]) {
    const response = await bff.handle(request(rawTarget), { rawTarget });
    assert.equal(response.status, 404);
  }
  assert.equal(calls, 0);
  // No trusted adapter context means only the Request's already visible path can be checked.
  assert.equal(
    (
      await bff.handle(request(`${base}/ui/catalog`), {
        rawTarget: `${base}/ui/catalog`,
      })
    ).status,
    200,
  );
  assert.equal(calls, 1);
});

test("assets require a fresh real cookie session and replace injected authority on every request", async () => {
  let resolutions = 0;
  const calls: { url: string; init: RequestInit }[] = [];
  const source = "export default { mount() {} };";
  const bff = app(
    async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return new Response(source, {
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          "set-cookie": "forged=1",
          "x-crewon-bff-authorization": "reflected",
        },
      });
    },
    () => {
      resolutions++;
    },
  );
  const path = `${mount}/assets/dist/entry.mjs`;
  assert.equal((await bff.handle(new Request(`${origin}${path}`))).status, 401);
  for (let i = 0; i < 2; i++) {
    const response = await bff.handle(
      request(path, {
        headers: {
          "authorization": "Bearer injected",
          "x-crewon-bff-authorization": "Bearer fake",
          "x-forwarded-tenant": "other",
        },
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), source);
    assert.equal(
      response.headers.get("content-type"),
      "text/javascript; charset=utf-8",
    );
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("x-crewon-bff-authorization"), null);
  }
  assert.equal(resolutions, 3);
  assert.equal(calls.length, 2);
  for (const { url, init } of calls) {
    assert.equal(url, `http://127.0.0.1:3210${path}`);
    const headers = new Headers(init.headers);
    assert.equal(
      headers.get("authorization"),
      `Bearer ${session.controlAccessToken}`,
    );
    assert.equal(
      headers.get("x-crewon-bff-authorization"),
      `Bearer ${serviceToken}`,
    );
    assert.equal(headers.get("cookie"), null);
    assert.equal(headers.get("x-forwarded-tenant"), null);
    assert.equal(headers.get("x-csrf-token"), null);
    assert.equal(init.redirect, "manual");
  }
});

test("install/select and UI mutation bodies keep CSRF separation and original idempotency", async () => {
  const calls: RequestInit[] = [];
  const bff = app(async (_url, init = {}) => {
    calls.push(init);
    return Response.json({ closed: true });
  });
  const bootstrap = await bff.handle(request("/control-api/session"));
  const { csrfToken } = (await bootstrap.json()) as { csrfToken: string };
  for (const [path, method] of [
    [`${base}/installations`, "POST"],
    [`${base}/selections/fixture.plugin`, "PUT"],
    [`${base}/ui/mounts`, "POST"],
    [`${mount}/actions`, "POST"],
    [mount, "DELETE"],
  ]) {
    const body = method === "DELETE" ? undefined : "{}";
    assert.equal(
      (
        await bff.handle(
          request(path!, {
            method,
            body,
            headers: {
              origin,
              "content-type": "application/json",
              "x-csrf-token": csrfToken,
              "idempotency-key": "host-action-once",
            },
          }),
        )
      ).status,
      200,
    );
    const init = calls.at(-1)!;
    assert.equal(new Headers(init.headers).get("x-csrf-token"), controlCsrf);
    assert.equal(
      new Headers(init.headers).get("idempotency-key"),
      "host-action-once",
    );
    assert.equal(init.method, method);
    assert.equal(
      init.body === undefined
        ? undefined
        : new TextDecoder().decode(init.body as Uint8Array),
      body,
    );
  }
  const count = calls.length;
  assert.equal(
    (
      await bff.handle(
        request(`${mount}/actions`, {
          method: "POST",
          body: "{}",
          headers: { origin, "content-type": "application/json" },
        }),
      )
    ).status,
    403,
  );
  assert.equal(calls.length, count);
});

test("asset bytes bypass JSON parsing while status errors remain finite JSON", async () => {
  const allowed = policy(`${mount}/assets/entry.js`)!;
  assert.equal(allowed.outcome, "allow");
  if (allowed.outcome !== "allow") throw new Error();
  const body = new Uint8Array(256 * 1024).fill(0xff);
  const response = await boundedPluginProxyResponse({
    upstream: new Response(body, {
      headers: { "content-type": "application/octet-stream" },
    }),
    signal: new AbortController().signal,
    policy: allowed,
  });
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), body);
  const error = await boundedPluginProxyResponse({
    upstream: Response.json(
      { error: { code: "authorization_denied" } },
      { status: 403 },
    ),
    signal: new AbortController().signal,
    policy: allowed,
  });
  assert.equal(error.status, 403);
  await assert.rejects(
    boundedPluginProxyResponse({
      upstream: new Response("redirect", {
        status: 302,
        headers: { location: "https://foreign.test/entry.js" },
      }),
      signal: new AbortController().signal,
      policy: allowed,
    }),
    /plugin_response_invalid/,
  );
  await assert.rejects(
    boundedPluginProxyResponse({
      upstream: new Response("not json", {
        status: 403,
        headers: { "content-type": "text/javascript" },
      }),
      signal: new AbortController().signal,
      policy: allowed,
    }),
    /plugin_response_invalid/,
  );
});

test("finite JSON and asset limits cancel oversized declared and streamed bodies", async () => {
  for (const path of [`${base}/packages`, `${mount}/assets/entry.js`]) {
    const allowed = policy(path)!;
    if (allowed.outcome !== "allow") throw new Error();
    for (const declared of [true, false]) {
      let cancelled = false;
      const upstream = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            if (!declared)
              controller.enqueue(new Uint8Array(allowed.responseMaxBytes + 1));
          },
          cancel() {
            cancelled = true;
          },
        }),
        {
          headers: {
            "content-type": path.includes("/assets/")
              ? "text/javascript"
              : "application/json",
            ...(declared
              ? { "content-length": String(allowed.responseMaxBytes + 1) }
              : {}),
          },
        },
      );
      await assert.rejects(
        boundedPluginProxyResponse({
          upstream,
          signal: new AbortController().signal,
          policy: allowed,
        }),
        /plugin_body_too_large/,
      );
      assert.equal(cancelled, true);
    }
  }
  const allowed = policy(`${base}/packages`)!;
  if (allowed.outcome !== "allow") throw new Error();
  await assert.rejects(
    boundedPluginProxyResponse({
      upstream: new Response("{", {
        headers: { "content-type": "application/json" },
      }),
      signal: new AbortController().signal,
      policy: allowed,
    }),
    /plugin_response_invalid/,
  );
});

test("browser cancellation interrupts a stalled asset body and cancels its upstream reader", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const bff = app(async (_url, init = {}) => {
    assert.ok(init.signal);
    return new Response(
      new ReadableStream({
        start(stream) {
          stream.enqueue(new TextEncoder().encode("export "));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "text/javascript" } },
    );
  });
  const pending = bff.handle(
    request(`${mount}/assets/entry.js`, { signal: controller.signal }),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  assert.equal((await pending).status, 502);
  assert.equal(cancelled, true);
});

test(
  "plugin upstream transport gets the finite ten second deadline",
  { timeout: 15_000 },
  async () => {
    let captured: AbortSignal | undefined;
    const bff = app(async (_url, init = {}) => {
      captured = init.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        captured!.addEventListener("abort", () => reject(captured!.reason), {
          once: true,
        });
      });
    });
    assert.equal((await bff.handle(request(`${base}/ui/catalog`))).status, 502);
    assert.equal(captured?.aborted, true);
    assert.equal(captured?.reason.name, "TimeoutError");
  },
);
