import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import type {
  ModelRequest,
  ModelTransportEvent,
  ModelTransportStreamOptions,
} from "@crewon/agent-kernel";
import {
  DirectResponsesTransport,
  type ResponsesFetch,
} from "./direct-responses-transport.ts";

type Observation = Parameters<
  NonNullable<ModelTransportStreamOptions["callSink"]>["record"]
>[0];
const request: ModelRequest = {
  schemaVersion: "crewon.model-request.v0",
  runId: "run",
  segmentId: "segment",
  agentVersionId: "agent",
  instructions: null,
  input: {
    strategy: "manual",
    items: [{ type: "message", role: "user", content: "private-prompt" }],
  },
  tools: [],
  maxOutputBytes: 8192,
};
const created = {
  type: "response.created",
  sequence_number: 0,
  response: { id: "resp-1" },
};
const delta = {
  type: "response.output_text.delta",
  sequence_number: 1,
  delta: "answer",
};
const response = {
  id: "resp-1",
  status: "completed",
  output: [
    {
      id: "message-1",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "answer" }],
    },
  ],
};
const completed = { type: "response.completed", sequence_number: 2, response };
const frame = (...events: readonly unknown[]) =>
  new TextEncoder().encode(
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
  );
const headers = {
  "content-type": "text/event-stream",
  "server": "cloudflare",
  "cf-ray": "ray-SJC",
  "x-oneapi-request-id": "request-1",
  "set-cookie": "private-cookie",
};
const collect = async (events: AsyncIterable<ModelTransportEvent>) => {
  const result = [];
  for await (const event of events) result.push(event);
  return result;
};
function ledger() {
  const writes: Observation[] = [];
  const options: ModelTransportStreamOptions = {
    callSink: {
      purpose: "agent",
      record: async (value) => {
        writes.push(structuredClone(value));
      },
    },
  };
  return { writes, options, final: () => writes.at(-1)! };
}
function transport(fetch: ResponsesFetch) {
  return new DirectResponsesTransport(
    {
      endpoint: "https://provider.test/responses",
      apiKey: "private-api-key",
      model: "model",
    },
    { fetch },
  );
}
function liveBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let canceled = 0;
  const body = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
    },
    cancel: () => {
      canceled += 1;
    },
  });
  return { body, controller: () => controller, canceled: () => canceled };
}

test("actual HTTP 524 preserves status and allowlisted correlation headers without response body or credentials", async (t) => {
  const server = createServer((_request, res) =>
    res
      .writeHead(524, { ...headers, "content-type": "text/html" })
      .end("private-upstream-error-body"),
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
  const l = ledger();
  const adapter = new DirectResponsesTransport({
    endpoint: `http://127.0.0.1:${address.port}/responses`,
    apiKey: "private-api-key",
    model: "model",
  });
  await assert.rejects(
    collect(adapter.stream(request, new AbortController().signal, l.options)),
    { code: "responses_provider_unavailable" },
  );
  assert.deepEqual(l.final().httpDiagnostics, {
    response: {
      status: 524,
      contentType: "text/html",
      server: "cloudflare",
      cfRay: "ray-SJC",
      oneApiRequestId: "request-1",
    },
    termination: {
      reason: "httpError",
      code: "responses_provider_unavailable",
    },
  });
  assert.equal(l.writes.length, 2);
  assert.ok(
    l.final().httpTiming!.headersMs! <= l.final().httpTiming!.finishedMs!,
  );
  assert.equal(
    /private-api-key|private-cookie|private-upstream-error-body|private-prompt/u.test(
      JSON.stringify(l.writes),
    ),
    false,
  );
});

for (const status of [500, 502, 503])
  test(`HTTP ${status} remains distinct without changing provider error mapping`, async () => {
    const l = ledger();
    await assert.rejects(
      collect(
        transport(
          async () => new Response("private-body", { status, headers }),
        ).stream(request, new AbortController().signal, l.options),
      ),
      { code: "responses_provider_unavailable" },
    );
    assert.equal(l.final().httpDiagnostics!.response!.status, status);
    assert.equal(l.final().httpDiagnostics!.termination!.reason, "httpError");
  });

test("200 HTML is diagnosed before content-type rejection", async () => {
  const l = ledger();
  await assert.rejects(
    collect(
      transport(
        async () =>
          new Response("private-html", {
            headers: { ...headers, "content-type": "text/html" },
          }),
      ).stream(request, new AbortController().signal, l.options),
    ),
    { code: "responses_content_type_invalid" },
  );
  assert.equal(l.final().httpDiagnostics!.response!.status, 200);
  assert.deepEqual(l.final().httpDiagnostics!.termination, {
    reason: "protocolError",
    code: "responses_content_type_invalid",
  });
});

test(
  "delta and validated terminal arrive while HTTP remains open without extra accounting writes",
  { timeout: 3000 },
  async (t) => {
    const l = ledger(),
      live = liveBody(),
      cancel = new AbortController();
    t.after(() => cancel.abort());
    const stream = transport(async () => new Response(live.body, { headers }))
      .stream(request, cancel.signal, l.options)
      [Symbol.asyncIterator]();
    const first = stream.next();
    live.controller().enqueue(frame(created, delta));
    assert.deepEqual((await first).value, {
      type: "output.delta",
      delta: "answer",
    });
    assert.equal(l.writes.length, 1);
    assert.equal(l.final().outcome, "unknown");
    live.controller().enqueue(frame(completed));
    assert.equal((await stream.next()).value?.type, "completed");
    assert.equal(live.canceled(), 1);
    assert.equal(l.writes.length, 1);
    assert.equal((await stream.next()).done, true);
    assert.equal(l.writes.length, 2);
    assert.equal(l.final().outcome, "completed");
    assert.deepEqual(l.final().httpDiagnostics!.read, {
      end: "releasedBeforeEof",
    });
    assert.deepEqual(l.final().httpDiagnostics!.termination, {
      reason: "protocolTerminal",
    });
    const timing = l.final().httpTiming!;
    assert.ok(timing.headersMs! <= timing.firstByteMs!);
    assert.ok(timing.readClosedMs! <= timing.terminalMs!);
    assert.ok(timing.terminalMs! <= timing.finishedMs!);
  },
);

test("EOF without protocol terminal remains incomplete and records actual read end", async () => {
  const l = ledger();
  await assert.rejects(
    collect(
      transport(
        async () => new Response(frame(created, delta), { headers }),
      ).stream(request, new AbortController().signal, l.options),
    ),
    { code: "responses_stream_incomplete" },
  );
  assert.equal(l.final().outcome, "failed");
  assert.deepEqual(l.final().httpDiagnostics!.read, { end: "eof" });
  assert.deepEqual(l.final().httpDiagnostics!.termination, {
    reason: "transportError",
    code: "responses_stream_incomplete",
  });
  assert.equal(l.final().httpTiming!.terminalMs, undefined);
});

test("fetch failure retains only finite network cause without fabricating HTTP headers", async () => {
  const l = ledger();
  const error = new TypeError("private-api-key in URL", {
    cause: Object.assign(new Error("private-body"), { code: "ECONNRESET" }),
  });
  await assert.rejects(
    collect(
      transport(async () => {
        throw error;
      }).stream(request, new AbortController().signal, l.options),
    ),
    { code: "responses_transport_unavailable" },
  );
  assert.deepEqual(l.final().httpDiagnostics, {
    termination: {
      reason: "transportError",
      code: "responses_transport_unavailable",
      networkCode: "ECONNRESET",
    },
  });
  assert.equal(l.final().httpTiming!.headersMs, undefined);
  assert.equal(
    /private-api-key|private-body/u.test(JSON.stringify(l.writes)),
    false,
  );
});

test("reader failure preserves exact safe network code and released-before-EOF evidence", async () => {
  const l = ledger(),
    live = liveBody();
  const stream = transport(async () => new Response(live.body, { headers }))
    .stream(request, new AbortController().signal, l.options)
    [Symbol.asyncIterator]();
  const first = stream.next();
  live.controller().enqueue(frame(created, delta));
  await first;
  live.controller().error(
    new Error("private-reader-message", {
      cause: {
        code: "UND_ERR_SOCKET",
        socket: { address: "private-address" },
      },
    }),
  );
  await assert.rejects(stream.next(), { code: "responses_stream_read_failed" });
  assert.deepEqual(l.final().httpDiagnostics!.termination, {
    reason: "transportError",
    code: "responses_stream_read_failed",
    networkCode: "UND_ERR_SOCKET",
  });
  assert.deepEqual(l.final().httpDiagnostics!.read, {
    end: "releasedBeforeEof",
  });
  assert.equal(
    /private-reader-message|private-address/u.test(JSON.stringify(l.writes)),
    false,
  );
});

test("hostile exception diagnostics cannot replace the original fetch error classification", async () => {
  const l = ledger();
  const revoked = Proxy.revocable([], {});
  revoked.revoke();
  const error = new Error("private-secret", {
    cause: { errors: revoked.proxy },
  });
  await assert.rejects(
    collect(
      transport(async () => {
        throw error;
      }).stream(request, new AbortController().signal, l.options),
    ),
    { code: "responses_transport_unavailable" },
  );
  assert.deepEqual(l.final().httpDiagnostics, {
    termination: {
      reason: "transportError",
      code: "responses_transport_unavailable",
    },
  });
});

test("provider failure terminal is distinct from an HTTP failure", async () => {
  const l = ledger();
  const events = await collect(
    transport(
      async () =>
        new Response(
          frame(created, {
            type: "response.failed",
            sequence_number: 1,
            response: {
              id: "resp-1",
              status: "failed",
              error: {
                code: "server_is_overloaded",
                message: "private-error-body",
              },
            },
          }),
          { headers },
        ),
    ).stream(request, new AbortController().signal, l.options),
  );
  assert.equal(events.at(-1)?.type, "failed");
  assert.equal(l.final().outcome, "failed");
  assert.deepEqual(l.final().httpDiagnostics!.termination, {
    reason: "protocolTerminal",
    code: "responses_provider_server_is_overloaded",
  });
  assert.equal(l.final().httpDiagnostics!.response!.status, 200);
});

for (const mode of [
  "idle-before-headers",
  "idle-after-delta",
  "canceled",
  "consumer-return",
] as const)
  test(`${mode} records its cause without persisting abort reason`, async () => {
    const l = ledger(),
      live = liveBody(),
      cancel = new AbortController();
    const scheduled = new Set<() => void>();
    let enterFetch!: () => void;
    const entered = new Promise<void>((resolve) => {
      enterFetch = resolve;
    });
    const adapter = new DirectResponsesTransport(
      { endpoint: "https://provider.test/responses", model: "model" },
      {
        scheduler: {
          schedule: (callback) => {
            scheduled.add(callback);
            return () => scheduled.delete(callback);
          },
        },
        fetch: async (_input, init) => {
          assert.ok(init?.signal);
          if (mode === "idle-before-headers")
            return new Promise<Response>((_resolve, reject) => {
              init.signal!.addEventListener(
                "abort",
                () => reject(init.signal!.reason),
                { once: true },
              );
              enterFetch();
            });
          init.signal.addEventListener(
            "abort",
            () => live.controller().error(init.signal!.reason),
            { once: true },
          );
          enterFetch();
          return new Response(live.body, { headers });
        },
      },
    );
    const stream = adapter
      .stream(request, cancel.signal, l.options)
      [Symbol.asyncIterator]();
    const first = stream.next();
    await entered;
    if (mode === "idle-before-headers") {
      for (const callback of [...scheduled]) callback();
      await assert.rejects(first, { code: "responses_idle_timeout" });
    } else {
      live.controller().enqueue(frame(created, delta));
      await first;
      if (mode === "consumer-return") await stream.return?.();
      else {
        if (mode === "canceled") cancel.abort("private-user-abort-reason");
        else for (const callback of [...scheduled]) callback();
        await assert.rejects(stream.next(), {
          code:
            mode === "canceled" ? "segment_canceled" : "responses_idle_timeout",
        });
      }
    }
    const reason = mode.startsWith("idle")
      ? "idleTimeout"
      : mode === "canceled"
        ? "canceled"
        : "consumerInterrupted";
    assert.equal(l.final().httpDiagnostics!.termination!.reason, reason);
    assert.ok(Number.isSafeInteger(l.final().httpTiming!.finishedMs));
    assert.equal(
      l.final().httpDiagnostics!.response === undefined,
      mode === "idle-before-headers",
    );
    assert.equal(
      JSON.stringify(l.writes).includes("private-user-abort-reason"),
      false,
    );
    assert.equal(scheduled.size, 0);
  });

test("retrieve captures response correlation, HTTP timing and actual EOF without altering its checkpoint", async () => {
  const l = ledger();
  const checkpoint = {
    schemaVersion: "crewon.provider-checkpoint.v0" as const,
    adapterName: "direct-responses",
    adapterVersion: "1",
    modelId: "model",
    opaquePayload: { responseId: "resp-1" },
  };
  const adapter = new DirectResponsesTransport(
    {
      endpoint: "https://provider.test/responses",
      model: "model",
      storeResponses: true,
    },
    {
      fetch: async (_input, init) => {
        assert.equal(init?.method, "GET");
        return Response.json(response, {
          headers: { ...headers, "content-type": "application/json" },
        });
      },
    },
  );
  const events = await collect(
    adapter.stream(
      { ...request, reconcileCheckpoint: checkpoint },
      new AbortController().signal,
      l.options,
    ),
  );
  assert.equal(events.at(-1)?.type, "completed");
  assert.equal(l.final().operation, "retrieve");
  assert.equal(l.final().outcome, "completed");
  assert.equal(l.final().providerResponseId, "resp-1");
  assert.deepEqual(l.final().httpDiagnostics!.read, { end: "eof" });
  assert.equal(
    l.final().httpDiagnostics!.response!.contentType,
    "application/json",
  );
  assert.ok(
    l.final().httpTiming!.dispatchedMs! <= l.final().httpTiming!.headersMs!,
  );
  assert.ok(
    l.final().httpTiming!.readClosedMs! <= l.final().httpTiming!.finishedMs!,
  );
});
