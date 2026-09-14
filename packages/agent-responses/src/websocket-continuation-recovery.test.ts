import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { type TestContext } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import {
  ModelTransportError,
  type ModelRequest,
  type ModelTransportEvent,
} from "@crewon/agent-kernel";
import {
  WebSocketResponsesTransport,
  ResilientResponsesTransport,
} from "./websocket-responses-transport.ts";

for (const transportKind of ["websocket", "hybrid"] as const) {
  test(`${transportKind}: missing persisted response recovers without HTTP downgrade and holds the stream guard`, async (context) => {
    const fixture = await createFixture(context, true);
    const transport =
      transportKind === "websocket"
        ? new WebSocketResponsesTransport({
            endpoint: fixture.endpoint,
            model: "model",
            storeResponses: true,
          })
        : new ResilientResponsesTransport({
            endpoint: fixture.endpoint,
            model: "model",
            storeResponses: true,
          });
    context.after(() => transport.close());
    const controller = new AbortController();
    const iterator = transport
      .stream(request("providerCheckpoint"), controller.signal)
      [Symbol.asyncIterator]();
    const fallback = await iterator.next();
    assert.equal(fallback.value?.type, "transport.fallback");
    assert.equal(fixture.frames.length, 1);
    await assert.rejects(
      collect(transport.stream(request("manual"), controller.signal)),
      (error: unknown) =>
        error instanceof ModelTransportError &&
        error.code === "responses_websocket_concurrent_stream",
    );
    const events: ModelTransportEvent[] = [];
    for (
      let next = await iterator.next();
      !next.done;
      next = await iterator.next()
    )
      events.push(next.value);
    assert.equal(events.at(-1)?.type, "completed");
    assert.equal(fixture.frames.length, 2);
    assert.equal(fixture.connections(), 2);
    assert.equal(fixture.httpCalls(), 0);
    assert.equal(fixture.frames[0]?.previous_response_id, "resp-old");
    assert.equal(fixture.frames[1]?.previous_response_id, undefined);
    assert.deepEqual(fixture.frames[1]?.input, [
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "next" },
    ]);
    assert.equal(
      fixture.frames[0]?.instructions,
      fixture.frames[1]?.instructions,
    );
    assert.deepEqual(fixture.frames[0]?.tools, fixture.frames[1]?.tools);
  });
}

test("a lost connection-local baseline with store=false rebuilds and remains incremental afterwards", async (context) => {
  const fixture = await createFixture(context, false);
  const transport = new WebSocketResponsesTransport({
    endpoint: fixture.endpoint,
    model: "model",
    storeResponses: false,
  });
  context.after(() => transport.close());
  const signal = new AbortController().signal;
  const first = request("manual");
  await collect(
    transport.stream(
      {
        ...first,
        input: { strategy: "manual", items: first.input.items.slice(0, 1) },
      },
      signal,
    ),
  );
  const secondEvents = await collect(transport.stream(first, signal));
  assert.equal(
    secondEvents.filter((event) => event.type === "transport.fallback").length,
    1,
  );
  assert.equal(fixture.frames.length, 3);
  assert.equal(fixture.frames[1]?.previous_response_id, "resp-old");
  assert.equal(fixture.frames[2]?.previous_response_id, undefined);
  await collect(
    transport.stream(
      {
        ...first,
        input: {
          strategy: "manual",
          items: [
            ...first.input.items,
            { type: "message", role: "assistant", content: "answer" },
            { type: "message", role: "user", content: "third" },
          ],
        },
      },
      signal,
    ),
  );
  assert.equal(fixture.frames.length, 4);
  assert.equal(fixture.frames[3]?.previous_response_id, "resp-new");
  assert.deepEqual(fixture.frames[3]?.input, [
    { role: "user", content: "third" },
  ]);
  assert.equal(
    fixture.frames.every((frame) => frame.store === false),
    true,
  );
});

test("canceling a WebSocket recovery at the audit boundary closes the operation without another request", async (context) => {
  const fixture = await createFixture(context, true);
  const transport = new WebSocketResponsesTransport({
    endpoint: fixture.endpoint,
    model: "model",
    storeResponses: true,
  });
  context.after(() => transport.close());
  const controller = new AbortController();
  const iterator = transport
    .stream(request("providerCheckpoint"), controller.signal)
    [Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.type, "transport.fallback");
  controller.abort();
  await assert.rejects(
    iterator.next(),
    (error: unknown) =>
      error instanceof ModelTransportError && error.code === "segment_canceled",
  );
  assert.equal(fixture.frames.length, 1);
  // A fresh scope can start; the failed operation must not retain the concurrency guard.
  await collect(
    transport.stream(request("manual"), new AbortController().signal),
  );
  assert.equal(fixture.frames.length, 2);
});

test("a later HTTP downgrade retains the recovered input without probing the expired checkpoint again", async (context) => {
  const fixture = await createFixture(context, true, { failReplacement: true });
  const transport = new ResilientResponsesTransport({
    endpoint: fixture.endpoint,
    model: "model",
    storeResponses: true,
    websocketMaxRetries: 0,
  });
  context.after(() => transport.close());
  const events = await collect(
    transport.stream(
      request("providerCheckpoint"),
      new AbortController().signal,
    ),
  );
  assert.equal(events.at(-1)?.type, "completed");
  assert.equal(fixture.frames.length, 2);
  assert.equal(fixture.httpRequests.length, 1);
  assert.equal(fixture.httpRequests[0]?.previous_response_id, undefined);
  assert.deepEqual(fixture.httpRequests[0]?.input, fixture.frames[1]?.input);
  assert.equal(
    events.filter((event) => event.type === "transport.fallback").length,
    2,
  );
});

async function createFixture(
  context: TestContext,
  persisted: boolean,
  options: { failReplacement?: boolean } = {},
) {
  let httpCalls = 0;
  let connections = 0;
  const frames: Record<string, unknown>[] = [];
  const httpRequests: Record<string, unknown>[] = [];
  const server = createServer(async (incoming, response) => {
    httpCalls += 1;
    if (!options.failReplacement) {
      response.writeHead(500).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk);
    httpRequests.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of completedEvents("resp-http"))
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  const websocket = new WebSocketServer({ server });
  websocket.on("connection", (socket) => {
    connections += 1;
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      frames.push(frame);
      if (frame.previous_response_id === "resp-old") {
        socket.send(
          JSON.stringify({
            type: "error",
            status: 400,
            error: {
              code: "previous_response_not_found",
              param: "previous_response_id",
            },
          }),
        );
      } else if (options.failReplacement) {
        socket.send(
          JSON.stringify({
            type: "error",
            sequence_number: 0,
            error: { code: "server_error" },
          }),
        );
      } else
        sendCompleted(
          socket,
          !persisted && frames.length === 1 ? "resp-old" : "resp-new",
        );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    for (const client of websocket.clients) client.terminate();
    await new Promise<void>((resolve) => websocket.close(() => resolve()));
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1/responses`,
    frames,
    httpRequests,
    connections: () => connections,
    httpCalls: () => httpCalls,
  };
}

function request(strategy: "manual" | "providerCheckpoint"): ModelRequest {
  const items = [
    { type: "message", role: "user", content: "first" },
    { type: "message", role: "assistant", content: "answer" },
    { type: "message", role: "user", content: "next" },
  ] as const;
  return {
    schemaVersion: "crewon.model-request.v0",
    runId: "run",
    segmentId: "segment",
    agentVersionId: "agent",
    instructions: "stable instructions",
    tools: [],
    maxOutputBytes: 32768,
    input:
      strategy === "manual"
        ? { strategy, items }
        : {
            strategy,
            items,
            newHistoryStartIndex: 2,
            checkpoint: {
              schemaVersion: "crewon.provider-checkpoint.v0",
              adapterName: "direct-responses",
              adapterVersion: "2",
              modelId: "model",
              opaquePayload: { responseId: "resp-old" },
            },
          },
  };
}

function sendCompleted(socket: WebSocket, id: string) {
  for (const event of completedEvents(id)) socket.send(JSON.stringify(event));
}

function completedEvents(id: string) {
  return [
    { type: "response.created", sequence_number: 0, response: { id } },
    { type: "response.output_text.delta", sequence_number: 1, delta: "answer" },
    {
      type: "response.completed",
      sequence_number: 2,
      response: {
        id,
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "answer" }],
          },
        ],
      },
    },
  ];
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}
