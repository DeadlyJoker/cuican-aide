import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentKernelError,
  CrewONAgentKernel,
  type ModelRequest,
  type ModelTransportPort,
} from "@crewon/agent-kernel";
import {
  CONTEXT_COMPACTION_PROMPT,
  type ContextCompactionContract,
  type ContextHistoryItem,
} from "@crewon/context";
import { KernelContextCompactor } from "./kernel-context-compactor.ts";

const OVERFLOW = "responses_provider_context_length_exceeded";
const user = (content: string): ContextHistoryItem => ({
  type: "message",
  role: "user",
  content,
});

function contract(
  history: readonly ContextHistoryItem[],
): ContextCompactionContract {
  return {
    runId: "run-1",
    segmentId: "segment-1",
    attempt: 1,
    agentVersionId: "version-1",
    policySnapshotId: "policy-1",
    history,
    maxOutputBytes: 32 * 1024,
  };
}

function fixture(
  options: {
    failures?: number;
    onFailure?: () => void;
    failureCode?: string;
  } = {},
) {
  const requests: ModelRequest[] = [];
  const transport: ModelTransportPort = {
    adapterName: "fixture",
    adapterVersion: "1",
    modelId: "fixture-model",
    async *stream(request) {
      requests.push(structuredClone(request));
      if (requests.length <= (options.failures ?? Infinity)) {
        options.onFailure?.();
        yield {
          type: "failed",
          code: options.failureCode ?? OVERFLOW,
          retryable: false,
        };
        return;
      }
      yield { type: "output.delta", delta: "summary" };
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
    compactor: new KernelContextCompactor(
      new CrewONAgentKernel({
        transport,
        instructions: "stable instructions",
        streamMaxRetries: 0,
      }),
    ),
  };
}

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof AgentKernelError && error.code === code;
}

test("persistent overflow has a fixed recovery budget independent of history length", async () => {
  const { compactor, requests } = fixture();
  const input = contract(
    Array.from({ length: 250 }, (_, index) => user(`history-${index}`)),
  );
  const before = structuredClone(input);
  await assert.rejects(
    compactor.compact(input, new AbortController().signal),
    hasCode(OVERFLOW),
  );
  assert.equal(requests.length, 4);
  assert.deepEqual(input, before);
  for (const [index, request] of requests.entries()) {
    assert.deepEqual(
      request.input.items.slice(0, -1),
      input.history.slice(index),
    );
    assert.equal(request.instructions, "stable instructions");
    assert.deepEqual(
      request.input.items.at(-1),
      user(CONTEXT_COMPACTION_PROMPT),
    );
  }
});

test("overflow never sends an empty source as a successful replacement summary", async () => {
  const { compactor, requests } = fixture({ failures: 1 });
  await assert.rejects(
    compactor.compact(
      contract([user("only source")]),
      new AbortController().signal,
    ),
    hasCode(OVERFLOW),
  );
  assert.equal(requests.length, 1);
});

test("initial empty or governance-only source is rejected before invoking the model", async () => {
  for (const input of [
    contract([]),
    { ...contract([user("governance")]), protectedPrefixLength: 1 },
  ]) {
    const { compactor, requests } = fixture({ failures: 0 });
    await assert.rejects(
      compactor.compact(input, new AbortController().signal),
      hasCode("compaction_source_empty"),
    );
    assert.equal(requests.length, 0);
  }
});

test("a Tool batch spanning the entire source cannot be discarded for a prompt-only retry", async () => {
  const { compactor, requests } = fixture({ failures: 1 });
  await assert.rejects(
    compactor.compact(
      contract([
        {
          type: "tool_call",
          kind: "function",
          callId: "a",
          name: "read",
          input: "{}",
        },
        {
          type: "tool_result",
          kind: "function",
          callId: "a",
          output: "essential result",
        },
      ]),
      new AbortController().signal,
    ),
    hasCode(OVERFLOW),
  );
  assert.equal(requests.length, 1);
});

test("recovery drops a closed parallel Tool batch without orphaning its results", async () => {
  const { compactor, requests } = fixture({ failures: 1 });
  const history: ContextHistoryItem[] = [
    {
      type: "tool_call",
      kind: "function",
      callId: "a",
      name: "read",
      input: "{}",
    },
    {
      type: "tool_call",
      kind: "custom",
      callId: "b",
      name: "search",
      input: "query",
    },
    { type: "tool_result", kind: "custom", callId: "b", output: "second" },
    { type: "tool_result", kind: "function", callId: "a", output: "first" },
    user("recent constraint"),
  ];
  assert.equal(
    (await compactor.compact(contract(history), new AbortController().signal))
      .summary,
    "summary",
  );
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1]?.input.items, [
    history[4],
    user(CONTEXT_COMPACTION_PROMPT),
  ]);
});

test("recovery preserves both trusted and untrusted governance prefix messages verbatim", async () => {
  const { compactor, requests } = fixture({ failures: 2 });
  const prefix: ContextHistoryItem[] = [
    { type: "message", role: "developer", content: "trusted governance" },
    user("untrusted reference data"),
  ];
  const input = {
    ...contract([...prefix, user("oldest"), user("older"), user("latest")]),
    protectedPrefixLength: prefix.length,
  };
  const original = structuredClone(input);
  assert.equal(
    (await compactor.compact(input, new AbortController().signal)).summary,
    "summary",
  );
  assert.equal(requests.length, 3);
  for (const request of requests)
    assert.deepEqual(request.input.items.slice(0, 2), prefix);
  assert.deepEqual(requests[2]?.input.items, [
    ...prefix,
    user("latest"),
    user(CONTEXT_COMPACTION_PROMPT),
  ]);
  assert.deepEqual(input, original);
});

test("a governance-only remainder cannot stand in for source history", async () => {
  const { compactor, requests } = fixture({ failures: 1 });
  await assert.rejects(
    compactor.compact(
      {
        ...contract([user("protected reference"), user("only source")]),
        protectedPrefixLength: 1,
      },
      new AbortController().signal,
    ),
    hasCode(OVERFLOW),
  );
  assert.equal(requests.length, 1);
});

test("invalid protected prefix metadata fails before a model request", async () => {
  for (const protectedPrefixLength of [-1, 0.5, 2, NaN, Infinity]) {
    const { compactor, requests } = fixture();
    await assert.rejects(
      compactor.compact(
        {
          ...contract([user("source")]),
          protectedPrefixLength,
        },
        new AbortController().signal,
      ),
      hasCode("compaction_protected_prefix_invalid"),
    );
    assert.equal(requests.length, 0);
  }
  const { compactor, requests } = fixture();
  await assert.rejects(
    compactor.compact(
      {
        ...contract([
          {
            type: "tool_call",
            kind: "function",
            callId: "a",
            name: "read",
            input: "{}",
          },
          {
            type: "tool_result",
            kind: "function",
            callId: "a",
            output: "result",
          },
        ]),
        protectedPrefixLength: 1,
      },
      new AbortController().signal,
    ),
    hasCode("compaction_protected_prefix_invalid"),
  );
  assert.equal(requests.length, 0);
});

for (const role of ["system", "developer"] as const) {
  test(`recovery cannot remove an unmarked ${role} instruction`, async () => {
    const { compactor, requests } = fixture({ failures: 1 });
    await assert.rejects(
      compactor.compact(
        contract([
          { type: "message", role, content: "governance" },
          user("source"),
        ]),
        new AbortController().signal,
      ),
      hasCode(OVERFLOW),
    );
    assert.equal(requests.length, 1);
  });
}

test("cancellation before or during overflow prevents another request", async () => {
  const controller = new AbortController();
  const { compactor, requests } = fixture({
    onFailure: () => controller.abort(),
  });
  const input = contract([user("one"), user("two")]);
  await assert.rejects(compactor.compact(input, controller.signal));
  assert.equal(requests.length, 1);
  await assert.rejects(compactor.compact(input, controller.signal));
  assert.equal(requests.length, 1);
});

test("non-context failures cannot trigger source trimming", async () => {
  const { compactor, requests } = fixture({ failureCode: "provider_denied" });
  await assert.rejects(
    compactor.compact(
      contract([user("one"), user("two")]),
      new AbortController().signal,
    ),
    hasCode("provider_denied"),
  );
  assert.equal(requests.length, 1);
});
