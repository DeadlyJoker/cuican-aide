import assert from "node:assert/strict";
import test from "node:test";
import { MAX_OFFICE_THREAD_RESPONSE_BYTES } from "@crewon/contracts";
import {
  ControlApiClient,
  ControlApiProtocolError,
} from "./control-api-client.ts";
const version = "office/version-1";
const thread = {
  threadId: "thread-1",
  title: "History",
  status: "active",
  revision: 1,
  lastMessageSequence: 0,
  forkedFromThreadId: null,
  forkedThroughHistorySequence: null,
  createdAt: "2026-09-14T00:00:00Z",
  updatedAt: "2026-09-14T00:00:00Z",
  archivedAt: null,
  deletedAt: null,
};
const snapshot = { officeId: "office-1", officeVersionId: version, thread };

test("Office association client encodes identity and forwards read cancellation, authentication and mutation credentials", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const controller = new AbortController();
  const client = new ControlApiClient({
    baseUrl: "https://control.test",
    accessToken: "token",
    csrfToken: "csrf",
    origin: "https://app.test",
    fetch: async (url, init = {}) => {
      requests.push({ url: String(url), init });
      return Response.json(
        init.method === "GET"
          ? snapshot
          : { ...snapshot, disposition: "existing" },
      );
    },
  });
  await client.getOfficeThread(version, { signal: controller.signal });
  await client.createOfficeThread(version, "create-key");
  await client.bindOfficeThread(version, {
    threadId: "thread-1",
    expectedRevision: 1,
  });
  assert.equal(requests[0]!.init.signal, controller.signal);
  assert.equal(
    requests[0]!.url,
    "https://control.test/api/v1/offices/office%2Fversion-1/thread",
  );
  assert.equal(requests[2]!.url, requests[0]!.url + "-binding");
  for (const { init } of requests)
    assert.equal(
      new Headers(init.headers).get("authorization"),
      "Bearer token",
    );
  for (const { init } of requests.slice(1))
    assert.equal(new Headers(init.headers).get("x-csrf-token"), "csrf");
  assert.equal(
    new Headers(requests[1]!.init.headers).get("idempotency-key"),
    "create-key",
  );
  assert.equal(requests[1]!.init.body, "{}");
  assert.deepEqual(JSON.parse(String(requests[2]!.init.body)), {
    threadId: "thread-1",
    expectedRevision: 1,
  });
});

test("association client rejects mismatched or malformed successful responses", async () => {
  for (const response of [
    { ...snapshot, officeVersionId: "wrong" },
    { ...snapshot, thread: {} },
    { ...snapshot, tenantId: "other" },
  ]) {
    const client = new ControlApiClient({
      baseUrl: "https://control.test",
      csrfToken: "csrf",
      fetch: async () => Response.json(response),
    });
    await assert.rejects(client.getOfficeThread(version), {
      message: "control_client_office_thread_invalid",
    });
    await assert.rejects(
      client.createOfficeThread(version, "key"),
      ControlApiProtocolError,
    );
    await assert.rejects(
      client.bindOfficeThread(version, {
        threadId: "thread-1",
        expectedRevision: 1,
      }),
      ControlApiProtocolError,
    );
  }
});

test("association client cancels oversized bodies on every route instead of retaining unbounded metadata", async () => {
  for (const operation of ["get", "create", "bind"] as const) {
    let canceled = false,
      reads = 0;
    const chunk = new Uint8Array(8 * 1024).fill(32);
    const client = new ControlApiClient({
      baseUrl: "https://control.test",
      csrfToken: "csrf",
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              reads++;
              controller.enqueue(chunk);
            },
            cancel() {
              canceled = true;
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    });
    const result =
      operation === "get"
        ? client.getOfficeThread(version)
        : operation === "create"
          ? client.createOfficeThread(version, "key")
          : client.bindOfficeThread(version, {
              threadId: "thread-1",
              expectedRevision: 1,
            });
    await assert.rejects(result, ControlApiProtocolError);
    assert.equal(canceled, true);
    assert.ok(reads <= MAX_OFFICE_THREAD_RESPONSE_BYTES / chunk.byteLength + 2);
  }
});
