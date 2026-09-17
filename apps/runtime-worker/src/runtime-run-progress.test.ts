import assert from "node:assert/strict";
import test from "node:test";
import type { RunLifecycleEvent } from "@crewon/domain";
import { RunExecutionProgress as RuntimeRunProgress } from "@crewon/application";

const base = {
  schemaVersion: "crewon.run-event.v0",
  identity: { runId: "run-1" },
  eventId: "event-1",
  occurredAt: "2026-09-15T00:00:00.000Z",
} as const;
function progress() {
  return new RuntimeRunProgress({
    runId: "run-1",
    onInvalid: (code) => {
      throw new Error(code);
    },
  });
}
function marker(
  sequence: number,
  sampleIndex: number,
  empty: boolean,
  segmentId = "segment-1",
): Extract<RunLifecycleEvent, { type: "segment.provider_continuation" }> {
  return {
    ...base,
    sequence,
    type: "segment.provider_continuation",
    data: {
      segmentId,
      segmentSequence: sequence,
      sampleIndex,
      throughHistorySequence: sampleIndex,
      ...(empty
        ? {
            emptyContinuation: {
              stepId: "step-1",
              attemptId: "attempt-1",
              contextRevision: "canonical",
            },
          }
        : {}),
    },
  };
}

test("paged Run progress counts assistant-only continuations separately from mixed Tool samples", () => {
  const fold = progress();
  fold.accept(marker(1, 1, true));
  fold.accept(marker(2, 2, false));
  fold.accept({
    ...base,
    sequence: 3,
    type: "tool.requested",
    data: {
      segmentId: "tool-segment",
      segmentSequence: 2,
      callId: "call-1",
      kind: "function",
      name: "read",
      input: "{}",
    },
  });
  fold.accept(marker(4, 3, false, "tool-segment"));
  assert.equal(fold.snapshot().assistantContinuationSamples, 2);
  assert.equal(fold.snapshot().emptyProviderContinuationSamples, 1);
  assert.equal(fold.snapshot().providerContinuationSamples, 3);
  assert.equal(fold.snapshot().pendingTools.length, 1);
  assert.equal(fold.snapshot().lastSegmentSequence, 4);
  fold.accept({
    ...base,
    sequence: 5,
    type: "tool.completed",
    data: {
      segmentId: "tool-segment",
      segmentSequence: 5,
      callId: "call-1",
      kind: "function",
      name: "read",
      output: "done",
      isError: false,
      artifactRef: null,
      outputTruncated: false,
    },
  });
  assert.deepEqual(fold.snapshot().pendingTools, []);
  assert.equal(fold.snapshot().lastSegmentSequence, 0);
  assert.equal(fold.snapshot().completedToolRounds, 1);
});

test("compaction invalidates the response anchor and usage without resetting cumulative continuation counts", () => {
  const fold = progress();
  fold.accept(marker(1, 1, true));
  for (let sequence = 2; sequence <= 10001; sequence++)
    fold.accept({
      ...base,
      sequence,
      type: "usage.recorded",
      data: {
        segmentId: "segment-1",
        segmentSequence: sequence,
        inputTokens: 1,
        outputTokens: 0,
        totalTokens: sequence,
      },
    });
  assert.equal(fold.snapshot().latestUsageTotalTokens, 10001);
  assert.ok(fold.snapshot().emptyContinuation);
  fold.accept({
    ...base,
    sequence: 10002,
    type: "context.compacted",
    data: {
      stepId: "compact-1",
      compactionItemId: "item-1",
      mode: "auto",
      replacesThroughSequence: 1,
      inputTokens: 100,
      outputTokens: 10,
      totalTokens: 110,
    },
  });
  assert.equal(fold.snapshot().emptyContinuation, null);
  assert.equal(fold.snapshot().latestUsageTotalTokens, null);
  assert.equal(fold.snapshot().emptyProviderContinuationSamples, 1);
  assert.equal(fold.snapshot().assistantContinuationSamples, 1);
});

test("paged Run progress rejects gaps, foreign Runs and forged continuation markers", () => {
  for (const event of [
    marker(2, 1, true),
    { ...marker(1, 1, true), identity: { runId: "foreign" } },
  ])
    assert.throws(
      () => progress().accept(event),
      /run_event_history_incomplete/,
    );
  assert.throws(
    () => progress().accept(marker(1, 2, true)),
    /provider_continuation_sequence_invalid/,
  );
  const forged = marker(1, 1, true);
  assert.throws(
    () =>
      progress().accept({
        ...forged,
        data: {
          ...forged.data,
          emptyContinuation: {
            stepId: "",
            attemptId: "attempt-1",
            contextRevision: "canonical",
          },
        },
      }),
    /provider_continuation_sequence_invalid/,
  );
});

test("progress checkpoints retain references and rehydrate tool bodies in canonical order", () => {
  const fold = progress();
  const request: Extract<RunLifecycleEvent, { type: "tool.requested" }> = {
    ...base,
    sequence: 1,
    type: "tool.requested",
    data: {
      segmentId: "tools",
      segmentSequence: 1,
      callId: "call-1",
      kind: "function",
      name: "read",
      input: "x".repeat(32000),
    },
  };
  fold.accept(request);
  const saved = fold.checkpoint();
  assert(saved.payload.length < 1000);
  assert(!saved.payload.includes(request.data.input));
  const restored = new RuntimeRunProgress({
    runId: "run-1",
    checkpoint: saved,
    onInvalid: (code) => {
      throw new Error(code);
    },
  });
  const next = {
    ...request,
    sequence: 2,
    eventId: "second",
    data: {
      ...request.data,
      segmentSequence: 2,
      callId: "call-2",
      input: "second",
    },
  };
  restored.accept(next);
  assert.deepEqual(restored.missingReferenceSequences(), [1]);
  assert.throws(
    () => restored.snapshot(),
    /run_execution_progress_reference_missing/,
  );
  assert.throws(
    () =>
      restored.hydrate({
        ...request,
        data: { ...request.data, segmentId: "foreign" },
      }),
    /run_execution_progress_reference_invalid/,
  );
  restored.hydrate(request);
  assert.deepEqual(
    restored.snapshot().pendingTools.map((event) => event.data.callId),
    ["call-1", "call-2"],
  );
  assert.equal(restored.snapshot().lastSegmentSequence, 2);
});

test("checkpointed empty response anchors survive restoration without replaying their counters", () => {
  const fold = progress(),
    empty = marker(1, 1, true);
  fold.accept(empty);
  const restored = new RuntimeRunProgress({
    runId: "run-1",
    checkpoint: fold.checkpoint(),
    onInvalid: (code) => {
      throw new Error(code);
    },
  });
  restored.hydrate(empty);
  assert.equal(restored.snapshot().emptyProviderContinuationSamples, 1);
  assert.deepEqual(restored.snapshot(), fold.snapshot());
  fold.accept(marker(2, 2, true));
  const saved = fold.checkpoint();
  const wrongAnchor = new RuntimeRunProgress({
    runId: "run-1",
    checkpoint: {
      ...saved,
      payload: JSON.stringify({
        ...JSON.parse(saved.payload),
        emptyContinuationSequence: 1,
      }),
    },
    onInvalid: (code) => {
      throw new Error(code);
    },
  });
  assert.throws(
    () => wrongAnchor.hydrate(empty),
    /run_execution_progress_reference_invalid/,
  );
  restored.accept(marker(2, 2, false));
  assert.equal(restored.snapshot().emptyContinuation, null);
  assert.equal(restored.snapshot().emptyProviderContinuationSamples, 1);
});

test("checkpointed progress rejects impossible counts and tool references", () => {
  const fold = progress();
  fold.accept(marker(1, 1, true));
  const checkpoint = fold.checkpoint();
  for (const patch of [
    { schemaVersion: "unknown" },
    { emptyProviderContinuationSamples: 9 },
    { emptyContinuationSequence: 2 },
    {
      pendingTools: [
        { callId: "c", segmentId: "s", sequence: 1, segmentSequence: 1 },
      ],
    },
    { completedToolSegments: Array(129).fill("same") },
  ]) {
    assert.throws(
      () =>
        new RuntimeRunProgress({
          runId: "run-1",
          checkpoint: {
            ...checkpoint,
            payload: JSON.stringify({
              ...JSON.parse(checkpoint.payload),
              ...patch,
            }),
          },
          onInvalid: (code) => {
            throw new Error(code);
          },
        }),
      /run_execution_progress_payload_invalid/,
    );
  }
});

test("progress replay rejects a seventeenth pending body immediately and preserves duplicate-call rejection", () => {
  const fold = progress();
  const event = (
    sequence: number,
  ): Extract<RunLifecycleEvent, { type: "tool.requested" }> => ({
    ...base,
    sequence,
    type: "tool.requested",
    data: {
      segmentId: "tools",
      segmentSequence: sequence,
      callId: `call-${sequence}`,
      kind: "function",
      name: "read",
      input: "{}",
    },
  });
  for (let sequence = 1; sequence <= 16; sequence++)
    fold.accept(event(sequence));
  assert.throws(
    () => fold.accept(event(17)),
    /run_execution_progress_pending_tool_limit_exceeded/,
  );
  const duplicate = progress();
  duplicate.accept(event(1));
  assert.throws(
    () =>
      duplicate.accept({
        ...event(2),
        data: { ...event(2).data, callId: "call-1" },
      }),
    /model_history_tool_call_duplicate/,
  );
});

test("progress replay rejects a 129th completed tool segment before retaining its identity", () => {
  const fold = progress();
  const event = (
    sequence: number,
  ): Extract<RunLifecycleEvent, { type: "tool.completed" }> => ({
    ...base,
    sequence,
    type: "tool.completed",
    data: {
      segmentId: `segment-${sequence}`,
      segmentSequence: 1,
      callId: `call-${sequence}`,
      kind: "function",
      name: "read",
      output: "done",
      isError: false,
      artifactRef: null,
      outputTruncated: false,
    },
  });
  for (let sequence = 1; sequence <= 128; sequence++)
    fold.accept(event(sequence));
  assert.throws(
    () => fold.accept(event(129)),
    /run_execution_progress_completed_tool_limit_exceeded/,
  );
});

test("cancellation can restore 128 legacy pending calls without allowing them into normal execution", () => {
  const onInvalid = (code: string): never => {
    throw new Error(code);
  };
  const fold = new RuntimeRunProgress({
    runId: "run-1",
    purpose: "cancel",
    onInvalid,
  });
  const events: Extract<RunLifecycleEvent, { type: "tool.requested" }>[] =
    Array.from({ length: 128 }, (_, i) => ({
      ...base,
      sequence: i + 1,
      type: "tool.requested",
      data: {
        segmentId: "legacy-tools",
        segmentSequence: i + 1,
        callId: `call-${i}`,
        kind: "function",
        name: "read",
        input: "{}",
      },
    }));
  for (const event of events) fold.accept(event);
  const checkpoint = fold.checkpoint();
  assert.throws(
    () => new RuntimeRunProgress({ runId: "run-1", checkpoint, onInvalid }),
    /run_execution_progress_payload_invalid/,
  );
  const restored = new RuntimeRunProgress({
    runId: "run-1",
    purpose: "cancel",
    checkpoint,
    onInvalid,
  });
  for (const event of events) restored.hydrate(event);
  assert.deepEqual(restored.snapshot().pendingTools, events);
  assert.throws(
    () =>
      restored.accept({
        ...events[0]!,
        sequence: 129,
        data: { ...events[0]!.data, callId: "one-too-many" },
      }),
    /run_execution_progress_pending_tool_limit_exceeded/,
  );
});
