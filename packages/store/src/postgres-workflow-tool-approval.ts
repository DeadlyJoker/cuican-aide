import {
  RunStoreError,
  type ConsumeWorkflowToolApprovalInput,
  type WorkflowAgentAttemptAuthority,
  type WorkflowToolApprovalConsumptionResult,
  type WorkflowToolApprovalOutcome,
} from "@crewon/application";
import {
  type ToolExecutionReceiptState,
  type WorkflowContentDigester,
} from "@crewon/domain";
import type { PoolClient } from "pg";

import { loadPostgresRunAttempt } from "./postgres-execution-authority.ts";
import { loadPostgresToolApproval } from "./postgres-tool-approvals.ts";
import { loadPostgresToolExecutionReceipt } from "./postgres-tool-execution.ts";
import {
  decodePostgresWorkflowToolApprovalResult,
  loadPostgresWorkflowApprovalCheckpoint,
  loadPostgresWorkflowToolApprovalHandoff,
  postgresWorkflowToolApprovalFingerprint,
  validatePostgresWorkflowToolApprovalResumePayload,
} from "./postgres-workflow-tool-approval-support.ts";
import { stableJson } from "./store-invariants.ts";

export {
  migratePostgresWorkflowToolApprovals,
  publishPostgresWorkflowToolApproval,
} from "./postgres-workflow-tool-approval-publication.ts";

export async function consumePostgresWorkflowToolApproval(
  client: PoolClient,
  schema: string,
  input: ConsumeWorkflowToolApprovalInput,
  digester: WorkflowContentDigester,
): Promise<WorkflowToolApprovalConsumptionResult> {
  const fingerprint = postgresWorkflowToolApprovalFingerprint(
    digester,
    "consume",
    input,
  );
  const handoff = await loadPostgresWorkflowToolApprovalHandoff(
    client,
    schema,
    input,
  );
  if (handoff === null)
    throw new RunStoreError("workflow_tool_approval_not_found");
  if (handoff.consumption_operation_id !== null) {
    if (
      handoff.consumption_operation_id !== input.operationId ||
      handoff.consumption_fingerprint !== fingerprint ||
      handoff.consumption_result_json === null
    )
      throw new RunStoreError("workflow_tool_approval_already_consumed");
    const replay =
      decodePostgresWorkflowToolApprovalResult<WorkflowToolApprovalConsumptionResult>(
        handoff.consumption_result_json,
      );
    return refreshConsumptionReplay(client, schema, input, replay);
  }
  await validatePostgresWorkflowToolApprovalResumePayload(
    client,
    schema,
    input,
  );
  const approval = await loadPostgresToolApproval(
    client,
    schema,
    { tenantId: input.authority.tenantId, approvalId: input.approvalId },
    true,
  );
  if (
    approval === null ||
    approval.actionDigest !== input.actionDigest ||
    approval.workItemId !== input.lease.workItemId
  )
    throw new RunStoreError("workflow_tool_approval_binding_mismatch");
  const receipt = await loadPostgresToolExecutionReceipt(
    client,
    schema,
    { ...input.authority, receiptId: approval.receiptId },
    true,
  );
  if (
    receipt === null ||
    receipt.actionDigest !== input.actionDigest ||
    receipt.workItemId !== input.authority.workItemId ||
    receipt.status !== "prepared"
  )
    throw new RunStoreError("workflow_tool_approval_receipt_mismatch");
  const adopted = await adoptResumeAuthority(
    client,
    schema,
    input,
    receipt,
    input.authority,
  );
  const outcome = terminalOutcome(approval, adopted);
  const result: WorkflowToolApprovalConsumptionResult = {
    disposition: "consumed",
    outcome,
  };
  const updated = await client.query(
    `UPDATE ${schema}.workflow_tool_approval_handoffs
     SET consumption_operation_id=$1,consumption_fingerprint=$2,
         consumption_result_json=$3,consumed_at=clock_timestamp()
     WHERE tenant_id=$4 AND run_id=$5 AND approval_id=$6
       AND consumption_operation_id IS NULL`,
    [
      input.operationId,
      fingerprint,
      stableJson(result),
      input.authority.tenantId,
      input.authority.runId,
      input.approvalId,
    ],
  );
  if (updated.rowCount !== 1)
    throw new RunStoreError("workflow_tool_approval_already_consumed");
  return result;
}

async function adoptResumeAuthority(
  client: PoolClient,
  schema: string,
  input: ConsumeWorkflowToolApprovalInput,
  receipt: ToolExecutionReceiptState,
  source: WorkflowAgentAttemptAuthority,
): Promise<{ authority: WorkflowAgentAttemptAuthority; receipt: ToolExecutionReceiptState }> {
  const authority = {
    ...input.authority,
    workItemId: input.lease.workItemId,
    leaseEpoch: input.lease.leaseEpoch,
  };
  const attempts = new Map([
    [`${source.attempt.stepId}\0${source.attempt.attemptId}`, source.attempt],
    [`${receipt.stepId}\0${receipt.attemptId}`, { stepId: receipt.stepId, attemptId: receipt.attemptId }],
  ]);
  for (const attempt of attempts.values()) {
    const current = await loadPostgresRunAttempt(
      client,
      schema,
      { ...source, ...attempt },
      true,
    );
    if (
      current?.status !== "running" ||
      current.workItemId !== source.workItemId ||
      current.leaseEpoch !== source.leaseEpoch
    )
      throw new RunStoreError("workflow_tool_approval_authority_mismatch");
    const next = { ...current, workItemId: authority.workItemId, leaseEpoch: authority.leaseEpoch };
    const updated = await client.query(
      `UPDATE ${schema}.run_attempts SET work_item_id=$1,lease_epoch=$2,state_json=$3
       WHERE tenant_id=$4 AND run_id=$5 AND step_id=$6 AND attempt_id=$7
         AND work_item_id=$8 AND lease_epoch=$9`,
      [
        next.workItemId,
        next.leaseEpoch,
        stableJson(next),
        source.tenantId,
        source.runId,
        attempt.stepId,
        attempt.attemptId,
        source.workItemId,
        source.leaseEpoch,
      ],
    );
    if (updated.rowCount !== 1)
      throw new RunStoreError("workflow_tool_approval_authority_mismatch");
  }
  const adoptedReceipt = { ...receipt, workItemId: authority.workItemId };
  const receiptUpdate = await client.query(
    `UPDATE ${schema}.tool_execution_receipts SET work_item_id=$1,state_json=$2
     WHERE tenant_id=$3 AND run_id=$4 AND receipt_id=$5
       AND work_item_id=$6 AND revision=$7`,
    [
      adoptedReceipt.workItemId,
      stableJson(adoptedReceipt),
      receipt.tenantId,
      receipt.runId,
      receipt.receiptId,
      receipt.workItemId,
      receipt.revision,
    ],
  );
  if (receiptUpdate.rowCount !== 1)
    throw new RunStoreError("workflow_tool_approval_receipt_mismatch");
  const checkpoint = await loadPostgresWorkflowApprovalCheckpoint(
    client,
    schema,
    source,
    true,
  );
  if (checkpoint === null || stableJson(checkpoint.authority) !== stableJson(source))
    throw new RunStoreError("workflow_tool_approval_authority_mismatch");
  const adoptedCheckpoint = {
    ...checkpoint,
    authority,
    revision: checkpoint.revision + 1,
  };
  const checkpointUpdate = await client.query(
    `UPDATE ${schema}.workflow_node_continuations
     SET revision=$1,state_json=$2 WHERE tenant_id=$3 AND run_id=$4
       AND node_id=$5 AND attempt_id=$6 AND revision=$7`,
    [
      adoptedCheckpoint.revision,
      stableJson(adoptedCheckpoint),
      source.tenantId,
      source.runId,
      source.nodeId,
      source.attempt.attemptId,
      checkpoint.revision,
    ],
  );
  if (checkpointUpdate.rowCount !== 1)
    throw new RunStoreError("workflow_tool_approval_authority_mismatch");
  return { authority, receipt: adoptedReceipt };
}

async function refreshConsumptionReplay(
  client: PoolClient,
  schema: string,
  input: ConsumeWorkflowToolApprovalInput,
  replay: WorkflowToolApprovalConsumptionResult,
): Promise<WorkflowToolApprovalConsumptionResult> {
  if (replay.outcome === null)
    throw new RunStoreError("workflow_tool_approval_receipt_corrupt");
  if (
    replay.outcome.authority.workItemId !== input.lease.workItemId ||
    replay.outcome.authority.leaseEpoch !== input.lease.leaseEpoch
  ) {
    await validatePostgresWorkflowToolApprovalResumePayload(
      client,
      schema,
      input,
    );
    const receipt = await loadPostgresToolExecutionReceipt(
      client,
      schema,
      replay.outcome.receipt,
      true,
    );
    if (receipt === null)
      throw new RunStoreError("workflow_tool_approval_receipt_corrupt");
    const adopted = await adoptResumeAuthority(
      client,
      schema,
      input,
      receipt,
      replay.outcome.authority,
    );
    const refreshed = { ...replay, outcome: { ...replay.outcome, ...adopted } };
    await client.query(
      `UPDATE ${schema}.workflow_tool_approval_handoffs SET consumption_result_json=$1
       WHERE tenant_id=$2 AND run_id=$3 AND approval_id=$4 AND consumption_operation_id=$5`,
      [stableJson(refreshed), input.authority.tenantId, input.authority.runId, input.approvalId, input.operationId],
    );
    return { ...refreshed, disposition: "replay" };
  }
  const receipt = await loadPostgresToolExecutionReceipt(client, schema, replay.outcome.receipt);
  if (
    receipt === null ||
    receipt.receiptId !== replay.outcome.receipt.receiptId ||
    receipt.actionDigest !== replay.outcome.receipt.actionDigest ||
    receipt.workItemId !== replay.outcome.authority.workItemId ||
    receipt.revision < replay.outcome.receipt.revision
  )
    throw new RunStoreError("workflow_tool_approval_receipt_corrupt");
  return { ...replay, disposition: "replay" };
}

function terminalOutcome(
  approval: import("@crewon/domain").ToolApprovalState,
  adopted: { authority: WorkflowAgentAttemptAuthority; receipt: ToolExecutionReceiptState },
): WorkflowToolApprovalOutcome {
  if (approval.status === "approved") return { kind: "approved", approval, ...adopted };
  if (approval.status === "rejected")
    return { kind: "failed", failureCode: "tool_approval_rejected", approval, ...adopted };
  if (approval.status === "expired")
    return { kind: "failed", failureCode: "tool_approval_expired", approval, ...adopted };
  if (approval.status === "superseded") return { kind: "canceled", approval, ...adopted };
  throw new RunStoreError("workflow_tool_approval_not_decided");
}
