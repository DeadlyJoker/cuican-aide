import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentKernelError,
  CrewONAgentKernel,
  type ModelTransportPort,
} from "@crewon/agent-kernel";
import type {
  ContextCompactionContract,
  ContextCompactionCheckpointPort,
} from "@crewon/context";
import { KernelContextCompactor } from "./kernel-context-compactor.ts";
const input: ContextCompactionContract = {
  runId: "run",
  segmentId: "segment",
  attempt: 1,
  agentVersionId: "version",
  policySnapshotId: "policy",
  history: [
    { type: "message", role: "user", content: "one" },
    { type: "message", role: "user", content: "two" },
  ],
  maxOutputBytes: 32768,
};
function fixture() {
  let row: { digest: string; revision: number; payload: string } | null = null;
  let fail = true;
  let calls = 0;
  const checkpoint: ContextCompactionCheckpointPort = {
    async load(digest) {
      if (row !== null && row.digest !== digest)
        throw new AgentKernelError(
          "compaction_checkpoint_context_mismatch",
          false,
        );
      return row;
    },
    async save(next) {
      const revision = next.expectedRevision + 1;
      row = { digest: next.contextDigest, revision, payload: next.payload };
      if (fail && JSON.parse(next.payload).results.length === 1) {
        fail = false;
        throw new Error("saved_before_disconnect");
      }
      return revision;
    },
  };
  const transport: ModelTransportPort = {
    adapterName: "fixture",
    adapterVersion: "1",
    modelId: "model",
    async *stream() {
      calls++;
      if (calls === 1) {
        yield {
          type: "failed",
          code: "responses_provider_context_length_exceeded",
          retryable: false,
        };
        return;
      }
      yield { type: "output.delta", delta: `summary-${calls}` };
      yield {
        type: "usage",
        inputTokens: 10,
        cachedInputTokens: 4,
        cachedInputTokensReported: true,
        outputTokens: 2,
        totalTokens: 12,
      };
      yield { type: "completed", checkpoint: null };
    },
  };
  return {
    checkpoint,
    calls: () => calls,
    compactor: (instructions = "stable", modelId = "model") =>
      new KernelContextCompactor(
        new CrewONAgentKernel({
          transport: { ...transport, modelId },
          instructions,
          streamMaxRetries: 0,
        }),
      ),
    state: () => JSON.parse(row!.payload),
    corrupt: (mutate: (state: any) => void) => {
      const state = JSON.parse(row!.payload);
      mutate(state);
      row = { ...row!, payload: JSON.stringify(state) };
    },
  };
}

test("checkpoint reuse survives a new segment and attempt without replaying model accounting", async () => {
  const f = fixture();
  await assert.rejects(
    f.compactor().compact(input, new AbortController().signal, {
      checkpoint: f.checkpoint,
    }),
    /saved_before_disconnect/,
  );
  assert.equal(f.calls(), 2);
  const result = await f
    .compactor()
    .compact(
      { ...input, segmentId: "new-segment", attempt: 2 },
      new AbortController().signal,
      { checkpoint: f.checkpoint },
    );
  assert.equal(f.calls(), 3);
  assert.ok(result.summary.includes("summary-2"));
  assert.ok(result.summary.includes("summary-3"));
  assert.equal(result.usage.inputTokens, 20);
  assert.deepEqual(
    f
      .state()
      .results.map((part: { segmentId: string; attempt: number }) => [
        part.segmentId,
        part.attempt,
      ]),
    [
      ["segment", 1],
      ["new-segment", 2],
    ],
  );
});

test("recovery rejects altered source, model, policy and input budgets before resampling", async () => {
  const f = fixture();
  await assert.rejects(
    f.compactor().compact(input, new AbortController().signal, {
      checkpoint: f.checkpoint,
    }),
  );
  for (const changed of [
    { ...input, history: [...input.history].reverse() },
    { ...input, policySnapshotId: "other" },
    { ...input, agentVersionId: "other" },
    { ...input, inputLimits: { maxItems: 10, maxBytes: 10000 } },
  ])
    await assert.rejects(
      f.compactor().compact(changed, new AbortController().signal, {
        checkpoint: f.checkpoint,
      }),
      { code: "compaction_checkpoint_context_mismatch" },
    );
  await assert.rejects(
    f
      .compactor("stable", "other-model")
      .compact(input, new AbortController().signal, {
        checkpoint: f.checkpoint,
      }),
    { code: "compaction_checkpoint_context_mismatch" },
  );
  assert.equal(f.calls(), 2);
});

test("corrupt checkpoints cannot skip sources, broaden output budgets or invent cache coverage", async () => {
  const mutations: Array<(state: any) => void> = [
    (state) => state.pending[0].range.start++,
    (state) => state.results[0].range.end++,
    (state) => (state.pending[0].outputBudget = 32768),
    (state) =>
      (state.results[0].result.usage.cachedInputTokensReported = false),
    (state) => (state.failures = 0),
    (state) => (state.pending = []),
    (state) => (state.schemaVersion = "unknown"),
  ];
  for (const mutate of mutations) {
    const f = fixture();
    await assert.rejects(
      f.compactor().compact(input, new AbortController().signal, {
        checkpoint: f.checkpoint,
      }),
    );
    f.corrupt(mutate);
    await assert.rejects(
      f.compactor().compact(input, new AbortController().signal, {
        checkpoint: f.checkpoint,
      }),
      { code: "compaction_checkpoint_state_invalid" },
    );
    assert.equal(f.calls(), 2);
  }
});
