import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AgentKernelError,
  type AgentKernelPort,
  type AgentSegmentContract,
  type KernelAgentEvent,
} from "@crewon/agent-kernel";
import { CONTEXT_COMPACTION_PROMPT } from "@crewon/context";

import { KernelContextCompactor } from "./kernel-context-compactor.ts";

test("turns one retrying Kernel segment into a bounded compaction result", async () => {
  const captured: AgentSegmentContract[] = [];
  const kernel = fakeKernel(async function* (contract) {
    captured.push(contract);
    yield event(contract, 1, "segment.started", {
      attempt: contract.attempt,
      model: "fixture-model",
    });
    yield event(contract, 2, "model.output.delta", { delta: "discarded" });
    yield event(contract, 3, "usage.recorded", {
      inputTokens: 2,
      cachedInputTokens: 0,
      outputTokens: 1,
      totalTokens: 3,
    });
    yield event(contract, 4, "model.sampling.retry", {
      samplingAttempt: 1,
      maxRetries: 1,
      code: "stream_closed",
      discardedOutput: true,
    });
    yield event(contract, 5, "model.output.delta", { delta: "summary" });
    yield event(contract, 6, "usage.recorded", {
      inputTokens: 7,
      cachedInputTokens: 2,
      outputTokens: 1,
      totalTokens: 8,
    });
    yield event(contract, 7, "segment.completed", { output: "summary" });
  });

  const result = await new KernelContextCompactor(kernel).compact(
    compactionContract(),
    new AbortController().signal,
  );

  assert.deepEqual(result, {
    summary: "summary",
    usage: {
      inputTokens: 7,
      cachedInputTokens: 2,
      outputTokens: 1,
      totalTokens: 8,
    },
  });
  assert.equal(captured[0]?.purpose, "compaction");
  assert.deepEqual(captured[0]?.continuation, { kind: "manual" });
  assert.deepEqual(captured[0]?.history.at(-1), {
    type: "message",
    role: "user",
    content: CONTEXT_COMPACTION_PROMPT,
  });
});

test("rejects Tool events from a compaction adapter", async () => {
  const kernel = fakeKernel(async function* (contract) {
    yield event(contract, 1, "tool.requested", {
      callId: "call-1",
      kind: "function",
      name: "read_file",
      input: "{}",
    });
  });

  await assert.rejects(
    new KernelContextCompactor(kernel).compact(
      compactionContract(),
      new AbortController().signal,
    ),
    (error) =>
      error instanceof AgentKernelError &&
      error.code === "compaction_tool_call_unsupported",
  );
});

test("matches AR-025 by dropping one oldest item after a context-window failure", async () => {
  const reference = JSON.parse(
    readFileSync(
      new URL(
        "../../../packages/test-contracts/fixtures/context-window-compaction.reference.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Readonly<{
    kernelFailureCode: string;
    expected: Readonly<Record<string, unknown>>;
  }>;
  const captured: AgentSegmentContract[] = [];
  const kernel = fakeKernel(async function* (contract) {
    captured.push(structuredClone(contract));
    if (captured.length === 1) {
      yield event(contract, 1, "segment.failed", {
        code: reference.kernelFailureCode,
        retryable: false,
      });
      return;
    }
    yield event(contract, 1, "model.output.delta", { delta: "summary" });
    yield event(contract, 2, "usage.recorded", {
      inputTokens: 3,
      cachedInputTokens: 0,
      outputTokens: 1,
      totalTokens: 4,
    });
    yield event(contract, 3, "segment.completed", { output: "summary" });
  });
  const result = await new KernelContextCompactor(kernel).compact(
    {
      ...compactionContract(),
      history: [
        { type: "message", role: "user", content: "oldest" },
        { type: "message", role: "assistant", content: "newest" },
      ],
    },
    new AbortController().signal,
  );
  const first = captured[0]?.history ?? [];
  const second = captured[1]?.history ?? [];

  assert.deepEqual(result, {
    summary: "summary",
    usage: {
      inputTokens: 3,
      cachedInputTokens: 0,
      outputTokens: 1,
      totalTokens: 4,
    },
  });
  assert.deepEqual(
    {
      compactionRequestCount: captured.length,
      historyItemsDroppedPerContextError: first.length - second.length,
      oldestItemChanged: JSON.stringify(first[0]) !== JSON.stringify(second[0]),
      promptStable:
        JSON.stringify(first.at(-1)) === JSON.stringify(second.at(-1)),
      terminal: "completed",
    },
    reference.expected,
  );
});

function fakeKernel(
  runSegment: AgentKernelPort["runSegment"],
): AgentKernelPort {
  return {
    modelIdentity: {
      adapterName: "fixture-adapter",
      adapterVersion: "1",
      modelId: "fixture-model",
    },
    runSegment,
  };
}

function compactionContract() {
  return {
    runId: "run-1",
    segmentId: "segment-1",
    attempt: 1,
    agentVersionId: "agent-version-1",
    policySnapshotId: "policy-1",
    history: [
      { type: "message", role: "user" as const, content: "long history" },
    ],
    maxOutputBytes: 32 * 1024,
  } as const;
}

function event<T extends KernelAgentEvent["type"]>(
  contract: AgentSegmentContract,
  sequence: number,
  type: T,
  data: Extract<KernelAgentEvent, { type: T }>["data"],
): Extract<KernelAgentEvent, { type: T }> {
  return {
    schemaVersion: "crewon.agent-event.v0",
    runId: contract.runId,
    segmentId: contract.segmentId,
    sequence,
    type,
    data,
  } as Extract<KernelAgentEvent, { type: T }>;
}
