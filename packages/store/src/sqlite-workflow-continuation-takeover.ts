import { DatabaseSync } from "node:sqlite";
import {
  RunStoreError,
  validateWorkflowNodeContinuationCheckpoint,
  type WorkItemLeaseInput,
  type WorkflowAgentAttemptAuthority,
  type WorkflowExecutionState,
  type WorkflowNodeContinuationCheckpoint,
} from "@crewon/application";
import type { ModelDispatchReceipt, RunAttemptState } from "@crewon/domain";

import { loadSqliteRunAttempt } from "./sqlite-execution-authority.ts";
import {
  loadSqliteModelDispatchReceipt,
  terminateSqliteModelDispatchForAttempt,
} from "./sqlite-model-dispatch-evidence.ts";
import { stableJson } from "./store-invariants.ts";
import { validateWorkflowExecutionState } from "./workflow-execution-state.ts";

export function takeOverSqliteWorkflowContinuation(
  database: DatabaseSync,
  input: Readonly<{
    priorAuthority: WorkflowAgentAttemptAuthority;
    reconciliationLease: WorkItemLeaseInput;
    checkpoint: WorkflowNodeContinuationCheckpoint;
    execution: WorkflowExecutionState;
    nodeInputDigest: string;
    dispatch: ModelDispatchReceipt &
      Readonly<{ status: "prepared" | "responseObserved" | "terminal" }>;
    reconciliationLeaseExpiresAt: string;
    resumedAt: string;
  }>,
): Readonly<{
  attempt: RunAttemptState & Readonly<{ status: "running" }>;
  continuation: WorkflowNodeContinuationCheckpoint;
  execution: WorkflowExecutionState;
}> {
  const { checkpoint, dispatch, priorAuthority } = input;
  const activeDispatch = checkpoint.activeDispatch;
  if (
    checkpoint.terminalCandidate !== null ||
    (dispatch.status === "terminal" || dispatch.status === "prepared"
      ? activeDispatch !== null ||
        priorAuthority.workItemId !== input.reconciliationLease.workItemId
      : activeDispatch === null ||
        activeDispatch.status !== "responseObserved" ||
        activeDispatch.operationId !== dispatch.operationId ||
        activeDispatch.requestSequence !== dispatch.requestSequence ||
        activeDispatch.expectedRevision !== dispatch.revision ||
        dispatch.operation !== "dispatch" ||
        dispatch.workItemId !== priorAuthority.workItemId ||
        dispatch.leaseEpoch !== priorAuthority.leaseEpoch)
  ) {
    corrupt();
  }
  const executionNode = input.execution.nodes.find(
    (candidate) => candidate.nodeId === priorAuthority.nodeId,
  );
  if (
    input.execution.tenantId !== priorAuthority.tenantId ||
    input.execution.runId !== priorAuthority.runId ||
    executionNode === undefined ||
    (executionNode.status !== "unknown" &&
      executionNode.status !== "running") ||
    executionNode.kind !== priorAuthority.nodeKind ||
    executionNode.claimId !== priorAuthority.claimId ||
    executionNode.claimEpoch !== priorAuthority.claimEpoch ||
    executionNode.agentVersionId !== priorAuthority.agentVersionId ||
    executionNode.inputDigest !== input.nodeInputDigest
  ) {
    corrupt();
  }
  const attempt = loadSqliteRunAttempt(database, {
    tenantId: priorAuthority.tenantId,
    runId: priorAuthority.runId,
    ...priorAuthority.attempt,
  });
  if (
    attempt === null ||
    attempt.status !== "running" ||
    attempt.workItemId !== priorAuthority.workItemId ||
    attempt.leaseEpoch !== priorAuthority.leaseEpoch ||
    attempt.providerTurnState !== checkpoint.providerTurnState
  ) {
    corrupt();
  }
  const providerCheckpoint = checkpoint.providerCheckpoint;
  if (
    providerCheckpoint === null ||
    dispatch.provider.agentVersionId !== priorAuthority.agentVersionId ||
    dispatch.provider.adapterName !== providerCheckpoint.adapterName ||
    dispatch.provider.adapterVersion !== providerCheckpoint.adapterVersion ||
    dispatch.provider.modelId !== providerCheckpoint.modelId
  ) {
    corrupt();
  }
  if (dispatch.status === "terminal") {
    validateTerminalProof(database, {
      priorAuthority,
      attempt,
      checkpoint,
      dispatch: { ...dispatch, status: "terminal" },
    });
  } else {
    if (
      dispatch.status === "prepared" &&
      (dispatch.operation !== "dispatch" ||
        dispatch.workItemId !== priorAuthority.workItemId ||
        dispatch.leaseEpoch !== priorAuthority.leaseEpoch)
    ) {
      corrupt();
    }
    const terminal = terminateSqliteModelDispatchForAttempt(database, {
      tenantId: priorAuthority.tenantId,
      runId: priorAuthority.runId,
      attempt: priorAuthority.attempt,
      attemptWorkItemId: priorAuthority.workItemId,
      attemptLeaseEpoch: priorAuthority.leaseEpoch,
      operationId: dispatch.operationId,
      requestSequence: dispatch.requestSequence,
      expectedRevision: dispatch.revision,
      transitionedAt: input.resumedAt,
      outcome:
        dispatch.status === "prepared"
          ? {
              kind: "failed",
              code: "workflow_model_not_dispatched",
              certainty: "notSent",
            }
          : {
              kind: "completed",
              code: null,
              certainty: "responseObserved",
            },
    });
    if (terminal.status !== "terminal") corrupt();
  }
  if (
    attempt.workItemId === input.reconciliationLease.workItemId &&
    attempt.leaseEpoch === input.reconciliationLease.leaseEpoch &&
    executionNode.status === "running"
  ) {
    return {
      attempt: { ...attempt, status: "running" },
      continuation: checkpoint,
      execution: input.execution,
    };
  }
  const resumedAttempt = {
    ...attempt,
    workItemId: input.reconciliationLease.workItemId,
    leaseEpoch: input.reconciliationLease.leaseEpoch,
    updatedAt: input.resumedAt,
  } satisfies RunAttemptState;
  const attemptUpdate = database
    .prepare(
      `UPDATE run_attempts
       SET work_item_id=?,lease_epoch=?,state_json=?,updated_at=?
       WHERE tenant_id=? AND run_id=? AND step_id=? AND attempt_id=?
         AND status='running' AND work_item_id=? AND lease_epoch=? AND state_json=?`,
    )
    .run(
      resumedAttempt.workItemId,
      resumedAttempt.leaseEpoch,
      stableJson(resumedAttempt),
      resumedAttempt.updatedAt,
      priorAuthority.tenantId,
      priorAuthority.runId,
      priorAuthority.attempt.stepId,
      priorAuthority.attempt.attemptId,
      priorAuthority.workItemId,
      priorAuthority.leaseEpoch,
      stableJson(attempt),
    );
  if (attemptUpdate.changes !== 1) corrupt();
  const authority = {
    ...priorAuthority,
    workItemId: input.reconciliationLease.workItemId,
    leaseEpoch: input.reconciliationLease.leaseEpoch,
  };
  const continuation = validateWorkflowNodeContinuationCheckpoint({
    ...checkpoint,
    authority,
    activeDispatch: null,
    terminalCandidate: null,
    revision: checkpoint.revision + 1,
    updatedAt: input.resumedAt,
  });
  const checkpointUpdate = database
    .prepare(
      `UPDATE workflow_node_continuations
       SET revision=?,checkpoint_json=?,updated_at=?
       WHERE tenant_id=? AND run_id=? AND step_id=? AND attempt_id=? AND revision=?`,
    )
    .run(
      continuation.revision,
      stableJson(continuation),
      continuation.updatedAt,
      authority.tenantId,
      authority.runId,
      authority.attempt.stepId,
      authority.attempt.attemptId,
      checkpoint.revision,
    );
  if (checkpointUpdate.changes !== 1) corrupt();
  const execution = {
    ...input.execution,
    revision: input.execution.revision + 1,
    nodes: input.execution.nodes.map((candidate) =>
      candidate.nodeId === priorAuthority.nodeId
        ? {
            ...candidate,
            status: "running" as const,
            leaseExpiresAt: input.reconciliationLeaseExpiresAt,
          }
        : candidate,
    ),
    updatedAt: input.resumedAt,
  };
  validateWorkflowExecutionState(execution);
  const executionUpdate = database
    .prepare(
      `UPDATE workflow_executions SET revision=?,state_json=?,updated_at=?
       WHERE tenant_id=? AND run_id=? AND revision=? AND state_json=?`,
    )
    .run(
      execution.revision,
      stableJson(execution),
      execution.updatedAt,
      execution.tenantId,
      execution.runId,
      input.execution.revision,
      stableJson(input.execution),
    );
  if (executionUpdate.changes !== 1) corrupt();
  return {
    attempt: { ...resumedAttempt, status: "running" },
    continuation,
    execution,
  };
}

function validateTerminalProof(
  database: DatabaseSync,
  input: Readonly<{
    priorAuthority: WorkflowAgentAttemptAuthority;
    attempt: RunAttemptState;
    checkpoint: WorkflowNodeContinuationCheckpoint;
    dispatch: ModelDispatchReceipt & Readonly<{ status: "terminal" }>;
  }>,
): void {
  const { attempt, checkpoint, dispatch, priorAuthority } = input;
  const observedProof =
    dispatch.terminalOutcome?.kind === "completed" &&
    dispatch.terminalOutcome.code === null &&
    dispatch.terminalOutcome.certainty === "responseObserved" &&
    dispatch.responseCheckpointDigest === attempt.checkpointDigest;
  const preparedProof =
    dispatch.terminalOutcome?.kind === "failed" &&
    dispatch.terminalOutcome.code === "workflow_model_not_dispatched" &&
    dispatch.terminalOutcome.certainty === "notSent" &&
    dispatch.responseCheckpointDigest === null;
  if (dispatch.operation !== "dispatch" || (!observedProof && !preparedProof)) {
    corrupt();
  }
  if (!preparedProof) return;
  const priorRow = database
    .prepare(
      `SELECT operation_id FROM model_dispatch_receipts
       WHERE tenant_id=? AND run_id=? AND step_id=? AND attempt_id=?
         AND request_sequence<? AND status='terminal'
       ORDER BY request_sequence DESC,revision DESC LIMIT 1`,
    )
    .get(
      priorAuthority.tenantId,
      priorAuthority.runId,
      priorAuthority.attempt.stepId,
      priorAuthority.attempt.attemptId,
      dispatch.requestSequence,
    ) as { operation_id: string } | undefined;
  const prior =
    priorRow === undefined
      ? null
      : loadSqliteModelDispatchReceipt(database, {
          tenantId: priorAuthority.tenantId,
          runId: priorAuthority.runId,
          ...priorAuthority.attempt,
          operationId: priorRow.operation_id,
        });
  const providerCheckpoint = checkpoint.providerCheckpoint!;
  if (
    prior?.operation !== "dispatch" ||
    prior.responseCheckpointDigest !== attempt.checkpointDigest ||
    prior.provider.agentVersionId !== priorAuthority.agentVersionId ||
    prior.provider.adapterName !== providerCheckpoint.adapterName ||
    prior.provider.adapterVersion !== providerCheckpoint.adapterVersion ||
    prior.provider.modelId !== providerCheckpoint.modelId ||
    prior.terminalOutcome?.kind !== "completed" ||
    prior.terminalOutcome.code !== null ||
    prior.terminalOutcome.certainty !== "responseObserved"
  ) {
    corrupt();
  }
}

function corrupt(): never {
  throw new RunStoreError("workflow_reconciliation_evidence_corrupt");
}
