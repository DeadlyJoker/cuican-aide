import assert from "node:assert/strict";
import test from "node:test";
import { inspectPendingResponsesFrame } from "./responses-pending-frame-diagnostics.ts";
import { parseResponsesSse } from "./responses-sse.ts";

test("bounded pending inspection classifies structure without accepting events or retaining private bytes", () => {
  for (const [buffer, expected] of [
    ["", { pendingJsonState: "empty" }],
    [": private-comment\n", { pendingJsonState: "no-data" }],
    ["data: [DONE]", { pendingJsonState: "done-marker" }],
    [
      'data: {"type":"response.completed","private":"secret"}',
      {
        pendingJsonState: "complete-object",
        pendingEventType: "response.completed",
      },
    ],
    [
      'data: {"type":"private-secret-type"}',
      { pendingJsonState: "complete-object", pendingEventType: "unknown" },
    ],
    [
      'data: {"type":\r\ndata: "response.completed"}',
      {
        pendingJsonState: "complete-object",
        pendingEventType: "response.completed",
      },
    ],
    ["data: null", { pendingJsonState: "complete-nonobject" }],
    ["data: []", { pendingJsonState: "complete-nonobject" }],
    ["data: {", { pendingJsonState: "not-complete-json" }],
    ["data: {invalid}", { pendingJsonState: "not-complete-json" }],
    [
      'data: {"type":"response.created"}\n\r\ndata: {"type":"response.completed"}',
      { pendingJsonState: "multiple-data-events" },
    ],
    [
      "data: " + "x".repeat(256 * 1024),
      { pendingJsonState: "not-complete-json" },
    ],
  ] as const)
    assert.deepEqual(inspectPendingResponsesFrame(buffer), expected);
});
test("pending inspection occurs once at read closure and cannot replace the original malformed-frame failure", async () => {
  let inspections = 0;
  const events = parseResponsesSse(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("data: {invalid}\n\n"));
      },
    }),
    {
      diagnostics: {
        chunk() {},
        frame() {},
        pending() {},
        pendingInspection() {
          inspections++;
          throw new Error("private-inspection-failure");
        },
      },
    },
  );
  await assert.rejects(
    (async () => {
      for await (const _event of events) {
      }
    })(),
    { code: "responses_event_json_invalid" },
  );
  assert.equal(inspections, 1);
});
