import assert from "node:assert/strict";
import test from "node:test";
import { MAX_PLUGIN_CREDIT_READ_RESPONSE_BYTES } from "@crewon/contracts";
import {
  boundedPluginProxyResponse,
  pluginProxyPolicy,
  PLUGIN_JSON_RESPONSE_MAX_BYTES,
  PLUGIN_LEASE_RESPONSE_MAX_BYTES,
  PLUGIN_RECOVERY_RESPONSE_MAX_BYTES,
  type PluginProxyPolicy,
} from "./plugin-proxy-policy.ts";
import { createWebBff } from "./web-bff.ts";

const accountsPath = "/api/v1/plugins/credits/accounts";
const entriesPath = "/api/v1/plugins/credits/entries";
const poolId = "本人/图像 😀?x=%&";
const origin = "https://credits.example.test";
const cookie = "crewon_session=credit-read-fixture";
const session = {
  sessionId: "credit-read-browser-session-at-least-32-bytes",
  expiresAt: "2030-01-01T00:00:00.000Z",
  controlAccessToken: "credit-read-user-credential-at-least-32-bytes",
};
const serviceToken = "credit-read-bff-credential-at-least-32-bytes";
function policy(path: string, method = "GET") {
  const offset = path.indexOf("?");
  return pluginProxyPolicy({
    pathname: offset < 0 ? path : path.slice(0, offset),
    search: offset < 0 ? "" : path.slice(offset),
    method,
  });
}
function allowed(
  path = accountsPath,
): Extract<PluginProxyPolicy, { outcome: "allow" }> {
  const result = policy(path);
  assert.equal(result?.outcome, "allow");
  if (result?.outcome !== "allow") throw new Error("Expected read policy");
  return result;
}
function app(fetch: typeof globalThis.fetch, onResolve?: () => void) {
  return createWebBff({
    publicOrigin: origin,
    controlTarget: "http://127.0.0.1:3210",
    controlBffToken: serviceToken,
    controlCsrfToken: "credit-read-control-csrf-at-least-32-bytes",
    csrfSecret: "credit-read-browser-csrf-at-least-32-bytes",
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
const queryDenied = {
  outcome: "deny",
  status: 400,
  code: "plugin_query_invalid",
};
const routeDenied = { outcome: "deny", status: 404, code: "route_not_found" };

test("only the two exact credit GET routes receive the 64 KiB successful JSON policy", () => {
  for (const path of [
    accountsPath,
    `${entriesPath}?poolId=${encodeURIComponent(poolId)}`,
  ]) {
    assert.deepEqual(policy(path), {
      outcome: "allow",
      responseKind: "json",
      responseMaxBytes: MAX_PLUGIN_CREDIT_READ_RESPONSE_BYTES,
    });
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
      assert.deepEqual(policy(path, method), {
        outcome: "deny",
        status: 405,
        code: "method_not_allowed",
      });
  }
  assert.equal(policy(`${accountsPath}?limit=1`)?.outcome, "allow");
  assert.equal(
    policy(`${accountsPath}?afterPoolId=${encodeURIComponent(poolId)}&limit=16`)
      ?.outcome,
    "allow",
  );
  assert.equal(
    policy(
      `${entriesPath}?poolId=${encodeURIComponent(poolId)}&afterRevision=2147483647&limit=50`,
    )?.outcome,
    "allow",
  );
});

test("entries require a real bounded pool ID; duplicate, owner and noncanonical queries are rejected", () => {
  for (const query of [
    "",
    "?",
    "?afterRevision=0",
    "?poolId=",
    "?poolId=a&poolId=b",
    "?poolId=a&limit=1&limit=2",
    "?poolId=a&afterRevision=0&afterRevision=1",
    "?poolId=a&limit=0",
    "?poolId=a&limit=51",
    "?poolId=a&limit=01",
    "?poolId=a&afterRevision=-1",
    "?poolId=a&afterRevision=01",
    "?poolId=a&afterRevision=2147483648",
    `?poolId=${"x".repeat(129)}`,
    "?poolId=%00",
    "?poolId=%20a",
    "?poolId=a&&",
    "?poolId=a&",
  ])
    assert.deepEqual(policy(`${entriesPath}${query}`), queryDenied, query);
  for (const selector of [
    "tenantId",
    "principalId",
    "actorId",
    "spaceId",
    "profileId",
    "grantId",
    "reservationId",
    "path",
    "sourceId",
  ])
    for (const path of [
      `${accountsPath}?${selector}=other`,
      `${entriesPath}?poolId=own&${selector}=other`,
    ])
      assert.deepEqual(policy(path), queryDenied, path);
  for (const query of [
    "?poolId=own",
    "?limit=17",
    "?limit=0",
    "?limit=01",
    "?limit=1&limit=2",
    "?afterPoolId=",
    "?afterPoolId=a&afterPoolId=b",
    `?afterPoolId=${"x".repeat(129)}`,
    "?limit=1&&",
  ])
    assert.deepEqual(policy(`${accountsPath}${query}`), queryDenied, query);
});

test("opaque query values cannot inject a route, while encoded or raw route aliases remain denied", () => {
  const injection = "../ui/mounts/x/actions?tenantId=other&poolId=foreign";
  assert.equal(
    policy(`${entriesPath}?poolId=${encodeURIComponent(injection)}`)?.outcome,
    "allow",
  );
  for (const path of [
    "/api/v1/plugins/credits",
    `${accountsPath}/`,
    `${entriesPath}/own`,
    `${accountsPath}/../entries`,
    "/api/v1/plugins/credits/%61ccounts",
    "/api/v1/%70lugins/credits/accounts",
    "/api/v1/plugins%2Fcredits/accounts",
    "/api/v1/plugins/credits%2Faccounts",
    "/api/v1/plugins/credits/%2e%2e/ui/catalog",
    "/api/v1/plugins/credits/accounts%3FpoolId=own",
    "/api/v1/plugins/credits/accounts%00",
    "/api/v1/plugins/credits/accounts\\entries",
    "/api/v1/plugins/credits/accounts/%ZZ",
    "/api/v1/plugins/credits//accounts",
  ])
    assert.deepEqual(policy(path), routeDenied, path);
});

test("fresh real sessions replace injected owner credentials without introducing a mutation or CSRF", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  let resolutions = 0;
  const response = {
    schemaVersion: "crewon.plugin-credit-accounts.v1",
    state: "ready",
    accounts: [],
    nextPoolId: null,
  };
  const history = {
    schemaVersion: "crewon.plugin-credit-entries.v1",
    state: "unconfigured",
    account: null,
    entries: [],
    nextRevision: null,
  };
  const bff = app(
    async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return Response.json(
        new URL(String(url)).pathname === entriesPath ? history : response,
      );
    },
    () => {
      resolutions++;
    },
  );
  const path = `${accountsPath}?afterPoolId=${encodeURIComponent(poolId)}&limit=1`;
  for (let i = 0; i < 2; i++) {
    const result = await bff.handle(
      request(path, {
        headers: {
          "authorization": "Bearer forged",
          "x-crewon-bff-authorization": "forged",
          "x-actor-id": "foreign",
          "x-forwarded-tenant": "foreign",
          "x-csrf-token": "forged",
        },
      }),
    );
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), response);
    assert.equal(result.headers.get("cache-control"), "no-store");
  }
  const historyPath = `${entriesPath}?${new URLSearchParams({ poolId, afterRevision: "0", limit: "50" })}`;
  const historyReply = await bff.handle(request(historyPath));
  assert.equal(historyReply.status, 200);
  assert.deepEqual(await historyReply.json(), history);
  assert.equal(resolutions, 3);
  assert.equal(calls.length, 3);
  for (const [index, { url, init }] of calls.entries()) {
    const headers = new Headers(init.headers);
    assert.equal(
      url,
      `http://127.0.0.1:3210${index === 2 ? historyPath : path}`,
    );
    assert.equal(init.method, "GET");
    assert.equal(init.body, undefined);
    assert.equal(init.redirect, "manual");
    assert.ok(init.signal);
    assert.equal(
      headers.get("authorization"),
      `Bearer ${session.controlAccessToken}`,
    );
    assert.equal(
      headers.get("x-crewon-bff-authorization"),
      `Bearer ${serviceToken}`,
    );
    for (const key of [
      "cookie",
      "x-actor-id",
      "x-forwarded-tenant",
      "x-csrf-token",
      "idempotency-key",
    ])
      assert.equal(headers.get(key), null);
  }
  assert.equal(
    (await bff.handle(new Request(`${origin}${accountsPath}`))).status,
    401,
  );
  assert.equal(calls.length, 3);
});

test("invalid queries, writes and raw traversal never dispatch through the BFF", async () => {
  let calls = 0;
  const bff = app(async () => {
    calls++;
    return Response.json({});
  });
  for (const path of [
    `${accountsPath}?tenantId=other`,
    `${entriesPath}?poolId=one&poolId=two`,
    entriesPath,
  ])
    assert.equal((await bff.handle(request(path))).status, 400);
  for (const method of ["POST", "PUT", "DELETE", "PATCH", "HEAD"])
    assert.equal(
      (await bff.handle(request(accountsPath, { method }))).status,
      405,
    );
  for (const rawTarget of [
    "/api/v1/plugins/credits/../credits/accounts",
    "/api/v1/plugins/credits/%2e%2e/ui/catalog",
  ])
    assert.equal(
      (await bff.handle(request(rawTarget), { rawTarget })).status,
      404,
    );
  assert.equal(calls, 0);
});

test("the BFF forwards exactly 64 KiB successful JSON and rejects streamed excess independently of Content-Length", async () => {
  const json = JSON.stringify({
    schemaVersion: "crewon.plugin-credit-accounts.v1",
    state: "ready",
    accounts: [],
    nextPoolId: null,
  });
  const exact =
    " ".repeat(
      MAX_PLUGIN_CREDIT_READ_RESPONSE_BYTES - Buffer.byteLength(json),
    ) + json;
  const exactBff = app(
    async () =>
      new Response(exact, { headers: { "content-type": "application/json" } }),
  );
  const response = await exactBff.handle(request(accountsPath));
  assert.equal(response.status, 200);
  assert.equal(
    Buffer.byteLength(await response.text()),
    MAX_PLUGIN_CREDIT_READ_RESPONSE_BYTES,
  );
  for (const declared of [true, false]) {
    let cancelled = false;
    const bff = app(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              if (!declared) {
                stream.enqueue(
                  new Uint8Array(MAX_PLUGIN_CREDIT_READ_RESPONSE_BYTES),
                );
                stream.enqueue(new Uint8Array(1));
              }
            },
            cancel() {
              cancelled = true;
            },
          }),
          {
            headers: {
              "content-type": "application/json",
              ...(declared
                ? {
                    "content-length": String(
                      MAX_PLUGIN_CREDIT_READ_RESPONSE_BYTES + 1,
                    ),
                  }
                : {}),
            },
          },
        ),
    );
    assert.equal((await bff.handle(request(accountsPath))).status, 502);
    assert.equal(cancelled, true);
  }
});

test("credit error envelopes preserve the existing 128 KiB error budget and status", async () => {
  const json = JSON.stringify({
    error: {
      category: "authorization",
      code: "plugin_credit_read_forbidden",
      requestId: "request-public",
    },
  });
  const body = " ".repeat(MAX_PLUGIN_CREDIT_READ_RESPONSE_BYTES) + json;
  assert.ok(Buffer.byteLength(body) < PLUGIN_JSON_RESPONSE_MAX_BYTES);
  const bff = app(
    async () =>
      new Response(body, {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
  );
  const response = await bff.handle(request(accountsPath));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), JSON.parse(json));
  let cancelled = false;
  await assert.rejects(
    boundedPluginProxyResponse({
      upstream: new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(new Uint8Array(PLUGIN_JSON_RESPONSE_MAX_BYTES + 1));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      ),
      signal: new AbortController().signal,
      policy: allowed(),
    }),
    /plugin_body_too_large/,
  );
  assert.equal(cancelled, true);
});

test("redirects and non-JSON successful responses fail through the actual BFF", async () => {
  for (const reply of [
    new Response(null, {
      status: 302,
      headers: { location: "https://foreign.example.test/credits" },
    }),
    new Response("{}", { headers: { "content-type": "text/plain" } }),
    new Response("{", { headers: { "content-type": "application/json" } }),
  ]) {
    const bff = app(async (_url, init = {}) => {
      assert.equal(init.redirect, "manual");
      return reply;
    });
    assert.equal((await bff.handle(request(accountsPath))).status, 502);
  }
});

test("browser abort cancels an actually stalled upstream read without returning stale balances", async () => {
  const controller = new AbortController();
  let entered!: () => void;
  const bodyEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let cancelled = false;
  const bff = app(async (_url, init = {}) => {
    assert.ok(init.signal);
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(stream) {
          stream.enqueue(new TextEncoder().encode(" "));
          entered();
          return new Promise<void>(() => {});
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  const pending = bff.handle(
    request(accountsPath, { signal: controller.signal }),
  );
  await bodyEntered;
  controller.abort();
  assert.equal((await pending).status, 502);
  assert.equal(cancelled, true);
});

test("existing plugin routes keep their original policies and unrelated route families stay outside this policy", () => {
  const ref = `mount_${"a".repeat(32)}`;
  for (const [path, method, bytes] of [
    ["/api/v1/plugins/sources", "GET", PLUGIN_JSON_RESPONSE_MAX_BYTES],
    ["/api/v1/plugins/packages", "GET", PLUGIN_JSON_RESPONSE_MAX_BYTES],
    ["/api/v1/plugins/installations", "POST", PLUGIN_JSON_RESPONSE_MAX_BYTES],
    ["/api/v1/plugins/ui/mounts", "POST", PLUGIN_LEASE_RESPONSE_MAX_BYTES],
    [
      `/api/v1/plugins/ui/mounts/${ref}/recovery`,
      "GET",
      PLUGIN_RECOVERY_RESPONSE_MAX_BYTES,
    ],
  ] as const)
    assert.deepEqual(policy(path, method), {
      outcome: "allow",
      responseKind: "json",
      responseMaxBytes: bytes,
    });
  for (const path of [
    "/api/v1/extensions",
    "/api/v1/threads",
    "/api/v1/runs/run/events",
    "/api/v1/creative-projects",
  ])
    assert.equal(policy(path), null);
  assert.deepEqual(
    policy("/api/v1/plugins/packages?afterPoolId=own"),
    queryDenied,
  );
  assert.deepEqual(
    policy("/api/v1/plugins/ui/catalog?poolId=own"),
    queryDenied,
  );
});
