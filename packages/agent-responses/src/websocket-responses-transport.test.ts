import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
} from "node:http";
import test, { type TestContext } from "node:test";

import {
  CrewONAgentKernel,
  ModelTransportError,
  type AgentSegmentContract,
  type ModelRequest,
} from "@crewon/agent-kernel";
import { WebSocketServer, type WebSocket } from "ws";

import {
  ResilientResponsesTransport,
  WebSocketResponsesTransport,
} from "./websocket-responses-transport.ts";

type WebSocketParityReference = Readonly<{
  fallback: Readonly<{
    caseIds: readonly string[];
    streamMaxRetries: number;
    startupPrewarmAttempts: number;
    firstTurn: Readonly<{
      websocketAttempts: number;
      httpAttempts: number;
      retryAttempts: readonly number[];
      fallback: Readonly<Record<string, unknown>>;
    }>;
    secondTurn: Readonly<{
      websocketAttempts: number;
      httpAttempts: number;
      fallbackEvents: number;
    }>;
    debugVisibleRetryAttempts: readonly number[];
    releaseVisibleRetryAttempts: readonly number[];
  }>;
  incremental: Readonly<{
    caseId: string;
    connectionCount: number;
    firstRequest: Readonly<Record<string, unknown>>;
    secondRequest: Readonly<Record<string, unknown>>;
  }>;
}>;

const websocketParity = JSON.parse(
  readFileSync(
    new URL(
      "../../test-contracts/fixtures/websocket-transport.reference.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as WebSocketParityReference;

test("reuses one authenticated WebSocket and sends only the new Turn suffix", async (context) => {
  const fixture = await websocketFixture(context);
  const frames: Record<string, unknown>[] = [];
  const handshakes: IncomingMessage[] = [];
  let connections = 0;
  fixture.webSocketServer.on("connection", (socket, request) => {
    connections += 1;
    handshakes.push(request);
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      frames.push(frame);
      const index = frames.length;
      sendCompleted(socket, `resp-${index}`, index === 1 ? "first" : "second");
    });
  });
  const transport = new WebSocketResponsesTransport({
    endpoint: fixture.endpoint,
    apiKey: "test-secret",
    model: "provider-model",
    storeResponses: true,
  });
  context.after(() => transport.close());

  await transport.prewarm(signal());
  const firstEvents = await collect(
    transport.stream(manualRequest("hello"), signal()),
  );
  await collect(
    transport.stream(
      {
        ...manualRequest("second"),
        input: {
          strategy: "manual",
          items: [
            { type: "message", role: "user", content: "hello" },
            { type: "message", role: "assistant", content: "first" },
            { type: "message", role: "user", content: "second" },
          ],
        },
      },
      signal(),
    ),
  );

  assert.equal(connections, 1);
  assert.deepEqual(firstEvents.at(-1), {
    type: "completed",
    checkpoint: {
      schemaVersion: "crewon.provider-checkpoint.v0",
      adapterName: "direct-responses",
      adapterVersion: "2",
      modelId: "provider-model",
      opaquePayload: { responseId: "resp-1" },
    },
  });
  assert.equal(handshakes[0]?.headers.authorization, "Bearer test-secret");
  assert.equal(
    handshakes[0]?.headers["openai-beta"],
    "responses_websockets=2026-02-06",
  );
  assert.deepEqual(frames[0], {
    type: "response.create",
    model: "provider-model",
    stream: true,
    store: true,
    input: [{ role: "user", content: "hello" }],
    tools: [],
  });
  assert.deepEqual(frames[1], {
    type: "response.create",
    model: "provider-model",
    stream: true,
    store: true,
    input: [{ role: "user", content: "second" }],
    tools: [],
    previous_response_id: "resp-1",
  });
  assert.deepEqual(
    {
      caseId: websocketParity.incremental.caseId,
      connectionCount: connections,
      firstRequest: normalizedIncrementalFrame(frames[0]),
      secondRequest: normalizedIncrementalFrame(frames[1]),
    },
    websocketParity.incremental,
  );
});

test("does not reuse one incremental baseline across different Runs", async (context) => {
  const fixture = await websocketFixture(context);
  const frames: Record<string, unknown>[] = [];
  let connections = 0;
  fixture.webSocketServer.on("connection", (socket) => {
    connections += 1;
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      frames.push(frame);
      sendCompleted(socket, `response-${frames.length}`, "done");
    });
  });
  const transport = new WebSocketResponsesTransport({
    endpoint: fixture.endpoint,
    model: "provider-model",
    storeResponses: true,
  });
  context.after(() => transport.close());

  await collect(transport.stream(manualRequest("first"), signal()));
  await collect(
    transport.stream(
      { ...manualRequest("second"), runId: "run-2", segmentId: "segment-2" },
      signal(),
    ),
  );

  assert.equal(frames[0]?.previous_response_id, undefined);
  assert.equal(frames[1]?.previous_response_id, undefined);
  assert.equal(connections, 2);
});

test("reconnects one Run to return its bounded handshake state", async (context) => {
  const fixture = await websocketFixture(context);
  const handshakes: IncomingMessage[] = [];
  let responseIndex = 0;
  fixture.webSocketServer.on("headers", (headers) => {
    headers.push("x-codex-turn-state: state-1");
  });
  fixture.webSocketServer.on("connection", (socket, request) => {
    handshakes.push(request);
    socket.on("message", () => {
      responseIndex += 1;
      sendCompleted(socket, `response-${responseIndex}`, "done");
    });
  });
  const transport = new WebSocketResponsesTransport({
    endpoint: fixture.endpoint,
    model: "provider-model",
  });
  context.after(() => transport.close());

  const first = await collect(
    transport.stream(manualRequest("first"), signal()),
  );
  const terminal = first.at(-1);
  assert.equal(terminal?.type, "completed");
  assert.equal(
    terminal?.type === "completed" ? terminal.providerTurnState : null,
    "state-1",
  );
  await collect(
    transport.stream(
      { ...manualRequest("second"), providerTurnState: "state-1" },
      signal(),
    ),
  );

  assert.equal(handshakes.length, 2);
  assert.equal(handshakes[0]?.headers["x-codex-turn-state"], undefined);
  assert.equal(handshakes[1]?.headers["x-codex-turn-state"], "state-1");
});

test("retains handshake state across a failed WebSocket stream retry", async (context) => {
  const fixture = await websocketFixture(context);
  const handshakes: IncomingMessage[] = [];
  let connections = 0;
  fixture.webSocketServer.on("headers", (headers) => {
    headers.push("x-codex-turn-state: retry-state");
  });
  fixture.webSocketServer.on("connection", (socket, request) => {
    connections += 1;
    handshakes.push(request);
    socket.on("message", () => {
      if (connections === 1) {
        socket.send("not-json");
      } else {
        sendCompleted(socket, `response-${connections}`, "done");
      }
    });
  });
  const transport = new WebSocketResponsesTransport({
    endpoint: fixture.endpoint,
    model: "provider-model",
  });
  context.after(() => transport.close());

  await assert.rejects(
    collect(transport.stream(manualRequest("first"), signal())),
  );
  await collect(transport.stream(manualRequest("second"), signal()));

  assert.equal(handshakes[0]?.headers["x-codex-turn-state"], undefined);
  assert.equal(handshakes[1]?.headers["x-codex-turn-state"], "retry-state");
  transport.releaseRun("run-1");
});

test("prewarm discards unscoped state and reacquires it for the first Run", async (context) => {
  const fixture = await websocketFixture(context);
  const handshakes: IncomingMessage[] = [];
  fixture.webSocketServer.on("headers", (headers) => {
    headers.push("x-codex-turn-state: state-1");
  });
  fixture.webSocketServer.on("connection", (socket, request) => {
    handshakes.push(request);
    socket.on("message", () => sendCompleted(socket, "response-1", "done"));
  });
  const transport = new WebSocketResponsesTransport({
    endpoint: fixture.endpoint,
    model: "provider-model",
  });
  context.after(() => transport.close());

  await transport.prewarm(signal());
  await collect(transport.stream(manualRequest("first"), signal()));

  assert.equal(handshakes.length, 2);
  assert.equal(handshakes[0]?.headers["x-codex-turn-state"], undefined);
  assert.equal(handshakes[1]?.headers["x-codex-turn-state"], undefined);
});

test("matches the shared Rust Responses Lite profile over WebSocket", async (context) => {
  const reference = JSON.parse(
    readFileSync(
      new URL(
        "../../test-contracts/fixtures/responses-lite-request.reference.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Readonly<{
    requestProfile: "responsesLite";
    expected: Readonly<Record<string, unknown>>;
  }>;
  const fixture = await websocketFixture(context);
  let frame: Record<string, unknown> | undefined;
  fixture.webSocketServer.on("connection", (socket) => {
    socket.once("message", (raw) => {
      frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      sendCompleted(socket, "resp-lite", "done");
    });
  });
  const transport = new WebSocketResponsesTransport({
    endpoint: fixture.endpoint,
    model: "provider-model",
    requestProfile: reference.requestProfile,
  });
  context.after(() => transport.close());

  await collect(transport.stream(manualRequest("hello"), signal()));

  assert.equal(transport.adapterVersion, "2+responses-lite");
  assert.deepEqual(
    {
      reasoningContext: (
        frame?.reasoning as Record<string, unknown> | undefined
      )?.context,
      parallelToolCalls: frame?.parallel_tool_calls,
    },
    reference.expected,
  );
  const resilient = new ResilientResponsesTransport({
    endpoint: fixture.endpoint,
    model: "provider-model",
    requestProfile: reference.requestProfile,
  });
  context.after(() => resilient.close());
  assert.equal(resilient.adapterVersion, "2+responses-lite");
});

test("falls back after the Rust-aligned WebSocket budget and gives HTTP a fresh retry budget", async (context) => {
  let websocketConnections = 0;
  let httpRequests = 0;
  const fixture = await websocketFixture(context, (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    httpRequests += 1;
    if (httpRequests === 1) {
      response.writeHead(503).end();
      return;
    }
    sendHttpCompleted(response, `http-${httpRequests}`, "done");
  });
  fixture.webSocketServer.on("connection", (socket) => {
    websocketConnections += 1;
    socket.once("message", () => socket.close());
  });
  const transport = new ResilientResponsesTransport({
    endpoint: fixture.endpoint,
    model: "provider-model",
  });
  context.after(() => transport.close());
  const kernel = new CrewONAgentKernel({
    transport,
    streamMaxRetries: 2,
    retryScheduler: { wait: async () => undefined },
  });

  const first = await collect(
    kernel.runSegment(segmentContract("run-1", "hello"), signal()),
  );
  const second = await collect(
    kernel.runSegment(segmentContract("run-2", "again"), signal()),
  );

  assert.equal(websocketConnections, 3);
  assert.equal(httpRequests, 3);
  assert.deepEqual(
    first
      .filter(
        (event) =>
          event.type === "model.sampling.retry" ||
          event.type === "model.transport.fallback",
      )
      .map((event) => ({ type: event.type, data: event.data })),
    [
      {
        type: "model.sampling.retry",
        data: {
          samplingAttempt: 1,
          maxRetries: 2,
          code: "responses_websocket_closed",
          discardedOutput: false,
        },
      },
      {
        type: "model.sampling.retry",
        data: {
          samplingAttempt: 2,
          maxRetries: 2,
          code: "responses_websocket_closed",
          discardedOutput: false,
        },
      },
      {
        type: "model.transport.fallback",
        data: {
          fromTransport: "websocket",
          toTransport: "http",
          code: "responses_websocket_closed",
          discardedOutput: false,
        },
      },
      {
        type: "model.sampling.retry",
        data: {
          samplingAttempt: 1,
          maxRetries: 2,
          code: "responses_provider_unavailable",
          discardedOutput: false,
        },
      },
    ],
  );
  assert.equal(
    first.find((event) => event.type === "segment.completed")?.data.output,
    "done",
  );
  assert.equal(
    second.some((event) => event.type === "model.transport.fallback"),
    false,
  );
});

test("marks reasoning-only WebSocket partials discarded before successful HTTP fallback", async (context) => {
  const httpBodies: Readonly<Record<string, unknown>>[] = [];
  const fixture = await websocketFixture(context, async (request, response) => {
    httpBodies.push(
      JSON.parse(await requestBody(request)) as Readonly<
        Record<string, unknown>
      >,
    );
    sendHttpCompleted(response, "resp-http-reasoning-fallback", "done");
  });
  fixture.webSocketServer.on("connection", (socket) => {
    socket.once("message", () => {
      for (const event of [
        {
          type: "response.created",
          sequence_number: 0,
          response: { id: "resp-ws-reasoning-partial" },
        },
        {
          type: "response.reasoning_summary_part.added",
          sequence_number: 1,
          summary_index: 0,
        },
        {
          type: "response.reasoning_summary_text.delta",
          sequence_number: 2,
          summary_index: 0,
          delta: "discarded summary",
        },
        {
          type: "response.reasoning_text.delta",
          sequence_number: 3,
          content_index: 0,
          delta: "provider-private",
        },
      ]) {
        socket.send(JSON.stringify(event));
      }
      socket.close();
    });
  });
  const transport = new ResilientResponsesTransport({
    endpoint: fixture.endpoint,
    model: "provider-model",
    websocketMaxRetries: 0,
  });
  context.after(() => transport.close());
  const events = await collect(
    new CrewONAgentKernel({ transport }).runSegment(
      segmentContract("run-reasoning-fallback", "hello"),
      signal(),
    ),
  );

  assert.deepEqual(
    events
      .filter(
        (event) =>
          event.type === "model.reasoning.summary" ||
          event.type === "model.transport.fallback" ||
          event.type === "segment.completed",
      )
      .map((event) => ({ type: event.type, data: event.data })),
    [
      {
        type: "model.reasoning.summary",
        data: { kind: "partAdded", summaryIndex: 0 },
      },
      {
        type: "model.reasoning.summary",
        data: {
          kind: "delta",
          summaryIndex: 0,
          delta: "discarded summary",
        },
      },
      {
        type: "model.transport.fallback",
        data: {
          fromTransport: "websocket",
          toTransport: "http",
          code: "responses_websocket_closed",
          discardedOutput: true,
        },
      },
      { type: "segment.completed", data: { output: "done" } },
    ],
  );
  assert.deepEqual(
    events
      .filter((event) => event.type === "model.output.delta")
      .map((event) => event.data.delta),
    ["done"],
  );
  assert.deepEqual(httpBodies[0]?.input, [{ role: "user", content: "hello" }]);
});

test("matches the shared Rust fallback and sticky transport decisions", async (context) => {
  let websocketConnections = 0;
  let httpRequests = 0;
  const fixture = await websocketFixture(context, (_request, response) => {
    httpRequests += 1;
    sendHttpCompleted(response, `http-${httpRequests}`, "done");
  });
  fixture.webSocketServer.on("connection", (socket) => {
    websocketConnections += 1;
    socket.once("message", () => socket.close());
  });
  const transport = new ResilientResponsesTransport({
    endpoint: fixture.endpoint,
    model: "provider-model",
    websocketMaxRetries: websocketParity.fallback.streamMaxRetries,
  });
  context.after(() => transport.close());
  const kernel = new CrewONAgentKernel({
    transport,
    streamMaxRetries: websocketParity.fallback.streamMaxRetries,
    retryScheduler: { wait: async () => undefined },
  });

  const first = await collect(
    kernel.runSegment(segmentContract("run-1", "hello"), signal()),
  );
  const websocketAfterFirst = websocketConnections;
  const httpAfterFirst = httpRequests;
  const second = await collect(
    kernel.runSegment(segmentContract("run-2", "second"), signal()),
  );
  const retryAttempts = first
    .filter((event) => event.type === "model.sampling.retry")
    .map((event) => event.data.samplingAttempt);
  const fallback = first.find(
    (event) => event.type === "model.transport.fallback",
  );

  assert.deepEqual(
    {
      streamMaxRetries: websocketParity.fallback.streamMaxRetries,
      firstTurn: {
        websocketAttempts: websocketAfterFirst,
        httpAttempts: httpAfterFirst,
        retryAttempts,
        fallback: fallback?.data,
      },
      secondTurn: {
        websocketAttempts: websocketConnections - websocketAfterFirst,
        httpAttempts: httpRequests - httpAfterFirst,
        fallbackEvents: second.filter(
          (event) => event.type === "model.transport.fallback",
        ).length,
      },
    },
    {
      streamMaxRetries: websocketParity.fallback.streamMaxRetries,
      firstTurn: websocketParity.fallback.firstTurn,
      secondTurn: websocketParity.fallback.secondTurn,
    },
  );
  assert.deepEqual(
    retryAttempts,
    websocketParity.fallback.debugVisibleRetryAttempts,
  );
});

test("switches immediately and stays on HTTP when upgrade returns 426", async (context) => {
  let upgradeRequests = 0;
  let httpRequests = 0;
  const server = createServer((_request, response) => {
    httpRequests += 1;
    sendHttpCompleted(response, `http-${httpRequests}`, "done");
  });
  server.on("upgrade", (_request, socket) => {
    upgradeRequests += 1;
    socket.end(
      "HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    );
  });
  const endpoint = await listen(server);
  context.after(() => closeServer(server));
  const transport = new ResilientResponsesTransport({
    endpoint,
    model: "provider-model",
  });
  context.after(() => transport.close());

  await transport.prewarm(signal());
  const first = await collect(
    transport.stream(manualRequest("hello"), signal()),
  );
  const second = await collect(
    transport.stream(manualRequest("again"), signal()),
  );

  assert.equal(upgradeRequests, 1);
  assert.equal(httpRequests, 2);
  assert.deepEqual(first[0], {
    type: "transport.fallback",
    fromTransport: "websocket",
    toTransport: "http",
    code: "responses_websocket_upgrade_required",
    discardedOutput: false,
  });
  assert.equal(
    second.some((event) => event.type === "transport.fallback"),
    false,
  );
});

test("reconnects on the provider WebSocket connection limit without falling back", async (context) => {
  const fixture = await websocketFixture(context);
  let connections = 0;
  fixture.webSocketServer.on("connection", (socket) => {
    connections += 1;
    socket.once("message", () => {
      if (connections === 1) {
        socket.send(
          JSON.stringify({
            type: "error",
            sequence_number: 0,
            error: { code: "websocket_connection_limit_reached" },
          }),
        );
        return;
      }
      sendCompleted(socket, "resp-success", "done");
    });
  });
  const transport = new ResilientResponsesTransport({
    endpoint: fixture.endpoint,
    model: "provider-model",
  });
  context.after(() => transport.close());
  const events = await collect(
    new CrewONAgentKernel({
      transport,
      streamMaxRetries: 2,
      retryScheduler: { wait: async () => undefined },
    }).runSegment(segmentContract("run-1", "hello"), signal()),
  );

  assert.equal(connections, 2);
  assert.equal(
    events.some((event) => event.type === "model.transport.fallback"),
    false,
  );
  assert.equal(
    events.find((event) => event.type === "model.sampling.retry")?.data.code,
    "responses_provider_websocket_connection_limit_reached",
  );
});

test("fails closed on binary WebSocket frames", async (context) => {
  const fixture = await websocketFixture(context);
  fixture.webSocketServer.on("connection", (socket) => {
    socket.once("message", () => {
      socket.send(
        Buffer.from(JSON.stringify(completedEvents("resp-1", "done")[0])),
      );
    });
  });
  const transport = new WebSocketResponsesTransport({
    endpoint: fixture.endpoint,
    model: "provider-model",
  });
  context.after(() => transport.close());

  await assert.rejects(
    collect(transport.stream(manualRequest("hello"), signal())),
    hasTransportCode("responses_websocket_binary_unsupported"),
  );
});

test("classifies a blocked WebSocket deterministically on abort and idle expiry", async (context) => {
  let requestObserved: (() => void) | undefined;
  const observed = new Promise<void>((resolve) => {
    requestObserved = resolve;
  });
  const fixture = await websocketFixture(context);
  fixture.webSocketServer.on("connection", (socket) => {
    socket.once("message", () => requestObserved?.());
  });
  const controller = new AbortController();
  const canceledTransport = new WebSocketResponsesTransport({
    endpoint: fixture.endpoint,
    model: "provider-model",
  });
  context.after(() => canceledTransport.close());
  const canceled = collect(
    canceledTransport.stream(manualRequest("hello"), controller.signal),
  );
  await observed;
  controller.abort("user_requested");
  await assert.rejects(canceled, hasTransportCode("segment_canceled"));

  let idleRequestObserved: (() => void) | undefined;
  const idleObserved = new Promise<void>((resolve) => {
    idleRequestObserved = resolve;
  });
  fixture.webSocketServer.once("connection", (socket) => {
    socket.once("message", () => idleRequestObserved?.());
  });
  const scheduler = new ManualScheduler();
  const idleTransport = new WebSocketResponsesTransport(
    {
      endpoint: fixture.endpoint,
      model: "provider-model",
      idleTimeoutMs: 10,
    },
    { scheduler },
  );
  context.after(() => idleTransport.close());
  const expired = collect(
    idleTransport.stream(manualRequest("idle"), signal()),
  );
  await idleObserved;
  scheduler.fire();
  await assert.rejects(
    expired,
    hasTransportCode("responses_websocket_idle_timeout"),
  );
});

async function websocketFixture(
  context: TestContext,
  handler?: RequestListener,
): Promise<{
  endpoint: string;
  webSocketServer: WebSocketServer;
}> {
  const server = createServer(handler);
  const webSocketServer = new WebSocketServer({ server });
  const endpoint = await listen(server);
  context.after(async () => {
    for (const client of webSocketServer.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve) => {
      webSocketServer.close(() => resolve());
    });
    await closeServer(server);
  });
  return { endpoint, webSocketServer };
}

function normalizedIncrementalFrame(
  frame: Record<string, unknown> | undefined,
): Readonly<Record<string, unknown>> {
  return {
    previousResponseId: frame?.previous_response_id ?? null,
    input: frame?.input,
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return `http://127.0.0.1:${address.port}/v1/responses`;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function sendCompleted(
  socket: WebSocket,
  responseId: string,
  output: string,
): void {
  for (const event of completedEvents(responseId, output)) {
    socket.send(JSON.stringify(event));
  }
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendHttpCompleted(
  response: import("node:http").ServerResponse,
  responseId: string,
  output: string,
): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of completedEvents(responseId, output)) {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  response.end();
}

function completedEvents(
  responseId: string,
  output: string,
): readonly unknown[] {
  return [
    {
      type: "response.created",
      sequence_number: 0,
      response: { id: responseId },
    },
    {
      type: "response.output_text.delta",
      sequence_number: 1,
      delta: output,
    },
    {
      type: "response.completed",
      sequence_number: 2,
      response: {
        id: responseId,
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: output }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
}

function manualRequest(content: string): ModelRequest {
  return {
    schemaVersion: "crewon.model-request.v0",
    runId: "run-1",
    segmentId: "segment-1",
    agentVersionId: "agent-version-1",
    instructions: null,
    input: {
      strategy: "manual",
      items: [{ type: "message", role: "user", content }],
    },
    tools: [],
    maxOutputBytes: 32 * 1024,
  };
}

function segmentContract(runId: string, content: string): AgentSegmentContract {
  return {
    schemaVersion: "crewon.agent-segment.v0",
    purpose: "agent",
    runId,
    segmentId: `${runId}-segment`,
    attempt: 1,
    agentVersionId: "agent-version-1",
    policySnapshotId: "policy-1",
    collaborationMode: "default",
    allowedTools: null,
    history: [{ type: "message", role: "user", content }],
    continuation: { kind: "manual" },
    budget: { maxOutputBytes: 32 * 1024 },
  };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) {
    values.push(value);
  }
  return values;
}

function hasTransportCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ModelTransportError && error.code === code;
}

class ManualScheduler {
  readonly #callbacks = new Set<() => void>();

  schedule(callback: () => void): () => void {
    this.#callbacks.add(callback);
    return () => this.#callbacks.delete(callback);
  }

  fire(): void {
    for (const callback of [...this.#callbacks]) {
      callback();
    }
  }
}
