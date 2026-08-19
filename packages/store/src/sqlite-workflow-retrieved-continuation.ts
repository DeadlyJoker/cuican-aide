import { DatabaseSync } from "node:sqlite";

import {
  canonicalJson,
  RunStoreError,
  validateWorkflowNodeContinuationCheckpoint,
  validateWorkflowRetrievedContinuationPayload,
  type WorkItemLeaseInput,
  type WorkflowAgentAttemptAuthority,
  type WorkflowExecutionState,
  type WorkflowNodeContinuationCheckpoint,
  type WorkflowPendingToolResume,
  type WorkflowRetrievedContinuationPayload,
} from "@crewon/application";
import type {
  ModelDispatchReceipt,
  RunAttemptState,
  RunStepState,
  WorkflowContentDigester,
} from "@crewon/domain";

import { appendSqliteWorkflowRetrievedEventSuffix } from "./sqlite-workflow-retrieved-events.ts";
import { takeOverSqliteWorkflowContinuation } from "./sqlite-workflow-continuation-takeover.ts";
import { takeOverSqliteWorkflowPendingTools } from "./sqlite-workflow-pending-tool-takeover.ts";
import { stableJson } from "./store-invariants.ts";

export function commitSqliteRetrievedWorkflowContinuationWithinTransaction(
  database: DatabaseSync,
  input: Readonly<{
    authority: WorkflowAgentAttemptAuthority;
    reconciliationLease: WorkItemLeaseInput;
    priorContinuation: WorkflowNodeContinuationCheckpoint | null;
    payload: WorkflowRetrievedContinuationPayload;
    dispatch: ModelDispatchReceipt & Readonly<{ status: "responseObserved" }>;
    step: RunStepState;
    currentAttempt: RunAttemptState & Readonly<{ status: "running" }>;
    execution: WorkflowExecutionState;
    nodeInputDigest: string;
    reconciliationLeaseExpiresAt: string;
    committedAt: string;
    digester: WorkflowContentDigester;
  }>,
): Readonly<{
  step: RunStepState;
  attempt: RunAttemptState & Readonly<{ status: "running" }>;
  continuation: WorkflowNodeContinuationCheckpoint;
  pendingTools: readonly WorkflowPendingToolResume[];
  execution: WorkflowExecutionState;
}> {
  const payload = validateWorkflowRetrievedContinuationPayload(input.payload);
  validateStoredPrior(database, input.authority, input.priorContinuation);
  validateSegmentAuthority(input, payload);
  validateHistory(input.priorContinuation, payload);

  appendSqliteWorkflowRetrievedEventSuffix(database, {
    tenantId: input.authority.tenantId,
    runId: input.authority.runId,
    attemptId: input.authority.attempt.attemptId,
    dispatchOperationId: input.dispatch.operationId,
    segmentId: payload.next.segmentId,
    payload,
    committedAt: input.committedAt,
    digester: input.digester,
  });
  const checkpoint = persistRetrievedCheckpoint(database, input, payload);
  const resumed = takeOverSqliteWorkflowContinuation(database, {
    priorAuthority: input.authority,
    reconciliationLease: input.reconciliationLease,
    checkpoint,
    execution: input.execution,
    nodeInputDigest: input.nodeInputDigest,
    dispatch: input.dispatch,
    reconciliationLeaseExpiresAt: input.reconciliationLeaseExpiresAt,
    resumedAt: input.committedAt,
  });
  const pendingTools = takeOverSqliteWorkflowPendingTools(database, {
    priorAuthority: input.authority,
    reconciliationLease: input.reconciliationLease,
    checkpoint,
    adoptedAt: input.committedAt,
    digester: input.digester,
  });
  return {
    step: input.step,
    attempt: resumed.attempt,
    continuation: resumed.continuation,
    pendingTools,
    execution: resumed.execution,
  };
}

function validateStoredPrior(
  database: DatabaseSync,
  authority: WorkflowAgentAttemptAuthority,
  expected: WorkflowNodeContinuationCheckpoint | null,
): void {
  const row = database
    .prepare(
      `SELECT checkpoint_json FROM workflow_node_continuations
       WHERE tenant_id=? AND run_id=? AND step_id=? AND attempt_id=?`,
    )
    .get(
      authority.tenantId,
      authority.runId,
      authority.attempt.stepId,
      authority.attempt.attemptId,
    ) as { checkpoint_json: string } | undefined;
  const stored =
    row === undefined
      ? null
      : validateWorkflowNodeContinuationCheckpoint(
          JSON.parse(row.checkpoint_json),
        );
  if (
    stableJson(stored) !== stableJson(expected) ||
    (stored !== null &&
      (stableJson(stored.authority) !== stableJson(authority) ||
        stored.activeDispatch !== null ||
        stored.terminalCandidate !== null))
  )
    corrupt();
}

function validateSegmentAuthority(
  input: Parameters<
    typeof commitSqliteRetrievedWorkflowContinuationWithinTransaction
  >[1],
  payload: WorkflowRetrievedContinuationPayload,
): void {
  const suffix = `:request:${input.dispatch.requestSequence}`;
  const segmentId = input.dispatch.operationId.endsWith(suffix)
    ? input.dispatch.operationId.slice(0, -suffix.length)
    : null;
  const modelSampleIndex =
    (input.priorContinuation?.modelSampleIndex ?? -1) + 1;
  const expectedSegmentId =
    modelSampleIndex === 0
      ? `segment:${input.authority.attempt.attemptId}`
      : `segment:${input.authority.attempt.attemptId}:round:${modelSampleIndex + 1}`;
  const checkpoint = payload.next.providerCheckpoint;
  if (
    segmentId !== expectedSegmentId ||
    payload.next.segmentId !== expectedSegmentId ||
    payload.next.modelSampleIndex !== modelSampleIndex ||
    payload.next.toolRoundsConsumed !==
      (input.priorContinuation?.toolRoundsConsumed ?? 0) ||
    checkpoint === null ||
    stableJson(checkpoint) !==
      stableJson(input.currentAttempt.providerCheckpoint) ||
    payload.next.providerTurnState !== input.currentAttempt.providerTurnState ||
    input.currentAttempt.checkpointDigest === null ||
    input.digester.sha256(canonicalJson(checkpoint)) !==
      input.currentAttempt.checkpointDigest ||
    input.dispatch.responseCheckpointDigest !==
      input.currentAttempt.checkpointDigest ||
    input.currentAttempt.stepId !== input.authority.attempt.stepId ||
    input.currentAttempt.attemptId !== input.authority.attempt.attemptId ||
    input.currentAttempt.workItemId !== input.authority.workItemId ||
    input.currentAttempt.leaseEpoch !== input.authority.leaseEpoch ||
    input.step.currentAttemptId !== input.currentAttempt.attemptId ||
    input.step.status !== "running" ||
    input.dispatch.operation !== "dispatch" ||
    input.dispatch.workItemId !== input.authority.workItemId ||
    input.dispatch.leaseEpoch !== input.authority.leaseEpoch ||
    input.dispatch.provider.agentVersionId !== input.authority.agentVersionId ||
    input.dispatch.provider.adapterName !== checkpoint.adapterName ||
    input.dispatch.provider.adapterVersion !== checkpoint.adapterVersion ||
    input.dispatch.provider.modelId !== checkpoint.modelId
  )
    corrupt();
}

function validateHistory(
  prior: WorkflowNodeContinuationCheckpoint | null,
  payload: WorkflowRetrievedContinuationPayload,
): void {
  const requested = payload.events.filter(
    (event) => event.type === "tool.requested",
  );
  const suffix = [
    ...(payload.assistantContinuation === null
      ? []
      : [
          {
            type: "message" as const,
            role: "assistant" as const,
            content: payload.assistantContinuation.output,
          },
        ]),
    ...requested.map((event) => ({
      type: "tool_call" as const,
      kind: event.data.kind,
      callId: event.data.callId,
      name: event.data.name,
      input: event.data.input,
    })),
  ];
  const history = payload.next.history;
  const prefix =
    prior?.history ?? history.slice(0, history.length - suffix.length);
  if (
    history.length < suffix.length ||
    (prior !== null &&
      stableJson(history.slice(0, prior.history.length)) !==
        stableJson(prior.history)) ||
    stableJson(history.slice(prefix.length)) !== stableJson(suffix)
  )
    corrupt();
  for (const event of requested) {
    const callId = event.data.callId;
    if (
      typeof callId !== "string" ||
      history.filter(
        (item) => item.type === "tool_call" && item.callId === callId,
      ).length !== 1 ||
      history.some(
        (item) => item.type === "tool_result" && item.callId === callId,
      )
    )
      corrupt();
  }
}

function persistRetrievedCheckpoint(
  database: DatabaseSync,
  input: Parameters<
    typeof commitSqliteRetrievedWorkflowContinuationWithinTransaction
  >[1],
  payload: WorkflowRetrievedContinuationPayload,
): WorkflowNodeContinuationCheckpoint {
  const expectedRevision = input.priorContinuation?.revision ?? 0;
  const checkpoint = validateWorkflowNodeContinuationCheckpoint({
    ...payload.next,
    authority: input.authority,
    activeDispatch: {
      operationId: input.dispatch.operationId,
      requestSequence: input.dispatch.requestSequence,
      expectedRevision: input.dispatch.revision,
      status: "responseObserved",
    },
    terminalCandidate: null,
    revision: expectedRevision + 1,
    updatedAt: input.committedAt,
  });
  const result = database
    .prepare(
      `INSERT INTO workflow_node_continuations
       (tenant_id,run_id,step_id,attempt_id,revision,checkpoint_json,updated_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(tenant_id,run_id,step_id,attempt_id) DO UPDATE SET
         revision=excluded.revision,checkpoint_json=excluded.checkpoint_json,
         updated_at=excluded.updated_at WHERE revision=?`,
    )
    .run(
      input.authority.tenantId,
      input.authority.runId,
      input.authority.attempt.stepId,
      input.authority.attempt.attemptId,
      checkpoint.revision,
      stableJson(checkpoint),
      checkpoint.updatedAt,
      expectedRevision,
    );
  if (result.changes !== 1) corrupt();
  return checkpoint;
}

function corrupt(): never {
  throw new RunStoreError("workflow_retrieved_continuation_corrupt");
}
