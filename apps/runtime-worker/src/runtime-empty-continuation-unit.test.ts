import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadContinuationCheckpoint } from "@crewon/application";
import type { ModelContextProjection } from "@crewon/context";
import type {
  RunAttemptState,
  RunStepState,
  RunLifecycleEvent,
} from "@crewon/domain";
import {
  loadEmptyContinuation,
  selectEmptyContinuation,
} from "./runtime-empty-continuation.ts";

const time = "2026-09-15T00:00:00.000Z";
const run = {
  tenantId: "tenant-1",
  runId: "run-1",
  threadId: "thread-1",
  agentVersionId: "agent-1",
};
const identity = {
  agentVersionId: "agent-1",
  adapterName: "test",
  adapterVersion: "1",
  modelId: "model-1",
};
const checkpoint = {
  schemaVersion: "crewon.provider-checkpoint.v0",
  adapterName: "test",
  adapterVersion: "1",
  modelId: "model-1",
  opaquePayload: { responseId: "response-1" },
} as const;
const marker: Extract<
  RunLifecycleEvent,
  { type: "segment.provider_continuation" }
> = {
  schemaVersion: "crewon.run-event.v0",
  identity: { runId: run.runId },
  eventId: "event-1",
  sequence: 3,
  occurredAt: time,
  type: "segment.provider_continuation",
  data: {
    segmentId: "segment-1",
    segmentSequence: 3,
    sampleIndex: 1,
    throughHistorySequence: 1,
    emptyContinuation: {
      stepId: "step-1",
      attemptId: "attempt-1",
      contextRevision: "canonical",
    },
  },
};
const step: RunStepState = {
  schemaVersion: "crewon.run-step.v0",
  tenantId: run.tenantId,
  runId: run.runId,
  stepId: "step-1",
  kind: "model",
  status: "completed",
  revision: 2,
  currentAttemptId: "attempt-1",
  attemptCount: 1,
  createdAt: time,
  updatedAt: time,
  terminalAt: time,
};
const attempt: RunAttemptState = {
  schemaVersion: "crewon.run-attempt.v0",
  tenantId: run.tenantId,
  runId: run.runId,
  stepId: "step-1",
  attemptId: "attempt-1",
  workItemId: "work-1",
  attemptNumber: 1,
  retryOfAttemptId: null,
  leaseEpoch: 1,
  status: "completed",
  checkpointDigest: null,
  providerCheckpoint: checkpoint,
  providerTurnState: null,
  failure: null,
  startedAt: time,
  updatedAt: time,
  terminalAt: time,
};
const stored: ThreadContinuationCheckpoint = {
  ...run,
  ...identity,
  checkpoint,
  throughHistorySequence: 1,
  contextRevision: "canonical",
  updatedAt: time,
};
const projection: ModelContextProjection = {
  items: [{ type: "message", role: "user", content: "stable" }],
  sourceSequences: [1],
  revision: "canonical",
  historyRewritten: false,
  repairs: [],
  throughHistorySequence: 1,
  compactedThroughSequence: null,
  byteLength: 6,
};

test("empty continuation selects only the unseen tail without requiring a fabricated assistant anchor", () => {
  assert.deepEqual(selectEmptyContinuation(projection, stored), {
    kind: "providerCheckpoint",
    checkpoint,
    newHistoryStartIndex: 1,
  });
  const appended: ModelContextProjection = {
    ...projection,
    throughHistorySequence: 2,
    sourceSequences: [1, 2],
    items: [
      ...projection.items,
      { type: "message", role: "user", content: "steering" },
    ],
  };
  assert.deepEqual(selectEmptyContinuation(appended, stored), {
    kind: "providerCheckpoint",
    checkpoint,
    newHistoryStartIndex: 1,
  });
  assert.deepEqual(
    selectEmptyContinuation(
      {
        ...appended,
        items: [
          ...projection.items,
          { type: "message", role: "assistant", content: "foreign output" },
        ],
      },
      stored,
    ),
    { kind: "manual" },
  );
});

test("empty continuation falls back after a rewrite, repair or unavailable history and permits a stable compaction", () => {
  for (const value of [
    null,
    { ...stored, contextRevision: "rollback-1" },
    { ...stored, throughHistorySequence: 2 },
    { ...stored, throughHistorySequence: 0 },
  ]) {
    assert.deepEqual(selectEmptyContinuation(projection, value), {
      kind: "manual",
    });
  }
  assert.deepEqual(
    selectEmptyContinuation(
      {
        ...projection,
        repairs: [
          {
            kind: "missingToolResultInserted",
            toolKind: "function",
            callId: "call-1",
          },
        ],
      },
      stored,
    ),
    { kind: "manual" },
  );
  assert.equal(
    selectEmptyContinuation(
      { ...projection, revision: "compaction-1", historyRewritten: true },
      { ...stored, contextRevision: "compaction-1" },
    ).kind,
    "providerCheckpoint",
  );
});

test("Run-private empty continuation loads only its immutable completed Attempt by scoped keys", async () => {
  const reads: unknown[] = [];
  const actual = await loadEmptyContinuation({
    run,
    event: marker,
    identity,
    store: {
      loadRunAttempt: async (input) => {
        reads.push(input);
        return attempt;
      },
      loadRunStep: async (input) => {
        reads.push(input);
        return step;
      },
    },
    onInvalid: (code) => {
      throw new Error(code);
    },
  });
  assert.deepEqual(actual, {
    tenantId: run.tenantId,
    threadId: run.threadId,
    ...identity,
    checkpoint,
    throughHistorySequence: 1,
    contextRevision: "canonical",
    updatedAt: time,
  });
  assert.deepEqual(reads, [
    {
      tenantId: run.tenantId,
      runId: run.runId,
      stepId: step.stepId,
      attemptId: attempt.attemptId,
    },
    { tenantId: run.tenantId, runId: run.runId, stepId: step.stepId },
  ]);
});

test("Run-private empty continuation rejects unfinished, foreign or substituted authority", async () => {
  const base = {
    run,
    event: marker,
    identity,
    onInvalid: (code: string): never => {
      throw new Error(code);
    },
  };
  for (const value of [
    null,
    { ...attempt, status: "running" as const },
    { ...attempt, tenantId: "foreign" },
    { ...attempt, attemptId: "other" },
    { ...attempt, terminalAt: "2026-09-14T00:00:00.000Z" },
  ]) {
    await assert.rejects(
      loadEmptyContinuation({
        ...base,
        store: {
          loadRunAttempt: async () => value,
          loadRunStep: async () => step,
        },
      }),
      /empty_continuation_attempt_invalid/,
    );
  }
  for (const value of [
    null,
    { ...step, kind: "tool" as const },
    { ...step, runId: "foreign" },
    { ...step, currentAttemptId: "other" },
  ]) {
    await assert.rejects(
      loadEmptyContinuation({
        ...base,
        store: {
          loadRunAttempt: async () => attempt,
          loadRunStep: async () => value,
        },
      }),
      /empty_continuation_attempt_invalid/,
    );
  }
  const store = {
    loadRunAttempt: async () => attempt,
    loadRunStep: async () => step,
  };
  await assert.rejects(
    loadEmptyContinuation({
      ...base,
      store,
      event: { ...marker, identity: { runId: "foreign" } },
    }),
    /empty_continuation_source_invalid/,
  );
  await assert.rejects(
    loadEmptyContinuation({
      ...base,
      store,
      identity: { ...identity, modelId: "other" },
    }),
    /empty_continuation_model_mismatch/,
  );
  assert.equal(
    await loadEmptyContinuation({
      ...base,
      store: {
        ...store,
        loadRunAttempt: async () => ({ ...attempt, providerCheckpoint: null }),
      },
    }),
    null,
  );
});
