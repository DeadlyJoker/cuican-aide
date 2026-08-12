import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
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
import { parseResponsesSse } from "./responses-sse.ts";

test("streams through a real self-hosted Responses-compatible HTTP server without credentials", async (context) => {
  let captured:
    | Readonly<{ authorization: string | undefined; body: unknown }>
    | undefined;
  const server = createServer(async (request, response) => {
    captured = {
      authorization: request.headers.authorization,
      body: JSON.parse(await requestBody(request)),
    };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of officialStreamChunks()) {
      response.write(chunk);
    }
    response.end();
  });
  const endpoint = await listen(context, server);
  const transport = new DirectResponsesTransport({
    endpoint,
    model: "self-hosted-model",
  });

  assert.deepEqual(await collect(transport.stream(manualRequest(), signal())), [
    { type: "output.delta", delta: "do" },
    { type: "output.delta", delta: "ne" },
    {
      type: "usage",
      inputTokens: 4,
      cachedInputTokens: 2,
      outputTokens: 1,
      totalTokens: 5,
    },
    { type: "completed", checkpoint: null },
  ]);
  assert.deepEqual(captured, {
    authorization: undefined,
    body: {
      model: "self-hosted-model",
      stream: true,
      store: false,
      input: [{ role: "user", content: "hello" }],
      tools: [],
    },
  });
});

test("ignores shared AR-041 unknown events and completes the HTTP stream", async () => {
  const reference = JSON.parse(
    readFileSync(
      new URL(
        "../../test-contracts/fixtures/responses-unknown-event.reference.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Readonly<{
    events: readonly Readonly<Record<string, unknown>>[];
    expected: Readonly<{
      stableEvents: readonly string[];
      output: string;
      usage: Readonly<Record<string, unknown>>;
    }>;
  }>;
  const transport = new DirectResponsesTransport(
    {
      endpoint: "https://provider.example/v1/responses",
      model: "provider-model",
    },
    { fetch: async () => responseStream(reference.events) },
  );
  const events = await collect(transport.stream(manualRequest(), signal()));
  const usage = events.find((event) => event.type === "usage");
  assert.deepEqual(
    {
      stableEvents: events.map((event) => event.type),
      output: events
        .filter((event) => event.type === "output.delta")
        .map((event) => event.delta)
        .join(""),
      usage:
        usage?.type === "usage"
          ? {
              inputTokens: usage.inputTokens,
              cachedInputTokens: usage.cachedInputTokens,
              outputTokens: usage.outputTokens,
              totalTokens: usage.totalTokens,
            }
          : null,
    },
    {
      stableEvents: reference.expected.stableEvents,
      output: reference.expected.output,
      usage: reference.expected.usage,
    },
  );
});

test("matches the shared Rust Responses Lite request profile", async () => {
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
  let capturedBody: Record<string, unknown> | undefined;
  const transport = new DirectResponsesTransport(
    {
      endpoint: "https://provider.example/v1/responses",
      model: "provider-model",
      requestProfile: reference.requestProfile,
    },
    {
      fetch: async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<
          string,
          unknown
        >;
        return responseStream(officialEvents());
      },
    },
  );

  await collect(transport.stream(manualRequest(), signal()));

  assert.equal(transport.adapterVersion, "1+responses-lite");
  assert.deepEqual(
    {
      reasoningContext: (
        capturedBody?.reasoning as Record<string, unknown> | undefined
      )?.context,
      parallelToolCalls: capturedBody?.parallel_tool_calls,
    },
    reference.expected,
  );
});

test("keeps OpenAI-specific request profile fields off standard endpoints", async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const transport = new DirectResponsesTransport(
    {
      endpoint: "https://self-hosted.example/v1/responses",
      model: "self-hosted-model",
    },
    {
      fetch: async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<
          string,
          unknown
        >;
        return responseStream(officialEvents());
      },
    },
  );

  await collect(transport.stream(manualRequest(), signal()));

  assert.equal(Object.hasOwn(capturedBody ?? {}, "reasoning"), false);
  assert.equal(Object.hasOwn(capturedBody ?? {}, "parallel_tool_calls"), false);
  assert.throws(
    () =>
      new DirectResponsesTransport({
        endpoint: "https://provider.example/v1/responses",
        model: "provider-model",
        requestProfile: "unsupported" as "standard",
      }),
    hasTransportError("protocol", "responses_request_profile_invalid", false),
  );
});

test("keeps manual replay and previous_response_id continuation mutually exclusive", async () => {
  let capturedHeaders: Headers | undefined;
  let capturedBody: unknown;
  const transport = new DirectResponsesTransport(
    {
      endpoint: "https://provider.example/v1/responses",
      apiKey: "secret-key",
      model: "provider-model",
      storeResponses: true,
    },
    {
      fetch: async (_input, init) => {
        capturedHeaders = new Headers(init?.headers);
        capturedBody = JSON.parse(String(init?.body));
        return responseStream(officialEvents());
      },
    },
  );

  const events = await collect(
    transport.stream(
      {
        ...manualRequest(),
        input: {
          strategy: "providerCheckpoint",
          checkpoint: directCheckpoint("resp-previous"),
          newHistoryStartIndex: 0,
          items: [
            {
              type: "message",
              role: "user",
              content: "only the new turn",
            },
          ],
        },
      },
      signal(),
    ),
  );

  assert.equal(capturedHeaders?.get("authorization"), "Bearer secret-key");
  assert.deepEqual(events.at(-1), {
    type: "completed",
    checkpoint: directCheckpoint("resp-1"),
  });
  assert.deepEqual(capturedBody, {
    model: "provider-model",
    stream: true,
    store: true,
    input: [{ role: "user", content: "only the new turn" }],
    tools: [],
    previous_response_id: "resp-previous",
  });
});

test("rejects previous_response_id when provider storage is disabled", async () => {
  let fetchCalled = false;
  const transport = new DirectResponsesTransport(
    {
      endpoint: "https://provider.example/v1/responses",
      model: "provider-model",
    },
    {
      fetch: async () => {
        fetchCalled = true;
        return responseStream(officialEvents());
      },
    },
  );

  await assert.rejects(
    collect(
      transport.stream(
        {
          ...manualRequest(),
          input: {
            strategy: "providerCheckpoint",
            checkpoint: directCheckpoint("resp-previous"),
            newHistoryStartIndex: 0,
            items: [{ type: "message", role: "user", content: "new" }],
          },
        },
        signal(),
      ),
    ),
    hasTransportError(
      "invalidRequest",
      "responses_previous_response_requires_storage",
      false,
    ),
  );
  assert.equal(fetchCalled, false);
  await assert.rejects(
    collect(
      transport.stream(
        {
          ...manualRequest(),
          reconcileCheckpoint: directCheckpoint("resp-lost"),
        },
        signal(),
      ),
    ),
    hasTransportError(
      "invalidRequest",
      "responses_retrieve_requires_storage",
      false,
    ),
  );
  assert.equal(transport.supportsResponseRetrieve, false);
});

test("retrieves a completed response without resampling and rebuilds ordered text and Tool output", async () => {
  const reference = JSON.parse(
    readFileSync(
      new URL(
        "../../test-contracts/fixtures/provider-response-reconcile.reference.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    checkpoint: ReturnType<typeof directCheckpoint>;
    completed: Record<string, unknown>;
  };
  let request:
    | Readonly<{ url: string; method: string | undefined }>
    | undefined;
  const transport = retrievingTransport(async (input, init) => {
    request = { url: String(input), method: init?.method };
    return Response.json(reference.completed);
  });
  const checkpoint = reference.checkpoint;
  const events = await collect(
    transport.stream(
      { ...manualRequest(), reconcileCheckpoint: checkpoint },
      signal(),
    ),
  );
  assert.deepEqual(request, {
    url: "https://provider.example/v1/responses/resp-lost",
    method: "GET",
  });
  assert.deepEqual(events, [
    { type: "response.created", checkpoint },
    { type: "output.delta", delta: "checking" },
    {
      type: "output.item.completed",
      item: { type: "message", role: "assistant", content: "checking" },
    },
    {
      type: "output.item.completed",
      item: {
        type: "tool_call",
        kind: "function",
        callId: "call-1",
        name: "lookup",
        input: '{"q":1}',
      },
    },
    {
      type: "usage",
      inputTokens: 5,
      cachedInputTokens: 1,
      outputTokens: 3,
      totalTokens: 8,
    },
    { type: "completed", checkpoint },
  ]);
});

test("keeps pending retrieve non-terminal and projects failed and incomplete terminals", async () => {
  for (const status of ["queued", "in_progress"] as const) {
    await assert.rejects(
      retrieveJson({ id: "resp-lost", status }),
      hasTransportError("unavailable", "responses_reconcile_pending", true),
    );
  }
  const cases = [
    [
      { id: "resp-lost", status: "failed", error: { code: "provider_failed" } },
      "responses_provider_provider_failed",
      true,
    ],
    [
      {
        id: "resp-lost",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      },
      "responses_incomplete_max_output_tokens",
      false,
    ],
  ] as const;
  for (const [body, code, retryable] of cases) {
    assert.deepEqual(await retrieveJson(body), [
      { type: "response.created", checkpoint: directCheckpoint("resp-lost") },
      { type: "failed", code, retryable },
    ]);
  }
});

test("fails closed on retrieved response identity drift and oversized bodies", async () => {
  await assert.rejects(
    retrieveJson({
      id: "other",
      status: "completed",
      output: [],
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    }),
    hasTransportCode("responses_response_id_mismatch"),
  );
  const oversized = retrievingTransport(
    async () =>
      new Response("x".repeat(512 * 1024 + 1), {
        headers: { "content-type": "application/json" },
      }),
  );
  await assert.rejects(
    retrieveWith(oversized),
    hasTransportCode("responses_retrieve_body_too_large"),
  );
});

test("switches create EOF to retrieval and never issues a second POST", async () => {
  const methods: string[] = [];
  const transport = retrievingTransport(async (_input, init) => {
    methods.push(init?.method ?? "GET");
    if (init?.method === "POST") {
      return responseStream([createdEvent(0)]);
    }
    return Response.json({
      id: "resp-1",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "done" }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
  });
  const events = await collect(
    new CrewONAgentKernel({
      transport,
      retryScheduler: { wait: async () => undefined },
    }).runSegment(
      {
        schemaVersion: "crewon.agent-segment.v0",
        purpose: "agent",
        runId: "run-1",
        segmentId: "segment-1",
        attempt: 1,
        agentVersionId: "agent-1",
        policySnapshotId: "policy-1",
        collaborationMode: "default",
        allowedTools: null,
        history: [{ type: "message", role: "user", content: "hello" }],
        continuation: { kind: "manual" },
        budget: { maxOutputBytes: 32 * 1024 },
      },
      signal(),
    ),
  );
  assert.deepEqual(methods, ["POST", "GET"]);
  assert.equal(
    events.filter((event) => event.type === "segment.provider_response_created")
      .length,
    1,
  );
  assert.equal(events.at(-1)?.type, "segment.completed");
});

test("serializes Tool definitions and exact call outputs for follow-up sampling", async () => {
  let capturedBody: unknown;
  const transport = new DirectResponsesTransport(
    {
      endpoint: "https://provider.example/v1/responses",
      model: "provider-model",
    },
    {
      fetch: async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body));
        return responseStream([
          createdEvent(0),
          {
            type: "response.output_item.done",
            sequence_number: 1,
            item: {
              type: "custom_tool_call",
              call_id: "call-2",
              name: "next_tool",
              input: "next",
            },
          },
          {
            type: "response.completed",
            sequence_number: 2,
            response: {
              id: "resp-1",
              status: "completed",
              output: [],
              usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
            },
          },
        ]);
      },
    },
  );
  const request: ModelRequest = {
    ...manualRequest(),
    instructions: "Use only the pinned tools.",
    input: {
      strategy: "manual",
      items: [
        {
          type: "message",
          role: "developer",
          content: "Trusted governed context.",
        },
        { type: "message", role: "user", content: "hello" },
        {
          type: "tool_call",
          kind: "custom",
          callId: "call-1",
          name: "fixture_tool",
          input: "payload",
        },
        {
          type: "tool_result",
          kind: "custom",
          callId: "call-1",
          output: "fixture",
        },
      ],
    },
    tools: [
      {
        schemaVersion: "crewon.tool-definition.v0",
        kind: "custom",
        name: "fixture_tool",
        description: "Returns a fixture.",
        execution: "serial",
        inputFormat: "text",
      },
    ],
  };

  assert.deepEqual(await collect(transport.stream(request, signal())), [
    {
      type: "output.item.completed",
      item: {
        type: "tool_call",
        kind: "custom",
        callId: "call-2",
        name: "next_tool",
        input: "next",
      },
    },
    {
      type: "usage",
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 1,
    },
    { type: "completed", checkpoint: null },
  ]);
  assert.deepEqual(capturedBody, {
    model: "provider-model",
    stream: true,
    store: false,
    instructions: "Use only the pinned tools.",
    input: [
      { role: "developer", content: "Trusted governed context." },
      { role: "user", content: "hello" },
      {
        type: "custom_tool_call",
        call_id: "call-1",
        name: "fixture_tool",
        input: "payload",
      },
      {
        type: "custom_tool_call_output",
        call_id: "call-1",
        output: "fixture",
      },
    ],
    tools: [
      {
        type: "custom",
        name: "fixture_tool",
        description: "Returns a fixture.",
        format: { type: "text" },
      },
    ],
  });
});

test("maps bounded HTTP failures without exposing provider response bodies", async () => {
  const transport = new DirectResponsesTransport(
    {
      endpoint: "https://provider.example/v1/responses",
      model: "provider-model",
    },
    {
      fetch: async () =>
        new Response("sensitive provider details", {
          status: 429,
          headers: { "retry-after": "2" },
        }),
    },
  );

  await assert.rejects(
    collect(transport.stream(manualRequest(), signal())),
    (error) =>
      error instanceof ModelTransportError &&
      error.category === "rateLimit" &&
      error.code === "responses_rate_limited" &&
      error.retryable &&
      error.retryAfterMs === 2_000 &&
      !error.message.includes("sensitive"),
  );
});

test("classifies the shared AR-025 HTTP context-window error", async () => {
  const reference = JSON.parse(
    readFileSync(
      new URL(
        "../../test-contracts/fixtures/context-window-compaction.reference.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Readonly<{
    providerFailureCode: string;
    kernelFailureCode: string;
  }>;
  const transport = new DirectResponsesTransport(
    {
      endpoint: "https://provider.example/v1/responses",
      model: "provider-model",
    },
    {
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: reference.providerFailureCode,
              message: "sensitive provider context details",
            },
          }),
          { status: 400 },
        ),
    },
  );

  await assert.rejects(
    collect(transport.stream(manualRequest(), signal())),
    hasTransportError("invalidRequest", reference.kernelFailureCode, false),
  );
});

test("classifies the shared AR-030 policy failure without exposing or retrying provider copy", async () => {
  const reference = JSON.parse(
    readFileSync(
      new URL(
        "../../test-contracts/fixtures/typed-policy-failure.reference.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Readonly<{
    providerFailure: Readonly<{
      httpStatus: number;
      type: string;
      code: string;
      message: string;
    }>;
    events: readonly Readonly<{ data: Readonly<{ code: string }> }>[];
  }>;
  let requestCount = 0;
  const transport = new DirectResponsesTransport(
    {
      endpoint: "https://provider.example/v1/responses",
      model: "provider-model",
    },
    {
      fetch: async () => {
        requestCount += 1;
        return new Response(
          JSON.stringify({
            error: {
              type: reference.providerFailure.type,
              code: reference.providerFailure.code,
              message: reference.providerFailure.message,
            },
          }),
          { status: reference.providerFailure.httpStatus },
        );
      },
    },
  );

  await assert.rejects(
    collect(transport.stream(manualRequest(), signal())),
    (error) =>
      hasTransportError(
        "permission",
        reference.events[0]?.data.code ?? assert.fail("missing failure"),
        false,
      )(error) &&
      error instanceof ModelTransportError &&
      !error.message.includes(reference.providerFailure.message),
  );
  assert.equal(requestCount, 1);
});

test("classifies AR-008 usage-limit responses as non-retryable and emits the shared safe snapshot", async () => {
  const reference = JSON.parse(
    readFileSync(
      new URL(
        "../../test-contracts/fixtures/usage-limit-reached.reference.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Readonly<{ events: readonly { data: Record<string, unknown> }[] }>;
  const transport = new DirectResponsesTransport(
    {
      endpoint: "https://provider.example/v1/responses",
      model: "provider-model",
    },
    {
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: {
              type: "usage_limit_reached",
              message: "sensitive provider copy",
              resets_at: 1_704_067_242,
              plan_type: "pro",
            },
          }),
          {
            status: 429,
            headers: usageLimitHeaders(),
          },
        ),
    },
  );
  const iterator = transport
    .stream(manualRequest(), signal())
    [Symbol.asyncIterator]();

  assert.deepEqual(await iterator.next(), {
    done: false,
    value: {
      type: "rate_limit",
      snapshot: reference.events[0]?.data.snapshot,
    },
  });
  await assert.rejects(
    iterator.next(),
    hasTransportError("rateLimit", "responses_usage_limit_reached", false),
  );
});

test("actively aborts an in-flight fetch from the caller signal", async () => {
  let receivedSignal: ((value: AbortSignal) => void) | undefined;
  const started = new Promise<AbortSignal>((resolve) => {
    receivedSignal = resolve;
  });
  const transport = new DirectResponsesTransport(
    {
      endpoint: "https://provider.example/v1/responses",
      model: "provider-model",
    },
    {
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const activeSignal = init?.signal;
          assert.ok(activeSignal !== null && activeSignal !== undefined);
          receivedSignal?.(activeSignal);
          activeSignal.addEventListener(
            "abort",
            () => reject(activeSignal.reason),
            { once: true },
          );
        }),
    },
  );
  const controller = new AbortController();
  const pending = collect(transport.stream(manualRequest(), controller.signal));
  const providerSignal = await started;

  controller.abort("user_requested");

  await assert.rejects(
    pending,
    hasTransportError("canceled", "segment_canceled", false),
  );
  assert.equal(providerSignal.aborted, true);
});

test("actively aborts a blocked response body from the caller signal", async () => {
  let bodyStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    bodyStarted = resolve;
  });
  const transport = new DirectResponsesTransport(
    {
      endpoint: "https://provider.example/v1/responses",
      model: "provider-model",
    },
    {
      fetch: async (_input, init) => {
        const activeSignal = init?.signal;
        assert.ok(activeSignal !== null && activeSignal !== undefined);
        return new Response(
          new ReadableStream({
            start(controller) {
              activeSignal.addEventListener(
                "abort",
                () => controller.error(activeSignal.reason),
                { once: true },
              );
              bodyStarted?.();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    },
  );
  const controller = new AbortController();
  const pending = collect(transport.stream(manualRequest(), controller.signal));
  await started;

  controller.abort("user_requested");

  await assert.rejects(
    pending,
    hasTransportError("canceled", "segment_canceled", false),
  );
});

test("classifies an idle stream deterministically without sleep", async () => {
  const scheduler = new ManualScheduler();
  let fetchStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    fetchStarted = resolve;
  });
  const transport = new DirectResponsesTransport(
    {
      endpoint: "https://provider.example/v1/responses",
      model: "provider-model",
      idleTimeoutMs: 10,
    },
    {
      scheduler,
      fetch: async (_input, init) => {
        const activeSignal = init?.signal;
        assert.ok(activeSignal !== null && activeSignal !== undefined);
        return new Response(
          new ReadableStream({
            start(controller) {
              activeSignal.addEventListener(
                "abort",
                () => controller.error(activeSignal.reason),
                { once: true },
              );
              fetchStarted?.();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    },
  );
  const pending = collect(transport.stream(manualRequest(), signal()));
  await started;

  scheduler.fire();

  await assert.rejects(
    pending,
    hasTransportError("timeout", "responses_idle_timeout", true),
  );
});

test("applies the idle timeout to a blocked retrieve body without sleep", async () => {
  const scheduler = new ManualScheduler();
  let bodyStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    bodyStarted = resolve;
  });
  const transport = new DirectResponsesTransport(
    {
      endpoint: "https://provider.example/v1/responses",
      model: "provider-model",
      storeResponses: true,
      idleTimeoutMs: 10,
    },
    {
      scheduler,
      fetch: async (_input, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener(
                "abort",
                () => controller.error(init.signal?.reason),
                { once: true },
              );
              bodyStarted?.();
            },
          }),
        ),
    },
  );
  const pending = retrieveWith(transport);
  await started;
  scheduler.fire();
  await assert.rejects(
    pending,
    hasTransportError("timeout", "responses_idle_timeout", true),
  );
});

test("fails closed on non-monotonic SSE sequence and unsupported tool events", async () => {
  const duplicateSequence = createTransport([
    createdEvent(0),
    { type: "response.output_text.delta", sequence_number: 0, delta: "x" },
  ]);
  await assert.rejects(
    collect(duplicateSequence.stream(manualRequest(), signal())),
    hasTransportCode("responses_sequence_invalid"),
  );

  const unsupportedOutput = createTransport([
    createdEvent(0),
    {
      type: "response.output_item.done",
      sequence_number: 1,
      item: { type: "image_generation_call", id: "image-1" },
    },
  ]);
  await assert.rejects(
    collect(unsupportedOutput.stream(manualRequest(), signal())),
    hasTransportCode("responses_output_item_unsupported"),
  );
});

test("exposes a completed assistant item before the response terminal", async () => {
  const transport = createTransport([
    createdEvent(0),
    { type: "response.output_text.delta", sequence_number: 1, delta: "done" },
    {
      type: "response.output_item.done",
      sequence_number: 2,
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "done" }],
      },
    },
    {
      type: "response.completed",
      sequence_number: 3,
      response: {
        id: "resp-1",
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "done" }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);

  assert.deepEqual(await collect(transport.stream(manualRequest(), signal())), [
    { type: "output.delta", delta: "done" },
    {
      type: "output.item.completed",
      item: { type: "message", role: "assistant", content: "done" },
    },
    {
      type: "usage",
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      totalTokens: 2,
    },
    { type: "completed", checkpoint: null },
  ]);
});

test("preserves the Provider end_turn=false continuation directive", async () => {
  const transport = createTransport([
    createdEvent(0),
    {
      type: "response.completed",
      sequence_number: 1,
      response: {
        id: "resp-1",
        status: "completed",
        end_turn: false,
        output: [],
        usage: { input_tokens: 4, output_tokens: 0, total_tokens: 4 },
      },
    },
  ]);

  assert.deepEqual(await collect(transport.stream(manualRequest(), signal())), [
    {
      type: "usage",
      inputTokens: 4,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 4,
    },
    { type: "completed", checkpoint: null, endTurn: false },
  ]);

  const invalid = createTransport([
    createdEvent(0),
    {
      type: "response.completed",
      sequence_number: 1,
      response: {
        id: "resp-1",
        status: "completed",
        end_turn: "false",
        output: [],
        usage: { input_tokens: 4, output_tokens: 0, total_tokens: 4 },
      },
    },
  ]);
  await assert.rejects(
    collect(invalid.stream(manualRequest(), signal())),
    hasTransportCode("responses_end_turn_invalid"),
  );
});

test("posts an empty stored continuation against the previous response", async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const transport = new DirectResponsesTransport(
    {
      endpoint: "https://provider.example/v1/responses",
      model: "provider-model",
      storeResponses: true,
    },
    {
      fetch: async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<
          string,
          unknown
        >;
        return responseStream([
          {
            type: "response.created",
            sequence_number: 0,
            response: { id: "resp-2" },
          },
          {
            type: "response.completed",
            sequence_number: 1,
            response: {
              id: "resp-2",
              status: "completed",
              output: [],
              usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
            },
          },
        ]);
      },
    },
  );
  const request = manualRequest();

  await collect(
    transport.stream(
      {
        ...request,
        input: {
          strategy: "providerCheckpoint",
          checkpoint: directCheckpoint("resp-1"),
          items: request.input.items,
          newHistoryStartIndex: request.input.items.length,
        },
      },
      signal(),
    ),
  );

  assert.deepEqual(capturedBody, {
    model: "provider-model",
    stream: true,
    store: true,
    input: [],
    tools: [],
    previous_response_id: "resp-1",
  });
});

test("defaults missing cached usage to zero and rejects cached input above total input", async () => {
  const compatible = createTransport([
    createdEvent(0),
    completedEvent({ input_tokens: 3, output_tokens: 1, total_tokens: 4 }),
  ]);
  assert.deepEqual(
    await collect(compatible.stream(manualRequest(), signal())),
    [
      {
        type: "usage",
        inputTokens: 3,
        cachedInputTokens: 0,
        outputTokens: 1,
        totalTokens: 4,
      },
      { type: "completed", checkpoint: null },
    ],
  );

  const invalid = createTransport([
    createdEvent(0),
    completedEvent({
      input_tokens: 3,
      input_tokens_details: { cached_tokens: 4 },
      output_tokens: 1,
      total_tokens: 4,
    }),
  ]);
  await assert.rejects(
    collect(invalid.stream(manualRequest(), signal())),
    hasTransportCode("responses_cached_input_tokens_exceeds_input"),
  );
});

test("rejects every malformed provider usage case in the shared Rust parity fixture", async () => {
  const reference = JSON.parse(
    readFileSync(
      new URL(
        "../../test-contracts/fixtures/provider-usage-validation.reference.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Readonly<{
    cases: readonly Readonly<{
      caseId: string;
      usage: Readonly<Record<string, unknown>>;
      expected: "rejected";
    }>[];
  }>;

  for (const fixture of reference.cases) {
    const transport = createTransport([
      createdEvent(0),
      completedEvent(fixture.usage),
    ]);
    await assert.rejects(
      collect(transport.stream(manualRequest(), signal())),
      (error) =>
        error instanceof ModelTransportError &&
        error.category === "protocol" &&
        error.retryable === false,
      fixture.caseId,
    );
  }
});

test("maps streamed failure and incomplete terminal states", async () => {
  const failed = createTransport([
    createdEvent(0),
    {
      type: "response.failed",
      sequence_number: 1,
      response: {
        id: "resp-1",
        status: "failed",
        error: { code: "server_error" },
      },
    },
  ]);
  assert.deepEqual(await collect(failed.stream(manualRequest(), signal())), [
    {
      type: "failed",
      code: "responses_provider_server_error",
      retryable: true,
    },
  ]);

  const incomplete = createTransport([
    createdEvent(0),
    {
      type: "response.incomplete",
      sequence_number: 1,
      response: {
        id: "resp-1",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      },
    },
  ]);
  assert.deepEqual(
    await collect(incomplete.stream(manualRequest(), signal())),
    [
      {
        type: "failed",
        code: "responses_incomplete_max_output_tokens",
        retryable: false,
      },
    ],
  );
});

test("maps AR-009 content-filter incomplete output to the shared non-retryable trace", async () => {
  const reference = JSON.parse(
    readFileSync(
      new URL(
        "../../test-contracts/fixtures/content-filter-incomplete.reference.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Readonly<{ events: readonly unknown[] }>;
  const transport = createTransport([
    createdEvent(0),
    {
      type: "response.output_item.added",
      sequence_number: 1,
      output_index: 0,
      item: { id: "msg-incomplete", type: "message", content: [] },
    },
    {
      type: "response.output_text.delta",
      sequence_number: 2,
      delta: "continued chunk",
    },
    {
      type: "response.incomplete",
      sequence_number: 3,
      response: {
        id: "resp-1",
        status: "incomplete",
        incomplete_details: { reason: "content_filter" },
      },
    },
  ]);

  const events = await collect(transport.stream(manualRequest(), signal()));
  const candidate = events.map((event, index) => ({
    schemaVersion: "crewon.turn-event.v0",
    sequence: index + 1,
    type: event.type === "output.delta" ? "model.output.delta" : "turn.failed",
    identity: { turnSlot: "first" },
    data:
      event.type === "output.delta"
        ? { delta: event.delta }
        : event.type === "failed"
          ? { code: event.code, retryable: event.retryable }
          : assert.fail(`unexpected AR-009 event ${event.type}`),
  }));

  assert.deepEqual(candidate, reference.events.slice(0, 2));
});

test("integrates with the owned Kernel while preserving canonical event order", async () => {
  const kernel = new CrewONAgentKernel({
    transport: createTransport(officialEvents()),
  });

  const events = await collect(
    kernel.runSegment(
      {
        schemaVersion: "crewon.agent-segment.v0",
        purpose: "agent",
        runId: "run-1",
        segmentId: "segment-1",
        attempt: 1,
        agentVersionId: "agent-version-1",
        policySnapshotId: "policy-1",
        collaborationMode: "default",
        allowedTools: null,
        history: [{ type: "message", role: "user", content: "hello" }],
        continuation: { kind: "manual" },
        budget: { maxOutputBytes: 32 * 1024 },
      },
      signal(),
    ),
  );

  assert.deepEqual(
    events.map(({ sequence, type }) => ({ sequence, type })),
    [
      { sequence: 1, type: "segment.started" },
      { sequence: 2, type: "model.output.delta" },
      { sequence: 3, type: "model.output.delta" },
      { sequence: 4, type: "usage.recorded" },
      { sequence: 5, type: "segment.completed" },
    ],
  );
});

test("parses fragmented CRLF frames and enforces the event byte cap", async () => {
  const fragmentStream = byteStream([
    'data: {"type":"one"}\r',
    '\n\r\ndata: {"type":"two"}\r\n\r\n',
  ]);
  assert.deepEqual(await collect(parseResponsesSse(fragmentStream)), [
    { kind: "event", value: { type: "one" } },
    { kind: "event", value: { type: "two" } },
  ]);

  await assert.rejects(
    collect(
      parseResponsesSse(byteStream([`data: ${"x".repeat(32)}`]), {
        maxEventBytes: 16,
      }),
    ),
    hasTransportCode("responses_event_too_large"),
  );
});

function createTransport(events: readonly unknown[]): DirectResponsesTransport {
  return new DirectResponsesTransport(
    {
      endpoint: "https://provider.example/v1/responses",
      model: "provider-model",
    },
    { fetch: async () => responseStream(events) },
  );
}

function manualRequest(): ModelRequest {
  return {
    schemaVersion: "crewon.model-request.v0",
    runId: "run-1",
    segmentId: "segment-1",
    agentVersionId: "agent-version-1",
    instructions: null,
    input: {
      strategy: "manual",
      items: [{ type: "message", role: "user", content: "hello" }],
    },
    tools: [],
    maxOutputBytes: 32 * 1024,
  };
}

function directCheckpoint(responseId: string) {
  return {
    schemaVersion: "crewon.provider-checkpoint.v0",
    adapterName: "direct-responses",
    adapterVersion: "1",
    modelId: "provider-model",
    opaquePayload: { responseId },
  } as const;
}

function retrievingTransport(fetch: typeof globalThis.fetch) {
  return new DirectResponsesTransport(
    {
      endpoint: "https://provider.example/v1/responses",
      model: "provider-model",
      storeResponses: true,
    },
    { fetch },
  );
}

function retrieveJson(body: unknown) {
  return retrieveWith(retrievingTransport(async () => Response.json(body)));
}

function retrieveWith(transport: DirectResponsesTransport) {
  return collect(
    transport.stream(
      {
        ...manualRequest(),
        reconcileCheckpoint: directCheckpoint("resp-lost"),
      },
      signal(),
    ),
  );
}

function officialEvents(): readonly unknown[] {
  return [
    createdEvent(0),
    { type: "response.output_text.delta", sequence_number: 1, delta: "do" },
    { type: "response.output_text.delta", sequence_number: 2, delta: "ne" },
    {
      type: "response.completed",
      sequence_number: 3,
      response: {
        id: "resp-1",
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "done" }],
          },
        ],
        usage: {
          input_tokens: 4,
          input_tokens_details: { cached_tokens: 2 },
          output_tokens: 1,
          total_tokens: 5,
        },
      },
    },
  ];
}

function createdEvent(sequence: number): Readonly<Record<string, unknown>> {
  return {
    type: "response.created",
    sequence_number: sequence,
    response: { id: "resp-1" },
  };
}

function completedEvent(
  usage: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    type: "response.completed",
    sequence_number: 1,
    response: {
      id: "resp-1",
      status: "completed",
      output: [],
      usage,
    },
  };
}

function officialStreamChunks(): readonly string[] {
  return officialEvents().flatMap((event) => {
    const payload = `data: ${JSON.stringify(event)}\r\n\r\n`;
    const split = Math.max(1, Math.floor(payload.length / 2));
    return [payload.slice(0, split), payload.slice(split)];
  });
}

function responseStream(events: readonly unknown[]): Response {
  return new Response(
    byteStream(events.map((event) => `data: ${JSON.stringify(event)}\n\n`)),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function usageLimitHeaders(): Headers {
  return new Headers({
    "x-codex-primary-used-percent": "100.0",
    "x-codex-secondary-used-percent": "87.5",
    "x-codex-primary-over-secondary-limit-percent": "95.0",
    "x-codex-primary-window-minutes": "15",
    "x-codex-secondary-window-minutes": "60",
  });
}

function byteStream(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

async function requestBody(request: IncomingMessage): Promise<string> {
  request.setEncoding("utf8");
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
  }
  return body;
}

async function listen(
  context: TestContext,
  server: ReturnType<typeof createServer>,
): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  context.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      }),
  );
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return `http://127.0.0.1:${address.port}/v1/responses`;
}

class ManualScheduler implements ResponsesTimerScheduler {
  #callback: (() => void) | null = null;

  schedule(callback: () => void, _delayMs: number): () => void {
    this.#callback = callback;
    return () => {
      if (this.#callback === callback) {
        this.#callback = null;
      }
    };
  }

  fire(): void {
    const callback = this.#callback;
    assert.ok(callback !== null);
    this.#callback = null;
    callback();
  }
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

function hasTransportError(
  category: ModelTransportError["category"],
  code: string,
  retryable: boolean,
): (error: unknown) => boolean {
  return (error) =>
    error instanceof ModelTransportError &&
    error.category === category &&
    error.code === code &&
    error.retryable === retryable;
}

function hasTransportCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ModelTransportError && error.code === code;
}
