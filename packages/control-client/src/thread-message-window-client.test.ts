import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_THREAD_MESSAGE_WINDOW_RESPONSE_BYTES,
  formatThreadMessageWindowCursor,
} from "@crewon/contracts";
import {
  ControlApiClient,
  ControlApiProtocolError,
} from "./control-api-client.ts";

const cursor = formatThreadMessageWindowCursor("thread-1", {
  threadRevision: 3,
  direction: "older",
  messageSequence: 2,
});
const window = () => ({
  schemaVersion: "crewon.message-window.v0",
  threadId: "thread-1",
  threadRevision: 3,
  eventSequence: 3,
  headMessageSequence: 2,
  data: [
    {
      messageId: "message-1",
      threadId: "thread-1",
      sequence: 1,
      role: "user",
      content: "Hello",
      proposedPlan: null,
      createdAt: "2026-09-10T00:00:00Z",
    },
  ],
  olderCursor: null,
  newerCursor: formatThreadMessageWindowCursor("thread-1", {
    threadRevision: 3,
    direction: "newer",
    messageSequence: 1,
  }),
});

test("message window client forwards cancellation and credentials and validates the requested cursor", async () => {
  const controller = new AbortController();
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    accessToken: "token",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/api/v1/threads/thread-1/message-window");
      assert.equal(url.searchParams.get("cursor"), cursor);
      assert.equal(url.searchParams.get("limit"), "1");
      assert.equal(init?.signal, controller.signal);
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer token",
      );
      return Response.json(window());
    },
  });
  assert.deepEqual(
    await client.getThreadMessageWindow(
      "thread-1",
      { cursor, limit: 1 },
      { signal: controller.signal },
    ),
    window(),
  );
  await assert.rejects(
    client.getThreadMessageWindow("other", { cursor }),
    /message_window_cursor_invalid/,
  );
});

test("message window client rejects a stale or cross-thread response instead of publishing it", async () => {
  for (const invalid of [
    { ...window(), threadRevision: 4, eventSequence: 4 },
    { ...window(), threadId: "other" },
    { ...window(), data: [{ ...window().data[0], sequence: 2 }] },
  ]) {
    const client = new ControlApiClient({
      baseUrl: "https://control.example/",
      fetch: async () => Response.json(invalid),
    });
    await assert.rejects(
      client.getThreadMessageWindow("thread-1", { cursor }),
      (error: unknown) =>
        error instanceof ControlApiProtocolError &&
        error.message === "control_client_message_window_invalid",
    );
  }
});

test("message window client cancels an oversized response stream before JSON parsing", async () => {
  let canceled = false;
  let reads = 0;
  const chunk = new Uint8Array(256 * 1024).fill(32);
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
    baseUrl: "https://control.example/",
    fetch: async () =>
      new Response(stream, { headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(
    client.getThreadMessageWindow("thread-1"),
    ControlApiProtocolError,
  );
  assert.equal(canceled, true);
  assert.ok(
    reads <= MAX_THREAD_MESSAGE_WINDOW_RESPONSE_BYTES / chunk.byteLength + 2,
  );
});
