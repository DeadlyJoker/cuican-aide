import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentKernelError,
  CrewONAgentKernel,
  type ModelRequest,
  type ModelTransportPort,
} from "@crewon/agent-kernel";
import {
  type ContextCompactionContract,
  type ContextHistoryItem,
} from "@crewon/context";
import { KernelContextCompactor } from "./kernel-context-compactor.ts";

const user = (content: string): ContextHistoryItem => ({
  type: "message",
  role: "user",
  content,
});
const overflow = "responses_provider_context_length_exceeded";
function input(
  history: readonly ContextHistoryItem[],
): ContextCompactionContract {
  return {
    runId: "run",
    segmentId: "segment",
    attempt: 1,
    agentVersionId: "version",
    policySnapshotId: "policy",
    history,
    maxOutputBytes: 32768,
  };
}
function fixture(
  fail: (request: ModelRequest, index: number) => boolean = (_, index) =>
    index === 0,
) {
  const requests: ModelRequest[] = [];
  const sources: ContextHistoryItem[][] = [];
  const transport: ModelTransportPort = {
    adapterName: "fixture",
    adapterVersion: "1",
    modelId: "fixture",
    async *stream(request) {
      requests.push(structuredClone(request));
      if (fail(request, requests.length - 1)) {
        yield { type: "failed", code: overflow, retryable: false };
        return;
      }
      const source = request.input.items.slice(0, -1) as ContextHistoryItem[];
      sources.push(source);
      yield {
        type: "output.delta",
        delta:
          source
            .filter((item) => item.type === "message")
            .map((item) => item.content)
            .join("|") || "tool evidence",
      };
      yield {
        type: "usage",
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        cachedInputTokens: 4,
        cachedInputTokensReported: true,
      };
      yield { type: "completed", checkpoint: null };
    },
  };
  return {
    requests,
    sources,
    compactor: new KernelContextCompactor(
      new CrewONAgentKernel({
        transport,
        instructions: "stable",
        streamMaxRetries: 0,
      }),
    ),
  };
}

test("overflow summaries cover every source exactly once, in original order", async () => {
  const f = fixture();
  const history = [
    user("first constraint"),
    user("middle decision"),
    user("last request"),
  ];
  const result = await f.compactor.compact(
    input(history),
    new AbortController().signal,
  );
  assert.deepEqual(f.sources.flat(), history);
  assert.equal(f.requests.length, 3);
  for (const item of history)
    if (item.type === "message")
      assert.ok(result.summary.includes(item.content));
  assert.equal(result.usage.inputTokens, 20);
  assert.equal(result.usage.cachedInputTokens, 8);
  assert.equal(result.usage.cachedInputTokensReported, true);
});

test("preflight partitions the entire source within the caller input limit", async () => {
  const f = fixture(() => false);
  const history = Array.from({ length: 18 }, (_, i) => user(`constraint-${i}`));
  const result = await f.compactor.compact(
    { ...input(history), inputLimits: { maxItems: 8, maxBytes: 8192 } },
    new AbortController().signal,
  );
  assert.deepEqual(f.sources.flat(), history);
  assert.ok(f.requests.every((request) => request.input.items.length <= 8));
  assert.equal(f.requests.length, 3);
  assert.ok(result.summary.includes("constraint-0"));
  assert.ok(result.summary.includes("constraint-17"));
});

test("partition budget is checked before paying for any part", async () => {
  const f = fixture(() => false);
  await assert.rejects(
    f.compactor.compact(
      {
        ...input(Array.from({ length: 100 }, (_, i) => user(`item-${i}`))),
        inputLimits: { maxItems: 3, maxBytes: 8192 },
      },
      new AbortController().signal,
    ),
    (error) =>
      error instanceof AgentKernelError &&
      error.code === "compaction_partition_limit_exceeded",
  );
  assert.equal(f.requests.length, 0);
});

test("overflow keeps parallel tools and results together across all covered partitions", async () => {
  const f = fixture();
  const history: ContextHistoryItem[] = [
    {
      type: "tool_call",
      callId: "a",
      kind: "function",
      name: "read",
      input: "{}",
    },
    {
      type: "tool_call",
      callId: "b",
      kind: "custom",
      name: "search",
      input: "query",
    },
    { type: "tool_result", callId: "b", kind: "custom", output: "second" },
    { type: "tool_result", callId: "a", kind: "function", output: "first" },
    user("tail"),
  ];
  await f.compactor.compact(input(history), new AbortController().signal);
  assert.deepEqual(f.sources, [history.slice(0, 4), history.slice(4)]);
});

test("UTF-8 byte limits partition before the first request without dropping a message", async () => {
  const f = fixture(() => false);
  const history = [user("界".repeat(120)), user("文".repeat(120))];
  await f.compactor.compact(
    { ...input(history), inputLimits: { maxItems: 100, maxBytes: 1024 } },
    new AbortController().signal,
  );
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.sources.flat(), history);
  for (const request of f.requests)
    assert.ok(
      request.input.items.reduce(
        (sum, item) => sum + Buffer.byteLength(JSON.stringify(item)),
        0,
      ) <= 1024,
    );
});

test("an oversized indivisible parallel Tool batch fails before requesting a misleading summary", async () => {
  const f = fixture(() => false);
  const history: ContextHistoryItem[] = [
    {
      type: "tool_call",
      callId: "a",
      kind: "function",
      name: "read",
      input: "{}",
    },
    {
      type: "tool_call",
      callId: "b",
      kind: "function",
      name: "read",
      input: "{}",
    },
    { type: "tool_result", callId: "a", kind: "function", output: "a" },
    { type: "tool_result", callId: "b", kind: "function", output: "b" },
    user("last"),
  ];
  await assert.rejects(
    f.compactor.compact(
      { ...input(history), inputLimits: { maxItems: 4, maxBytes: 8192 } },
      new AbortController().signal,
    ),
    (error) =>
      error instanceof AgentKernelError &&
      error.code === "compaction_source_unit_limit_exceeded",
  );
  assert.equal(f.requests.length, 0);
});

test("a later failed partition never returns the earlier successful summary as complete", async () => {
  const f = fixture((_, index) => index === 0 || index === 2);
  await assert.rejects(
    f.compactor.compact(
      input([user("one"), user("two")]),
      new AbortController().signal,
    ),
    (error) => error instanceof AgentKernelError && error.code === overflow,
  );
  assert.equal(f.sources.length, 1);
  assert.equal(f.requests.length, 3);
});

test("cancellation between parts prevents remaining model calls", async () => {
  const controller = new AbortController();
  const f = fixture((_, index) => {
    if (index === 1) controller.abort();
    return index === 0;
  });
  await assert.rejects(
    f.compactor.compact(input([user("one"), user("two")]), controller.signal),
  );
  assert.equal(f.requests.length, 2);
});

test("too little output space for all checkpoints fails before any request", async () => {
  const f = fixture(() => false);
  await assert.rejects(
    f.compactor.compact(
      {
        ...input([user("one"), user("two")]),
        maxOutputBytes: 1024,
        inputLimits: { maxItems: 2, maxBytes: 8192 },
      },
      new AbortController().signal,
    ),
    (error) =>
      error instanceof AgentKernelError &&
      error.code === "compaction_output_budget_insufficient",
  );
  assert.equal(f.requests.length, 0);
});

test("all output parts and separators share the original UTF-8 byte budget", async () => {
  let calls = 0;
  const budgets: number[] = [];
  const transport: ModelTransportPort = {
    adapterName: "fixture",
    adapterVersion: "1",
    modelId: "fixture",
    async *stream(request) {
      calls += 1;
      if (calls === 1) {
        yield { type: "failed", code: overflow, retryable: false };
        return;
      }
      budgets.push(request.maxOutputBytes);
      yield {
        type: "output.delta",
        delta: "界".repeat(Math.floor(request.maxOutputBytes / 3)),
      };
      yield {
        type: "usage",
        inputTokens: 10,
        cachedInputTokens: 0,
        cachedInputTokensReported: false,
        outputTokens: 2,
        totalTokens: 12,
      };
      yield { type: "completed", checkpoint: null };
    },
  };
  const compactor = new KernelContextCompactor(
    new CrewONAgentKernel({ transport, streamMaxRetries: 0 }),
  );
  const result = await compactor.compact(
    { ...input([user("one"), user("two")]), maxOutputBytes: 4096 },
    new AbortController().signal,
  );
  assert.equal(calls, 3);
  assert.ok(budgets.reduce((sum, bytes) => sum + bytes, 0) < 4096);
  assert.ok(Buffer.byteLength(result.summary) <= 4096);
  assert.ok(Buffer.byteLength(result.summary) >= 4088);
  assert.equal(result.usage.cachedInputTokensReported, false);
});

test("adaptive splitting shares its overflow budget and never resubmits a completed source part", async () => {
  const f = fixture((request) => request.input.items.length > 3);
  const history = Array.from({ length: 8 }, (_, index) =>
    user(`source-${index}`),
  );
  await f.compactor.compact(input(history), new AbortController().signal);
  assert.equal(f.requests.length, 7);
  assert.equal(f.sources.length, 4);
  assert.deepEqual(f.sources.flat(), history);
  assert.ok(f.requests.every((request) => request.instructions === "stable"));
});

test("invalid source Tool pairing fails before any paid request", async () => {
  const f = fixture(() => false);
  for (const history of [
    [
      user("source"),
      {
        type: "tool_result",
        kind: "function",
        callId: "absent",
        output: "orphan",
      },
    ],
    [
      {
        type: "tool_call",
        kind: "function",
        callId: "pending",
        name: "read",
        input: "{}",
      },
      user("source"),
    ],
  ] as ContextHistoryItem[][])
    await assert.rejects(
      f.compactor.compact(input(history), new AbortController().signal),
      (error) =>
        error instanceof AgentKernelError &&
        error.code === "compaction_source_tool_boundary_invalid",
    );
  assert.equal(f.requests.length, 0);
});
