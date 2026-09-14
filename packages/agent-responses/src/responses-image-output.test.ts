import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import {
  ModelTransportError,
  type ModelRequest,
  type ModelTransportEvent,
} from "@crewon/agent-kernel";
import { DirectResponsesTransport } from "./direct-responses-transport.ts";
import { ResponsesProtocolDecoder } from "./responses-protocol.ts";
import {
  MAX_RESPONSES_IMAGE_BYTES,
  type ResponsesImageSink,
} from "./responses-image-output.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=",
  "base64",
);
const request: ModelRequest = {
  schemaVersion: "crewon.model-request.v0",
  runId: "run-1",
  segmentId: "segment-1",
  agentVersionId: "agent-1",
  instructions: null,
  input: {
    strategy: "manual",
    items: [{ type: "message", role: "user", content: "Draw a sample" }],
  },
  tools: [],
  maxOutputBytes: 32 * 1024,
};

test("streams image progress before any pixels or terminal, then persists a multi-megabyte result exactly once", async () => {
  const pixels = Buffer.concat([png, Buffer.alloc(2_700_000)]);
  const item = imageItem("image-1", pixels);
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const saved: Parameters<ResponsesImageSink["persist"]>[0][] = [];
  const transport = new DirectResponsesTransport(
    {
      endpoint: "https://fixture.invalid/v1/responses",
      model: "fixture-model",
      outputDeltaFlushBytes: 1024,
    },
    {
      fetch: async () =>
        new Response(body, {
          headers: { "content-type": "text/event-stream" },
        }),
      imageSink: {
        async persist(input, signal) {
          assert.equal(signal.aborted, false);
          saved.push(input);
          return { artifactRef: "artifact-1" };
        },
      },
    },
  );
  const iterator = transport
    .stream(request, new AbortController().signal)
    [Symbol.asyncIterator]();
  const emit = (event: unknown) =>
    controller.enqueue(
      new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`),
    );
  emit(created());
  emit(added());
  assert.deepEqual((await iterator.next()).value, {
    type: "image.progress",
    itemId: "image-1",
    stage: "in_progress",
  });
  assert.equal(saved.length, 0);
  emit({
    type: "response.image_generation_call.generating",
    sequence_number: 2,
    item_id: "image-1",
    output_index: 0,
  });
  assert.deepEqual((await iterator.next()).value, {
    type: "image.progress",
    itemId: "image-1",
    stage: "generating",
  });
  emit({
    type: "response.image_generation_call.completed",
    sequence_number: 3,
    item_id: "image-1",
    output_index: 0,
  });
  assert.deepEqual((await iterator.next()).value, {
    type: "image.progress",
    itemId: "image-1",
    stage: "completed",
  });
  // Chunk boundaries deliberately split the large JSON string and SSE terminator.
  const frame = new TextEncoder().encode(
    `data: ${JSON.stringify({ type: "response.output_item.done", sequence_number: 4, output_index: 0, item })}\r\n\r\n`,
  );
  for (let offset = 0; offset < frame.length; offset += 65_521)
    controller.enqueue(frame.subarray(offset, offset + 65_521));
  assert.deepEqual((await iterator.next()).value, {
    type: "image.generated",
    itemId: "image-1",
    artifactRef: "artifact-1",
    mimeType: "image/png",
    byteLength: pixels.length,
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.runId, request.runId);
  assert.equal(saved[0]?.segmentId, request.segmentId);
  assert.deepEqual(saved[0]?.bytes, pixels);
  emit(completed(5, [item]));
  controller.close();
  assert.deepEqual((await iterator.next()).value, {
    type: "completed",
    checkpoint: null,
  });
  assert.equal((await iterator.next()).done, true);
  assert.equal(
    saved.length,
    1,
    "terminal replay must not write a second artifact",
  );
  assert.equal(body.locked, false);
});

test("portable empty terminal preserves a saved image and never injects its base64 into history", () => {
  const decoder = imageDecoder();
  decoder.accept(added());
  decoder.accept({
    type: "response.output_item.done",
    sequence_number: 2,
    output_index: 0,
    item: imageItem(),
  });
  assert.equal(decoder.takeImageResults().length, 1);
  decoder.accept(completed(3, []));
  assert.deepEqual(decoder.completedHistoryItems, []);
  assert.equal(decoder.takeImageResults().length, 0);
  decoder.finish();
});

test("terminal-only image results require the announced identity and are validated before becoming available", () => {
  const decoder = imageDecoder();
  decoder.accept(added());
  decoder.accept(completed(2, [imageItem()]));
  assert.equal(decoder.takeImageResults().length, 1);
  const mismatch = imageDecoder();
  mismatch.accept(added());
  assert.throws(
    () =>
      mismatch.accept({
        ...completed(2, [imageItem()]),
        response: {
          id: "different-response",
          status: "completed",
          output: [imageItem()],
        },
      }),
    code("responses_response_id_mismatch"),
  );
  assert.equal(mismatch.takeImageResults().length, 0);
});

test("image replay cannot replace pixels, indexes, or omit an announced result", () => {
  const decoder = imageDecoder();
  decoder.accept(added());
  decoder.accept({
    type: "response.output_item.done",
    sequence_number: 2,
    output_index: 0,
    item: imageItem(),
  });
  decoder.takeImageResults();
  assert.throws(
    () =>
      decoder.accept(
        completed(3, [
          imageItem("image-1", Buffer.concat([png, Buffer.from([1])])),
        ]),
      ),
    code("responses_image_replay_mismatch"),
  );
  assert.equal(decoder.takeImageResults().length, 0);
  const changedIndex = imageDecoder();
  changedIndex.accept(added());
  assert.throws(
    () =>
      changedIndex.accept({
        type: "response.output_item.done",
        sequence_number: 2,
        output_index: 1,
        item: imageItem(),
      }),
    code("responses_image_item_mismatch"),
  );
  const missing = imageDecoder();
  missing.accept(added());
  assert.throws(
    () => missing.accept(completed(2, [])),
    code("responses_image_result_missing"),
  );
});

test("image support retains sequence checks and enforces bounded count, bytes, metadata, encoding and format", () => {
  const sequence = imageDecoder();
  assert.throws(
    () => sequence.accept({ ...added(), sequence_number: 0 }),
    code("responses_sequence_invalid"),
  );
  for (const [patch, expected] of [
    [{ result: "!!!!" }, "responses_image_base64_invalid"],
    [{ result: "AAAA" }, "responses_image_format_invalid"],
    [
      { result: png.toString("base64"), output_format: "jpeg" },
      "responses_image_format_mismatch",
    ],
    [
      {
        result: Buffer.concat([
          png,
          Buffer.alloc(MAX_RESPONSES_IMAGE_BYTES),
        ]).toString("base64"),
      },
      "responses_image_result_invalid",
    ],
    [{ revised_prompt: "x".repeat(256 * 1024) }, "responses_event_too_large"],
  ] as const) {
    const decoder = imageDecoder();
    decoder.accept(added());
    assert.throws(
      () =>
        decoder.accept({
          type: "response.output_item.done",
          sequence_number: 2,
          output_index: 0,
          item: { ...imageItem(), ...patch },
        }),
      code(expected),
    );
    assert.equal(decoder.takeImageResults().length, 0);
  }
  const count = imageDecoder();
  for (let index = 0; index < 4; index++)
    count.accept(added(index + 1, `image-${index}`, index));
  assert.throws(
    () => count.accept(added(5, "image-5", 4)),
    code("responses_image_count_exceeded"),
  );
  const metadata = imageDecoder();
  assert.throws(
    () =>
      metadata.accept({
        type: "unrecognized",
        sequence_number: 1,
        result: "x".repeat(256 * 1024),
      }),
    code("responses_event_too_large"),
  );
});

test("missing sinks, rejected persistence and invalid artifact references fail without emitting pixels", async () => {
  for (const [sink, expected] of [
    [undefined, "responses_image_sink_unavailable"],
    [
      { persist: async () => ({ artifactRef: "/tmp/private-image.png" }) },
      "responses_image_artifact_ref_invalid",
    ],
    [
      {
        persist: async () => {
          throw new Error("storage failed");
        },
      },
      "responses_transport_unavailable",
    ],
  ] as const) {
    const transport = new DirectResponsesTransport(
      { endpoint: "https://fixture.invalid/v1/responses", model: "fixture" },
      {
        fetch: async () =>
          streamResponse([
            created(),
            added(),
            {
              type: "response.output_item.done",
              sequence_number: 2,
              output_index: 0,
              item: imageItem(),
            },
            completed(3, []),
          ]),
        ...(sink === undefined ? {} : { imageSink: sink }),
      },
    );
    const events: ModelTransportEvent[] = [];
    await assert.rejects(async () => {
      for await (const event of transport.stream(
        request,
        new AbortController().signal,
      ))
        events.push(event);
    }, code(expected));
    assert.equal(
      events.some((event) => event.type === "image.generated"),
      false,
    );
    assert.equal(
      JSON.stringify(events).includes(png.toString("base64")),
      false,
    );
  }
});

function imageDecoder(): ResponsesProtocolDecoder {
  const decoder = new ResponsesProtocolDecoder({
    sequencePolicy: "required",
    completedCheckpoint: () => null,
    imagesEnabled: true,
    finalOutputPolicy: "streamAuthoritativeWhenEmpty",
  });
  decoder.accept(created());
  return decoder;
}
function created() {
  return {
    type: "response.created",
    sequence_number: 0,
    response: { id: "resp-1" },
  };
}
function added(sequence_number = 1, id = "image-1", output_index = 0) {
  return {
    type: "response.output_item.added",
    sequence_number,
    output_index,
    item: { type: "image_generation_call", id, status: "in_progress" },
  };
}
function imageItem(id = "image-1", bytes = png) {
  return {
    type: "image_generation_call",
    id,
    status: "completed",
    output_format: "png",
    result: bytes.toString("base64"),
  };
}
function completed(sequence_number: number, output: unknown[]) {
  return {
    type: "response.completed",
    sequence_number,
    response: { id: "resp-1", status: "completed", output },
  };
}
function code(expected: string) {
  return (error: unknown) =>
    error instanceof ModelTransportError && error.code === expected;
}
function streamResponse(events: unknown[]): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}
