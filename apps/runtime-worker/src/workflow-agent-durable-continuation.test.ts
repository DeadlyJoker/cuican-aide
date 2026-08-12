import assert from "node:assert/strict";
import test from "node:test";

import { workflowContinuationCheckpoint } from "./workflow-agent-durable-continuation.ts";

const authority = {
  tenantId: "tenant-1", runId: "run-1", nodeId: "agent",
  nodeKind: "agent" as const, agentVersionId: "agent-v1",
  claimId: "claim-1", claimEpoch: 1, stepId: "agent",
  attemptId: "attempt-1", workItemId: "work-1", leaseEpoch: 1,
};
const dispatch = {
  schemaVersion: "crewon.model-dispatch-receipt.v0" as const,
  tenantId: "tenant-1", runId: "run-1", stepId: "agent",
  attemptId: "attempt-1", operationId: "dispatch-1", requestSequence: 1,
  operation: "dispatch" as const, workItemId: "work-1", leaseEpoch: 1,
  requestDigest: `sha256:${"a".repeat(64)}`,
  provider: { agentVersionId: "agent-v1", adapterName: "responses",
    adapterVersion: "1", modelId: "model-1" },
  status: "responseObserved" as const, revision: 3,
  preparedAt: "2026-08-12T00:00:01.000Z",
  possiblySentAt: "2026-08-12T00:00:02.000Z",
  responseObservedAt: "2026-08-12T00:00:03.000Z",
  responseCheckpointDigest: `sha256:${"b".repeat(64)}`,
  terminalAt: null, terminalOutcome: null,
  updatedAt: "2026-08-12T00:00:03.000Z",
};

test("builds the exact durable continuation CAS payload", () => {
  assert.deepEqual(workflowContinuationCheckpoint({
    authority, segmentId: "segment-1", modelSampleIndex: 1,
    toolRoundsConsumed: 1, history: [
      { type: "message", role: "assistant", content: "answer" },
    ], dispatch, providerCheckpoint: null, providerTurnState: null,
  }), {
    schemaVersion: "crewon.workflow-node-continuation.v0",
    terminalCandidate: null,
    authority: { tenantId: "tenant-1", runId: "run-1", nodeId: "agent",
      nodeKind: "agent", agentVersionId: "agent-v1", claimId: "claim-1",
      claimEpoch: 1, attempt: { stepId: "agent", attemptId: "attempt-1" },
      workItemId: "work-1", leaseEpoch: 1 },
    segmentId: "segment-1", modelSampleIndex: 1, toolRoundsConsumed: 1,
    providerCheckpoint: null, providerTurnState: null,
    activeDispatch: { operationId: "dispatch-1", requestSequence: 1,
      expectedRevision: 3, status: "responseObserved" },
    history: [{ type: "message", role: "assistant", content: "answer" }],
  });
});
