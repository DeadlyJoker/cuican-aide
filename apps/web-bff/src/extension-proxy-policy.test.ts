import assert from "node:assert/strict";
import test from "node:test";
import { createWebBff } from "./web-bff.ts";
import {
  boundedExtensionProxyResponse,
  extensionProxyPolicy,
  EXTENSION_PROXY_RESPONSE_MAX_BYTES,
  EXTENSION_CATALOG_RESPONSE_MAX_BYTES,
} from "./extension-proxy-policy.ts";
import type { WebIdentitySession } from "./identity-session-adapter.ts";

const origin = "https://crewon.example.test";
const target = "http://127.0.0.1:3210";
const base = "/api/v1/extensions/crewon.comfyui-krea2";
const cookie = "crewon_session=opaque-http-only-session";
const serviceToken = "bff-extension-service-credential-at-least-32";
const controlCsrf = "control-extension-csrf-at-least-32-bytes";
const session: WebIdentitySession = {
  sessionId: "extension-browser-session-at-least-32-bytes",
  expiresAt: "2030-01-01T00:00:00.000Z",
  controlAccessToken: "identity-control-access-token-at-least-32",
};

function policy(path: string, method = "GET") {
  const url = new URL(path, origin);
  return extensionProxyPolicy({
    pathname: url.pathname,
    search: url.search,
    method,
  });
}

function bff(fetchImpl: typeof globalThis.fetch, identity = session) {
  return createWebBff({
    controlBffToken: serviceToken,
    controlCsrfToken: controlCsrf,
    controlTarget: target,
    csrfSecret: "extension-browser-csrf-secret-at-least-32",
    publicOrigin: origin,
    identity: { resolve: async () => identity },
    fetch: fetchImpl,
  });
}

function request(path: string, init: RequestInit = {}) {
  return new Request(new URL(path, origin), init);
}

test("allows only the declared plugin methods and bounded configuration revision query", () => {
  for (const [path, method] of [
    [`${base}/configuration`, "GET"],
    [`${base}/configuration?revision=2147483647`, "GET"],
    [`${base}/configuration`, "PUT"],
    [`${base}/activation`, "GET"],
    [`${base}/activation`, "PUT"],
    [`${base}/tasks`, "POST"],
  ])
    assert.deepEqual(policy(path!, method), {
      outcome: "allow",
      responseMaxBytes: EXTENSION_PROXY_RESPONSE_MAX_BYTES,
    });
  for (const query of [
    "revision=0",
    "revision=01",
    "revision=2147483648",
    "revision=1&revision=2",
    "tenantId=other",
    "revision=1&actorId=other",
    "&&",
  ]) {
    assert.deepEqual(policy(`${base}/configuration?${query}`), {
      outcome: "deny",
      status: 400,
      code: "extension_query_invalid",
    });
  }
  for (const [path, method] of [
    [`${base}/configuration?revision=1`, "PUT"],
    [`${base}/activation?tenantId=other`, "GET"],
    [`${base}/tasks?spaceId=other`, "POST"],
  ])
    assert.equal(policy(path!, method)?.outcome, "deny");
  assert.deepEqual(policy(`${base}/tasks`), {
    outcome: "deny",
    status: 405,
    code: "method_not_allowed",
  });
  assert.deepEqual(policy(`${base}/configuration`, "HEAD"), {
    outcome: "deny",
    status: 405,
    code: "method_not_allowed",
  });
});

test("denies unknown or encoded plugin paths and leaves existing chat/team/run paths unchanged", () => {
  for (const path of [
    `${base}/private`,
    `${base}/tasks/run-1/events`,
    `${base}/configuration/`,
    "/api/v1/%65xtensions/crewon.comfyui-krea2/configuration",
    "/api/v1/extensions%2Fcrewon.comfyui-krea2/configuration",
    "/api/v1/extensions/crewon%2Ecomfyui-krea2/configuration",
    "/api/v1/extensions/invalid/configuration",
    `/api/v1/extensions/crewon.${"x".repeat(48)}/configuration`,
  ])
    assert.deepEqual(policy(path), {
      outcome: "deny",
      status: 404,
      code: "route_not_found",
    });
  for (const path of [
    "/api/v1/threads",
    "/api/v1/teams",
    "/api/v1/runs/run-1/events?extensions=owned",
  ])
    assert.equal(policy(path), null);
});

test("catalog, runtime proof and authoritative task reads have exact paths and query fields", () => {
  assert.deepEqual(policy("/api/v1/extensions"), {
    outcome: "allow",
    responseMaxBytes: EXTENSION_CATALOG_RESPONSE_MAX_BYTES,
  });
  for (const path of [
    `${base}/runtime?agentVersionId=plugin-agent&configurationRevision=1`,
    `${base}/tasks/run-1`,
    `${base}/tasks/${encodeURIComponent("运行-1")}`,
  ]) {
    assert.deepEqual(policy(path), {
      outcome: "allow",
      responseMaxBytes: EXTENSION_PROXY_RESPONSE_MAX_BYTES,
    });
  }
  for (const path of [
    "/api/v1/extensions?tenantId=other",
    `${base}/runtime`,
    `${base}/runtime?agentVersionId=agent-1`,
    `${base}/runtime?agentVersionId=agent-1&configurationRevision=0`,
    `${base}/runtime?agentVersionId=agent-1&configurationRevision=2147483648`,
    `${base}/runtime?agentVersionId=agent-1&agentVersionId=agent-2&configurationRevision=1`,
    `${base}/runtime?agentVersionId=agent-1&configurationRevision=1&spaceId=other`,
    `${base}/runtime?agentVersionId=${"a".repeat(129)}&configurationRevision=1`,
    `${base}/runtime?agentVersionId=%00&configurationRevision=1`,
    `${base}/tasks/run-1?tenantId=other`,
  ])
    assert.equal(policy(path)?.outcome, "deny");
  for (const segment of [
    "run%2F1",
    "run%5C1",
    "%00",
    "%20run",
    "a".repeat(129),
    "%E0%A4%A",
  ]) {
    assert.deepEqual(policy(`${base}/tasks/${segment}`), {
      outcome: "deny",
      status: 404,
      code: "route_not_found",
    });
  }
});

test("plugin reads use the verified browser session and strip injected authority", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const app = bff(async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json(
      { configuration: null },
      {
        headers: {
          "set-cookie": "forged=1",
          "x-crewon-bff-authorization": "reflected-secret",
        },
      },
    );
  });
  const response = await app.handle(
    request(`${base}/configuration?revision=3`, {
      headers: {
        cookie,
        "authorization": "Bearer browser-forged",
        "x-crewon-bff-authorization": "Bearer forged-service",
        "x-forwarded-tenant": "other-tenant",
      },
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { configuration: null });
  assert.equal(calls[0]!.url, `${target}${base}/configuration?revision=3`);
  const headers = new Headers(calls[0]!.init?.headers);
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
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("x-crewon-bff-authorization"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("configuration, activation and task mutations preserve CSRF separation and idempotency", async () => {
  const calls: RequestInit[] = [];
  const app = bff(async (_input, init) => {
    calls.push(init!);
    return Response.json({ disposition: "created" });
  });
  const bootstrap = await app.handle(
    request("/control-api/session", { headers: { cookie } }),
  );
  const csrfToken = ((await bootstrap.json()) as { csrfToken: string })
    .csrfToken;
  for (const [suffix, method] of [
    ["configuration", "PUT"],
    ["activation", "PUT"],
    ["tasks", "POST"],
  ]) {
    const body = JSON.stringify({ command: suffix });
    const response = await app.handle(
      request(`${base}/${suffix}`, {
        method,
        headers: {
          cookie,
          origin,
          "x-csrf-token": csrfToken,
          "content-type": "application/json",
          "idempotency-key": `${suffix}-once`,
        },
        body,
      }),
    );
    assert.equal(response.status, 200);
    const upstream = calls.at(-1)!;
    assert.equal(upstream.method, method);
    assert.equal(
      new Headers(upstream.headers).get("x-csrf-token"),
      controlCsrf,
    );
    assert.equal(
      new Headers(upstream.headers).get("idempotency-key"),
      `${suffix}-once`,
    );
    assert.equal(new TextDecoder().decode(upstream.body as ArrayBuffer), body);
  }
  const denied = await app.handle(
    request(`${base}/tasks`, {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body: "{}",
    }),
  );
  assert.equal(denied.status, 403);
  assert.equal(calls.length, 3);
  const invalidQuery = await app.handle(
    request(`${base}/activation?tenantId=other`, { headers: { cookie } }),
  );
  assert.equal(invalidQuery.status, 400);
  assert.equal(calls.length, 3);
});

test("bounded plugin responses reject advertised and chunked overflow and cancel upstream", async () => {
  for (const declared of [
    String(EXTENSION_PROXY_RESPONSE_MAX_BYTES + 1),
    "-1",
    "invalid",
  ]) {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const app = bff(
      async () =>
        new Response(stream, {
          headers: {
            "content-type": "application/json",
            "content-length": declared,
          },
        }),
    );
    const response = await app.handle(
      request(`${base}/activation`, { headers: { cookie } }),
    );
    assert.equal(response.status, 502);
    assert.equal(cancelled, true);
  }
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(EXTENSION_PROXY_RESPONSE_MAX_BYTES));
      controller.enqueue(new Uint8Array(1));
    },
    cancel() {
      cancelled = true;
    },
  });
  const app = bff(
    async () =>
      new Response(stream, { headers: { "content-type": "application/json" } }),
  );
  const response = await app.handle(
    request(`${base}/activation`, { headers: { cookie } }),
  );
  assert.equal(response.status, 502);
  assert.equal(cancelled, true);
});

test("bounded plugin replies preserve JSON errors and rewrite actual body length", async () => {
  const response = await boundedExtensionProxyResponse({
    upstream: new Response("{}", {
      status: 403,
      headers: { "content-type": "application/json", "content-length": "12" },
    }),
    signal: new AbortController().signal,
  });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("content-length"), "2");
  assert.equal(await response.text(), "{}");
  await assert.rejects(
    boundedExtensionProxyResponse({
      upstream: new Response("<html>internal</html>", {
        headers: { "content-type": "text/html" },
      }),
      signal: new AbortController().signal,
    }),
    /extension_response_invalid/u,
  );
});

test("catalog permits a larger finite JSON payload while other plugin reads remain bounded", async () => {
  const large = JSON.stringify({
    extensions: [
      { description: "x".repeat(EXTENSION_PROXY_RESPONSE_MAX_BYTES) },
    ],
  });
  const app = bff(
    async () =>
      new Response(large, { headers: { "content-type": "application/json" } }),
  );
  assert.equal(
    (await app.handle(request("/api/v1/extensions", { headers: { cookie } })))
      .status,
    200,
  );
  assert.equal(
    (await app.handle(request(`${base}/activation`, { headers: { cookie } })))
      .status,
    502,
  );
});

test("browser cancellation stops a pending plugin JSON read while Run SSE remains streaming", async () => {
  let started!: () => void;
  const upstreamStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const controller = new AbortController();
  const app = bff(async () => {
    started();
    return new Response(stream, {
      headers: { "content-type": "application/json" },
    });
  });
  const pending = app.handle(
    request(`${base}/activation`, {
      headers: { cookie },
      signal: controller.signal,
    }),
  );
  await upstreamStarted;
  controller.abort();
  assert.equal((await pending).status, 502);
  assert.equal(cancelled, true);
  const sse = bff(
    async () =>
      new Response("id: 1\ndata: {}\n\n", {
        headers: { "content-type": "text/event-stream" },
      }),
  );
  const events = await sse.handle(
    request("/api/v1/runs/run-1/events", {
      headers: { cookie, "last-event-id": "0" },
    }),
  );
  assert.equal(events.headers.get("content-type"), "text/event-stream");
  assert.equal(await events.text(), "id: 1\ndata: {}\n\n");
});
