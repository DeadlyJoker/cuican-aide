import {
  RunStoreError,
  canonicalJson,
  validateWorkflowNodeContinuationCheckpoint,
  type ConsumeWorkflowToolApprovalInput,
  type PublishWorkflowToolApprovalInput,
  type WorkflowAgentAttemptAuthority,
} from "@crewon/application";
import type { WorkflowContentDigester } from "@crewon/domain";
import type { PoolClient } from "pg";

import { loadPostgresToolApproval } from "./postgres-tool-approvals.ts";
import { stableJson } from "./store-invariants.ts";

export type PostgresWorkflowToolApprovalHandoffRow = Readonly<{
  publication_fingerprint: string;
  publication_result_json: unknown;
  consumption_operation_id: string | null;
  consumption_fingerprint: string | null;
  consumption_result_json: unknown | null;
}>;

export function postgresWorkflowToolApprovalResumePayload(
  input: Pick<
    ConsumeWorkflowToolApprovalInput,
    "binding" | "authority" | "approvalId" | "actionDigest"
  >,
  receiptId: string,
) {
  return {
    schemaVersion: "crewon.workflow-tool-approval-resume-work-item.v0",
    trigger: "workflowToolApprovalResume",
    binding: input.binding,
    nodeId: input.authority.nodeId,
    claimId: input.authority.claimId,
    claimEpoch: input.authority.claimEpoch,
    stepId: input.authority.attempt.stepId,
    attemptId: input.authority.attempt.attemptId,
    agentVersionId: input.authority.agentVersionId,
    agentWorkItemId: input.authority.workItemId,
    agentLeaseEpoch: input.authority.leaseEpoch,
    approvalId: input.approvalId,
    receiptId,
    actionDigest: input.actionDigest,
  };
}

export async function validatePostgresWorkflowToolApprovalResumePayload(
  client: PoolClient,
  schema: string,
  input: ConsumeWorkflowToolApprovalInput,
): Promise<void> {
  const approval = await loadPostgresToolApproval(client, schema, {
    tenantId: input.authority.tenantId,
    approvalId: input.approvalId,
  });
  const work = await client.query<{ work_item_json: { payload?: unknown } }>(
    `SELECT work_item_json FROM ${schema}.work_items
     WHERE work_item_id=$1 FOR UPDATE`,
    [input.lease.workItemId],
  );
  if (
    approval === null ||
    stableJson(work.rows[0]?.work_item_json.payload) !==
      stableJson(
        postgresWorkflowToolApprovalResumePayload(input, approval.receiptId),
      )
  )
    throw new RunStoreError("stale_lease");
}

export async function loadPostgresWorkflowApprovalCheckpoint(
  client: PoolClient,
  schema: string,
  authority: WorkflowAgentAttemptAuthority,
  lock: boolean,
) {
  const result = await client.query<{ state_json: unknown }>(
    `SELECT state_json FROM ${schema}.workflow_node_continuations
     WHERE tenant_id=$1 AND run_id=$2 AND node_id=$3 AND attempt_id=$4${lock ? " FOR UPDATE" : ""}`,
    [
      authority.tenantId,
      authority.runId,
      authority.nodeId,
      authority.attempt.attemptId,
    ],
  );
  return result.rows[0] === undefined
    ? null
    : validateWorkflowNodeContinuationCheckpoint(result.rows[0].state_json);
}

export async function loadPostgresWorkflowToolApprovalHandoff(
  client: PoolClient,
  schema: string,
  input: {
    authority: { tenantId: string; runId: string };
    operationId: string;
    approvalId?: string;
  },
): Promise<PostgresWorkflowToolApprovalHandoffRow | null> {
  const columns = `publication_fingerprint,publication_result_json,
    consumption_operation_id,consumption_fingerprint,consumption_result_json`;
  const result =
    input.approvalId === undefined
      ? await client.query<PostgresWorkflowToolApprovalHandoffRow>(
          `SELECT ${columns} FROM ${schema}.workflow_tool_approval_handoffs
           WHERE tenant_id=$1 AND run_id=$2 AND publication_operation_id=$3
           FOR UPDATE`,
          [input.authority.tenantId, input.authority.runId, input.operationId],
        )
      : await client.query<PostgresWorkflowToolApprovalHandoffRow>(
          `SELECT ${columns} FROM ${schema}.workflow_tool_approval_handoffs
           WHERE tenant_id=$1 AND run_id=$2 AND approval_id=$3 FOR UPDATE`,
          [input.authority.tenantId, input.authority.runId, input.approvalId],
        );
  return result.rows[0] ?? null;
}

export function postgresWorkflowToolApprovalFingerprint(
  digester: WorkflowContentDigester,
  kind: "publish" | "consume",
  input: PublishWorkflowToolApprovalInput | ConsumeWorkflowToolApprovalInput,
): string {
  const value =
    kind === "consume"
      ? (({ lease: _lease, ...semantic }) => semantic)(
          input as ConsumeWorkflowToolApprovalInput,
        )
      : input;
  return digester.sha256(canonicalJson({ kind, input: value }));
}

export function decodePostgresWorkflowToolApprovalResult<T>(input: unknown): T {
  return (typeof input === "string"
    ? JSON.parse(input)
    : structuredClone(input)) as T;
}
