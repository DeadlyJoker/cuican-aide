import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";

import {
  HttpIdentitySessionAdapter,
  type WebIdentitySession,
  type WebIdentitySessionPort,
} from "./identity-session-adapter.ts";
import { createWebBff } from "./web-bff.ts";

const PUBLIC_ORIGIN = "https://crewon.example.test";
const CONTROL_TARGET = "http://127.0.0.1:3210";
const CONTROL_BFF_TOKEN = "control-bff-service-token-32-bytes-minimum";
const CONTROL_CSRF = "control-csrf-token-32-bytes-minimum";
const CSRF_SECRET = "web-csrf-secret-at-least-32-bytes";
const COOKIE = "crewon_session=http-only-opaque-session";
const SESSION: WebIdentitySession = {
  sessionId: "identity-session-1234567890-abcdef",
  expiresAt: "2030-01-01T00:00:00.000Z",
  controlAccessToken: "short-lived-control-access-token-123456",
};
const execFileAsync = promisify(execFile);

test("returns only same-origin bootstrap data and never exposes the Control bearer", async () => {
  const bff = testBff({ identity: fixedIdentity(SESSION) });
  const response = await bff.handle(
    request("/control-api/session", { headers: { cookie: COOKIE } }),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.deepEqual(Object.keys(body as object).sort(), [
    "baseUrl",
    "csrfToken",
  ]);
  assert.equal((body as { baseUrl: string }).baseUrl, "/");
  assert.match((body as { csrfToken: string }).csrfToken, /^[\w-]{43}$/u);
  assert.doesNotMatch(JSON.stringify(body), /control-access-token/u);
  assert.doesNotMatch(JSON.stringify(body), /control-bff-service-token/u);
});

test("rejects a short BFF-to-Control service credential before serving", () => {
  assert.throws(
    () =>
      createWebBff({
        publicOrigin: PUBLIC_ORIGIN,
        controlTarget: CONTROL_TARGET,
        controlBffToken: "too-short",
        controlCsrfToken: CONTROL_CSRF,
        csrfSecret: CSRF_SECRET,
        identity: fixedIdentity(SESSION),
      }),
    /control_bff_token_invalid/u,
  );
});

test("requires the HttpOnly identity session for bootstrap and proxy requests", async () => {
  const identity = fixedIdentity(null);
  const bff = testBff({ identity });

  assert.equal((await bff.handle(request("/control-api/session"))).status, 401);
  assert.equal((await bff.handle(request("/api/v1/threads"))).status, 401);
  assert.equal(identity.calls.length, 2);
});

test("proxies reads with server authority and strips browser credentials", async () => {
  const upstream: Array<{ input: URL | RequestInfo; init?: RequestInit }> = [];
  const bff = testBff({
    identity: fixedIdentity(SESSION),
    fetch: async (input, init) => {
      upstream.push({ input, init });
      return new Response(JSON.stringify({ data: [] }), {
        headers: {
          "content-type": "application/json",
          "set-cookie": "bad=1",
          "x-crewon-bff-authorization": "Bearer reflected-service-token",
        },
      });
    },
  });
  const response = await bff.handle(
    request("/api/v1/threads?limit=20", {
      headers: {
        "authorization": "Bearer browser-injected-token",
        "cookie": COOKIE,
        "last-event-id": "41",
        "x-crewon-bff-authorization": "Bearer browser-forged-bff-token",
        "x-forwarded-user": "forged-principal",
      },
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("x-crewon-bff-authorization"), null);
  assert.equal(upstream.length, 1);
  assert.equal(
    String(upstream[0]?.input),
    `${CONTROL_TARGET}/api/v1/threads?limit=20`,
  );
  const headers = new Headers(upstream[0]?.init?.headers);
  assert.deepEqual(
    {
      authorization: headers.get("authorization"),
      bffAuthorization: headers.get("x-crewon-bff-authorization"),
      cookie: headers.get("cookie"),
      lastEventId: headers.get("last-event-id"),
      origin: headers.get("origin"),
      forwardedUser: headers.get("x-forwarded-user"),
    },
    {
      authorization: `Bearer ${SESSION.controlAccessToken}`,
      bffAuthorization: `Bearer ${CONTROL_BFF_TOKEN}`,
      cookie: null,
      lastEventId: "41",
      origin: PUBLIC_ORIGIN,
      forwardedUser: null,
    },
  );
});

test("uses separate browser and Control CSRF values for mutations", async () => {
  const upstream: RequestInit[] = [];
  const bff = testBff({
    identity: fixedIdentity(SESSION),
    fetch: async (_input, init) => {
      upstream.push(init ?? {});
      return new Response(null, { status: 204 });
    },
  });
  const sessionResponse = await bff.handle(
    request("/control-api/session", { headers: { cookie: COOKIE } }),
  );
  const { csrfToken } = (await sessionResponse.json()) as { csrfToken: string };
  const response = await bff.handle(
    request("/api/v1/threads", {
      method: "POST",
      headers: {
        "cookie": COOKIE,
        "origin": PUBLIC_ORIGIN,
        "content-type": "application/json",
        "idempotency-key": "thread-create-1",
        "x-csrf-token": csrfToken,
      },
      body: JSON.stringify({ title: "bounded" }),
    }),
  );

  assert.equal(response.status, 204);
  assert.equal(upstream.length, 1);
  const headers = new Headers(upstream[0]?.headers);
  assert.equal(headers.get("x-csrf-token"), CONTROL_CSRF);
  assert.equal(headers.get("idempotency-key"), "thread-create-1");
  assert.equal(
    new TextDecoder().decode(upstream[0]?.body as ArrayBuffer),
    JSON.stringify({ title: "bounded" }),
  );
});

test("fails closed before proxying mutations with missing origin or invalid CSRF", async () => {
  let fetchCalls = 0;
  const bff = testBff({
    identity: fixedIdentity(SESSION),
    fetch: async () => {
      fetchCalls += 1;
      return new Response(null, { status: 204 });
    },
  });
  const sessionResponse = await bff.handle(
    request("/control-api/session", { headers: { cookie: COOKIE } }),
  );
  const { csrfToken } = (await sessionResponse.json()) as { csrfToken: string };

  const missingOrigin = await bff.handle(
    request("/api/v1/threads", {
      method: "POST",
      headers: { "cookie": COOKIE, "x-csrf-token": csrfToken },
    }),
  );
  const badCsrf = await bff.handle(
    request("/api/v1/threads", {
      method: "POST",
      headers: {
        "cookie": COOKIE,
        "origin": PUBLIC_ORIGIN,
        "x-csrf-token": "wrong-csrf-value-at-least-32-bytes",
      },
    }),
  );

  assert.equal(missingOrigin.status, 403);
  assert.equal(badCsrf.status, 403);
  assert.equal(fetchCalls, 0);
});

test("preserves bounded SSE streams without buffering them into JSON", async () => {
  const bff = testBff({
    identity: fixedIdentity(SESSION),
    fetch: async () =>
      new Response("id: 42\nevent: run.updated\ndata: {}\n\n", {
        headers: { "content-type": "text/event-stream" },
      }),
  });
  const response = await bff.handle(
    request("/api/v1/runs/run-1/events", { headers: { cookie: COOKIE } }),
  );

  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(
    await response.text(),
    "id: 42\nevent: run.updated\ndata: {}\n\n",
  );
});

test("propagates a disconnected browser signal to the upstream SSE request", async () => {
  const controller = new AbortController();
  const upstreamSignals: AbortSignal[] = [];
  let markUpstreamStarted!: () => void;
  const upstreamStarted = new Promise<void>((resolve) => {
    markUpstreamStarted = resolve;
  });
  const bff = testBff({
    identity: fixedIdentity(SESSION),
    fetch: async (_input, init) => {
      const upstreamSignal = init?.signal;
      if (upstreamSignal === null || upstreamSignal === undefined) {
        throw new Error("missing_upstream_abort_signal");
      }
      upstreamSignals.push(upstreamSignal);
      markUpstreamStarted();
      await new Promise<void>((resolve) =>
        upstreamSignal.addEventListener("abort", () => resolve(), {
          once: true,
        }),
      );
      throw new Error("upstream_aborted");
    },
  });
  const pending = bff.handle(
    request("/api/v1/runs/run-1/events", {
      headers: { cookie: COOKIE },
      signal: controller.signal,
    }),
  );

  await upstreamStarted;
  assert.equal(upstreamSignals[0]?.aborted, false);
  controller.abort();

  assert.equal((await pending).status, 502);
  assert.equal(upstreamSignals[0]?.aborted, true);
});

test("the HTTP identity adapter accepts only a bounded short-lived exact exchange", async () => {
  const now = Date.parse("2026-08-09T00:00:00.000Z");
  let exchangeHeaders = new Headers();
  const adapter = new HttpIdentitySessionAdapter({
    endpoint: "https://identity.example.test/internal/crewon/session",
    serviceToken: "identity-service-token-at-least-32-bytes",
    now: () => now,
    fetch: async (_input, init) => {
      exchangeHeaders = new Headers(init?.headers);
      return Response.json({
        sessionId: SESSION.sessionId,
        expiresAt: new Date(now + 60_000).toISOString(),
        controlAccessToken: SESSION.controlAccessToken,
      });
    },
  });

  assert.deepEqual(
    await adapter.resolve({ cookie: COOKIE, userAgent: "CrewON test" }),
    {
      sessionId: SESSION.sessionId,
      expiresAt: "2026-08-09T00:01:00.000Z",
      controlAccessToken: SESSION.controlAccessToken,
    },
  );
  assert.equal(exchangeHeaders.get("cookie"), COOKIE);
  assert.match(exchangeHeaders.get("authorization") ?? "", /^Bearer /u);
});

test("the HTTP identity adapter fails closed on transport and schema drift", async (context) => {
  assert.throws(
    () =>
      new HttpIdentitySessionAdapter({
        endpoint: "http://identity.example.test/session",
        serviceToken: "identity-service-token-at-least-32-bytes",
      }),
    /identity_endpoint_invalid/u,
  );

  const now = Date.parse("2026-08-09T00:00:00.000Z");
  for (const [name, response] of [
    ["expired", { ...SESSION, expiresAt: "2026-08-08T23:59:59.000Z" }],
    ["excess lifetime", { ...SESSION, expiresAt: "2026-08-09T00:11:00.000Z" }],
    ["extra authority field", { ...SESSION, actorId: "browser-authority" }],
  ] as const) {
    await context.test(name, async () => {
      const adapter = new HttpIdentitySessionAdapter({
        endpoint: "https://identity.example.test/session",
        serviceToken: "identity-service-token-at-least-32-bytes",
        now: () => now,
        fetch: async () => Response.json(response),
      });
      await assert.rejects(
        adapter.resolve({ cookie: COOKIE, userAgent: null }),
        /identity_session_invalid/u,
      );
    });
  }

  const unauthorized = new HttpIdentitySessionAdapter({
    endpoint: "https://identity.example.test/session",
    serviceToken: "identity-service-token-at-least-32-bytes",
    fetch: async () => new Response(null, { status: 401 }),
  });
  assert.equal(
    await unauthorized.resolve({ cookie: COOKIE, userAgent: null }),
    null,
  );
});

test("production nginx routes the same-origin boundary to the BFF, not Vite", async () => {
  const nginx = await readFile(
    new URL("../../../deploy/crewon/nginx.conf", import.meta.url),
    "utf8",
  );
  const dockerfile = await readFile(
    new URL("../../../deploy/crewon/web-bff.Dockerfile", import.meta.url),
    "utf8",
  );

  assert.match(nginx, /location = \/control-api\/session/u);
  assert.match(nginx, /location \/api\/v1\//u);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:3211/u);
  assert.match(nginx, /proxy_set_header Authorization "";/u);
  assert.match(nginx, /proxy_set_header X-CrewON-BFF-Authorization "";/u);
  assert.match(nginx, /proxy_buffering off;/u);
  assert.doesNotMatch(dockerfile, /vite|CREWON_CONTROL_SESSION_TOKEN/iu);
  assert.match(dockerfile, /src\/main\.ts/u);
});

test("production cutover gate accepts only the request-scoped Control composition", async () => {
  const gate = new URL(
    "../../../deploy/crewon/check-web-production-gates.mjs",
    import.meta.url,
  );
  const result = await execFileAsync(process.execPath, [gate.pathname]);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "web_production_identity_source_gate_passed\n");
});

function request(path: string, init?: RequestInit): Request {
  return new Request(new URL(path, PUBLIC_ORIGIN), init);
}

function fixedIdentity(
  session: WebIdentitySession | null,
): WebIdentitySessionPort & {
  calls: Array<{ cookie: string | null; userAgent: string | null }>;
} {
  const calls: Array<{ cookie: string | null; userAgent: string | null }> = [];
  return {
    calls,
    async resolve(input) {
      calls.push(input);
      return session;
    },
  };
}

function testBff(overrides: {
  identity: WebIdentitySessionPort;
  fetch?: typeof globalThis.fetch;
}) {
  return createWebBff({
    publicOrigin: PUBLIC_ORIGIN,
    controlTarget: CONTROL_TARGET,
    controlBffToken: CONTROL_BFF_TOKEN,
    controlCsrfToken: CONTROL_CSRF,
    csrfSecret: CSRF_SECRET,
    identity: overrides.identity,
    fetch: overrides.fetch,
  });
}
