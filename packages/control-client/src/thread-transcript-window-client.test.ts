import assert from "node:assert/strict";
import test from "node:test";
import { MAX_THREAD_TRANSCRIPT_WINDOW_RESPONSE_BYTES } from "@crewon/contracts";
import {
  ControlApiClient,
  ControlApiProtocolError,
} from "./control-api-client.ts";

const response = {
  schemaVersion: "crewon.transcript-window.v0",
  messageWindow: {
    schemaVersion: "crewon.message-window.v0",
    threadId: "thread-1",
    threadRevision: 2,
    eventSequence: 2,
    headMessageSequence: 1,
    olderCursor: null,
    newerCursor: null,
    data: [
      {
        messageId: "message-1",
        threadId: "thread-1",
        sequence: 1,
        role: "user",
        content: "source",
        proposedPlan: null,
        createdAt: "2026-09-11T00:00:00Z",
      },
    ],
  },
  runBindings: [
    { messageId: "message-1", runId: "run-1", source: "turnStartReceipt" },
  ],
};

test("transcript client forwards scope, credentials and cancellation without extra reads", async () => {
  const controller = new AbortController();
  let requests = 0;
  const client = new ControlApiClient({
    baseUrl: "https://control.example",
    accessToken: "fixture-token",
    fetch: async (url, init) => {
      requests++;
      assert.equal(
        String(url),
        "https://control.example/api/v1/threads/thread-1/transcript-window?limit=20",
      );
      assert.equal(init?.signal, controller.signal);
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer fixture-token",
      );
      return Response.json(response);
    },
  });
  assert.deepEqual(
    await client.getThreadTranscriptWindow(
      "thread-1",
      { limit: 20 },
      { signal: controller.signal },
    ),
    response,
  );
  assert.equal(requests, 1);
});

test("transcript client rejects a message/Run mapping mismatch", async () => {
  const client = new ControlApiClient({
    baseUrl: "https://control.example",
    fetch: async () => Response.json({ ...response, runBindings: [] }),
  });
  await assert.rejects(
    client.getThreadTranscriptWindow("thread-1"),
    (error) =>
      error instanceof ControlApiProtocolError &&
      error.message === "control_client_transcript_window_invalid",
  );
});

test("transcript client cancels oversized response streams before parsing", async () => {
  let reads = 0;
  let canceled = false;
  const chunk = new Uint8Array(256 * 1024).fill(32);
  const client = new ControlApiClient({
    baseUrl: "https://control.example",
    fetch: async () =>
      new Response(
        new ReadableStream({
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
  await assert.rejects(
    client.getThreadTranscriptWindow("thread-1"),
    ControlApiProtocolError,
  );
  assert.equal(canceled, true);
  assert.ok(
    reads <= MAX_THREAD_TRANSCRIPT_WINDOW_RESPONSE_BYTES / chunk.byteLength + 2,
  );
});
