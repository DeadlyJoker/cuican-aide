import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadModelState } from "@crewon/application";
import type { ModelContextProjection } from "@crewon/context";

import { decideModelSwitchCompaction } from "./model-switch-compaction.ts";

test("requires AR-024 compaction conservatively and suppresses it after the durable boundary", () => {
  const prior = priorState();
  const current = {
    agentVersionId: "agent-small",
    adapterName: "responses",
    adapterVersion: "1",
    modelId: "gpt-small",
    contextWindowTokens: 125_000,
    autoCompactAtTokens: 112_500,
  } as const;

  assert.deepEqual(decideModelSwitchCompaction(prior, current, projection()), {
    required: true,
    replacesThroughSequence: 2,
  });
  assert.deepEqual(
    decideModelSwitchCompaction(
      { ...prior, latestUsage: null },
      current,
      projection(),
    ),
    { required: true, replacesThroughSequence: 2 },
  );
  assert.deepEqual(
    decideModelSwitchCompaction(prior, current, {
      ...projection(),
      compactedThroughSequence: 2,
    }),
    { required: false },
  );
});

function priorState(): ThreadModelState {
  return {
    schemaVersion: "crewon.thread-model-state.v0",
    tenantId: "tenant-1",
    threadId: "thread-1",
    agentVersionId: "agent-large",
    adapterName: "responses",
    adapterVersion: "1",
    modelId: "gpt-large",
    contextWindowTokens: 273_000,
    autoCompactAtTokens: 200_000,
    throughHistorySequence: 2,
    contextRevision: "canonical",
    latestUsage: {
      inputTokens: 119_999,
      outputTokens: 1,
      totalTokens: 120_000,
    },
    updatedAt: "2026-08-09T00:00:00Z",
  };
}

function projection(): ModelContextProjection {
  return {
    items: [
      { type: "message", role: "user", content: "old" },
      { type: "message", role: "assistant", content: "answer" },
      { type: "message", role: "user", content: "new" },
    ],
    sourceSequences: [1, 2, 3],
    revision: "canonical",
    historyRewritten: false,
    repairs: [],
    throughHistorySequence: 3,
    compactedThroughSequence: null,
    byteLength: 11,
  };
}
