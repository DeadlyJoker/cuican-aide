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

test("SSE framing accepts mixed line endings and split CRLF without merging events", async () => {
  const text =
    ': heartbeat\r\ndata: {"type":"first",\rdata: "text":"你好"}\n\r\ndata: {"type":"second"}\r\n\ndata: [DONE]\r\r';
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  assert.deepEqual(await drain(body), [
    { kind: "event", value: { type: "first", text: "你好" } },
    { kind: "event", value: { type: "second" } },
    { kind: "done" },
  ]);
});

test("one large network chunk remains bounded per frame while fragmented oversized frames fail", async () => {
  const body = new Response('data: {"type":"ok"}\n\n'.repeat(20_000)).body!;
  let count = 0;
  for await (const _event of parseResponsesSse(body, { maxEventBytes: 64 }))
    count++;
  assert.equal(count, 20_000);
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"'));
      controller.enqueue(new TextEncoder().encode("x".repeat(65)));
      controller.close();
    },
  });
  await assert.rejects(
    async () => {
      for await (const _event of parseResponsesSse(oversized, {
        maxEventBytes: 64,
      })) {
        /* Consume. */
      }
    },
    (error: unknown) =>
      error instanceof ModelTransportError &&
      error.code === "responses_event_too_large",
  );
  assert.equal(oversized.locked, false);
});
