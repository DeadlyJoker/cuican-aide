import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { compareTraces, type CanonicalTrace } from "@crewon/test-contracts";

import { AgentKernelError } from "./agent-kernel-port.ts";
import { CrewONAgentKernel } from "./crewon-agent-kernel.ts";
import { DeterministicFakeModelTransport } from "./deterministic-fake-model.ts";
import {
  ModelTransportError,
  type ModelInputItem,
  type ModelTransportPort,
} from "./model-transport-port.ts";

test("runs a bounded deterministic text segment with canonical ordering", async () => {
  const transport = new DeterministicFakeModelTransport({
    expectedLastUserMessage: "hello",
    events: [
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
    ],
  });
  const events = await collect(
    new CrewONAgentKernel({ transport }).runSegment(
      segmentContract(),
      new AbortController().signal,
    ),
  );

  assert.deepEqual(
    events.map((event) => [event.sequence, event.type]),
    [
      [1, "segment.started"],
      [2, "model.output.delta"],
      [3, "model.output.delta"],
      [4, "usage.recorded"],
      [5, "segment.completed"],
    ],
  );
  assert.deepEqual(events.at(-1)?.data, { output: "done" });
  assert.deepEqual(events[3]?.data, {
    inputTokens: 4,
    cachedInputTokens: 2,
    outputTokens: 1,
    totalTokens: 5,
  });
  assert.deepEqual(transport.requests[0]?.input, {
    strategy: "manual",
    items: [{ type: "message", role: "user", content: "hello" }],
  });
});

test("matches the shared deterministic text Segment trace", async () => {
  const reference = fixture<CanonicalTrace>("text-run.reference.json");
  const events = await collect(
    new CrewONAgentKernel({
      transport: new DeterministicFakeModelTransport({
        expectedLastUserMessage: "hello",
        events: [
          { type: "output.delta", delta: "done" },
          { type: "completed", checkpoint: null },
        ],
      }),
    }).runSegment(
      {
        ...segmentContract(),
        runId: "run-text-1",
        segmentId: "segment-text-1",
      },
      new AbortController().signal,
    ),
  );
  const candidate: CanonicalTrace = {
    schemaVersion: "crewon.trace.v0",
    caseId: "text-run",
    events: events.map((event) => ({
      schemaVersion: event.schemaVersion,
      sequence: event.sequence,
      type: event.type,
      identity: { runId: event.runId, segmentId: event.segmentId },
      data: event.data,
    })),
    finalState: {
      lastSequence: events.length,
      revision: events.length,
      status: "completed",
    },
  };

  assert.deepEqual(compareTraces(reference, candidate), { equal: true });
});

test("returns control at the Tool boundary without executing or resampling", async () => {
  const requests: import("./model-transport-port.ts").ModelRequest[] = [];
  const checkpoint = {
    schemaVersion: "crewon.provider-checkpoint.v0",
    adapterName: "tool-boundary-adapter",
    adapterVersion: "1",
    modelId: "tool-boundary-model",
    opaquePayload: { responseId: "response-with-tool" },
  } as const;
  const transport: ModelTransportPort = {
    adapterName: checkpoint.adapterName,
    adapterVersion: checkpoint.adapterVersion,
    modelId: checkpoint.modelId,
    async *stream(request) {
      requests.push(structuredClone(request));
      yield {
        type: "tool.call",
        kind: "function",
        callId: "call-1",
        name: "fixture_reader",
        input: "{}",
      };
      yield { type: "completed", checkpoint };
    },
  };
  const definition = {
    schemaVersion: "crewon.tool-definition.v0" as const,
    kind: "function" as const,
    name: "fixture_reader",
    description: "Returns a deterministic fixture.",
    execution: "serial" as const,
    inputSchema: { type: "object" },
  };
  const events = await collect(
    new CrewONAgentKernel({
      transport,
      toolCatalog: { definitions: () => [definition] },
    }).runSegment(segmentContract(), new AbortController().signal),
  );

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]?.tools, [definition]);
  assert.deepEqual(
    events.map(({ sequence, type }) => ({ sequence, type })),
    [
      { sequence: 1, type: "segment.started" },
      { sequence: 2, type: "tool.requested" },
      { sequence: 3, type: "segment.checkpointed" },
    ],
  );
  assert.equal(
    events.some((event) => event.type === "tool.completed"),
    false,
  );
  assert.equal(
    events.some((event) => event.type === "segment.completed"),
    false,
  );
});

test("keeps compaction segments Tool-free", async () => {
  const requests: import("./model-transport-port.ts").ModelRequest[] = [];
  const transport: ModelTransportPort = {
    adapterName: "compaction-adapter",
    adapterVersion: "1",
    modelId: "compaction-model",
    async *stream(request) {
      requests.push(structuredClone(request));
      yield { type: "output.delta", delta: "summary" };
      yield { type: "usage", inputTokens: 5, outputTokens: 1, totalTokens: 6 };
      yield { type: "completed", checkpoint: null };
    },
  };
  const kernel = new CrewONAgentKernel({
    transport,
    toolCatalog: {
      definitions: () => [
        {
          schemaVersion: "crewon.tool-definition.v0",
          kind: "function",
          name: "should_not_be_visible",
          description: "Must not be advertised to compaction.",
          execution: "serial",
          inputSchema: { type: "object" },
        },
      ],
    },
  });

  const events = await collect(
    kernel.runSegment(
      { ...segmentContract(), purpose: "compaction" },
      new AbortController().signal,
    ),
  );

  assert.deepEqual(requests[0]?.tools, []);
  assert.equal(events.at(-1)?.type, "segment.completed");
});

test("pins AgentVersion instructions and ordered Tool definitions across requests", async () => {
  const reference = fixture<{
    expected: Readonly<{
      requestCount: number;
      instructionsStable: boolean;
      toolDefinitionsStable: boolean;
      toolOrderStable: boolean;
    }>;
  }>("prompt-tool-stability.reference.json");
  const requests: import("./model-transport-port.ts").ModelRequest[] = [];
  const transport: ModelTransportPort = {
    adapterName: "prompt-stability-adapter",
    adapterVersion: "1",
    modelId: "prompt-stability-model",
    async *stream(request) {
      requests.push(structuredClone(request));
      yield { type: "completed", checkpoint: null };
    },
  };
  const first = {
    schemaVersion: "crewon.tool-definition.v0" as const,
    kind: "function" as const,
    name: "first_tool",
    description: "The first stable Tool.",
    execution: "serial" as const,
    inputSchema: { type: "object" },
  };
  const second = {
    schemaVersion: "crewon.tool-definition.v0" as const,
    kind: "custom" as const,
    name: "second_tool",
    description: "The second stable Tool.",
    execution: "parallel" as const,
    inputFormat: "text" as const,
  };
  let refreshed = false;
  const kernel = new CrewONAgentKernel({
    transport,
    instructions: "Be consistent and helpful.",
    toolCatalog: {
      definitions: () => (refreshed ? [second] : [first, second]),
    },
  });

  await collect(
    kernel.runSegment(segmentContract(), new AbortController().signal),
  );
  refreshed = true;
  await collect(
    kernel.runSegment(
      { ...segmentContract(), segmentId: "segment-2" },
      new AbortController().signal,
    ),
  );

  assert.equal(requests.length, reference.expected.requestCount);
  assert.equal(
    requests[0]?.instructions === requests[1]?.instructions,
    reference.expected.instructionsStable,
  );
  assert.equal(
    JSON.stringify(requests[0]?.tools) === JSON.stringify(requests[1]?.tools),
    reference.expected.toolDefinitionsStable,
  );
  assert.equal(
    JSON.stringify(requests[0]?.tools.map(({ name }) => name)) ===
      JSON.stringify(requests[1]?.tools.map(({ name }) => name)),
    reference.expected.toolOrderStable,
  );
  assert.equal(requests[0]?.instructions, "Be consistent and helpful.");
  assert.deepEqual(requests[0]?.tools, [first, second]);
  assert.throws(
    () =>
      new CrewONAgentKernel({
        transport,
        instructions: "界".repeat(11_000),
      }),
    hasKernelCode("agent_instructions_invalid"),
  );
});

test("pins Plan instructions and advertises only the server allow-list", async () => {
  const requests: import("./model-transport-port.ts").ModelRequest[] = [];
  const transport: ModelTransportPort = {
    adapterName: "plan-adapter",
    adapterVersion: "1",
    modelId: "plan-model",
    async *stream(request) {
      requests.push(structuredClone(request));
      yield {
        type: "output.delta",
        delta: "<proposed_plan>Inspect and migrate.</proposed_plan>",
      };
      yield { type: "completed", checkpoint: null };
    },
  };
  const read = {
    schemaVersion: "crewon.tool-definition.v0" as const,
    kind: "function" as const,
    name: "read_file",
    description: "Read one file.",
    execution: "parallel" as const,
    inputSchema: { type: "object" },
  };
  const write = {
    ...read,
    name: "write_file",
    description: "Write one file.",
    execution: "serial" as const,
  };
  const kernel = new CrewONAgentKernel({
    transport,
    instructions: "Pinned AgentVersion instructions.",
    toolCatalog: { definitions: () => [read, write] },
  });

  await collect(
    kernel.runSegment(
      {
        ...segmentContract(),
        collaborationMode: "plan",
        allowedTools: [{ kind: "function", name: "read_file" }],
      },
      new AbortController().signal,
    ),
  );

  assert.deepEqual(requests[0]?.tools, [read]);
  assert.match(requests[0]?.instructions ?? "", /Plan mode/);
  assert.match(requests[0]?.instructions ?? "", /<proposed_plan>/);
  assert.match(
    requests[0]?.instructions ?? "",
    /^Pinned AgentVersion instructions\./,
  );
});

test("merges server-owned runtime Tools and rejects AgentVersion collisions", async () => {
  const requests: import("./model-transport-port.ts").ModelRequest[] = [];
  const transport: ModelTransportPort = {
    adapterName: "runtime-tool-adapter",
    adapterVersion: "1",
    modelId: "runtime-tool-model",
    async *stream(request) {
      requests.push(structuredClone(request));
      yield { type: "output.delta", delta: "done" };
      yield { type: "completed", checkpoint: null };
    },
  };
  const runtimeTool = {
    schemaVersion: "crewon.tool-definition.v0" as const,
    kind: "function" as const,
    name: "get_goal",
    description: "Get the current Goal.",
    execution: "serial" as const,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  };
  const kernel = new CrewONAgentKernel({ transport });

  await collect(
    kernel.runSegment(
      { ...segmentContract(), runtimeTools: [runtimeTool] },
      new AbortController().signal,
    ),
  );

  assert.deepEqual(requests[0]?.tools, [runtimeTool]);

  await assert.rejects(
    collect(
      new CrewONAgentKernel({
        transport,
        toolCatalog: { definitions: () => [runtimeTool] },
      }).runSegment(
        { ...segmentContract(), runtimeTools: [runtimeTool] },
        new AbortController().signal,
      ),
    ),
    hasKernelCode("runtime_tool_identity_conflict"),
  );
});

test("fails closed when a provider emits a Tool call during compaction", async () => {
  const transport: ModelTransportPort = {
    adapterName: "invalid-compaction-adapter",
    adapterVersion: "1",
    modelId: "invalid-compaction-model",
    async *stream() {
      yield {
        type: "tool.call",
        kind: "function",
        callId: "call-during-compaction",
        name: "read_file",
        input: "{}",
      };
      yield { type: "completed", checkpoint: null };
    },
  };

  await assert.rejects(
    collect(
      new CrewONAgentKernel({ transport }).runSegment(
        { ...segmentContract(), purpose: "compaction" },
        new AbortController().signal,
      ),
    ),
    hasKernelCode("compaction_tool_call_unsupported"),
  );
});

test("matches the Rust early-close retry reference within one durable Attempt", async () => {
  const reference = fixture<CanonicalTrace>(
    "stream-early-close-retry.reference.json",
  );
  let requestCount = 0;
  const retryDelays: number[] = [];
  const transport: ModelTransportPort = {
    adapterName: "retry-adapter",
    adapterVersion: "1",
    modelId: "retry-model",
    async *stream() {
      requestCount += 1;
      if (requestCount === 1) {
        return;
      }
      yield { type: "output.delta", delta: "done" };
      yield { type: "completed", checkpoint: null };
    },
  };
  const events = await collect(
    new CrewONAgentKernel({
      transport,
      streamMaxRetries: 1,
      retryScheduler: {
        wait: async (delayMs) => {
          retryDelays.push(delayMs);
        },
      },
      retryRandom: () => 0.5,
    }).runSegment(
      {
        ...segmentContract(),
        runId: "run-retry-1",
        segmentId: "segment-retry-1",
      },
      new AbortController().signal,
    ),
  );
  const completed = events.at(-1);
  const candidate: CanonicalTrace = {
    schemaVersion: "crewon.trace.v0",
    caseId: reference.caseId,
    events: events.map((event) => ({
      schemaVersion: event.schemaVersion,
      sequence: event.sequence,
      type: event.type,
      identity: { runId: event.runId, segmentId: event.segmentId },
      data: event.data,
    })),
    finalState: {
      status: "completed",
      lastSequence: events.length,
      requestCount,
      samplingRetries: retryDelays.length,
      finalOutput:
        completed?.type === "segment.completed" ? completed.data.output : "",
    },
  };

  assert.deepEqual(compareTraces(reference, candidate), { equal: true });
  assert.deepEqual(retryDelays, [200]);
});

test("bounds same-Turn retries", async () => {
  let requests = 0;
  const transport: ModelTransportPort = {
    adapterName: "empty-adapter",
    adapterVersion: "1",
    modelId: "empty-model",
    async *stream() {
      requests += 1;
    },
  };
  await assert.rejects(
    collect(
      new CrewONAgentKernel({
        transport,
        streamMaxRetries: 1,
        retryScheduler: { wait: async () => undefined },
      }).runSegment(segmentContract(), new AbortController().signal),
    ),
    (error) =>
      error instanceof AgentKernelError &&
      error.code === "model_stream_incomplete" &&
      !error.retryable,
  );
  assert.equal(requests, 2);
});

test("carries a completed assistant item into an incomplete-stream retry", async () => {
  const reference = fixture<{
    completedItem: ModelInputItem;
    expectedSecondRequestItems: readonly ModelInputItem[];
    finalState: { samplingRetries: number };
  }>("stream-completed-assistant-close-retry.reference.json");
  const requests: import("./model-transport-port.ts").ModelRequest[] = [];
  let requestCount = 0;
  const transport: ModelTransportPort = {
    adapterName: "completed-item-adapter",
    adapterVersion: "1",
    modelId: "completed-item-model",
    async *stream(request) {
      requests.push(structuredClone(request));
      requestCount += 1;
      if (requestCount === 1) {
        yield { type: "output.delta", delta: "first" };
        yield {
          type: "output.item.completed",
          item: reference.completedItem,
        };
        return;
      }
      yield { type: "output.delta", delta: "done" };
      yield { type: "completed", checkpoint: null };
    },
  };

  const events = await collect(
    new CrewONAgentKernel({
      transport,
      streamMaxRetries: 1,
      retryScheduler: { wait: async () => undefined },
    }).runSegment(segmentContract(), new AbortController().signal),
  );

  assert.deepEqual(requests[1]?.input.items, [
    ...segmentContract().history,
    ...reference.expectedSecondRequestItems,
  ]);
  assert.deepEqual(
    events.find((event) => event.type === "model.sampling.retry")?.data,
    {
      samplingAttempt: 1,
      maxRetries: reference.finalState.samplingRetries,
      code: "model_stream_incomplete",
      discardedOutput: true,
    },
  );
});

test("turns a completed Tool item without a terminal into one durable Tool boundary", async () => {
  const reference = fixture<{
    completedItem: Extract<ModelInputItem, { type: "tool_call" }>;
    finalState: { toolRequestedEventCount: number };
  }>("stream-completed-tool-close-retry.reference.json");
  const transport: ModelTransportPort = {
    adapterName: "completed-tool-adapter",
    adapterVersion: "1",
    modelId: "completed-tool-model",
    async *stream() {
      yield { type: "output.item.completed", item: reference.completedItem };
    },
  };

  const events = await collect(
    new CrewONAgentKernel({
      transport,
      streamMaxRetries: 1,
      retryScheduler: { wait: async () => undefined },
    }).runSegment(segmentContract(), new AbortController().signal),
  );

  assert.equal(
    events.filter((event) => event.type === "tool.requested").length,
    reference.finalState.toolRequestedEventCount,
  );
  assert.deepEqual(
    events.find((event) => event.type === "tool.requested")?.data,
    {
      callId: reference.completedItem.callId,
      kind: reference.completedItem.kind,
      name: reference.completedItem.name,
      input: reference.completedItem.input,
    },
  );
  assert.equal(
    events.some((event) => event.type === "model.sampling.retry"),
    false,
  );
});

test("discards partial output and matches the Rust retry reference", async () => {
  const reference = fixture<CanonicalTrace>(
    "stream-partial-close-retry.reference.json",
  );
  let requestCount = 0;
  const retryDelays: number[] = [];
  const transport: ModelTransportPort = {
    adapterName: "partial-adapter",
    adapterVersion: "1",
    modelId: "partial-retry-model",
    async *stream() {
      requestCount += 1;
      if (requestCount === 1) {
        yield { type: "output.delta", delta: "draft" };
        return;
      }
      yield { type: "output.delta", delta: "done" };
      yield { type: "completed", checkpoint: null };
    },
  };
  const events = await collect(
    new CrewONAgentKernel({
      transport,
      streamMaxRetries: 1,
      retryScheduler: {
        wait: async (delayMs) => {
          retryDelays.push(delayMs);
        },
      },
      retryRandom: () => 0.5,
    }).runSegment(
      {
        ...segmentContract(),
        runId: "run-partial-retry-1",
        segmentId: "segment-partial-retry-1",
      },
      new AbortController().signal,
    ),
  );
  const completed = events.at(-1);
  const candidate: CanonicalTrace = {
    schemaVersion: "crewon.trace.v0",
    caseId: reference.caseId,
    events: events.map((event) => ({
      schemaVersion: event.schemaVersion,
      sequence: event.sequence,
      type: event.type,
      identity: { runId: event.runId, segmentId: event.segmentId },
      data: event.data,
    })),
    finalState: {
      status: "completed",
      lastSequence: events.length,
      requestCount,
      samplingRetries: retryDelays.length,
      finalOutput:
        completed?.type === "segment.completed" ? completed.data.output : "",
    },
  };

  assert.deepEqual(compareTraces(reference, candidate), { equal: true });
  assert.deepEqual(retryDelays, [200]);
});

test("fails closed on output budgets, malformed usage and cancellation", async () => {
  const oversized = new CrewONAgentKernel({
    transport: new DeterministicFakeModelTransport({
      expectedLastUserMessage: "hello",
      events: [{ type: "output.delta", delta: "x".repeat(33 * 1024) }],
    }),
  });
  await assert.rejects(
    collect(
      oversized.runSegment(segmentContract(), new AbortController().signal),
    ),
    hasKernelCode("model_output_delta_too_large"),
  );

  const invalidUsage = new CrewONAgentKernel({
    transport: new DeterministicFakeModelTransport({
      expectedLastUserMessage: "hello",
      events: [
        { type: "usage", inputTokens: 1, outputTokens: 1, totalTokens: 3 },
      ],
    }),
  });
  await assert.rejects(
    collect(
      invalidUsage.runSegment(segmentContract(), new AbortController().signal),
    ),
    hasKernelCode("model_usage_total_mismatch"),
  );

  const invalidCachedUsage = new CrewONAgentKernel({
    transport: new DeterministicFakeModelTransport({
      expectedLastUserMessage: "hello",
      events: [
        {
          type: "usage",
          inputTokens: 1,
          cachedInputTokens: 2,
          outputTokens: 0,
          totalTokens: 1,
        },
      ],
    }),
  });
  await assert.rejects(
    collect(
      invalidCachedUsage.runSegment(
        segmentContract(),
        new AbortController().signal,
      ),
    ),
    hasKernelCode("model_usage_cached_input_exceeds_input"),
  );

  const controller = new AbortController();
  controller.abort("user_requested");
  await assert.rejects(
    collect(
      new CrewONAgentKernel({
        transport: new DeterministicFakeModelTransport({
          expectedLastUserMessage: "hello",
          events: [{ type: "completed", checkpoint: null }],
        }),
      }).runSegment(segmentContract(), controller.signal),
    ),
    hasKernelCode("segment_canceled"),
  );
});

test("preserves full replay history and marks the provider checkpoint delta", async () => {
  const requests: import("./model-transport-port.ts").ModelRequest[] = [];
  const checkpoint = {
    schemaVersion: "crewon.provider-checkpoint.v0",
    adapterName: "capture-adapter",
    adapterVersion: "1",
    modelId: "capture-model",
    opaquePayload: { responseId: "resp-previous" },
  } as const;
  const transport: ModelTransportPort = {
    adapterName: checkpoint.adapterName,
    adapterVersion: checkpoint.adapterVersion,
    modelId: checkpoint.modelId,
    async *stream(request) {
      requests.push(structuredClone(request));
      yield { type: "completed", checkpoint: null };
    },
  };

  await collect(
    new CrewONAgentKernel({ transport }).runSegment(
      {
        ...segmentContract(),
        history: [
          { type: "message", role: "user", content: "old turn" },
          { type: "message", role: "assistant", content: "old answer" },
          { type: "message", role: "user", content: "new turn" },
        ],
        continuation: {
          kind: "providerCheckpoint",
          checkpoint,
          newHistoryStartIndex: 2,
        },
      },
      new AbortController().signal,
    ),
  );

  assert.deepEqual(requests[0]?.input, {
    strategy: "providerCheckpoint",
    checkpoint,
    items: [
      { type: "message", role: "user", content: "old turn" },
      { type: "message", role: "assistant", content: "old answer" },
      { type: "message", role: "user", content: "new turn" },
    ],
    newHistoryStartIndex: 2,
  });
});

test("resets the sampling budget and discarded output on a transport fallback", async () => {
  let requests = 0;
  const transport: ModelTransportPort = {
    adapterName: "fallback-adapter",
    adapterVersion: "1",
    modelId: "fallback-model",
    async *stream() {
      requests += 1;
      if (requests === 1) {
        yield { type: "output.delta", delta: "discarded" };
        yield {
          type: "transport.fallback",
          fromTransport: "websocket",
          toTransport: "http",
          code: "responses_websocket_closed",
          discardedOutput: true,
        };
        throw new ModelTransportError({
          category: "unavailable",
          code: "http_temporarily_unavailable",
          retryable: true,
        });
      }
      yield { type: "output.delta", delta: "done" };
      yield { type: "completed", checkpoint: null };
    },
  };
  const events = await collect(
    new CrewONAgentKernel({
      transport,
      streamMaxRetries: 1,
      retryScheduler: { wait: async () => undefined },
    }).runSegment(segmentContract(), new AbortController().signal),
  );

  assert.equal(requests, 2);
  assert.deepEqual(
    events.map(({ sequence, type }) => ({ sequence, type })),
    [
      { sequence: 1, type: "segment.started" },
      { sequence: 2, type: "model.output.delta" },
      { sequence: 3, type: "model.transport.fallback" },
      { sequence: 4, type: "model.sampling.retry" },
      { sequence: 5, type: "model.output.delta" },
      { sequence: 6, type: "segment.completed" },
    ],
  );
  assert.equal(
    events.find((event) => event.type === "model.sampling.retry")?.data
      .discardedOutput,
    false,
  );
  assert.equal(
    events.find((event) => event.type === "segment.completed")?.data.output,
    "done",
  );
});

test("uses classified Retry-After inside the same Turn", async () => {
  let requests = 0;
  const retryDelays: number[] = [];
  const transport: ModelTransportPort = {
    adapterName: "classified-adapter",
    adapterVersion: "1",
    modelId: "classified-provider",
    async *stream() {
      requests += 1;
      if (requests === 1) {
        throw new ModelTransportError({
          category: "rateLimit",
          code: "responses_rate_limited",
          retryable: true,
          retryAfterMs: 2_500,
        });
      }
      yield { type: "completed", checkpoint: null };
    },
  };
  const events = await collect(
    new CrewONAgentKernel({
      transport,
      streamMaxRetries: 1,
      retryScheduler: {
        wait: async (delayMs) => {
          retryDelays.push(delayMs);
        },
      },
    }).runSegment(segmentContract(), new AbortController().signal),
  );

  assert.equal(requests, 2);
  assert.deepEqual(retryDelays, [2_500]);
  assert.deepEqual(
    events.map(({ sequence, type }) => ({ sequence, type })),
    [
      { sequence: 1, type: "segment.started" },
      { sequence: 2, type: "model.sampling.retry" },
      { sequence: 3, type: "segment.completed" },
    ],
  );
});

test("marks classified transport failure terminal after retry exhaustion", async () => {
  const transport: ModelTransportPort = {
    adapterName: "classified-adapter",
    adapterVersion: "1",
    modelId: "classified-provider",
    async *stream() {
      throw new ModelTransportError({
        category: "rateLimit",
        code: "responses_rate_limited",
        retryable: true,
        retryAfterMs: 2_500,
      });
    },
  };

  await assert.rejects(
    collect(
      new CrewONAgentKernel({ transport, streamMaxRetries: 0 }).runSegment(
        segmentContract(),
        new AbortController().signal,
      ),
    ),
    (error) =>
      error instanceof AgentKernelError &&
      error.code === "responses_rate_limited" &&
      !error.retryable &&
      error.retryAfterMs === 2_500,
  );
});

test("retries an explicitly retryable model terminal in the same segment", async () => {
  let requests = 0;
  const transport: ModelTransportPort = {
    adapterName: "failed-event-adapter",
    adapterVersion: "1",
    modelId: "failed-event-provider",
    async *stream() {
      requests += 1;
      if (requests === 1) {
        yield { type: "failed", code: "provider_busy", retryable: true };
        return;
      }
      yield { type: "output.delta", delta: "done" };
      yield { type: "completed", checkpoint: null };
    },
  };
  const events = await collect(
    new CrewONAgentKernel({
      transport,
      streamMaxRetries: 1,
      retryScheduler: { wait: async () => undefined },
    }).runSegment(segmentContract(), new AbortController().signal),
  );

  assert.equal(requests, 2);
  assert.deepEqual(
    events.map(({ sequence, type }) => ({ sequence, type })),
    [
      { sequence: 1, type: "segment.started" },
      { sequence: 2, type: "model.sampling.retry" },
      { sequence: 3, type: "model.output.delta" },
      { sequence: 4, type: "segment.completed" },
    ],
  );
});

function segmentContract() {
  return {
    schemaVersion: "crewon.agent-segment.v0",
    purpose: "agent",
    runId: "run-1",
    segmentId: "segment-1",
    attempt: 1,
    agentVersionId: "agent-version-1",
    policySnapshotId: "policy-1",
    collaborationMode: "default",
    allowedTools: null,
    history: [{ type: "message", role: "user" as const, content: "hello" }],
    continuation: { kind: "manual" },
    budget: { maxOutputBytes: 32 * 1024 },
  } as const;
}

function fixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(
      new URL(import.meta.resolve(`@crewon/test-contracts/fixtures/${name}`)),
      "utf8",
    ),
  ) as T;
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) {
    values.push(value);
  }
  return values;
}

function hasKernelCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof AgentKernelError && error.code === code;
}
