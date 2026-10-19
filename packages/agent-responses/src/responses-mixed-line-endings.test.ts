import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { DirectResponsesTransport } from "./direct-responses-transport.ts";
import { parseResponsesSse } from "./responses-sse.ts";
import type { ModelRequest, ModelTransportEvent } from "@crewon/agent-kernel";
const request: ModelRequest = {
  schemaVersion: "crewon.model-request.v0",
  runId: "mixed-run",
  segmentId: "mixed-segment",
  agentVersionId: "fixture",
  instructions: null,
  input: {
    strategy: "manual",
    items: [{ type: "message", role: "user", content: "fixture" }],
  },
  tools: [],
  maxOutputBytes: 4096,
};
const created = {
  type: "response.created",
  sequence_number: 0,
  response: { id: "mixed-response" },
};
const completed = {
  type: "response.completed",
  sequence_number: 1,
  response: { id: "mixed-response", status: "completed", output: [] },
};
for (const ending of ["\n\r\n", "\r\n\r", "\n\r"]) {
  test(
    `real open HTTP terminal accepts mixed end-of-lines ${JSON.stringify(ending)}`,
    { timeout: 3000 },
    async (t) => {
      const server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify(created)}\n\n`);
        response.write(`data: ${JSON.stringify(completed)}${ending}`);
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
        idleTimeoutMs: 100,
      });
      const events: ModelTransportEvent[] = [];
      for await (const event of transport.stream(
        request,
        new AbortController().signal,
      ))
        events.push(event);
      assert.deepEqual(
        events.map((e) => e.type),
        ["completed"],
      );
    },
  );
}
test("a single CRLF across bytes is one line ending, never a blank dispatch", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const reader = parseResponsesSse(body)[Symbol.asyncIterator]();
  let settled = false;
  const pending = reader.next().then((result) => {
    settled = true;
    return result;
  });
  for (const byte of new TextEncoder().encode('data: {"type":"fixture"}\r\n')) {
    controller.enqueue(new Uint8Array([byte]));
    for (let i = 0; i < 4; i++) await Promise.resolve();
  }
  assert.equal(settled, false);
  for (const byte of new TextEncoder().encode("\r\n"))
    controller.enqueue(new Uint8Array([byte]));
  assert.deepEqual((await pending).value, {
    kind: "event",
    value: { type: "fixture" },
  });
  await reader.return?.();
});

for (const ending of [
  "\n\n",
  "\r\r",
  "\r\n\r\n",
  "\n\r\n",
  "\r\n\n",
  "\r\n\r",
  "\r\r\n",
  "\n\r",
]) {
  test(`byte-split mixed stream completes without EOF ${JSON.stringify(ending)}`, async () => {
    const bytes = new TextEncoder().encode(
      `event: response.created\r\ndata: ${JSON.stringify(created)}${ending}event: response.completed\ndata: ${JSON.stringify(completed)}${ending}`,
    );
    let index = 0,
      canceled = false;
    const transport = new DirectResponsesTransport(
      {
        endpoint: "https://fixture.invalid/responses",
        model: "fixture",
        idleTimeoutMs: 100,
      },
      {
        fetch: async () =>
          new Response(
            new ReadableStream<Uint8Array>(
              {
                pull(c) {
                  if (index < bytes.length)
                    c.enqueue(bytes.slice(index, index++ + 1));
                },
                cancel() {
                  canceled = true;
                },
              },
              { highWaterMark: 0 },
            ),
            { headers: { "content-type": "text/event-stream" } },
          ),
      },
    );
    const events: ModelTransportEvent[] = [];
    for await (const event of transport.stream(
      request,
      new AbortController().signal,
    ))
      events.push(event);
    assert.deepEqual(
      events.map((e) => e.type),
      ["completed"],
    );
    assert.equal(canceled, true);
  });
}
test(
  "real HTTP byte writes recognize split mixed terminal while keeping the provider connection open",
  { timeout: 3000 },
  async (t) => {
    let sent = 0;
    const bytes = new TextEncoder().encode(
      `data: ${JSON.stringify(created)}\n\ndata: ${JSON.stringify(completed)}\n\r\n`,
    );
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
      const timer = setInterval(() => {
        if (sent < bytes.length) response.write(bytes.slice(sent, sent++ + 1));
        else clearInterval(timer);
      }, 1);
      response.once("close", () => clearInterval(timer));
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
    const observations: Parameters<
      NonNullable<
        import("@crewon/agent-kernel").ModelTransportStreamOptions["callSink"]
      >["record"]
    >[0][] = [];
    const transport = new DirectResponsesTransport({
      endpoint: `http://127.0.0.1:${address.port}/responses`,
      model: "fixture",
      idleTimeoutMs: 500,
    });
    const events: ModelTransportEvent[] = [];
    for await (const event of transport.stream(
      request,
      new AbortController().signal,
      {
        callSink: {
          purpose: "agent",
          record: async (value) => {
            observations.push(structuredClone(value));
          },
        },
      },
    ))
      events.push(event);
    assert.deepEqual(
      events.map((e) => e.type),
      ["completed"],
    );
    assert.ok(observations.at(-1)!.httpDiagnostics!.stream!.chunkCount > 2);
    assert.equal(
      observations.at(-1)!.httpDiagnostics!.stream!.terminalEventCount,
      1,
    );
  },
);
for (const tail of ['data: {"type":\n\r\n', "data: not-json\r\n\r"]) {
  test(`mixed framing does not accept malformed received terminal tail ${JSON.stringify(tail)}`, async () => {
    const bytes = new TextEncoder().encode(
      `data: ${JSON.stringify(created)}\n\ndata: ${JSON.stringify(completed)}\n\r\n${tail}`,
    );
    const transport = new DirectResponsesTransport(
      { endpoint: "https://fixture.invalid/responses", model: "fixture" },
      {
        fetch: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                c.enqueue(bytes);
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      },
    );
    const events: ModelTransportEvent[] = [];
    await assert.rejects(
      (async () => {
        for await (const event of transport.stream(
          request,
          new AbortController().signal,
        ))
          events.push(event);
      })(),
      { code: "responses_event_json_invalid" },
    );
    assert.deepEqual(events, []);
  });
}
