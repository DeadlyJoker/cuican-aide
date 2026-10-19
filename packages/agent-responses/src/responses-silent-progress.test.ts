import assert from "node:assert/strict";
import test from "node:test";
import {
  ModelTransportError,
  type ModelRequest,
  type ModelTransportEvent,
} from "@crewon/agent-kernel";
import {
  DirectResponsesTransport,
  type ResponsesTimerScheduler,
} from "./direct-responses-transport.ts";

const request: ModelRequest = {
  schemaVersion: "crewon.model-request.v0",
  runId: "silent-progress-run",
  segmentId: "after-tool",
  agentVersionId: "fixture-agent",
  instructions: null,
  input: {
    strategy: "manual",
    items: [
      { type: "message", role: "user", content: "Continue the plan" },
      {
        type: "tool_call",
        kind: "function",
        callId: "same-call",
        name: "update_plan",
        input: "{}",
      },
      {
        type: "tool_result",
        kind: "function",
        callId: "same-call",
        output: "x".repeat(555),
      },
    ],
  },
  tools: [],
  maxOutputBytes: 4096,
};
class Clock implements ResponsesTimerScheduler {
  now = 0;
  timers = new Map<symbol, { at: number; callback: () => void }>();
  schedule(callback: () => void, delayMs: number) {
    const id = Symbol();
    this.timers.set(id, { at: this.now + delayMs, callback });
    return () => {
      this.timers.delete(id);
    };
  }
  advance(to: number) {
    assert.ok(to >= this.now);
    for (;;) {
      const next = [...this.timers.entries()]
        .filter(([, v]) => v.at <= to)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.now = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.now = to;
  }
}
async function drain() {
  for (let i = 0; i < 48; i++) await Promise.resolve();
}
async function fixture() {
  const clock = new Clock(),
    abort = new AbortController();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let reply!: (response: Response) => void;
  let body: Record<string, unknown> | undefined;
  const transport = new DirectResponsesTransport(
    {
      endpoint: "https://named-fixture.invalid/v1/responses",
      model: "fixture-model",
      idleTimeoutMs: 60000,
    },
    {
      scheduler: clock,
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return new Promise<Response>((resolve) => {
          reply = resolve;
          init?.signal?.addEventListener(
            "abort",
            () => controller?.error(init.signal?.reason),
            { once: true },
          );
        });
      },
    },
  );
  const observations: Parameters<
    NonNullable<
      import("@crewon/agent-kernel").ModelTransportStreamOptions["callSink"]
    >["record"]
  >[0][] = [];
  const events: ModelTransportEvent[] = [];
  const pending = (async () => {
    try {
      for await (const event of transport.stream(request, abort.signal, {
        callSink: {
          purpose: "agent",
          record: async (value) => {
            observations.push(structuredClone(value));
          },
        },
      }))
        events.push(event);
      return null;
    } catch (error) {
      return error;
    }
  })();
  await drain();
  clock.advance(25220);
  reply(
    new Response(
      new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    ),
  );
  await drain();
  const write = async (text: string) => {
    controller.enqueue(new TextEncoder().encode(text));
    await drain();
  };
  return { clock, abort, events, pending, write, body, observations };
}
test("heartbeat-only SSE reproduces long post-tool silence then a 60-second byte-idle failure without losing the tool result", async () => {
  const f = await fixture();
  assert.equal(f.body?.previous_response_id, undefined);
  assert.deepEqual((f.body?.input as unknown[]).at(-1), {
    type: "function_call_output",
    call_id: "same-call",
    output: "x".repeat(555),
  });
  for (const at of [25221, 60000, 93252]) {
    f.clock.advance(at);
    await f.write(": upstream keepalive\n\n");
  }
  assert.deepEqual(f.events, []);
  f.clock.advance(153251);
  await drain();
  assert.deepEqual(f.events, []);
  f.clock.advance(153252);
  const error = await f.pending;
  assert.ok(error instanceof ModelTransportError);
  assert.equal(error.code, "responses_idle_timeout");
  const final = f.observations.at(-1)!;
  assert.deepEqual(final.httpDiagnostics?.stream, {
    chunkCount: 3,
    byteCount: 66,
    frameCount: 3,
    commentFrameCount: 3,
    dataFrameCount: 0,
    unknownEventCount: 0,
    textDeltaCount: 0,
    reasoningDeltaCount: 0,
    toolArgumentDeltaCount: 0,
    completedItemCount: 0,
    terminalEventCount: 0,
    pendingFrameBytes: 0,
    pendingJsonState: "empty",
  });
  assert.equal(final.httpTiming?.firstSemanticMs, undefined);
  assert.equal(final.httpTiming?.lastSemanticMs, undefined);
  assert.equal(f.clock.timers.size, 0);
});
test("recognized text and reasoning deltas are visible on the same open SSE without an item.done or terminal", async () => {
  const f = await fixture();
  await f.write(
    'data: {"type":"response.created","sequence_number":0,"response":{"id":"response-fixture"}}\n\n',
  );
  await f.write(
    'data: {"type":"response.reasoning_summary_text.delta","sequence_number":1,"summary_index":0,"delta":"Planning"}\n\n',
  );
  await f.write(
    'data: {"type":"response.output_text.delta","sequence_number":2,"output_index":0,"delta":"Visible now"}\n\n',
  );
  assert.ok(f.events.some((e) => e.type === "reasoning.delta"));
  assert.ok(
    f.events.some(
      (e) => e.type === "output.delta" && e.delta === "Visible now",
    ),
  );
  assert.ok(
    !f.events.some(
      (e) => e.type === "output.item.completed" || e.type === "completed",
    ),
  );
  f.abort.abort("fixture_done");
  const error = await f.pending;
  assert.ok(error instanceof ModelTransportError);
  assert.equal(error.category, "canceled");
  const final = f.observations.at(-1)!;
  assert.equal(final.httpDiagnostics?.stream?.textDeltaCount, 1);
  assert.equal(final.httpDiagnostics?.stream?.reasoningDeltaCount, 1);
  assert.equal(final.httpDiagnostics?.stream?.completedItemCount, 0);
  assert.equal(
    final.httpDiagnostics?.stream?.lastEventType,
    "response.output_text.delta",
  );
  assert.ok(Number.isSafeInteger(final.httpTiming?.firstSemanticMs));
  assert.ok(
    final.httpTiming!.lastSemanticMs! >= final.httpTiming!.firstSemanticMs!,
  );
  assert.equal(f.clock.timers.size, 0);
});

test("empty deltas and unknown names remain nonsemantic while valid arguments and an unfinished frame are classified without retaining content", async () => {
  const f = await fixture();
  const send = (event: unknown) =>
    f.write(`data: ${JSON.stringify(event)}\n\n`);
  await send({
    type: "response.created",
    sequence_number: 0,
    response: { id: "fixture-created" },
  });
  await send({
    type: "private-event-name-do-not-record",
    sequence_number: 1,
    secret: "private-body-do-not-record",
  });
  await send({
    type: "response.output_text.delta",
    sequence_number: 2,
    output_index: 0,
    delta: "",
  });
  await send({
    type: "response.reasoning_summary_text.delta",
    sequence_number: 3,
    summary_index: 0,
    delta: "",
  });
  await send({
    type: "response.function_call_arguments.delta",
    sequence_number: 4,
    delta: "",
  });
  f.abort.abort("empty_fixture_done");
  await f.pending;
  const first = f.observations.at(-1)!;
  assert.equal(first.httpTiming?.firstSemanticMs, undefined);
  assert.equal(first.httpDiagnostics?.stream?.unknownEventCount, 1);
  assert.equal(first.httpDiagnostics?.stream?.textDeltaCount, 1);
  assert.equal(first.httpDiagnostics?.stream?.reasoningDeltaCount, 1);
  assert.equal(first.httpDiagnostics?.stream?.toolArgumentDeltaCount, 1);
  assert.ok(!JSON.stringify(first).includes("private-event-name"));
  assert.ok(!JSON.stringify(first).includes("private-body"));
  const g = await fixture();
  await g.write(
    'data: {"type":"response.created","sequence_number":0,"response":{"id":"fixture-created"}}\n\n',
  );
  await g.write(
    'data: {"type":"response.function_call_arguments.delta","sequence_number":1,"delta":"{\\"private\\":"}\n\n',
  );
  await g.write("data: {");
  g.abort.abort("partial_fixture_done");
  await g.pending;
  const second = g.observations.at(-1)!;
  assert.equal(second.httpDiagnostics?.stream?.pendingFrameBytes, 7);
  assert.equal(
    second.httpDiagnostics?.stream?.pendingJsonState,
    "not-complete-json",
  );
  assert.equal(second.httpDiagnostics?.stream?.frameCount, 2);
  assert.equal(second.httpDiagnostics?.stream?.toolArgumentDeltaCount, 1);
  assert.equal(
    second.httpDiagnostics?.stream?.lastEventType,
    "response.function_call_arguments.delta",
  );
  assert.ok(Number.isSafeInteger(second.httpTiming?.firstSemanticMs));
  assert.ok(!JSON.stringify(second).includes("private"));
});

test("a completed tool item is diagnosed separately from the still missing protocol terminal", async () => {
  const f = await fixture();
  await f.write(
    'data: {"type":"response.created","sequence_number":0,"response":{"id":"fixture-created"}}\n\n',
  );
  await f.write(
    'data: {"type":"response.output_item.done","sequence_number":1,"item":{"type":"function_call","call_id":"next-call","name":"project_context_read","arguments":"{}"}}\n\n',
  );
  assert.ok(f.events.some((event) => event.type === "output.item.completed"));
  assert.ok(!f.events.some((event) => event.type === "completed"));
  f.clock.advance(85221);
  const error = await f.pending;
  assert.ok(error instanceof ModelTransportError);
  const final = f.observations.at(-1)!;
  assert.equal(final.httpDiagnostics?.stream?.completedItemCount, 1);
  assert.equal(final.httpDiagnostics?.stream?.terminalEventCount, 0);
  assert.equal(
    final.httpDiagnostics?.stream?.lastEventType,
    "response.output_item.done",
  );
  assert.ok(Number.isSafeInteger(final.httpTiming?.firstCompletedItemMs));
  assert.ok(Number.isSafeInteger(final.httpTiming?.lastSemanticMs));
});

test("a buffered complete terminal JSON is classified at cancellation without accepting it as a terminal", async () => {
  const f = await fixture();
  await f.write(
    'data: {"type":"response.created","sequence_number":0,"response":{"id":"fixture-created"}}\n\n',
  );
  await f.write(
    'data: {"type":"response.completed","sequence_number":1,"response":{"id":"fixture-created","status":"completed","output":[]}}',
  );
  assert.ok(!f.events.some((e) => e.type === "completed"));
  f.abort.abort("inspect_pending_only");
  await f.pending;
  const final = f.observations.at(-1)!;
  assert.equal(final.outcome, "canceled");
  assert.equal(
    final.httpDiagnostics?.stream?.pendingJsonState,
    "complete-object",
  );
  assert.equal(
    final.httpDiagnostics?.stream?.pendingEventType,
    "response.completed",
  );
  assert.equal(final.httpDiagnostics?.stream?.terminalEventCount, 0);
});
