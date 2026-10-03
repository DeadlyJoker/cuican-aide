import assert from "node:assert/strict";
import test from "node:test";
import {
  formatCreativeProjectCursor,
  MAX_PROJECT_GENERATION_SELECTION_BYTES,
} from "@crewon/contracts";
import {
  boundedCreativeProjectProxyRequest,
  boundedCreativeProjectProxyResponse,
  creativeProjectProxyPolicy,
  CREATIVE_PROJECT_PROXY_DEADLINE_MS,
  CREATIVE_PROJECT_PROXY_RESPONSE_MAX_BYTES,
} from "./creative-project-proxy-policy.ts";
import { createWebBff } from "./web-bff.ts";
import type { WebIdentitySession } from "./identity-session-adapter.ts";

const origin = "https://project-bff.example.test";
const target = "http://127.0.0.1:3210";
const base = "/api/v1/creative-projects";
const cookie = "crewon_session=project-session-a";
const serviceToken = "project-bff-service-credential-at-least-32";
const controlCsrf = "project-control-csrf-token-at-least-32";
const session: WebIdentitySession = {
  sessionId: "project-browser-session-a-at-least-32",
  expiresAt: "2030-01-01T00:00:00.000Z",
  controlAccessToken: "project-control-identity-a-at-least-32",
};
const otherSession: WebIdentitySession = {
  ...session,
  sessionId: "project-browser-session-b-at-least-32",
  controlAccessToken: "project-control-identity-b-at-least-32",
};

const selectionPath = `${base}/${encodeURIComponent("项目/%")}/concepts/${encodeURIComponent("概念\\图")}/selection`;
function selectionRequest() {
  return {
    reference: {
      projectId: "项目/%",
      assetId: "概念\\图",
      assetRevision: 2,
      expectedProjectRevision: 7,
      expectedAssetMetadataRevision: 3,
    },
    operationId: "00000000-0000-4000-8000-000000000123",
    expectedOperationRevision: 4,
    resultIndex: 2,
    expectedSelectionRevision: 0,
  };
}

function policy(path: string, method = "GET") {
  const position = path.indexOf("?");
  return creativeProjectProxyPolicy({
    pathname: position < 0 ? path : path.slice(0, position),
    search: position < 0 ? "" : path.slice(position),
    method,
  });
}
function request(path: string, init: RequestInit = {}) {
  return new Request(new URL(path, origin), init);
}
function bff(fetchImpl: typeof globalThis.fetch) {
  return createWebBff({
    controlBffToken: serviceToken,
    controlCsrfToken: controlCsrf,
    controlTarget: target,
    csrfSecret: "project-browser-csrf-secret-at-least-32",
    publicOrigin: origin,
    identity: {
      resolve: async ({ cookie: supplied }) =>
        supplied === cookie
          ? session
          : supplied === "crewon_session=project-session-b"
            ? otherSession
            : null,
    },
    fetch: fetchImpl,
  });
}
async function csrfToken(app: ReturnType<typeof bff>, suppliedCookie = cookie) {
  const response = await app.handle(
    request("/control-api/session", { headers: { cookie: suppliedCookie } }),
  );
  assert.equal(response.status, 200);
  return ((await response.json()) as { csrfToken: string }).csrfToken;
}
function writeHeaders(csrf: string, key = "project-write-once") {
  return {
    cookie,
    "origin": origin,
    "x-csrf-token": csrf,
    "content-type": "application/json",
    "idempotency-key": key,
  };
}

test("declares every project route and leaves existing chat, team, plugin and SSE routes unchanged", () => {
  for (const [path, methods] of [
    [base, ["GET", "POST"]],
    [`${base}/project-1`, ["GET"]],
    [`${base}/project-1/title`, ["PUT"]],
    [`${base}/project-1/state`, ["PUT"]],
    [`${base}/project-1/briefs`, ["GET", "POST"]],
    [`${base}/project-1/briefs/1`, ["GET"]],
    [`${base}/project-1/concepts`, ["GET", "POST"]],
    [`${base}/project-1/concepts/asset-1`, ["GET"]],
    [`${base}/project-1/concepts/asset-1/revisions`, ["GET", "POST"]],
    [`${base}/project-1/concepts/asset-1/revisions/9007199254740991`, ["GET"]],
    [`${base}/project-1/concepts/asset-1/revisions/1/generation`, ["GET"]],
  ] as const) {
    for (const method of methods)
      assert.deepEqual(policy(path, method), {
        outcome: "allow",
        responseMaxBytes: CREATIVE_PROJECT_PROXY_RESPONSE_MAX_BYTES,
      });
    for (const method of ["HEAD", "PATCH", "DELETE", "OPTIONS", "CONNECT"])
      assert.deepEqual(policy(path, method), {
        outcome: "deny",
        status: 405,
        code: "method_not_allowed",
      });
  }
  for (const path of [
    "/api/v1/threads",
    "/api/v1/teams",
    "/api/v1/runs/run-1/events?extensions=owned",
    "/api/v1/plugins/ui/catalog",
    "/api/v1/extensions",
    "/control-api/session",
  ])
    assert.equal(policy(path), null);
});

test("saved generation lookups admit only exact authenticated reads with no caller-selected task or result", async () => {
  const path = `${base}/${encodeURIComponent("项目/%")}/concepts/${encodeURIComponent("资产/百分%")}/revisions/1/generation`;
  assert.equal(policy(path)?.outcome, "allow");
  for (const method of ["POST", "PUT", "HEAD", "OPTIONS"])
    assert.deepEqual(policy(path, method), {
      outcome: "deny",
      status: 405,
      code: "method_not_allowed",
    });
  for (const query of [
    "?",
    "?runId=forged",
    "?pluginId=forged",
    "?operationId=forged",
    "?resultIndex=0",
    "?limit=1&limit=1",
  ])
    assert.deepEqual(policy(`${path}${query}`), {
      outcome: "deny",
      status: 400,
      code: "creative_project_query_invalid",
    });
  const calls: { url: string; headers: Headers; redirect?: RequestRedirect }[] =
    [];
  const app = bff(async (input, init) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      redirect: init?.redirect,
    });
    return Response.json({ generation: null });
  });
  assert.equal((await app.handle(request(path))).status, 401);
  assert.equal(calls.length, 0);
  const response = await app.handle(
    request(path, {
      headers: {
        cookie,
        "authorization": "Bearer forged",
        "x-crewon-principal-id": "forged",
      },
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { generation: null });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `${target}${path}`);
  assert.equal(
    calls[0]!.headers.get("authorization"),
    `Bearer ${session.controlAccessToken}`,
  );
  assert.equal(calls[0]!.headers.get("x-crewon-principal-id"), null);
  assert.equal(calls[0]!.headers.get("x-csrf-token"), null);
  assert.equal(calls[0]!.redirect, "manual");
  for (const suffix of ["/", "/query", "/selection", "/private", "/generation"])
    assert.equal(
      (await app.handle(request(`${path}${suffix}`, { headers: { cookie } })))
        .status,
      404,
    );
  assert.equal(calls.length, 1);
});

test("opaque IDs preserve the Domain Unicode and UTF-16 limits without decoding separators into routes", () => {
  for (const id of [
    "项目一",
    "😀".repeat(64),
    "x".repeat(128),
    "percent%20/literal\\part?query#hash",
    "with internal spaces",
    "with\u0085C1",
  ]) {
    const encoded = encodeURIComponent(id);
    assert.equal(policy(`${base}/${encoded}`)?.outcome, "allow");
    assert.equal(
      policy(`${base}/project-1/concepts/${encoded}/revisions`)?.outcome,
      "allow",
    );
  }
  for (const segment of [
    "",
    "x".repeat(129),
    encodeURIComponent("😀".repeat(65)),
    "%00",
    "%1F",
    "%7F",
    "%20project",
    "project%20",
    "%ED%A0%80",
    "%E0%A4%A",
    ".",
    "..",
    "%2e",
    "%2E%2e",
  ])
    assert.deepEqual(policy(`${base}/${segment}`), {
      outcome: "deny",
      status: 404,
      code: "route_not_found",
    });
});

test("unknown family paths and encoded or normalized escapes cannot fall back to the ordinary proxy", async () => {
  let calls = 0;
  const app = bff(async () => {
    calls++;
    return Response.json({});
  });
  for (const path of [
    `${base}/`,
    `${base}/p/private`,
    `${base}/p/title/`,
    `${base}/p/briefs/0`,
    `${base}/p/briefs/01`,
    `${base}/p/briefs/9007199254740992`,
    `${base}/p/concepts/a/revisions/1/private`,
    `${base}/p/%63oncepts/a`,
    "/api/v1/%63reative-projects/p",
    "/api/v1/creative-projects%2Fp",
    "/api/v1/creative-projects%ZZ/p",
    `${base}/../threads`,
    `${base}/%2e%2e/threads`,
    `${base}/p\\briefs`,
  ]) {
    assert.deepEqual(policy(path), {
      outcome: "deny",
      status: 404,
      code: "route_not_found",
    });
    assert.equal(
      (
        await app.handle(request(path, { headers: { cookie } }), {
          rawTarget: path,
        })
      ).status,
      404,
    );
  }
  assert.equal(calls, 0);
});

test("bounded project queries share the public contracts and reject duplicate, unknown and malformed input", () => {
  const cursor = formatCreativeProjectCursor("archived", {
    updatedAt: "2026-10-03T00:00:00.000Z",
    projectId: "项目一",
  });
  for (const path of [
    `${base}?state=archived&cursor=${cursor}&limit=50`,
    `${base}?state=all&limit=1`,
    `${base}/p/briefs?afterBriefRevision=0&limit=20`,
    `${base}/p/briefs?afterBriefRevision=9007199254740991`,
    `${base}/p/concepts?afterAssetId=${encodeURIComponent("资产/% ?#")}&limit=50`,
    `${base}/p/concepts/a/revisions?afterAssetRevision=0&limit=1`,
  ])
    assert.equal(policy(path)?.outcome, "allow");
  for (const path of [
    `${base}?state=active&cursor=${cursor}`,
    `${base}?cursor=invalid`,
    `${base}?state=other`,
    `${base}?tenantId=forged`,
    `${base}?limit=0`,
    `${base}?limit=51`,
    `${base}?limit=01`,
    `${base}?limit=1&limit=1`,
    `${base}?limit=1&%6cimit=2`,
    `${base}?state=active&`,
    `${base}?`,
    `${base}?limit`,
    `${base}?state=%E0%A4%A`,
    `${base}?state=%ZZ`,
    `${base}/p?ownerPrincipalId=forged`,
    `${base}/p/briefs?afterBriefRevision=-1`,
    `${base}/p/briefs?afterBriefRevision=01`,
    `${base}/p/briefs?afterBriefRevision=9007199254740992`,
    `${base}/p/concepts?afterAssetId=${"x".repeat(129)}`,
    `${base}/p/concepts/a/revisions?afterAssetRevision=1&afterAssetRevision=1`,
    `${base}/p/briefs/1?limit=1`,
    `${base}/p/concepts/a/revisions/1?limit=1`,
  ])
    assert.deepEqual(policy(path), {
      outcome: "deny",
      status: 400,
      code: "creative_project_query_invalid",
    });
  for (const [path, method] of [
    [`${base}?limit=1`, "POST"],
    [`${base}/p/title?state=active`, "PUT"],
    [`${base}/p/state?limit=1`, "PUT"],
    [`${base}/p/briefs?afterBriefRevision=0`, "POST"],
    [`${base}/p/concepts?limit=1`, "POST"],
    [`${base}/p/concepts/a/revisions?afterAssetRevision=0`, "POST"],
  ])
    assert.equal(policy(path!, method)?.outcome, "deny");
});

test("project reads use the verified session while writes preserve CSRF separation and exact idempotency", async () => {
  const calls: { url: string; init?: RequestInit; body: string | null }[] = [];
  const app = bff(async (input, init) => {
    calls.push({
      url: String(input),
      init,
      body: init?.body
        ? new TextDecoder().decode(init.body as Uint8Array)
        : null,
    });
    return Response.json(
      { project: { projectId: "p" } },
      {
        headers: {
          "set-cookie": "forged=1",
          "x-crewon-principal-id": "forged",
        },
      },
    );
  });
  const read = await app.handle(
    request(`${base}/p`, {
      headers: {
        cookie,
        "authorization": "Bearer forged",
        "x-crewon-principal-id": "forged",
        "x-crewon-actor-id": "forged",
        "x-crewon-tenant-id": "forged",
        "x-crewon-space-id": "forged",
        "x-crewon-bff-authorization": "Bearer forged",
      },
    }),
  );
  assert.equal(read.status, 200);
  const csrf = await csrfToken(app);
  const body = JSON.stringify({ title: "真实输入", briefText: "保留\n换行" });
  const written = await app.handle(
    request(base, {
      method: "POST",
      headers: writeHeaders(csrf, "create-original-key"),
      body,
    }),
  );
  assert.equal(written.status, 200);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    const headers = new Headers(call.init?.headers);
    assert.equal(
      headers.get("authorization"),
      `Bearer ${session.controlAccessToken}`,
    );
    assert.equal(
      headers.get("x-crewon-bff-authorization"),
      `Bearer ${serviceToken}`,
    );
    assert.equal(headers.get("origin"), origin);
    for (const key of [
      "cookie",
      "x-crewon-principal-id",
      "x-crewon-actor-id",
      "x-crewon-tenant-id",
      "x-crewon-space-id",
    ])
      assert.equal(headers.get(key), null);
    assert.equal(call.init?.redirect, "manual");
  }
  assert.equal(new Headers(calls[0]!.init?.headers).get("x-csrf-token"), null);
  assert.equal(
    new Headers(calls[1]!.init?.headers).get("x-csrf-token"),
    controlCsrf,
  );
  assert.equal(
    new Headers(calls[1]!.init?.headers).get("idempotency-key"),
    "create-original-key",
  );
  assert.equal(calls[1]!.body, body);
  assert.equal(written.headers.get("set-cookie"), null);
  assert.equal(written.headers.get("x-crewon-principal-id"), null);
  assert.equal(written.headers.get("cache-control"), "no-store");
});

test("missing sessions, cross-session CSRF and invalid mutation transport never reach Control", async () => {
  let calls = 0;
  const app = bff(async () => {
    calls++;
    return Response.json({});
  });
  assert.equal((await app.handle(request(base))).status, 401);
  const csrf = await csrfToken(app);
  const headers = writeHeaders(csrf);
  for (const changed of [
    { ...headers, cookie: "crewon_session=project-session-b" },
    { ...headers, origin: "https://other.example.test" },
    { ...headers, "x-csrf-token": "invalid" },
  ])
    assert.equal(
      (
        await app.handle(
          request(base, { method: "POST", headers: changed, body: "{}" }),
        )
      ).status,
      403,
    );
  for (const [changed, body] of [
    [{ ...headers, "content-type": "text/plain" }, "{}"],
    [{ ...headers, "idempotency-key": "" }, "{}"],
    [{ ...headers, "idempotency-key": "x".repeat(129) }, "{}"],
    [headers, "[]"],
    [headers, "null"],
    [headers, "invalid"],
  ] as const)
    assert.equal(
      (
        await app.handle(
          request(base, { method: "POST", headers: changed, body }),
        )
      ).status,
      400,
    );
  assert.equal(
    (
      await app.handle(
        request(base, {
          method: "POST",
          headers,
          body: JSON.stringify({ text: "x".repeat(65_536) }),
        }),
      )
    ).status,
    413,
  );
  assert.equal(calls, 0);
});

test("finite project response bound includes successes and errors, validates JSON and refuses redirects", async () => {
  const maximum = CREATIVE_PROJECT_PROXY_RESPONSE_MAX_BYTES;
  const exact = JSON.stringify({ pad: "x".repeat(maximum - 10) });
  assert.equal(Buffer.byteLength(exact), maximum);
  const accepted = await boundedCreativeProjectProxyResponse({
    upstream: new Response(exact, {
      headers: { "content-type": "application/json" },
    }),
    signal: new AbortController().signal,
  });
  assert.equal(Buffer.byteLength(await accepted.text()), maximum);
  for (const response of [
    new Response(`${exact} `, {
      headers: { "content-type": "application/json" },
    }),
    new Response(`${exact} `, {
      status: 403,
      headers: { "content-type": "application/json" },
    }),
    new Response("{}", {
      headers: {
        "content-type": "application/json",
        "content-length": String(maximum + 1),
      },
    }),
    new Response("{}", { headers: { "content-type": "text/html" } }),
    new Response("[]", { headers: { "content-type": "application/json" } }),
    new Response("invalid", {
      headers: { "content-type": "application/json" },
    }),
    new Response(new Uint8Array([0xff]), {
      headers: { "content-type": "application/json" },
    }),
    new Response("{}", {
      status: 302,
      headers: {
        "content-type": "application/json",
        "location": "https://other.example.test",
      },
    }),
    new Response(null, { status: 204 }),
  ])
    await assert.rejects(
      boundedCreativeProjectProxyResponse({
        upstream: response,
        signal: new AbortController().signal,
      }),
      /creative_project_response_invalid/u,
    );
  const app = bff(
    async () =>
      new Response("{}", {
        status: 302,
        headers: { "content-type": "application/json" },
      }),
  );
  assert.equal(
    (await app.handle(request(base, { headers: { cookie } }))).status,
    502,
  );
});

test("mutation body cancellation retains the original bounded reader", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const pending = boundedCreativeProjectProxyRequest(
    request(base, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "write-once",
      },
      body: new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }),
      duplex: "half",
    } as RequestInit),
    controller.signal,
  );
  controller.abort();
  await assert.rejects(pending, /creative_project_request_invalid/u);
  assert.equal(cancelled, true);
});

test("project deadline and browser cancellation stop pending JSON while Run SSE stays streaming", async (context) => {
  const deadline = new AbortController();
  context.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    assert.equal(milliseconds, CREATIVE_PROJECT_PROXY_DEADLINE_MS);
    return deadline.signal;
  });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let cancelled = false;
  const app = bff(async () => {
    started();
    return new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }),
      {
        headers: { "content-type": "application/json" },
      },
    );
  });
  const pending = app.handle(request(base, { headers: { cookie } }));
  await ready;
  deadline.abort();
  assert.equal((await pending).status, 502);
  assert.equal(cancelled, true);
  context.mock.restoreAll();
  const browser = new AbortController();
  const another = app.handle(
    request(base, { headers: { cookie }, signal: browser.signal }),
  );
  browser.abort();
  assert.equal((await another).status, 502);
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

test("independent selection route admits GET/PUT only, with empty query and 24 KiB replies", () => {
  for (const method of ["GET", "PUT"])
    assert.deepEqual(policy(selectionPath, method), {
      outcome: "allow",
      responseMaxBytes: MAX_PROJECT_GENERATION_SELECTION_BYTES,
    });
  for (const method of ["POST", "PATCH", "DELETE", "HEAD", "OPTIONS"])
    assert.deepEqual(policy(selectionPath, method), {
      outcome: "deny",
      status: 405,
      code: "method_not_allowed",
    });
  for (const query of [
    "?",
    "?owner=forged",
    "?operationId=forged",
    "?resultIndex=0",
  ])
    for (const method of ["GET", "PUT"])
      assert.equal(policy(selectionPath + query, method)?.outcome, "deny");
  for (const suffix of ["/", "/query", "/private"])
    assert.equal(policy(selectionPath + suffix)?.outcome, "deny");
  assert.equal(
    policy(`${base}/p/concepts/a/revisions/1/selection`)?.outcome,
    "deny",
  );
});

test("selection forwarding preserves server session, original CSRF/key, and exact choice bytes", async () => {
  const observed: {
    headers: Headers;
    body: unknown;
    method: string | undefined;
  }[] = [];
  const app = bff(async (url, init) => {
    assert.equal(String(url), `${target}${selectionPath}`);
    observed.push({
      headers: new Headers(init?.headers),
      body: init?.body
        ? JSON.parse(new TextDecoder().decode(init.body as Uint8Array))
        : null,
      method: init?.method,
    });
    return Response.json(
      init?.method === "GET"
        ? { selectionRevision: 0, current: null }
        : { disposition: "committed", selectionRevision: 1, selection: {} },
    );
  });
  const csrf = await csrfToken(app);
  const read = await app.handle(
    request(selectionPath, {
      headers: {
        cookie,
        "authorization": "Bearer forged",
        "x-crewon-principal-id": "forged",
      },
    }),
  );
  assert.equal(read.status, 200);
  const write = await app.handle(
    request(selectionPath, {
      method: "PUT",
      headers: {
        ...writeHeaders(csrf, "choose-once"),
        "x-crewon-principal-id": "forged",
      },
      body: JSON.stringify(selectionRequest()),
    }),
  );
  assert.equal(write.status, 200);
  assert.equal(observed.length, 2);
  assert.deepEqual(observed[1]!.body, selectionRequest());
  for (const item of observed) {
    assert.equal(
      item.headers.get("authorization"),
      `Bearer ${session.controlAccessToken}`,
    );
    assert.equal(item.headers.get("x-crewon-principal-id"), null);
  }
  assert.equal(observed[0]!.headers.get("idempotency-key"), null);
  assert.equal(observed[1]!.headers.get("idempotency-key"), "choose-once");
  assert.equal(observed[1]!.headers.get("x-csrf-token"), controlCsrf);
});

test("selection body and path mismatch or injected authority is refused before upstream", async () => {
  let calls = 0;
  const app = bff(async () => {
    calls++;
    return Response.json({});
  });
  const csrf = await csrfToken(app);
  for (const body of [
    {
      ...selectionRequest(),
      reference: { ...selectionRequest().reference, projectId: "other" },
    },
    {
      ...selectionRequest(),
      reference: { ...selectionRequest().reference, assetId: "other" },
    },
    { ...selectionRequest(), url: "https://forged.test" },
    {
      ...selectionRequest(),
      source: { kind: "authenticated-project-command" },
    },
    { ...selectionRequest(), resultIndex: 16 },
    { ...selectionRequest(), idempotencyKey: "body-key" },
  ])
    assert.equal(
      (
        await app.handle(
          request(selectionPath, {
            method: "PUT",
            headers: writeHeaders(csrf),
            body: JSON.stringify(body),
          }),
        )
      ).status,
      400,
    );
  assert.equal(
    (
      await app.handle(
        request(selectionPath, {
          method: "PUT",
          headers: writeHeaders("forged-csrf"),
          body: JSON.stringify(selectionRequest()),
        }),
      )
    ).status,
    403,
  );
  assert.equal(calls, 0);
});

test("selection request and response streams obey 24 KiB without changing metadata bounds", async () => {
  let calls = 0;
  const app = bff(async () => {
    calls++;
    return Response.json({
      padding: "a".repeat(MAX_PROJECT_GENERATION_SELECTION_BYTES),
    });
  });
  const csrf = await csrfToken(app);
  const huge = await app.handle(
    request(selectionPath, {
      method: "PUT",
      headers: writeHeaders(csrf),
      body: JSON.stringify({
        ...selectionRequest(),
        padding: "a".repeat(MAX_PROJECT_GENERATION_SELECTION_BYTES),
      }),
    }),
  );
  assert.equal(huge.status, 413);
  assert.equal(calls, 0);
  assert.equal(
    (await app.handle(request(selectionPath, { headers: { cookie } }))).status,
    502,
  );
  assert.equal(calls, 1);
  assert.equal(policy(`${base}/p`)?.outcome, "allow");
  assert.equal(
    (await app.handle(request(`${base}/p`, { headers: { cookie } }))).status,
    200,
  );
});
