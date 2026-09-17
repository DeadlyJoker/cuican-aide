import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { WebSocketServer } from "ws";
import type {
  ModelRequest,
  ModelTransportEvent,
  ModelTransportStreamOptions,
} from "@crewon/agent-kernel";
import {
  DirectResponsesTransport,
  responsesCheckpoint,
} from "./direct-responses-transport.ts";
import {
  ResilientResponsesTransport,
  WebSocketResponsesTransport,
} from "./websocket-responses-transport.ts";

const request: ModelRequest = {
  schemaVersion: "crewon.model-request.v0",
  runId: "run",
  segmentId: "segment",
  agentVersionId: "agent",
  instructions: "stable instructions",
  tools: [],
  maxOutputBytes: 8192,
  input: {
    strategy: "manual",
    items: [{ type: "message", role: "user", content: "stable prefix" }],
  },
};
const completed = {
  id: "response-1",
  status: "completed",
  output: [],
  usage: {
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 80 },
    output_tokens: 10,
    total_tokens: 110,
  },
};
const events = [
  {
    type: "response.created",
    sequence_number: 0,
    response: { id: completed.id },
  },
  { type: "response.completed", sequence_number: 1, response: completed },
];
const sse = () =>
  new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
async function collect(stream: AsyncIterable<ModelTransportEvent>) {
  const out = [];
  for await (const e of stream) out.push(e);
  return out;
}
function ledger(purpose: "agent" | "compaction" = "agent") {
  const rows: Parameters<
    NonNullable<ModelTransportStreamOptions["callSink"]>["record"]
  >[0][] = [];
  const options: ModelTransportStreamOptions = {
    callSink: {
      purpose,
      record: async (row) => {
        rows.push(row);
      },
    },
  };
  return { rows, options };
}
const config = { endpoint: "https://provider.test/responses", model: "model" };

for (const Transport of [
  DirectResponsesTransport,
  WebSocketResponsesTransport,
  ResilientResponsesTransport,
])
  test(`${Transport.name} rejects invalid output ceilings before I/O`, () => {
    for (const bad of [
      null,
      0,
      -1,
      0.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      "128",
    ]) {
      assert.throws(
        () => new Transport({ ...config, maxOutputTokens: bad as number }),
        { code: "responses_max_output_tokens_invalid" },
      );
    }
    assert.equal(new Transport(config).maxOutputTokens, undefined);
  });

for (const requestProfile of ["standard", "responsesLite"] as const)
  test(`${requestProfile}: explicit ceiling is stable across calls, purpose and segment, without changing prefix`, async () => {
    const bodies: Record<string, unknown>[] = [];
    const make = (maxOutputTokens?: number) =>
      new DirectResponsesTransport(
        { ...config, requestProfile, maxOutputTokens },
        {
          fetch: async (_url, init) => {
            bodies.push(JSON.parse(String(init?.body)));
            return sse();
          },
        },
      );
    const legacy = make();
    await collect(legacy.stream(request, new AbortController().signal));
    assert.equal(Object.hasOwn(bodies[0]!, "max_output_tokens"), false);
    const bounded = make(128);
    for (const purpose of ["agent", "compaction"] as const) {
      const l = ledger(purpose);
      await collect(
        bounded.stream(
          { ...request, segmentId: purpose },
          new AbortController().signal,
          l.options,
        ),
      );
      assert.equal(l.rows.length, 2);
      assert.ok(
        l.rows.every(
          (row) => row.maxOutputTokens === 128 && row.purpose === purpose,
        ),
      );
    }
    for (const body of bodies.slice(1)) {
      const { max_output_tokens, ...unchanged } = body;
      assert.equal(max_output_tokens, 128);
      assert.deepEqual(unchanged, bodies[0]);
      assert.equal(Object.hasOwn(body, "callId"), false);
    }
  });

test("HTTP continuation fallback retains the cap, and retrieval carries no new generation ceiling", async () => {
  const l = ledger(),
    bodies: Record<string, unknown>[] = [],
    methods: string[] = [];
  const transport = new DirectResponsesTransport(
    { ...config, storeResponses: true, maxOutputTokens: 128 },
    {
      fetch: async (_url, init) => {
        methods.push(init?.method ?? "GET");
        if (init?.method === "GET") {
          assert.equal(init.body, undefined);
          return Response.json(completed);
        }
        bodies.push(JSON.parse(String(init?.body)));
        if (bodies.length === 1)
          return Response.json(
            {
              error: {
                code: "previous_response_not_found",
                param: "previous_response_id",
              },
            },
            { status: 400 },
          );
        return sse();
      },
    },
  );
  await collect(
    transport.stream(
      {
        ...request,
        input: {
          strategy: "providerCheckpoint",
          checkpoint: responsesCheckpoint("old", transport.modelIdentity()),
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
  assert.equal(bodies.length, 2);
  assert.ok(bodies.every((b) => b.max_output_tokens === 128));
  assert.equal(bodies[0]!.previous_response_id, "old");
  assert.equal(Object.hasOwn(bodies[1]!, "previous_response_id"), false);
  await collect(
    transport.stream(
      {
        ...request,
        reconcileCheckpoint: responsesCheckpoint(
          completed.id,
          transport.modelIdentity(),
        ),
      },
      new AbortController().signal,
      l.options,
    ),
  );
  assert.deepEqual(methods, ["POST", "POST", "GET"]);
  assert.deepEqual(
    l.rows
      .filter((r) => r.outcome === "unknown")
      .map((r) => [r.operation, r.maxOutputTokens]),
    [
      ["generate", 128],
      ["generate", 128],
      ["retrieve", undefined],
    ],
  );
});

test("a gateway rejecting max_output_tokens fails without retrying an unbounded request", async () => {
  let calls = 0;
  const transport = new DirectResponsesTransport(
    { ...config, maxOutputTokens: 128 },
    {
      fetch: async () => {
        calls++;
        return Response.json(
          {
            error: {
              code: "unsupported_parameter",
              param: "max_output_tokens",
            },
          },
          { status: 400 },
        );
      },
    },
  );
  await assert.rejects(
    collect(transport.stream(request, new AbortController().signal)),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "retryable" in error &&
      error.retryable === false,
  );
  assert.equal(calls, 1);
});

test("WebSocket continuation fallback preserves the configured output ceiling on every frame", async (t) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        for (const s of server.clients) s.terminate();
        server.close(() => resolve());
      }),
  );
  const frames: Record<string, unknown>[] = [];
  server.on("connection", (socket) =>
    socket.on("message", (bytes) => {
      frames.push(JSON.parse(bytes.toString()));
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
  assert.ok(address && typeof address !== "string");
  const transport = new WebSocketResponsesTransport({
    endpoint: `http://127.0.0.1:${address.port}/responses`,
    model: "model",
    storeResponses: true,
    maxOutputTokens: 128,
  });
  t.after(() => transport.close());
  const l = ledger();
  await collect(
    transport.stream(
      {
        ...request,
        input: {
          strategy: "providerCheckpoint",
          checkpoint: responsesCheckpoint("old", transport.modelIdentity()),
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
  assert.equal(frames.length, 2);
  assert.ok(frames.every((frame) => frame.max_output_tokens === 128));
  assert.ok(l.rows.every((row) => row.maxOutputTokens === 128));
  assert.equal(frames[0]!.previous_response_id, "old");
  assert.equal(Object.hasOwn(frames[1]!, "previous_response_id"), false);
});

test("WebSocket handshake fallback to HTTP keeps the same cap", async (t) => {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    res
      .writeHead(200, { "content-type": "text/event-stream" })
      .end(await sse().text());
  });
  server.on("upgrade", (_req, socket) =>
    socket.end(
      "HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    ),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const transport = new ResilientResponsesTransport({
    endpoint: `http://127.0.0.1:${address.port}/responses`,
    model: "model",
    maxOutputTokens: 128,
  });
  t.after(() => transport.close());
  const l = ledger();
  await collect(
    transport.stream(request, new AbortController().signal, l.options),
  );
  assert.equal(transport.maxOutputTokens, 128);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]!.max_output_tokens, 128);
  assert.ok(l.rows.every((row) => row.maxOutputTokens === 128));
});
