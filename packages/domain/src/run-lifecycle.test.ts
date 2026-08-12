import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  compareTraces,
  type CanonicalTrace,
  type TraceObject,
} from "@crewon/test-contracts";
import { RUN_STATUSES as CONTRACT_RUN_STATUSES } from "@crewon/contracts";

import {
  RUN_STATUSES,
  RunLifecycleError,
  reduceRunLifecycleEvent,
  replayRunLifecycle,
  type RunLifecycleEvent,
  type RunState,
} from "./run-lifecycle.ts";

const referenceTrace = JSON.parse(
  readFileSync(
    new URL(
      import.meta.resolve(
        "@crewon/test-contracts/fixtures/run-lifecycle.reference.json",
      ),
    ),
    "utf8",
  ),
) as CanonicalTrace;

const timestamp = (sequence: number) =>
  `2026-08-08T00:00:${sequence.toString().padStart(2, "0")}Z`;

function event(
  sequence: number,
  type: RunLifecycleEvent["type"],
  data: Record<string, unknown>,
  runId = "run-test",
): RunLifecycleEvent {
  return {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId },
    eventId: `event-${sequence}`,
    sequence,
    occurredAt: timestamp(sequence),
    type,
    data,
  } as RunLifecycleEvent;
}

function created(sequence = 1, runId = "run-test"): RunLifecycleEvent {
  return event(
    sequence,
    "run.created",
    {
      threadId: "thread-1",
      tenantId: "tenant-1",
      spaceId: "space-1",
      createdByActorId: "actor-1",
      authorityId: "standalone-1",
      runtimeGeneration: "ts-v0",
      agentVersionId: "agent-version-1",
      policySnapshotId: "policy-1",
      workspaceBindingId: "workspace-1",
      collaborationMode: "default",
      goalBinding: null,
      purpose: "turn",
      origin: null,
    },
    runId,
  );
}

test("replays the shared text-run lifecycle fixture exactly", () => {
  const events = referenceTrace.events as unknown as RunLifecycleEvent[];
  const state = replayRunLifecycle(events);
  const candidate: CanonicalTrace = {
    ...referenceTrace,
    finalState: stableState(state),
  };

  assert.deepEqual(compareTraces(referenceTrace, candidate), { equal: true });
});

test("keeps domain and wire RunStatus values aligned without a runtime dependency", () => {
  assert.deepEqual(RUN_STATUSES, CONTRACT_RUN_STATUSES);
});

test("persists one exact Automation origin across Run replay", () => {
  const origin = automationOrigin("run-automation");
  const state = replayRunLifecycle([
    createdWithOrigin(origin),
    event(2, "run.started", {}, "run-automation"),
    event(3, "run.completed", { outputRef: null }, "run-automation"),
  ]);

  assert.equal(state.purpose, "turn");
  assert.deepEqual(state.origin, origin);
});

test("normalizes a legacy missing Run origin to null", () => {
  const legacy = created();
  assert.equal(legacy.type, "run.created");
  const { origin: _origin, purpose: _purpose, ...legacyData } = legacy.data;
  const state = replayRunLifecycle([
    { ...legacy, data: legacyData } as RunLifecycleEvent,
  ]);

  assert.equal(state.origin, null);
  assert.equal(state.purpose, undefined);
});

test("rejects forged, mismatched and injected Automation Run origins", () => {
  const origin = automationOrigin("run-automation");
  for (const invalid of [
    { ...origin, unexpected: true },
    { ...origin, binding: { ...origin.binding, runId: "run-other" } },
    {
      ...origin,
      binding: {
        ...origin.binding,
        routeDigest: `sha256:${"A".repeat(64)}`,
      },
    },
  ]) {
    assert.throws(
      () => replayRunLifecycle([createdWithOrigin(invalid as never)]),
      RunLifecycleError,
    );
  }
  const withExtraData = createdWithOrigin(origin);
  assert.equal(withExtraData.type, "run.created");
  assert.throws(
    () =>
      replayRunLifecycle([
        {
          ...withExtraData,
          data: { ...withExtraData.data, injected: true },
        } as RunLifecycleEvent,
      ]),
    hasCode("run_created_fields_invalid"),
  );
  const missingPurpose = createdWithOrigin(origin);
  assert.equal(missingPurpose.type, "run.created");
  const { purpose: _purpose, ...dataWithoutPurpose } = missingPurpose.data;
  assert.throws(
    () =>
      replayRunLifecycle([
        { ...missingPurpose, data: dataWithoutPurpose } as RunLifecycleEvent,
      ]),
    hasCode("automation_invocation_purpose_invalid"),
  );
});

test("accepts a bounded transport fallback only while the Run is active", () => {
  const running = replayRunLifecycle([
    created(),
    event(2, "run.started", {}),
    event(3, "model.transport.fallback", {
      segmentId: "segment-1",
      segmentSequence: 3,
      fromTransport: "websocket",
      toTransport: "http",
      code: "responses_websocket_closed",
      discardedOutput: true,
    }),
  ]);

  assert.equal(running.status, "running");
  assert.equal(running.lastSequence, 3);
  assert.throws(
    () =>
      reduceRunLifecycleEvent(
        running,
        event(4, "model.transport.fallback", {
          segmentId: "segment-1",
          segmentSequence: 4,
          fromTransport: "",
          toTransport: "http",
          code: "responses_websocket_closed",
          discardedOutput: false,
        }),
      ),
    hasCode("model_transport_from_invalid"),
  );
});

test("persists cancellation independently from best-effort execution interruption", () => {
  let state = replayRunLifecycle([
    created(),
    event(2, "run.started", {}),
    event(3, "run.approval.required", {
      approvalId: "approval-1",
      actionDigest: "sha256:action-1",
    }),
    event(4, "run.cancel.requested", { actorId: "actor-1" }),
  ]);

  assert.throws(
    () =>
      reduceRunLifecycleEvent(
        state,
        event(5, "run.completed", { outputRef: "artifact-late" }),
      ),
    hasCode("cancel_pending"),
  );
  state = reduceRunLifecycleEvent(
    state,
    event(5, "run.canceled", { reasonCode: "user_requested" }),
  );

  assert.deepEqual(state, {
    runId: "run-test",
    threadId: "thread-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
    createdByActorId: "actor-1",
    authorityId: "standalone-1",
    runtimeGeneration: "ts-v0",
    agentVersionId: "agent-version-1",
    policySnapshotId: "policy-1",
    workspaceBindingId: "workspace-1",
    collaborationMode: "default",
    purpose: "turn",
    origin: null,
    goalBinding: null,
    goalAccounting: null,
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    status: "canceled",
    revision: 5,
    lastSequence: 5,
    cancelRequested: true,
    waitingApproval: {
      approvalId: "approval-1",
      actionDigest: "sha256:action-1",
    },
    suspensionReasonCode: null,
    reconciliationReceiptId: null,
    outputRef: null,
    failure: null,
    createdAt: timestamp(1),
    updatedAt: timestamp(5),
    terminalAt: timestamp(5),
  });
});

test("requires reconciliation to resume before a run can complete", () => {
  let state = replayRunLifecycle([
    created(),
    event(2, "run.started", {}),
    event(3, "run.reconciliation.required", { receiptId: "receipt-1" }),
  ]);

  assert.throws(
    () =>
      reduceRunLifecycleEvent(
        state,
        event(4, "run.completed", { outputRef: "artifact-1" }),
      ),
    hasCode("invalid_transition:reconciling:run.completed"),
  );

  state = reduceRunLifecycleEvent(
    state,
    event(4, "run.resumed", { reasonCode: "receipt_reconciled" }),
  );
  state = reduceRunLifecycleEvent(
    state,
    event(5, "run.completed", { outputRef: "artifact-1" }),
  );

  assert.equal(state.status, "completed");
  assert.equal(state.reconciliationReceiptId, null);
  assert.equal(state.outputRef, "artifact-1");
});

test("reconciles an unknown side effect before confirming cancellation", () => {
  let state = replayRunLifecycle([
    created(),
    event(2, "run.started", {}),
    event(3, "run.cancel.requested", { actorId: "actor-1" }),
    event(4, "run.reconciliation.required", { receiptId: "receipt-1" }),
  ]);

  assert.throws(
    () =>
      reduceRunLifecycleEvent(
        state,
        event(5, "run.canceled", { reasonCode: "user_requested" }),
      ),
    hasCode("reconciliation_pending"),
  );
  state = reduceRunLifecycleEvent(
    state,
    event(5, "run.resumed", { reasonCode: "receipt_reconciled" }),
  );
  state = reduceRunLifecycleEvent(
    state,
    event(6, "run.canceled", { reasonCode: "user_requested" }),
  );

  assert.equal(state.status, "canceled");
  assert.equal(state.reconciliationReceiptId, null);
  assert.equal(state.cancelRequested, true);
});

test("records bounded Agent stream and assistant Message events while running", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const state = replayRunLifecycle([
    created(),
    event(2, "run.started", {}),
    event(3, "segment.started", {
      segmentId: "segment-1",
      segmentSequence: 1,
      attempt: 1,
    }),
    event(4, "model.sampling.retry", {
      segmentId: "segment-1",
      segmentSequence: 2,
      samplingAttempt: 1,
      maxRetries: 1,
      code: "model_stream_incomplete",
      discardedOutput: false,
    }),
    event(5, "model.output.delta", {
      segmentId: "segment-1",
      segmentSequence: 3,
      delta: "done",
    }),
    event(6, "rate_limit.updated", {
      segmentId: "segment-1",
      segmentSequence: 4,
      snapshot: {
        limitId: "codex",
        limitName: null,
        primary: { usedPercent: 100, windowMinutes: 15, resetsAt: null },
        secondary: null,
        credits: null,
        individualLimit: null,
        planType: null,
        rateLimitReachedType: null,
      },
    }),
    event(7, "usage.recorded", {
      segmentId: "segment-1",
      segmentSequence: 5,
      inputTokens: 4,
      cachedInputTokens: 2,
      outputTokens: 1,
      totalTokens: 5,
    }),
    event(8, "segment.checkpointed", {
      segmentId: "segment-1",
      segmentSequence: 6,
      checkpointDigest: digest,
    }),
    event(9, "segment.completed", {
      segmentId: "segment-1",
      segmentSequence: 7,
    }),
    event(10, "message.completed", {
      messageId: "message-1",
      messageSequence: 1,
      role: "assistant",
      contentDigest: digest,
    }),
    event(11, "run.completed", { outputRef: "message:message-1" }),
  ]);

  assert.equal(state.status, "completed");
  assert.equal(state.revision, 11);
  assert.equal(state.lastSequence, 11);
  assert.equal(state.outputRef, "message:message-1");
  assert.deepEqual(state.usage, {
    inputTokens: 4,
    cachedInputTokens: 2,
    outputTokens: 1,
    totalTokens: 5,
  });

  const running = replayRunLifecycle([created(), event(2, "run.started", {})]);
  assert.throws(
    () =>
      reduceRunLifecycleEvent(
        running,
        event(3, "usage.recorded", {
          segmentId: "segment-1",
          segmentSequence: 1,
          inputTokens: 1,
          cachedInputTokens: 0,
          outputTokens: 1,
          totalTokens: 3,
        }),
      ),
    hasCode("usage_total_tokens_mismatch"),
  );
  assert.throws(
    () =>
      reduceRunLifecycleEvent(
        running,
        event(3, "usage.recorded", {
          segmentId: "segment-1",
          segmentSequence: 1,
          inputTokens: 1,
          cachedInputTokens: 2,
          outputTokens: 0,
          totalTokens: 1,
        }),
      ),
    hasCode("usage_cached_input_tokens_exceeds_input"),
  );
});

test("aggregates sampling and compaction usage without losing safe-integer bounds", () => {
  const running = replayRunLifecycle([
    created(),
    event(2, "run.started", {}),
    event(3, "usage.recorded", {
      segmentId: "segment-1",
      segmentSequence: 1,
      inputTokens: 7,
      cachedInputTokens: 2,
      outputTokens: 3,
      totalTokens: 10,
    }),
    event(4, "context.compacted", {
      stepId: "step-compact",
      compactionItemId: "history-compact",
      mode: "auto",
      replacesThroughSequence: 1,
      inputTokens: 4,
      cachedInputTokens: 1,
      outputTokens: 2,
      totalTokens: 6,
    }),
  ]);

  assert.deepEqual(running.usage, {
    inputTokens: 11,
    cachedInputTokens: 3,
    outputTokens: 5,
    totalTokens: 16,
  });
  assert.throws(
    () =>
      reduceRunLifecycleEvent(
        {
          ...running,
          usage: {
            inputTokens: Number.MAX_SAFE_INTEGER,
            cachedInputTokens: 0,
            outputTokens: 0,
            totalTokens: Number.MAX_SAFE_INTEGER,
          },
        },
        event(5, "usage.recorded", {
          segmentId: "segment-2",
          segmentSequence: 1,
          inputTokens: 1,
          cachedInputTokens: 0,
          outputTokens: 0,
          totalTokens: 1,
        }),
      ),
    hasCode("usage_overflow"),
  );
});

test("rejects cross-run events, sequence gaps, unrequested cancel and terminal mutation", () => {
  const queued = reduceRunLifecycleEvent(null, created());
  assert.throws(
    () =>
      reduceRunLifecycleEvent(queued, event(2, "run.started", {}, "other-run")),
    hasCode("run_id_mismatch"),
  );
  assert.throws(
    () => reduceRunLifecycleEvent(queued, event(3, "run.started", {})),
    hasCode("sequence_gap"),
  );
  assert.throws(
    () =>
      reduceRunLifecycleEvent(
        queued,
        event(2, "run.canceled", { reasonCode: "not_requested" }),
      ),
    hasCode("cancel_not_requested"),
  );

  const completed = replayRunLifecycle([
    created(),
    event(2, "run.started", {}),
    event(3, "run.completed", { outputRef: null }),
  ]);
  assert.throws(
    () =>
      reduceRunLifecycleEvent(
        completed,
        event(4, "run.cancel.requested", { actorId: "actor-1" }),
      ),
    hasCode("terminal_state"),
  );
});

test("binds Workflow purpose to one exact immutable version provenance", () => {
  const base = created();
  assert.equal(base.type, "run.created");
  const binding = {
    workflowId: "workflow-1",
    workflowVersionId: "workflow-version-1",
    contentDigest: `sha256:${"a".repeat(64)}`,
  } as const;
  const state = reduceRunLifecycleEvent(null, {
    ...base,
    data: { ...base.data, purpose: "workflow", workflowVersionBinding: binding },
  });
  assert.deepEqual(state.workflowVersionBinding, binding);
  assert.equal(state.agentVersionId, "agent-version-1");

  assert.throws(
    () =>
      reduceRunLifecycleEvent(null, {
        ...base,
        data: { ...base.data, purpose: "workflow" },
      }),
    hasCode("run_execution_binding_invalid"),
  );
  assert.throws(
    () =>
      reduceRunLifecycleEvent(null, {
        ...base,
        data: { ...base.data, workflowVersionBinding: binding },
      }),
    hasCode("run_execution_binding_invalid"),
  );
});

function stableState(state: RunState): TraceObject {
  return {
    runId: state.runId,
    threadId: state.threadId,
    tenantId: state.tenantId,
    spaceId: state.spaceId,
    createdByActorId: state.createdByActorId,
    authorityId: state.authorityId,
    runtimeGeneration: state.runtimeGeneration,
    agentVersionId: state.agentVersionId,
    policySnapshotId: state.policySnapshotId,
    workspaceBindingId: state.workspaceBindingId,
    collaborationMode: state.collaborationMode,
    goalBinding: state.goalBinding,
    usage: state.usage,
    status: state.status,
    revision: state.revision,
    lastSequence: state.lastSequence,
    cancelRequested: state.cancelRequested,
    waitingApproval: state.waitingApproval,
    suspensionReasonCode: state.suspensionReasonCode,
    reconciliationReceiptId: state.reconciliationReceiptId,
    outputRef: state.outputRef,
    failure: state.failure,
  } as TraceObject;
}

function createdWithOrigin(
  origin: ReturnType<typeof automationOrigin>,
): RunLifecycleEvent {
  const base = created(1, "run-automation");
  assert.equal(base.type, "run.created");
  return { ...base, data: { ...base.data, origin } };
}

function automationOrigin(runId: string) {
  return {
    kind: "automation" as const,
    binding: {
      automationId: "automation-1",
      automationRevision: 1 as const,
      definitionDigest: `sha256:${"a".repeat(64)}`,
      instructionDigest: `sha256:${"c".repeat(64)}`,
      invocationId: "invocation-1",
      runId,
      routeDigest: `sha256:${"b".repeat(64)}`,
    },
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof RunLifecycleError && error.code === code;
}
