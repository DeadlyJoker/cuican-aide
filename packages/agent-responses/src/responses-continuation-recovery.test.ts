import assert from "node:assert/strict";
import test from "node:test";
import {
  CrewONAgentKernel,
  AgentKernelError,
  ModelTransportError,
  type ModelRequest,
} from "@crewon/agent-kernel";
import {
  DirectResponsesTransport,
  type ResponsesFetch,
} from "./direct-responses-transport.ts";
import { PREVIOUS_RESPONSE_REJECTED } from "./responses-continuation-recovery.ts";

const missing = {
  type: "error",
  status: 400,
  error: {
    code: "previous_response_not_found",
    param: "previous_response_id",
    message: "private provider copy",
  },
};

for (const status of [400, 404, 200]) {
  test(`HTTP ${status}: a rejected checkpoint replays full history exactly once and releases timers`, async () => {
    const requests: Record<string, unknown>[] = [];
    const timers = new Set<() => void>();
    const controller = new AbortController();
    const transport = createTransport(async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return requests.length === 1
        ? status === 200
          ? sse([missing])
          : Response.json(missing, { status })
        : sse(completed());
    }, timers);
    const original = request();
    const before = structuredClone(original);
    const events = await collect(transport.stream(original, controller.signal));
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0]?.input, [{ role: "user", content: "next" }]);
    assert.equal(requests[0]?.previous_response_id, "resp-old");
    assert.deepEqual(requests[1], {
      model: "provider-model",
      stream: true,
      store: true,
      instructions: "stable instructions",
      tools: [],
      input: [
        { role: "user", content: "first" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "next" },
      ],
    });
    assert.deepEqual(events[0], {
      type: "transport.fallback",
      fromTransport: "http",
      toTransport: "http",
      code: PREVIOUS_RESPONSE_REJECTED,
      discardedOutput: false,
      inputStrategy: "manual",
    });
    assert.equal(events.at(-1)?.type, "completed");
    assert.deepEqual(original, before);
    assert.equal(timers.size, 0);
  });
}

test("HTTP does not reinterpret generic failures, limits, credentials, or malformed errors as expired state", async () => {
  for (const [status, body] of [
    [404, { error: { code: "not_found" } }],
    [
      400,
      {
        error: {
          code: "invalid_prompt",
          message: "previous_response_not_found",
        },
      },
    ],
    [401, missing],
    [403, missing],
    [429, missing],
    [500, missing],
    [400, { error: { code: "previous_response_not_found", param: "model" } }],
    [400, { ...missing, status: 500 }],
    [400, "previous_response_not_found"],
    [400, { ...missing, padding: "x".repeat(65536) }],
  ] as const) {
    let calls = 0;
    const transport = createTransport(async () => {
      calls += 1;
      return Response.json(body, { status });
    });
    await assert.rejects(
      collect(transport.stream(request(), new AbortController().signal)),
      ModelTransportError,
    );
    assert.equal(
      calls,
      1,
      JSON.stringify({
        status,
        code: typeof body === "object" ? body.error : body,
      }),
    );
  }
});

test("HTTP refuses fallback for missing prefix, manual input, and unknown current-attempt retrieval", async () => {
  for (const mode of ["no-prefix", "manual", "retrieve"] as const) {
    let calls = 0;
    const original = request();
    const altered: ModelRequest =
      mode === "no-prefix"
        ? {
            ...original,
            input: {
              ...original.input,
              strategy: "providerCheckpoint",
              checkpoint: checkpoint(),
              newHistoryStartIndex: 0,
            },
          }
        : mode === "manual"
          ? {
              ...original,
              input: { strategy: "manual", items: original.input.items },
            }
          : { ...original, reconcileCheckpoint: checkpoint() };
    const transport = createTransport(async () => {
      calls += 1;
      return Response.json(missing, { status: 404 });
    });
    await assert.rejects(
      collect(transport.stream(altered, new AbortController().signal)),
      ModelTransportError,
    );
    assert.equal(calls, 1, mode);
  }
});

test("a rejection after response creation or visible output never starts another generation", async () => {
  for (const emitted of [
    [
      {
        type: "response.created",
        sequence_number: 0,
        response: { id: "resp-new" },
      },
    ],
    [
      {
        type: "response.created",
        sequence_number: 0,
        response: { id: "resp-new" },
      },
      {
        type: "response.output_text.delta",
        sequence_number: 1,
        delta: "partial",
      },
    ],
  ]) {
    let calls = 0;
    const transport = createTransport(async () => {
      calls += 1;
      return sse([...emitted, { ...missing, sequence_number: emitted.length }]);
    });
    const events = await collect(
      transport.stream(request(), new AbortController().signal),
    );
    assert.equal(calls, 1);
    assert.equal(
      events.some((event) => event.type === "transport.fallback"),
      false,
    );
    assert.deepEqual(events.at(-1), {
      type: "failed",
      code: "responses_provider_previous_response_not_found",
      retryable: false,
    });
  }
});

test("cancellation while the fallback audit is being persisted prevents replacement I/O", async () => {
  let calls = 0;
  const timers = new Set<() => void>();
  const controller = new AbortController();
  const transport = createTransport(async () => {
    calls += 1;
    return Response.json(missing, { status: 400 });
  }, timers);
  const iterator = transport
    .stream(request(), controller.signal)
    [Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.type, "transport.fallback");
  assert.equal(timers.size, 0);
  controller.abort();
  await assert.rejects(
    iterator.next(),
    (error: unknown) =>
      error instanceof ModelTransportError && error.code === "segment_canceled",
  );
  assert.equal(calls, 1);
});

for (const { succeeds, retriesBeforeRejection } of [
  { succeeds: true, retriesBeforeRejection: 0 },
  { succeeds: false, retriesBeforeRejection: 0 },
  { succeeds: true, retriesBeforeRejection: 1 },
  { succeeds: false, retriesBeforeRejection: 1 },
]) {
  test(`Kernel retains manual input and the retry budget after fallback (${succeeds ? "recovery" : "exhaustion"}, ${retriesBeforeRejection} prior retries)`, async () => {
    const bodies: Record<string, unknown>[] = [];
    const transport = createTransport(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === retriesBeforeRejection + 1)
        return Response.json(missing, { status: 400 });
      return succeeds && bodies.length === retriesBeforeRejection + 3
        ? sse(completed())
        : Response.json({ error: { code: "server_error" } }, { status: 503 });
    });
    const kernel = new CrewONAgentKernel({
      transport,
      streamMaxRetries: 2,
      retryScheduler: { wait: async () => undefined },
    });
    const original = request();
    const events: { type: string }[] = [];
    const run = async () => {
      for await (const event of kernel.runSegment(
        {
          schemaVersion: "crewon.agent-segment.v0",
          purpose: "agent",
          runId: original.runId,
          segmentId: original.segmentId,
          attempt: 1,
          agentVersionId: original.agentVersionId,
          policySnapshotId: "policy",
          collaborationMode: "default",
          allowedTools: null,
          history: original.input.items,
          continuation: {
            kind: "providerCheckpoint",
            checkpoint: checkpoint(),
            newHistoryStartIndex: 2,
          },
          budget: { maxOutputBytes: 32768 },
        },
        new AbortController().signal,
      ))
        events.push(event);
    };
    if (succeeds) await run();
    else
      await assert.rejects(
        run(),
        (error: unknown) =>
          error instanceof AgentKernelError &&
          error.code === "responses_provider_unavailable" &&
          !error.retryable,
      );
    assert.equal(bodies.length, succeeds ? retriesBeforeRejection + 3 : 4);
    assert.equal(
      events.filter((event) => event.type === "model.transport.fallback")
        .length,
      1,
    );
    assert.equal(
      events.filter((event) => event.type === "model.sampling.retry").length,
      succeeds ? retriesBeforeRejection + 1 : 2,
    );
    for (const body of bodies.slice(retriesBeforeRejection + 1)) {
      assert.equal(body.previous_response_id, undefined);
      assert.deepEqual(body.input, bodies[retriesBeforeRejection + 1]?.input);
    }
    if (succeeds) assert.equal(events.at(-1)?.type, "segment.completed");
  });
}

test("the replacement rejection is terminal instead of recursively falling back", async () => {
  let calls = 0;
  const transport = createTransport(async () => {
    calls += 1;
    return sse([missing]);
  });
  const events = await collect(
    transport.stream(request(), new AbortController().signal),
  );
  assert.equal(calls, 2);
  assert.equal(
    events.filter((event) => event.type === "transport.fallback").length,
    1,
  );
  assert.deepEqual(events.at(-1), {
    type: "failed",
    code: PREVIOUS_RESPONSE_REJECTED,
    retryable: false,
  });
});

function createTransport(
  fetch: ResponsesFetch,
  timers = new Set<() => void>(),
) {
  return new DirectResponsesTransport(
    {
      endpoint: "https://provider.example/v1/responses",
      model: "provider-model",
      storeResponses: true,
    },
    {
      fetch,
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
}

function request(): ModelRequest {
  return {
    schemaVersion: "crewon.model-request.v0",
    runId: "run-1",
    segmentId: "segment-1",
    agentVersionId: "agent-version-1",
    instructions: "stable instructions",
    input: {
      strategy: "providerCheckpoint",
      checkpoint: checkpoint(),
      newHistoryStartIndex: 2,
      items: [
        { type: "message", role: "user", content: "first" },
        { type: "message", role: "assistant", content: "answer" },
        { type: "message", role: "user", content: "next" },
      ],
    },
    tools: [],
    maxOutputBytes: 32768,
  };
}

function checkpoint() {
  return {
    schemaVersion: "crewon.provider-checkpoint.v0",
    adapterName: "direct-responses",
    adapterVersion: "1",
    modelId: "provider-model",
    opaquePayload: { responseId: "resp-old" },
  } as const;
}

function completed() {
  return [
    {
      type: "response.created",
      sequence_number: 0,
      response: { id: "resp-new" },
    },
    { type: "response.output_text.delta", sequence_number: 1, delta: "done" },
    {
      type: "response.completed",
      sequence_number: 2,
      response: {
        id: "resp-new",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "done" }],
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 1,
          total_tokens: 11,
          input_tokens_details: { cached_tokens: 0 },
        },
      },
    },
  ];
}

function sse(events: readonly unknown[]) {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}
