import assert from "node:assert/strict";
import test from "node:test";
import { ModelTransportError } from "@crewon/agent-kernel";
import { responsesProtocolEvents } from "./responses-protocol.ts";

test("small text flushes before a delayed terminal and cancel releases its pending reader", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    cancel() {
      canceled = true;
    },
  });
  const stream = responsesProtocolEvents(body, {
    sequencePolicy: "required",
    completedCheckpoint: () => null,
    onActivity: () => undefined,
    outputDeltaFlushBytes: 1024,
  });
  const iterator = stream[Symbol.asyncIterator]();
  controller.enqueue(
    encode({
      type: "response.created",
      sequence_number: 0,
      response: { id: "resp-1" },
    }),
  );
  controller.enqueue(
    encode({
      type: "response.output_text.delta",
      sequence_number: 1,
      delta: "visible now",
    }),
  );
  const output = await iterator.next();
  assert.deepEqual(output.value, {
    type: "output.delta",
    delta: "visible now",
  });
  assert.equal(canceled, false, "the response terminal has not arrived");
  await iterator.return?.();
  assert.equal(canceled, true);
  assert.equal(body.locked, false);
});

test("a failed later frame does not discard an already validated small text delta", async () => {
  const body = new Response(
    [
      {
        type: "response.created",
        sequence_number: 0,
        response: { id: "resp-1" },
      },
      {
        type: "response.output_text.delta",
        sequence_number: 1,
        delta: "partial",
      },
      {
        type: "response.output_text.delta",
        sequence_number: 1,
        delta: "invalid sequence",
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(""),
  ).body!;
  const iterator = responsesProtocolEvents(body, {
    sequencePolicy: "required",
    completedCheckpoint: () => null,
    onActivity: () => undefined,
    outputDeltaFlushBytes: 1024,
  })[Symbol.asyncIterator]();
  assert.deepEqual((await iterator.next()).value, {
    type: "output.delta",
    delta: "partial",
  });
  await assert.rejects(
    iterator.next(),
    (error: unknown) =>
      error instanceof ModelTransportError &&
      error.code === "responses_sequence_invalid",
  );
  assert.equal(body.locked, false);
});

function encode(event: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}
