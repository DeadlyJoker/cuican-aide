import assert from "node:assert/strict";
import test from "node:test";
import { ModelTransportError } from "@crewon/agent-kernel";
import { parseResponsesSse } from "./responses-sse.ts";

async function drain(body: ReadableStream<Uint8Array>) {
  const events = [];
  for await (const event of parseResponsesSse(body)) events.push(event);
  return events;
}

test("body read failures after valid events remain retryable transport interruptions", async () => {
  let reads = 0;
  const cause = new TypeError("socket terminated");
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads++ === 0)
        controller.enqueue(
          new TextEncoder().encode('data: {"type":"response.created"}\n\n'),
        );
      else controller.error(cause);
    },
  });
  const events = parseResponsesSse(body)[Symbol.asyncIterator]();
  assert.equal((await events.next()).value?.kind, "event");
  await assert.rejects(
    events.next(),
    (error) =>
      error instanceof ModelTransportError &&
      error.category === "unavailable" &&
      error.code === "responses_stream_read_failed" &&
      error.retryable &&
      error.cause === cause,
  );
  assert.equal(body.locked, false);
});

test("invalid UTF-8 and invalid JSON remain nonretryable protocol failures", async () => {
  for (const [bytes, code] of [
    [new Uint8Array([0xc3, 0x28]), "responses_stream_decode_failed"],
    [new Uint8Array([0xc3]), "responses_stream_decode_failed"],
    [
      new TextEncoder().encode("data: not-json\n\n"),
      "responses_event_json_invalid",
    ],
  ] as const) {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    await assert.rejects(
      drain(body),
      (error) =>
        error instanceof ModelTransportError &&
        error.category === "protocol" &&
        error.code === code &&
        !error.retryable,
    );
    assert.equal(body.locked, false);
  }
});

test("explicit transport classifications from a body stream are preserved", async () => {
  const failure = new ModelTransportError({
    category: "canceled",
    code: "segment_canceled",
    retryable: false,
  });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(failure);
    },
  });
  await assert.rejects(drain(body), (error) => error === failure);
});
