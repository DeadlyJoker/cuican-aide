import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { WebSocketServer } from "ws";
import type {
  ModelRequest,
  ModelTransportEvent,
  ModelTransportStreamOptions,
} from "@crewon/agent-kernel";
import { DirectResponsesTransport } from "./direct-responses-transport.ts";
import {
  ResilientResponsesTransport,
  WebSocketResponsesTransport,
} from "./websocket-responses-transport.ts";

type ModelCallObservation = Parameters<
  NonNullable<ModelTransportStreamOptions["callSink"]>["record"]
>[0];

const request: ModelRequest = {
  schemaVersion: "crewon.model-request.v0",
  runId: "run",
  segmentId: "segment",
  agentVersionId: "agent",
  instructions: "fixed instructions",
  input: {
    strategy: "manual",
    items: [{ type: "message", role: "user", content: "request" }],
  },
  tools: [],
  maxOutputBytes: 8192,
};
const response = {
  id: "resp-1",
  status: "completed",
  output: [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "answer" }],
    },
  ],
  usage: {
    input_tokens: 10,
    input_tokens_details: { cached_tokens: 8 },
    output_tokens: 1,
    total_tokens: 11,
  },
};
const events = [
  { type: "response.created", sequence_number: 0, response: { id: "resp-1" } },
  { type: "response.output_text.delta", sequence_number: 1, delta: "answer" },
  { type: "response.completed", sequence_number: 2, response },
];
const sse = () =>
  new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
async function collect(stream: AsyncIterable<ModelTransportEvent>) {
  const result = [];
  for await (const event of stream) result.push(event);
  return result;
}
function ledger() {
  const rows = new Map<string, ModelCallObservation>();
  const writes: ModelCallObservation[] = [];
  return {
    rows,
    writes,
    options: {
      callSink: {
        purpose: "agent" as const,
        record: async (value: ModelCallObservation) => {
          writes.push(structuredClone(value));
          rows.set(value.callId, structuredClone(value));
        },
      },
    },
  };
}

test("HTTP records both rejected continuation and its one replacement before their fetches", async () => {
  const l = ledger();
  let calls = 0;
  const bodies: unknown[] = [];
  const transport = new DirectResponsesTransport(
    {
      endpoint: "https://provider.test/responses",
      model: "model",
      storeResponses: true,
    },
    {
      fetch: async (_url, init) => {
        calls++;
        assert.equal(l.rows.size, calls);
        assert.equal(l.writes.at(-1)?.outcome, "unknown");
        bodies.push(JSON.parse(String(init?.body)));
        return calls === 1
          ? Response.json(
              {
                error: {
                  code: "previous_response_not_found",
                  param: "previous_response_id",
                },
              },
              { status: 404 },
            )
          : sse();
      },
    },
  );
  const result = await collect(
    transport.stream(
      {
        ...request,
        input: {
          strategy: "providerCheckpoint",
          checkpoint: {
            schemaVersion: "crewon.provider-checkpoint.v0",
            adapterName: "direct-responses",
            adapterVersion: "1",
            modelId: "model",
            opaquePayload: { responseId: "old" },
          },
          items: [
            ...request.input.items,
            { type: "message", role: "user", content: "next" },
          ],
          newHistoryStartIndex: 1,
        },
      },
      new AbortController().signal,
      l.options,
    ),
  );
  assert.deepEqual(
    [...l.rows.values()].map((row) => row.outcome),
    ["failed", "completed"],
  );
  assert.equal(l.writes.length, 4);
  assert.equal(
    result.find((event) => event.type === "usage")?.callId,
    [...l.rows.keys()][1],
  );
  assert.equal([...l.rows.values()][1]?.providerResponseId, "resp-1");
  assert(!JSON.stringify(bodies).includes("callId"));
});

test("cancellation while the intent is being committed prevents fetch and closes its idle watch", async () => {
  const controller = new AbortController();
  const l = ledger();
  let calls = 0;
  const timers = new Set<() => void>();
  const transport = new DirectResponsesTransport(
    { endpoint: "https://provider.test/responses", model: "model" },
    {
      fetch: async () => {
        calls++;
        return sse();
      },
      scheduler: {
        schedule: (callback) => {
          timers.add(callback);
          return () => {
            timers.delete(callback);
          };
        },
      },
    },
  );
  await assert.rejects(
    collect(
      transport.stream(request, controller.signal, {
        callSink: {
          purpose: "agent",
          record: async (value) => {
            await l.options.callSink.record(value);
            if (value.outcome === "unknown") controller.abort();
          },
        },
      }),
    ),
    { code: "segment_canceled" },
  );
  assert.equal(calls, 0);
  assert.equal(l.writes.at(-1)?.outcome, "canceled");
  assert.equal(timers.size, 0);
});

test("a 426 handshake fallback keeps accounting attached to the HTTP generation", async (context) => {
  const l = ledger();
  let posts = 0;
  const server = createServer(async (_request, response) => {
    posts++;
    assert.equal(l.rows.size, 1);
    response
      .writeHead(200, { "content-type": "text/event-stream" })
      .end(await sse().text());
  });
  server.on("upgrade", (_request, socket) => {
    socket.end(
      "HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  assert(address && typeof address !== "string");
  const transport = new ResilientResponsesTransport({
    endpoint: `http://127.0.0.1:${address.port}/responses`,
    model: "model",
  });
  context.after(() => transport.close());
  await collect(
    transport.stream(request, new AbortController().signal, l.options),
  );
  assert.equal(posts, 1);
  assert.deepEqual(
    [...l.rows.values()].map((row) => [row.transport, row.outcome]),
    [["http", "completed"]],
  );
});

test("WebSocket continuation replacement accounts for each response.create while preserving private metadata boundaries", async (context) => {
  const l = ledger();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  context.after(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of server.clients) socket.terminate();
        server.close(() => resolve());
      }),
  );
  const frames: Record<string, unknown>[] = [];
  server.on("connection", (socket) =>
    socket.on("message", (bytes) => {
      frames.push(JSON.parse(bytes.toString()));
      assert.equal(l.rows.size, frames.length);
      if (frames.length === 1)
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
      else for (const event of events) socket.send(JSON.stringify(event));
    }),
  );
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  const transport = new WebSocketResponsesTransport({
    endpoint: `http://127.0.0.1:${address.port}/responses`,
    model: "model",
    storeResponses: true,
  });
  context.after(() => transport.close());
  await collect(
    transport.stream(
      {
        ...request,
        input: {
          strategy: "providerCheckpoint",
          checkpoint: {
            schemaVersion: "crewon.provider-checkpoint.v0",
            adapterName: transport.adapterName,
            adapterVersion: transport.adapterVersion,
            modelId: transport.modelId,
            opaquePayload: { responseId: "old" },
          },
          items: [
            ...request.input.items,
            { type: "message", role: "user", content: "next" },
          ],
          newHistoryStartIndex: 1,
        },
      },
      new AbortController().signal,
      l.options,
    ),
  );
  assert.deepEqual(
    [...l.rows.values()].map((row) => [row.transport, row.outcome]),
    [
      ["websocket", "failed"],
      ["websocket", "completed"],
    ],
  );
  assert.equal(frames.length, 2);
  assert(!JSON.stringify(frames).includes("callId"));
});

test("HTTP redirects cannot silently resend a generation outside accounting", async (context) => {
  let charged = 0;
  const server = createServer((request, response) => {
    if (request.url === "/charged") {
      charged++;
      response.end();
    } else response.writeHead(307, { location: "/charged" }).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  assert(address && typeof address !== "string");
  const l = ledger();
  const transport = new DirectResponsesTransport({
    endpoint: `http://127.0.0.1:${address.port}/responses`,
    model: "model",
  });
  await assert.rejects(
    collect(transport.stream(request, new AbortController().signal, l.options)),
    { code: "responses_http_status_invalid", retryable: false },
  );
  assert.equal(charged, 0);
  assert.equal(l.rows.size, 1);
});

for (const status of ["completed", "failed"] as const)
  test(`${status} accounting respects the decoder's terminal-authoritative response identity`, async () => {
    const l = ledger();
    const tail = {
      ...response,
      id: "terminal-authority",
      status,
      ...(status === "failed"
        ? { error: { code: "server_error" }, usage: undefined }
        : {}),
    };
    const stream = [
      events[0]!,
      ...(status === "completed" ? [events[1]!] : []),
      {
        type: `response.${status}`,
        sequence_number: status === "completed" ? 2 : 1,
        response: tail,
      },
    ];
    const transport = new DirectResponsesTransport(
      {
        endpoint: "https://provider.test/responses",
        model: "model",
        identityPolicy: "terminalAuthoritative",
      },
      {
        fetch: async () =>
          new Response(
            stream
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join(""),
            { headers: { "content-type": "text/event-stream" } },
          ),
      },
    );
    await collect(
      transport.stream(request, new AbortController().signal, l.options),
    );
    assert.equal(l.writes.at(-1)?.providerResponseId, "terminal-authority");
    assert.equal(l.writes.at(-1)?.usageEventObserved, status === "completed");
    assert.equal(l.writes.at(-1)?.outcome, status);
  });

test("HTTP diagnostics distinguish admission, body arrival, validated terminal and owned read completion", async () => {
  const l = ledger();
  let bodyController!: ReadableStreamDefaultController<Uint8Array>;
  let bodyCanceled = 0;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      bodyController = c;
    },
    cancel() {
      bodyCanceled += 1;
    },
  });
  const transport = new DirectResponsesTransport(
    { endpoint: "https://provider.test/responses", model: "model" },
    {
      fetch: async () =>
        new Response(body, {
          headers: { "content-type": "text/event-stream" },
        }),
    },
  );
  const stream = transport
    .stream(request, new AbortController().signal, l.options)
    [Symbol.asyncIterator]();
  const next = stream.next();
  bodyController.enqueue(
    new TextEncoder().encode(
      events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
    ),
  );
  assert.equal((await next).value?.type, "output.delta");
  assert.equal((await stream.next()).value?.type, "usage");
  assert.equal((await stream.next()).value?.type, "completed");
  // HTTP ownership has ended. Final accounting still awaits consumer settlement.
  assert.equal(l.writes.at(-1)?.outcome, "unknown");
  assert.equal(bodyCanceled, 1);
  assert.equal(body.locked, false);
  assert.equal((await stream.next()).done, true);
  assert.equal(l.writes.at(-1)?.outcome, "completed");
  const timing = l.writes.at(-1)?.httpTiming;
  assert.ok(timing);
  for (const key of [
    "admittedMs",
    "dispatchedMs",
    "headersMs",
    "firstByteMs",
    "lastByteMs",
    "terminalMs",
    "streamEndMs",
  ] as const) {
    assert.ok(Number.isSafeInteger(timing[key]), key);
  }
  assert.ok(timing.admittedMs! <= timing.dispatchedMs!);
  assert.ok(timing.dispatchedMs! <= timing.headersMs!);
  assert.ok(timing.headersMs! <= timing.firstByteMs!);
  assert.ok(timing.firstByteMs! <= timing.terminalMs!);
  assert.ok(timing.terminalMs! <= timing.streamEndMs!);
});
