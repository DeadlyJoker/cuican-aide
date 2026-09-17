import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_THREAD_CATALOG_RESPONSE_BYTES,
  formatThreadCatalogCursor,
} from "@crewon/contracts";
import {
  ControlApiClient,
  ControlApiProtocolError,
} from "./control-api-client.ts";

const filter = { status: "active" as const, search: "", excludeForks: true };
const position = {
  direction: "older" as const,
  threadId: "thread-100",
  updatedAt: "2026-09-11T00:00:00Z",
};
const emptyPage = () => ({
  schemaVersion: "crewon.thread-catalog.v0",
  data: [],
  scannedCount: 1,
  olderCursor: formatThreadCatalogCursor(filter, {
    ...position,
    threadId: "thread-050",
  }),
  newerCursor: null,
});

test("catalog client forwards credentials/cancellation and rejects filter-bound cursor mismatches before fetching", async () => {
  const controller = new AbortController();
  let requests = 0;
  const client = new ControlApiClient({
    baseUrl: "https://control.test",
    accessToken: "token",
    fetch: async (input, init) => {
      requests++;
      assert.equal(new URL(String(input)).pathname, "/api/v1/thread-catalog");
      assert.equal(
        new URL(String(input)).searchParams.get("excludeForks"),
        "true",
      );
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer token",
      );
      assert.equal(init?.signal, controller.signal);
      return Response.json(emptyPage());
    },
  });
  const cursor = formatThreadCatalogCursor(filter, position);
  assert.deepEqual(
    await client.getThreadCatalog(
      { ...filter, cursor, limit: 1 },
      { signal: controller.signal },
    ),
    emptyPage(),
  );
  await assert.rejects(
    client.getThreadCatalog({ ...filter, search: "changed", cursor }),
    /thread_catalog_cursor_invalid/,
  );
  assert.equal(requests, 1);
});

test("catalog client rejects response limits and non-progressing continuations", async () => {
  for (const response of [
    { ...emptyPage(), scannedCount: 101 },
    {
      ...emptyPage(),
      olderCursor: formatThreadCatalogCursor(filter, position),
    },
    { ...emptyPage(), data: [{ threadId: "private", tenantId: "other" }] },
  ]) {
    const client = new ControlApiClient({
      baseUrl: "https://control.test",
      fetch: async () => Response.json(response),
    });
    await assert.rejects(
      client.getThreadCatalog({
        ...filter,
        cursor: formatThreadCatalogCursor(filter, position),
      }),
      (error) =>
        error instanceof ControlApiProtocolError &&
        error.message === "control_client_thread_catalog_invalid",
    );
  }
});

test("catalog client cancels an oversized response instead of accumulating arbitrary metadata", async () => {
  let canceled = false;
  let reads = 0;
  const chunk = new Uint8Array(64 * 1024).fill(32);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads++;
      controller.enqueue(chunk);
    },
    cancel() {
      canceled = true;
    },
  });
  const client = new ControlApiClient({
    baseUrl: "https://control.test",
    fetch: async () =>
      new Response(stream, { headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(client.getThreadCatalog(), ControlApiProtocolError);
  assert.equal(canceled, true);
  assert.ok(reads <= MAX_THREAD_CATALOG_RESPONSE_BYTES / chunk.byteLength + 2);
});
