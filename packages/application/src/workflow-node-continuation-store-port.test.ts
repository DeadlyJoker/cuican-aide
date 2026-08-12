import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_WORKFLOW_CONTINUATION_HISTORY_BYTES,
  MAX_WORKFLOW_CONTINUATION_HISTORY_ITEM_BYTES,
  MAX_WORKFLOW_CONTINUATION_HISTORY_ITEMS,
  validateWorkflowNodeContinuationCheckpoint,
  type WorkflowNodeContinuationCheckpoint,
} from "./workflow-node-continuation-store-port.ts";

test("deep-validates one bounded Workflow continuation checkpoint", () => {
  const input = checkpoint();
  const validated = validateWorkflowNodeContinuationCheckpoint(input);
  assert.deepEqual(validated, input);
  assert.notEqual(validated, input);
  assert.notEqual(validated.history, input.history);
});

test("rejects authority, dispatch, provider and injected-field drift", () => {
  const input = checkpoint();
  for (const candidate of [
    { ...input, extra: true },
    { ...input, authority: { ...input.authority, claimEpoch: 0 } },
    { ...input, authority: { ...input.authority, nodeKind: "humanGate" } },
    {
      ...input,
      activeDispatch: { ...input.activeDispatch!, expectedRevision: 0 },
    },
    { ...input, providerTurnState: "line\nbreak" },
    {
      ...input,
      providerCheckpoint: {
        schemaVersion: "crewon.provider-checkpoint.v0",
        adapterName: "test",
        adapterVersion: "1",
        modelId: "model",
        opaquePayload: { oversized: "x".repeat(9_000) },
      },
    },
  ])
    assert.throws(() => validateWorkflowNodeContinuationCheckpoint(candidate),
      /workflow_node_continuation_invalid/u);
});

test("enforces per-item, item-count and total continuation history caps", () => {
  const input = checkpoint();
  assert.throws(
    () =>
      validateWorkflowNodeContinuationCheckpoint({
        ...input,
        history: [message("x".repeat(MAX_WORKFLOW_CONTINUATION_HISTORY_ITEM_BYTES))],
      }),
    /workflow_node_continuation_invalid/u,
  );
  assert.throws(
    () =>
      validateWorkflowNodeContinuationCheckpoint({
        ...input,
        history: Array.from(
          { length: MAX_WORKFLOW_CONTINUATION_HISTORY_ITEMS + 1 },
          () => message("x"),
        ),
      }),
    /workflow_node_continuation_invalid/u,
  );
  const largeHistory = Array.from({ length: 14 }, () =>
    message("x".repeat(39_000)),
  );
  assert.ok(
    new TextEncoder().encode(JSON.stringify(largeHistory)).byteLength >
      MAX_WORKFLOW_CONTINUATION_HISTORY_BYTES,
  );
  assert.throws(
    () =>
      validateWorkflowNodeContinuationCheckpoint({
        ...input,
        history: largeHistory,
      }),
    /workflow_node_continuation_invalid/u,
  );
});

function checkpoint(): WorkflowNodeContinuationCheckpoint {
  return {
    schemaVersion: "crewon.workflow-node-continuation.v0",
    authority: {
      tenantId: "tenant-1",
      runId: "run-1",
      workItemId: "work-1",
      leaseEpoch: 1,
      nodeId: "node-1",
      nodeKind: "agent",
      claimId: "claim-1",
      claimEpoch: 1,
      agentVersionId: "agent-1",
      attempt: { stepId: "step-1", attemptId: "attempt-1" },
    },
    segmentId: "segment-1",
    modelSampleIndex: 1,
    toolRoundsConsumed: 1,
    providerCheckpoint: {
      schemaVersion: "crewon.provider-checkpoint.v0",
      adapterName: "test",
      adapterVersion: "1",
      modelId: "model",
      opaquePayload: { responseId: "response-1" },
    },
    providerTurnState: "turn-state-1",
    activeDispatch: {
      operationId: "dispatch-1",
      requestSequence: 2,
      expectedRevision: 3,
      status: "responseObserved",
    },
    history: [
      message("hello"),
      {
        type: "tool_call",
        kind: "function",
        callId: "call-1",
        name: "read_file",
        input: "{}",
      },
      {
        type: "tool_result",
        kind: "function",
        callId: "call-1",
        output: "ok",
      },
    ],
    revision: 1,
    updatedAt: "2026-08-12T00:00:00.000Z",
  };
}

function message(content: string) {
  return { type: "message" as const, role: "assistant" as const, content };
}
