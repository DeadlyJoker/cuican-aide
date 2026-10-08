import assert from "node:assert/strict";
import test from "node:test";
import { parseProjectSourceUploadPartResponse } from "@crewon/contracts/project-source-uploads";
import {
  sourceUploadProxyFixture,
  sourceUploadBrowserOrigin,
  sourceUploadCookie,
} from "./project-source-upload-proxy.test-support.ts";

test("native browser HTTP through the real BFF preserves a complete raw part and replaces forged credentials with the original session and CSRF", async (t) => {
  const f = await sourceUploadProxyFixture(t);
  const response = await f.fetch(f.path, {
    headers: {
      "authorization": "Bearer forged",
      "x-actor-id": "foreign",
      "x-crewon-bff-authorization": "forged",
      "idempotency-key": "original-upload-key",
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(
    parseProjectSourceUploadPartResponse(
      await response.json(),
      f.locator,
      f.bytes.length,
    ),
    f.acknowledgement,
  );
  assert.equal(f.observations.length, 1);
  assert.equal(f.upstreamRequests, 1);
  assert.equal(f.observations[0]!.path, f.path);
  assert.deepEqual(f.observations[0]!.bytes, f.bytes);
  assert.equal(
    f.observations[0]!.headers["idempotency-key"],
    "original-upload-key",
  );
  assert.equal(f.resolutions, 2); // Bootstrap plus the actual fresh upload session lookup.
});

test("raw native BFF rejects invalid route, method and query before identity lookup or any upstream request", async (t) => {
  const f = await sourceUploadProxyFixture(t);
  for (const [path, method, status] of [
    [f.path + "/extra", "PUT", 404],
    [f.path.replace("/parts/0/", "/parts/00/"), "PUT", 404],
    [f.path.replace("/parts/0/", "/parts/306/"), "PUT", 404],
    [
      f.path.replace(
        f.locator.rawDigest.slice(7),
        f.locator.rawDigest.slice(7).toUpperCase(),
      ),
      "PUT",
      404,
    ],
    [
      f.path.replace("original-byte-upload", "%6Friginal-byte-upload"),
      "PUT",
      404,
    ],
    [f.path + "?", "PUT", 400],
    [f.path + "?ownerPrincipalId=foreign", "PUT", 400],
    [f.path, "POST", 405],
    [f.path, "GET", 405],
  ] as const) {
    const response = await f.fetch(path, {
      method,
      ...(method === "GET" ? { body: null } : {}),
    });
    assert.equal(response.status, status, `${method} ${path}`);
    await response.arrayBuffer();
  }
  assert.equal(f.observations.length, 0);
  assert.equal(f.upstreamRequests, 0);
  assert.equal(f.resolutions, 1);
});

test("native raw BFF rejects foreign session, CSRF, content type, encoding and empty or oversized body without contacting upstream", async (t) => {
  const f = await sourceUploadProxyFixture(t);
  for (const [init, status] of [
    [{ headers: { cookie: "foreign-session" } }, 401],
    [{ headers: { "x-csrf-token": "forged" } }, 403],
    [{ headers: { origin: "https://foreign.example.test" } }, 403],
    [{ headers: { "content-type": "application/json" } }, 400],
    [
      {
        headers: { "content-type": "application/octet-stream; charset=utf-8" },
      },
      400,
    ],
    [{ headers: { "content-encoding": "gzip" } }, 400],
    [{ headers: { "content-encoding": "identity" } }, 400],
    [{ body: new Uint8Array() }, 400],
    [{ body: new Uint8Array(65_537) }, 413],
  ] satisfies readonly (readonly [RequestInit, number])[]) {
    const response = await f.fetch(f.path, init);
    assert.equal(response.status, status);
    await response.arrayBuffer();
  }
  assert.equal(f.observations.length, 0);
  assert.equal(f.upstreamRequests, 0);
});

test("native raw BFF rejects upstream success or error JSON above 60 KiB and preserves bounded original failures", async (t) => {
  const f = await sourceUploadProxyFixture(t);
  for (const status of [200, 409]) {
    f.reply.status = status;
    f.reply.body = { result: "x".repeat(60 * 1024) };
    const response = await f.fetch();
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      error: { code: "control_api_response_invalid" },
    });
  }
  f.reply.status = 409;
  f.reply.body = { error: { code: "upload_revision_conflict" } };
  const response = await f.fetch();
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), f.reply.body);
  assert.equal(f.observations.length, 3);
  assert.equal(f.upstreamRequests, 3);
});

test("caller cancellation while the BFF is reading a raw part cancels the native input and makes no upstream invocation", async (t) => {
  const f = await sourceUploadProxyFixture(t);
  let cancelled = false;
  const abort = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request(sourceUploadBrowserOrigin + f.path, {
    method: "PUT",
    headers: f.headers,
    body,
    signal: abort.signal,
    ...{ duplex: "half" },
  });
  const pending = f.app.handle(request);
  abort.abort(new Error("original_browser_cancelled"));
  const response = await pending;
  assert.equal(response.status, 400);
  await response.arrayBuffer();
  assert.equal(cancelled, true);
  assert.equal(f.observations.length, 0);
  assert.equal(f.upstreamRequests, 0);
  assert.equal(request.headers.get("cookie"), sourceUploadCookie);
});

test(
  "a real browser HTTP disconnect halfway through a raw part aborts the original request before the BFF can invoke upstream",
  { timeout: 5_000 },
  async (t) => {
    const f = await sourceUploadProxyFixture(t);
    const controller = new AbortController();
    const pending = fetch(f.browserOrigin + f.path, {
      method: "PUT",
      headers: f.headers,
      signal: controller.signal,
      body: new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(f.bytes.slice(0, 8192));
        },
      }),
      ...{ duplex: "half" },
    });
    await f.bodyStarted;
    const reason = new Error("actual_browser_connection_cancelled");
    controller.abort(reason);
    await assert.rejects(pending, (error) => error === reason);
    await f.browserDisconnected;
    assert.equal(f.upstreamRequests, 0);
    assert.equal(f.observations.length, 0);
  },
);
