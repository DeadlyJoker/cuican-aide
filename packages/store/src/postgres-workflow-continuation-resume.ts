import {
  canonicalJson,
  RunStoreError,
  validateWorkflowNodeContinuationCheckpoint,
  type WorkItemLeaseInput,
  type WorkflowAgentAttemptAuthority,
  type WorkflowNodeContinuationCheckpoint,
} from "@crewon/application";
import type {
  ModelDispatchReceipt,
  RunAttemptState,
  WorkflowContentDigester,
} from "@crewon/domain";
import type { PoolClient } from "pg";

import {
  loadPostgresModelDispatchReceipt,
  terminatePostgresModelDispatchForAttempt,
} from "./postgres-model-dispatch-evidence.ts";
import { stableJson } from "./store-invariants.ts";

type ContinuationRow = Readonly<{
  tenant_id: string;
  run_id: string;
  node_id: string;
  attempt_id: string;
  revision: string | number;
  state_json: unknown;
  updated_at: Date | string;
}>;

export async function loadPostgresWorkflowContinuationForReconciliation(
  client: PoolClient,
  schema: string,
  authority: WorkflowAgentAttemptAuthority,
): Promise<WorkflowNodeContinuationCheckpoint | null> {
  const result = await client.query<ContinuationRow>(
    `SELECT tenant_id,run_id,node_id,attempt_id,revision,state_json,updated_at
     FROM ${schema}.workflow_node_continuations
     WHERE tenant_id=$1 AND run_id=$2 AND node_id=$3 FOR UPDATE`,
    [authority.tenantId, authority.runId, authority.nodeId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  let checkpoint: WorkflowNodeContinuationCheckpoint;
  try {
    checkpoint = validateWorkflowNodeContinuationCheckpoint(row.state_json);
  } catch (error) {
    throw new RunStoreError("workflow_reconciliation_evidence_corrupt", {
      cause: error,
    });
  }
  if (
    stableJson(checkpoint.authority) !== stableJson(authority) ||
    row.tenant_id !== authority.tenantId ||
    row.run_id !== authority.runId ||
    row.node_id !== authority.nodeId ||
    row.attempt_id !== authority.attempt.attemptId ||
    Number(row.revision) !== checkpoint.revision ||
    new Date(row.updated_at).toISOString() !== checkpoint.updatedAt
  )
    throw new RunStoreError("workflow_reconciliation_evidence_corrupt");
  return checkpoint;
}

export async function takeOverPostgresWorkflowContinuation(
  client: PoolClient,
  schema: string,
  input: Readonly<{
    authority: WorkflowAgentAttemptAuthority;
    reconciliationLease: WorkItemLeaseInput;
    attempt: RunAttemptState & Readonly<{ status: "running" }>;
    checkpoint: WorkflowNodeContinuationCheckpoint;
    dispatch:
      | (ModelDispatchReceipt &
          Readonly<{ status: "prepared" | "responseObserved" }>)
      | null;
    resumedAt: string;
    digester: WorkflowContentDigester;
  }>,
): Promise<
  Readonly<{
    attempt: RunAttemptState & Readonly<{ status: "running" }>;
    continuation: WorkflowNodeContinuationCheckpoint;
  }>
> {
  const { attempt, authority, checkpoint, dispatch } = input;
  validateContinuationCorrelation(input);
  if (dispatch !== null) {
    const active = checkpoint.activeDispatch;
    if (
      dispatch.operation !== "dispatch" ||
      dispatch.workItemId !== authority.workItemId ||
      dispatch.leaseEpoch !== authority.leaseEpoch ||
      dispatch.provider.agentVersionId !== authority.agentVersionId ||
      dispatch.provider.adapterName !==
        attempt.providerCheckpoint?.adapterName ||
      dispatch.provider.adapterVersion !==
        attempt.providerCheckpoint?.adapterVersion ||
      dispatch.provider.modelId !== attempt.providerCheckpoint?.modelId
    )
      throw new RunStoreError("workflow_reconciliation_evidence_corrupt");
    const observingCommittedResponse =
      dispatch.status === "responseObserved" &&
      active?.status === "responseObserved" &&
      active.operationId === dispatch.operationId &&
      active.requestSequence === dispatch.requestSequence &&
      active.expectedRevision === dispatch.revision &&
      dispatch.responseCheckpointDigest === attempt.checkpointDigest;
    const abandoningUnsentPost =
      dispatch.status === "prepared" && active === null;
    if (!observingCommittedResponse && !abandoningUnsentPost)
      throw new RunStoreError("workflow_reconciliation_evidence_corrupt");
    await terminatePostgresModelDispatchForAttempt(client, schema, {
      tenantId: authority.tenantId,
      runId: authority.runId,
      lease: input.reconciliationLease,
      attempt: authority.attempt,
      attemptWorkItemId: authority.workItemId,
      attemptLeaseEpoch: authority.leaseEpoch,
      operationId: dispatch.operationId,
      requestSequence: dispatch.requestSequence,
      expectedRevision: dispatch.revision,
      transitionedAt: input.resumedAt,
      outcome: observingCommittedResponse
        ? {
            kind: "completed",
            code: null,
            certainty: "responseObserved",
          }
        : {
            kind: "canceled",
            code: "workflow_resume_prepared_dispatch_superseded",
            certainty: "notSent",
          },
    });
  } else {
    if (
      checkpoint.activeDispatch !== null ||
      authority.workItemId !== input.reconciliationLease.workItemId
    )
      throw new RunStoreError("workflow_reconciliation_evidence_corrupt");
    await requireConsumedResponseDispatch(client, schema, input);
  }
  if (
    attempt.workItemId === input.reconciliationLease.workItemId &&
    attempt.leaseEpoch === input.reconciliationLease.leaseEpoch
  )
    return { attempt, continuation: checkpoint };

  const resumedAttempt = {
    ...attempt,
    workItemId: input.reconciliationLease.workItemId,
    leaseEpoch: input.reconciliationLease.leaseEpoch,
    updatedAt: input.resumedAt,
    status: "running" as const,
  };
  const attemptUpdate = await client.query(
    `UPDATE ${schema}.run_attempts
     SET work_item_id=$1,lease_epoch=$2,state_json=$3::jsonb,updated_at=$4
     WHERE tenant_id=$5 AND run_id=$6 AND step_id=$7 AND attempt_id=$8
       AND status='running' AND work_item_id=$9 AND lease_epoch=$10`,
    [
      resumedAttempt.workItemId,
      resumedAttempt.leaseEpoch,
      JSON.stringify(resumedAttempt),
      resumedAttempt.updatedAt,
      authority.tenantId,
      authority.runId,
      authority.attempt.stepId,
      authority.attempt.attemptId,
      attempt.workItemId,
      attempt.leaseEpoch,
    ],
  );
  if (attemptUpdate.rowCount !== 1)
    throw new RunStoreError("workflow_reconciliation_evidence_corrupt");

  const resumedAuthority = {
    ...authority,
    workItemId: input.reconciliationLease.workItemId,
    leaseEpoch: input.reconciliationLease.leaseEpoch,
  };
  const continuation = validateWorkflowNodeContinuationCheckpoint({
    ...checkpoint,
    authority: resumedAuthority,
    activeDispatch: null,
    terminalCandidate: null,
    revision: checkpoint.revision + 1,
    updatedAt: input.resumedAt,
  });
  const continuationUpdate = await client.query(
    `UPDATE ${schema}.workflow_node_continuations
     SET revision=$1,state_json=$2::jsonb,updated_at=$3
     WHERE tenant_id=$4 AND run_id=$5 AND node_id=$6 AND attempt_id=$7
       AND revision=$8`,
    [
      continuation.revision,
      JSON.stringify(continuation),
      continuation.updatedAt,
      authority.tenantId,
      authority.runId,
      authority.nodeId,
      authority.attempt.attemptId,
      checkpoint.revision,
    ],
  );
  if (continuationUpdate.rowCount !== 1)
    throw new RunStoreError("workflow_reconciliation_evidence_corrupt");
  return { attempt: resumedAttempt, continuation };
}

function validateContinuationCorrelation(
  input: Readonly<{
    authority: WorkflowAgentAttemptAuthority;
    attempt: RunAttemptState & Readonly<{ status: "running" }>;
    checkpoint: WorkflowNodeContinuationCheckpoint;
    digester: WorkflowContentDigester;
  }>,
): void {
  const { attempt, authority, checkpoint } = input;
  if (
    checkpoint.terminalCandidate !== null ||
    stableJson(checkpoint.authority) !== stableJson(authority) ||
    attempt.workItemId !== authority.workItemId ||
    attempt.leaseEpoch !== authority.leaseEpoch ||
    attempt.stepId !== authority.attempt.stepId ||
    attempt.attemptId !== authority.attempt.attemptId ||
    attempt.providerCheckpoint === null ||
    attempt.checkpointDigest === null ||
    input.digester.sha256(canonicalJson(attempt.providerCheckpoint)) !==
      attempt.checkpointDigest ||
    stableJson(attempt.providerCheckpoint) !==
      stableJson(checkpoint.providerCheckpoint) ||
    attempt.providerTurnState !== checkpoint.providerTurnState
  )
    throw new RunStoreError("workflow_reconciliation_evidence_corrupt");
}

async function requireConsumedResponseDispatch(
  client: PoolClient,
  schema: string,
  input: Readonly<{
    authority: WorkflowAgentAttemptAuthority;
    attempt: RunAttemptState & Readonly<{ status: "running" }>;
  }>,
): Promise<void> {
  const operations = await client.query<{ operation_id: string }>(
    `SELECT operation_id FROM ${schema}.model_dispatch_receipts
     WHERE tenant_id=$1 AND run_id=$2 AND step_id=$3 AND attempt_id=$4
       AND status='terminal'
       AND state_json->'terminalOutcome'->>'certainty'='responseObserved'
     ORDER BY request_sequence DESC,revision DESC LIMIT 1`,
    [
      input.authority.tenantId,
      input.authority.runId,
      input.authority.nodeId,
      input.authority.attempt.attemptId,
    ],
  );
  const operationId = operations.rows[0]?.operation_id;
  const receipt =
    operationId === undefined
      ? null
      : await loadPostgresModelDispatchReceipt(
          client,
          schema,
          {
            tenantId: input.authority.tenantId,
            runId: input.authority.runId,
            ...input.authority.attempt,
            operationId,
          },
          true,
        );
  if (
    receipt?.status !== "terminal" ||
    receipt.operation !== "dispatch" ||
    receipt.responseCheckpointDigest !== input.attempt.checkpointDigest ||
    receipt.provider.agentVersionId !== input.authority.agentVersionId ||
    receipt.provider.adapterName !==
      input.attempt.providerCheckpoint?.adapterName ||
    receipt.provider.adapterVersion !==
      input.attempt.providerCheckpoint?.adapterVersion ||
    receipt.provider.modelId !== input.attempt.providerCheckpoint?.modelId ||
    stableJson(receipt.terminalOutcome) !==
      stableJson({
        kind: "completed",
        code: null,
        certainty: "responseObserved",
      })
  )
    throw new RunStoreError("workflow_reconciliation_evidence_corrupt");
}
