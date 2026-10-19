import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { WebSocketServer } from "ws";
import {
  captureModelImageObservation,
  type ModelInputItem,
  type ModelRequest,
} from "@crewon/agent-kernel";
import {
  DirectResponsesTransport,
  responsesCheckpoint,
  responsesRequestBody,
} from "./direct-responses-transport.ts";
import { WebSocketResponsesTransport } from "./websocket-responses-transport.ts";
import {
  ResponsesImageInputState,
  planResponsesImageInput,
} from "./responses-image-input.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nxjYAAAAASUVORK5CYII=",
  "base64",
);
const scope = {
  runId: "review",
  segmentId: "segment",
  agentVersionId: "reviewer",
};
function image(
  detail: "high" | "low" = "high",
  owner = scope,
  evidenceId = "frame",
) {
  return captureModelImageObservation({
    scope: owner,
    evidenceId,
    mediaType: "image/png",
    bytes: png,
    detail,
  });
}
function request(
  items: readonly ModelInputItem[] = [
    { type: "message", role: "user", content: "review the frame" },
    image(),
  ],
  owner = scope,
): ModelRequest {
  return {
    schemaVersion: "crewon.model-request.v0",
    ...owner,
    instructions: null,
    input: { strategy: "manual", items },
    tools: [],
    maxOutputBytes: 8192,
  };
}
const signal = () => new AbortController().signal;
async function collect<T>(source: AsyncIterable<T>) {
  const events: T[] = [];
  for await (const event of source) events.push(event);
  return events;
}
const done = (id: string) => [
  { type: "response.created", sequence_number: 0, response: { id } },
  {
    type: "response.completed",
    sequence_number: 1,
    response: { id, status: "completed", output: [] },
  },
];

test("image selection must be the original request suffix; no injected, cloned or over-budget alternative", () => {
  const original = request();
  for (const inputItems of [
    [image()],
    [{ ...original.input.items[1]! }],
    Array.from({ length: 7 }, () => image()),
    [original.input.items[1]!, original.input.items[1]!],
  ]) {
    assert.throws(
      () =>
        responsesRequestBody({
          request: original,
          inputItems,
          previousResponseId: null,
          modelId: "fixture",
          storeResponses: true,
        }),
      { code: "responses_image_selection_invalid" },
    );
  }
  const textOnly = request([original.input.items[0]!]);
  assert.throws(
    () =>
      responsesRequestBody({
        request: textOnly,
        inputItems: [image()],
        previousResponseId: null,
        modelId: "fixture",
        storeResponses: true,
      }),
    { code: "responses_image_selection_invalid" },
  );
});

test("unknown image checkpoints replay full input even when the caller selects all images", () => {
  const original = request();
  for (const inputItems of [
    original.input.items,
    original.input.items.slice(1),
    [],
  ]) {
    const body = responsesRequestBody({
      request: original,
      inputItems,
      previousResponseId: "unknown",
      modelId: "fixture",
      storeResponses: true,
    });
    assert.equal(body.previous_response_id, undefined);
    assert.equal((body.input as unknown[]).length, 2);
  }
  const plan = planResponsesImageInput({
    request: original,
    inputItems: original.input.items.slice(1),
    previousResponseId: null,
  });
  assert.deepEqual(plan, {
    previousResponseId: null,
    inputItems: original.input.items,
  });
});

test(
  "HTTP continuation retains proven images; release, unknown identity and changed detail resend full evidence",
  { timeout: 5000 },
  async (t) => {
    const received: Array<{ input: unknown[]; previous_response_id?: string }> =
      [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        done(`response-${received.length}`)
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
      );
    });
    t.after(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const transport = new DirectResponsesTransport({
      endpoint: `http://127.0.0.1:${address.port}/v1/responses`,
      model: "fixture",
      storeResponses: true,
    });
    const first = request();
    await collect(transport.stream(first, signal()));
    const continued = (
      previous: string,
      items = first.input.items,
    ): ModelRequest => ({
      ...first,
      input: {
        strategy: "providerCheckpoint",
        checkpoint: responsesCheckpoint(previous, transport.modelIdentity()),
        items,
        newHistoryStartIndex: 2,
      },
    });
    await collect(
      transport.stream(
        continued("response-1", [
          ...first.input.items,
          { type: "message", role: "user", content: "check continuity" },
        ]),
        signal(),
      ),
    );
    assert.equal(received[1]!.previous_response_id, "response-1");
    assert.deepEqual(received[1]!.input, [
      { role: "user", content: "check continuity" },
    ]);
    await collect(transport.stream(continued("unknown"), signal()));
    transport.releaseRun(scope.runId);
    await collect(transport.stream(continued("response-3"), signal()));
    await collect(
      transport.stream(
        continued("response-4", [first.input.items[0]!, image("low")]),
        signal(),
      ),
    );
    for (const index of [2, 3, 4]) {
      assert.equal(received[index]!.previous_response_id, undefined);
      assert.equal(received[index]!.input.length, 2);
    }
    assert.ok(JSON.stringify(received[4]!.input).includes('"detail":"low"'));
  },
);

test(
  "an invalid received terminal tail does not establish trusted image lineage",
  { timeout: 5000 },
  async (t) => {
    const bodies: Array<{ input: unknown[]; previous_response_id?: string }> =
      [];
    const transport = new DirectResponsesTransport(
      {
        endpoint: "https://fixture.invalid/v1/responses",
        model: "fixture",
        storeResponses: true,
      },
      {
        fetch: async (_url, init) => {
          assert.ok(init);
          bodies.push(JSON.parse(init.body as string));
          return new Response(
            done("tail-response")
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join("") + (bodies.length === 1 ? "data: invalid-json\n\n" : ""),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      },
    );
    const original = request();
    await assert.rejects(collect(transport.stream(original, signal())), {
      code: "responses_event_json_invalid",
    });
    await collect(
      transport.stream(
        {
          ...original,
          input: {
            strategy: "providerCheckpoint",
            checkpoint: responsesCheckpoint(
              "tail-response",
              transport.modelIdentity(),
            ),
            items: original.input.items,
            newHistoryStartIndex: 2,
          },
        },
        signal(),
      ),
    );
    assert.equal(bodies[1]!.previous_response_id, undefined);
    assert.equal(bodies[1]!.input.length, 2);
  },
);

test(
  "real WebSocket reuses unchanged images, resets changed evidence and replays after release",
  { timeout: 5000 },
  async (t) => {
    const server = createServer();
    const sockets = new WebSocketServer({ server });
    const frames: Array<{ input: unknown[]; previous_response_id?: string }> =
      [];
    sockets.on("connection", (socket) =>
      socket.on("message", (raw) => {
        frames.push(JSON.parse(raw.toString()));
        for (const event of done(`socket-response-${frames.length}`))
          socket.send(JSON.stringify(event));
      }),
    );
    t.after(async () => {
      for (const client of sockets.clients) client.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const transport = new WebSocketResponsesTransport({
      endpoint: `http://127.0.0.1:${address.port}/v1/responses`,
      model: "fixture",
      storeResponses: true,
    });
    t.after(() => transport.close());
    const original = request();
    await collect(transport.stream(original, signal()));
    const second = request([
      ...original.input.items,
      { type: "message", role: "user", content: "review continuity" },
    ]);
    await collect(transport.stream(second, signal()));
    assert.equal(frames[1]!.previous_response_id, "socket-response-1");
    assert.deepEqual(frames[1]!.input, [
      { role: "user", content: "review continuity" },
    ]);
    const changed = request([
      original.input.items[0]!,
      image("low"),
      second.input.items[2]!,
    ]);
    await collect(transport.stream(changed, signal()));
    assert.equal(frames[2]!.previous_response_id, undefined);
    assert.equal(frames[2]!.input.length, 3);
    transport.releaseRun(scope.runId);
    await collect(
      transport.stream(
        {
          ...changed,
          input: {
            strategy: "providerCheckpoint",
            checkpoint: responsesCheckpoint(
              "socket-response-3",
              transport.modelIdentity(),
            ),
            items: changed.input.items,
            newHistoryStartIndex: 3,
          },
        },
        signal(),
      ),
    );
    assert.equal(frames[3]!.previous_response_id, undefined);
    assert.equal(frames[3]!.input.length, 3);
  },
);

test("lineage is isolated by segment and bounded by 16 responses / 32 runs; eviction replays", () => {
  const state = new ResponsesImageInputState();
  const original = request();
  const plan = (target = original, id = "response-0") =>
    planResponsesImageInput({
      request: target,
      previousResponseId: id,
      inputItems: [],
      imageState: state,
    });
  for (let index = 0; index < 17; index++)
    state.completed(state.capture(original), `response-${index}`);
  assert.equal(plan().previousResponseId, null);
  assert.equal(plan(original, "response-16").previousResponseId, "response-16");
  const foreignScope = { ...scope, segmentId: "foreign-segment" };
  assert.equal(
    plan(request([image("high", foreignScope)], foreignScope), "response-16")
      .previousResponseId,
    null,
  );
  for (let index = 0; index < 32; index++) {
    const owner = { ...scope, runId: `other-run-${index}` };
    state.completed(
      state.capture(request([image("high", owner)], owner)),
      "other-response",
    );
  }
  assert.equal(plan(original, "response-16").previousResponseId, null);
  state.completed(state.capture(original), "fresh");
  state.clear();
  assert.equal(plan(original, "fresh").previousResponseId, null);
});

test("image lineage records the evidence actually dispatched after asynchronous accounting admission", async () => {
  const bodies: Array<{ input: unknown[]; previous_response_id?: string }> = [];
  const transport = new DirectResponsesTransport(
    {
      endpoint: "https://fixture.invalid/v1/responses",
      model: "fixture",
      storeResponses: true,
    },
    {
      fetch: async (_url, init) => {
        assert.ok(init);
        bodies.push(JSON.parse(init.body as string));
        return new Response(
          done(`admitted-${bodies.length}`)
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    },
  );
  const high = image();
  const low = image("low");
  const items: ModelInputItem[] = [
    { type: "message", role: "user", content: "review" },
    high,
  ];
  const original = request(items);
  await collect(
    transport.stream(original, signal(), {
      callSink: {
        purpose: "agent",
        record: async (observation) => {
          if (observation.finishedAt === null) items[1] = low;
        },
      },
    }),
  );
  assert.ok(JSON.stringify(bodies[0]).includes('"detail":"low"'));
  items[1] = high;
  await collect(
    transport.stream(
      {
        ...original,
        input: {
          strategy: "providerCheckpoint",
          checkpoint: responsesCheckpoint(
            "admitted-1",
            transport.modelIdentity(),
          ),
          items,
          newHistoryStartIndex: 2,
        },
      },
      signal(),
    ),
  );
  assert.equal(bodies[1]!.previous_response_id, undefined);
  assert.equal(bodies[1]!.input.length, 2);
  assert.ok(JSON.stringify(bodies[1]).includes('"detail":"high"'));
});
