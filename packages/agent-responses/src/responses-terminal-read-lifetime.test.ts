import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import test, { type TestContext } from "node:test";

import {
  CrewONAgentKernel,
  ModelTransportError,
  type ModelRequest,
} from "@crewon/agent-kernel";

import {
  DirectResponsesTransport,
  type ResponsesTimerScheduler,
} from "./direct-responses-transport.ts";

const encoder = new TextEncoder();
const request: ModelRequest = {
  schemaVersion: "crewon.model-request.v0",
  runId: "terminal-read-run",
  segmentId: "terminal-read-segment",
  agentVersionId: "terminal-read-agent",
  instructions: null,
  input: {
    strategy: "manual",
    items: [{ type: "message", role: "user", content: "hello" }],
  },
  tools: [],
  maxOutputBytes: 4096,
};

const created = {
  type: "response.created",
  sequence_number: 0,
  response: { id: "resp-read" },
};
const delta = {
  type: "response.output_text.delta",
  sequence_number: 1,
  delta: "done",
};
const completed = {
  type: "response.completed",
  sequence_number: 2,
  response: {
    id: "resp-read",
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "done" }],
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  },
};
const failed = {
  type: "response.failed",
  sequence_number: 2,
  response: {
    id: "resp-read",
    status: "failed",
    error: { code: "invalid_prompt" },
  },
};

for (const flushBytes of [undefined, 1024]) {
  test(
    `validated completion closes an open HTTP tail with flushBytes=${flushBytes}`,
    { timeout: 2000 },
    async (context) => {
      let calls = 0;
      let closeResponse!: () => void;
      const closed = new Promise<void>((resolve) => {
        closeResponse = resolve;
      });
      const endpoint = await openServer(context, (response) => {
        calls += 1;
        response.once("close", closeResponse);
        response.write(frames([created, delta, completed]));
        // The server deliberately leaves its HTTP body open after the trusted terminal.
      });
      const transport = new DirectResponsesTransport({
        endpoint,
        model: "read-lifetime-model",
        idleTimeoutMs: 200,
        ...(flushBytes === undefined
          ? {}
          : { outputDeltaFlushBytes: flushBytes }),
      });
      const events = await collect(
        transport.stream(request, new AbortController().signal),
      );
      assert.deepEqual(
        events.map((event) => event.type),
        ["output.delta", "usage", "completed"],
      );
      assert.equal(calls, 1);
      await closed;
    },
  );
}

test(
  "the real HTTP Kernel path completes once instead of retrying a validated terminal",
  { timeout: 2000 },
  async (context) => {
    let calls = 0;
    const endpoint = await openServer(context, (response) => {
      calls += 1;
      response.write(frames([created, delta, completed]));
    });
    const kernel = new CrewONAgentKernel({
      transport: new DirectResponsesTransport({
        endpoint,
        model: "read-lifetime-model",
        idleTimeoutMs: 100,
      }),
      streamMaxRetries: 2,
      retryScheduler: { wait: async () => undefined },
    });
    const events = await collect(
      kernel.runSegment(
        {
          schemaVersion: "crewon.agent-segment.v0",
          purpose: "agent",
          runId: request.runId,
          segmentId: request.segmentId,
          attempt: 1,
          agentVersionId: request.agentVersionId,
          policySnapshotId: "terminal-read-policy",
          collaborationMode: "default",
          allowedTools: null,
          history: request.input.items,
          continuation: { kind: "manual" },
          budget: { maxOutputBytes: 4096 },
        },
        new AbortController().signal,
      ),
    );
    assert.equal(events.at(-1)?.type, "segment.completed");
    assert.deepEqual(events.at(-1)?.data, { output: "done" });
    assert.equal(
      events.filter((event) => event.type === "model.sampling.retry").length,
      0,
    );
    assert.equal(calls, 1);
  },
);

test(
  "a trusted failed terminal retains its provider failure while the HTTP tail remains open",
  { timeout: 2000 },
  async (context) => {
    const endpoint = await openServer(context, (response) => {
      response.write(frames([created, delta, failed]));
    });
    const transport = new DirectResponsesTransport({
      endpoint,
      model: "read-lifetime-model",
      idleTimeoutMs: 100,
    });
    const events = await collect(
      transport.stream(request, new AbortController().signal),
    );
    assert.deepEqual(events.at(-1), {
      type: "failed",
      code: "responses_provider_invalid_prompt",
      retryable: false,
    });
  },
);

for (const terminal of [completed, failed]) {
  test(`${terminal.type} rejects a complete post-terminal event already received in the same chunk`, async () => {
    const body = frames([
      created,
      delta,
      terminal,
      { type: "response.output_text.delta", sequence_number: 3, delta: "late" },
    ]);
    const { transport, lifetime } = openBodyTransport(body);
    const observed: string[] = [];
    await assert.rejects(
      (async () => {
        for await (const event of transport.stream(
          request,
          new AbortController().signal,
        ))
          observed.push(event.type);
      })(),
      hasCode("responses_event_after_terminal"),
    );
    // Nothing terminal or billable is released before the received tail passes validation.
    assert.deepEqual(observed, ["output.delta"]);
    assert.equal(lifetime.signal?.aborted, true);
    assert.equal(lifetime.body?.locked, false);
  });
}

for (const [tail, code] of [
  ["data: not-json\n\n", "responses_event_json_invalid"],
  ['data: {"type":', "responses_event_json_invalid"],
  [
    'data: {"type":"response.completed","sequence_number":3}',
    "responses_event_after_terminal",
  ],
] as const) {
  test(`a terminal does not hide an already received invalid tail (${tail})`, async () => {
    const { transport } = openBodyTransport(
      frames([created, delta, completed]) + tail,
    );
    await assert.rejects(
      collect(transport.stream(request, new AbortController().signal)),
      hasCode(code),
    );
  });
}

for (const tail of [
  "",
  ": heartbeat\n\n",
  "data: [DONE]\n\n",
  "data: [DO",
  ": heartbeat\n\ndata: [D",
]) {
  test(`optional terminal trailer never requires a future read (${tail})`, async () => {
    const { transport, lifetime } = openBodyTransport(
      frames([created, delta, completed]) + tail,
    );
    const events = await collect(
      transport.stream(request, new AbortController().signal),
    );
    assert.equal(events.at(-1)?.type, "completed");
    assert.equal(lifetime.signal?.aborted, true);
    assert.equal(lifetime.body?.locked, false);
    assert.equal(lifetime.scheduler.active, 0);
  });
}

test(
  "terminal cleanup aborts a tee's unread tail without hanging or unhandled rejection",
  { timeout: 2000 },
  async () => {
    const scheduler = new OwnedScheduler();
    let inspection: Promise<void> = Promise.resolve();
    let inspectionReadEnded = false;
    let transportBody: ReadableStream<Uint8Array> | null = null;
    let ownedSignal: AbortSignal | null = null;
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => {
      unhandled.push(error);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const transport = new DirectResponsesTransport(
        {
          endpoint: "https://read-lifetime.example/v1/responses",
          model: "read-lifetime-model",
        },
        {
          scheduler,
          fetch: async (_input, init) => {
            ownedSignal = init!.signal!;
            const source = new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode(frames([created, delta, completed])),
                );
                ownedSignal!.addEventListener(
                  "abort",
                  () => controller.error(new Error("owned read closed")),
                  { once: true },
                );
              },
            });
            const [consumer, observer] = source.tee();
            transportBody = consumer;
            inspection = (async () => {
              const reader = observer.getReader();
              try {
                while (!(await reader.read()).done) {}
              } catch {
                inspectionReadEnded = true;
              } finally {
                reader.releaseLock();
              }
            })();
            return new Response(consumer, {
              headers: { "content-type": "text/event-stream" },
            });
          },
        },
      );
      const events = await collect(
        transport.stream(request, new AbortController().signal),
      );
      await inspection;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(events.at(-1)?.type, "completed");
      assert.equal(inspectionReadEnded, true);
      assert.equal((ownedSignal as AbortSignal | null)?.aborted, true);
      assert.equal(
        (transportBody as ReadableStream<Uint8Array> | null)?.locked,
        false,
      );
      assert.equal(scheduler.active, 0);
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  },
);

test(
  "a trusted terminal does not await an unresponsive body cancellation",
  { timeout: 1000 },
  async () => {
    const scheduler = new OwnedScheduler();
    let ownedSignal: AbortSignal | null = null;
    let cancellationStarted = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(frames([created, delta, completed])));
      },
      cancel() {
        cancellationStarted = true;
        return new Promise<void>(() => {});
      },
    });
    const transport = new DirectResponsesTransport(
      {
        endpoint: "https://read-lifetime.example/v1/responses",
        model: "read-lifetime-model",
      },
      {
        scheduler,
        fetch: async (_input, init) => {
          ownedSignal = init!.signal!;
          // Deliberately ignores abort, as a custom adapter or unrelated tee branch can do.
          return new Response(body, {
            headers: { "content-type": "text/event-stream" },
          });
        },
      },
    );
    const events = await collect(
      transport.stream(request, new AbortController().signal),
    );
    assert.equal(events.at(-1)?.type, "completed");
    assert.equal(cancellationStarted, true);
    assert.equal(body.locked, false);
    assert.equal((ownedSignal as AbortSignal | null)?.aborted, true);
    assert.equal(scheduler.active, 0);
  },
);

test("a rejected body cancellation does not escape cleanup as an unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => {
    unhandled.push(error);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(frames([created, delta, completed])));
      },
      cancel() {
        return Promise.reject(new Error("upstream cancellation failed"));
      },
    });
    const transport = new DirectResponsesTransport(
      {
        endpoint: "https://read-lifetime.example/v1/responses",
        model: "read-lifetime-model",
      },
      {
        fetch: async () =>
          new Response(body, {
            headers: { "content-type": "text/event-stream" },
          }),
      },
    );
    const events = await collect(
      transport.stream(request, new AbortController().signal),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(events.at(-1)?.type, "completed");
    assert.equal(body.locked, false);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test(
  "consumer return aborts an unfinished timed stream instead of treating reader cancellation as EOF",
  { timeout: 1000 },
  async () => {
    const scheduler = new OwnedScheduler();
    let ownedSignal: AbortSignal | null = null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(frames([created, delta])));
      },
    });
    const transport = new DirectResponsesTransport(
      {
        endpoint: "https://read-lifetime.example/v1/responses",
        model: "read-lifetime-model",
        outputDeltaFlushBytes: 1024,
      },
      {
        scheduler,
        fetch: async (_input, init) => {
          ownedSignal = init!.signal!;
          return new Response(body, {
            headers: { "content-type": "text/event-stream" },
          });
        },
      },
    );
    const stream = transport
      .stream(request, new AbortController().signal)
      [Symbol.asyncIterator]();
    assert.equal((await stream.next()).value?.type, "output.delta");
    await stream.return?.();
    assert.equal((ownedSignal as AbortSignal | null)?.aborted, true);
    assert.equal(body.locked, false);
    assert.equal(scheduler.active, 0);
  },
);

test("an already ended HTTP body clears idle ownership without aborting its reusable connection", async () => {
  const scheduler = new OwnedScheduler();
  let ownedSignal: AbortSignal | null = null;
  const transport = new DirectResponsesTransport(
    {
      endpoint: "https://read-lifetime.example/v1/responses",
      model: "read-lifetime-model",
    },
    {
      scheduler,
      fetch: async (_input, init) => {
        ownedSignal = init!.signal!;
        return new Response(frames([created, delta, completed]), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    },
  );
  const events = await collect(
    transport.stream(request, new AbortController().signal),
  );
  assert.equal(events.at(-1)?.type, "completed");
  assert.equal((ownedSignal as AbortSignal | null)?.aborted, false);
  assert.equal(scheduler.active, 0);
});

test(
  "a complete assistant item without a protocol terminal still fails idle",
  { timeout: 2000 },
  async (context) => {
    const endpoint = await openServer(context, (response) => {
      response.write(
        frames([
          created,
          delta,
          {
            type: "response.output_item.done",
            sequence_number: 2,
            item: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "done" }],
            },
          },
        ]),
      );
    });
    const transport = new DirectResponsesTransport({
      endpoint,
      model: "read-lifetime-model",
      idleTimeoutMs: 40,
    });
    await assert.rejects(
      collect(transport.stream(request, new AbortController().signal)),
      (error) =>
        error instanceof ModelTransportError &&
        error.code === "responses_idle_timeout" &&
        error.retryable,
    );
  },
);

test("invalid terminal identity is rejected instead of closing successfully", async () => {
  const { transport } = openBodyTransport(
    frames([
      created,
      delta,
      {
        ...completed,
        response: { ...completed.response, id: "resp-wrong" },
      },
    ]),
  );
  await assert.rejects(
    collect(transport.stream(request, new AbortController().signal)),
    hasCode("responses_response_id_mismatch"),
  );
});

test(
  "caller cancellation closes the active body and remains cancellation",
  { timeout: 2000 },
  async (context) => {
    const endpoint = await openServer(context, (response) => {
      response.write(frames([created, delta]));
    });
    const controller = new AbortController();
    const transport = new DirectResponsesTransport({
      endpoint,
      model: "read-lifetime-model",
    });
    const events = transport
      .stream(request, controller.signal)
      [Symbol.asyncIterator]();
    assert.equal((await events.next()).value?.type, "output.delta");
    controller.abort("user canceled");
    await assert.rejects(
      events.next(),
      (error) =>
        error instanceof ModelTransportError &&
        error.code === "segment_canceled" &&
        !error.retryable,
    );
  },
);

function frames(events: readonly unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function openBodyTransport(bytes: string) {
  const lifetime: {
    signal: AbortSignal | null;
    body: ReadableStream<Uint8Array> | null;
    scheduler: OwnedScheduler;
  } = {
    signal: null,
    body: null,
    scheduler: new OwnedScheduler(),
  };
  const transport = new DirectResponsesTransport(
    {
      endpoint: "https://read-lifetime.example/v1/responses",
      model: "read-lifetime-model",
    },
    {
      scheduler: lifetime.scheduler,
      fetch: async (_input, init) => {
        lifetime.signal = init!.signal!;
        lifetime.body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(bytes));
            lifetime.signal!.addEventListener(
              "abort",
              () => controller.error(new Error("owned read closed")),
              { once: true },
            );
          },
        });
        return new Response(lifetime.body, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    },
  );
  return { transport, lifetime };
}

async function openServer(
  context: TestContext,
  write: (response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    write(response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  context.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}/v1/responses`;
}

class OwnedScheduler implements ResponsesTimerScheduler {
  readonly #active = new Set<() => void>();
  get active() {
    return this.#active.size;
  }
  schedule(callback: () => void): () => void {
    this.#active.add(callback);
    return () => {
      this.#active.delete(callback);
    };
  }
}

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof ModelTransportError &&
    error.code === code &&
    !error.retryable;
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of source) events.push(event);
  return events;
}
