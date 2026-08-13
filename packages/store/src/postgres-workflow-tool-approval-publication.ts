import {
  RunStoreError,
  type PublishWorkflowToolApprovalInput,
  type WorkflowToolApprovalPublicationResult,
} from "@crewon/application";
import {
  reduceRunLifecycleEvent,
  validateToolApprovalState,
  type RunState,
  type WorkflowContentDigester,
} from "@crewon/domain";
import type { PoolClient } from "pg";

import { loadPostgresRunAttempt } from "./postgres-execution-authority.ts";
import {
  writePostgresOutbox,
  writePostgresRunEvents,
  writePostgresRunSnapshot,
} from "./postgres-run-writer.ts";
import {
  insertPostgresToolApproval,
  loadPostgresToolApproval,
} from "./postgres-tool-approvals.ts";
import { loadPostgresToolExecutionReceipt } from "./postgres-tool-execution.ts";
import { postgresDate } from "./postgres-queue-codec.ts";
import { assertPostgresSchemaNotNewer } from "./postgres-store-support.ts";
import { loadPostgresWorkflowExecution } from "./postgres-workflow-run-composition-transactions.ts";
import {
  decodePostgresWorkflowToolApprovalResult,
  loadPostgresWorkflowApprovalCheckpoint,
  loadPostgresWorkflowToolApprovalHandoff,
  postgresWorkflowToolApprovalFingerprint,
  postgresWorkflowToolApprovalResumePayload,
} from "./postgres-workflow-tool-approval-support.ts";
import { stableJson } from "./store-invariants.ts";
import { parseBoundWorkflow } from "./workflow-run-composition-support.ts";

export async function migratePostgresWorkflowToolApprovals(
  client: PoolClient,
  schema: string,
): Promise<void> {
  await assertPostgresSchemaNotNewer(
    client,
    schema,
    "workflow_tool_approval",
    1,
  );
  const current = await client.query<{ version: number }>(
    `SELECT version FROM ${schema}.schema_migrations
     WHERE component='workflow_tool_approval'`,
  );
  if (current.rows[0] !== undefined)
    await assertPhysicalSchema(client, schema, current.rows[0].version);
  await client.query(`
    INSERT INTO ${schema}.schema_migrations(component, version)
      VALUES ('workflow_tool_approval', 1) ON CONFLICT (component) DO NOTHING;
    CREATE TABLE IF NOT EXISTS ${schema}.workflow_tool_approval_handoffs (
      tenant_id text NOT NULL, run_id text NOT NULL, approval_id text NOT NULL,
      action_digest text NOT NULL, receipt_id text NOT NULL,
      node_id text NOT NULL, claim_id text NOT NULL,
      claim_epoch bigint NOT NULL CHECK (claim_epoch BETWEEN 1 AND 9007199254740991),
      step_id text NOT NULL, attempt_id text NOT NULL,
      agent_work_item_id text NOT NULL, resume_work_item_id text NOT NULL UNIQUE,
      publication_operation_id text NOT NULL, publication_fingerprint text NOT NULL,
      publication_result_json jsonb NOT NULL,
      consumption_operation_id text, consumption_fingerprint text,
      consumption_result_json jsonb, created_at timestamptz NOT NULL,
      consumed_at timestamptz,
      PRIMARY KEY (tenant_id,run_id,approval_id),
      UNIQUE (tenant_id,run_id,publication_operation_id),
      FOREIGN KEY (approval_id) REFERENCES ${schema}.tool_approvals(approval_id),
      FOREIGN KEY (tenant_id,run_id,step_id,attempt_id)
        REFERENCES ${schema}.run_attempts(tenant_id,run_id,step_id,attempt_id)
    )`);
  await assertPhysicalSchema(client, schema, 1);
}

async function assertPhysicalSchema(
  client: PoolClient,
  schema: string,
  version: number | undefined,
): Promise<void> {
  const columns = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema=$1 AND table_name='workflow_tool_approval_handoffs'
     ORDER BY ordinal_position`,
    [schema.replaceAll('"', "")],
  );
  const expected = [
    "tenant_id",
    "run_id",
    "approval_id",
    "action_digest",
    "receipt_id",
    "node_id",
    "claim_id",
    "claim_epoch",
    "step_id",
    "attempt_id",
    "agent_work_item_id",
    "resume_work_item_id",
    "publication_operation_id",
    "publication_fingerprint",
    "publication_result_json",
    "consumption_operation_id",
    "consumption_fingerprint",
    "consumption_result_json",
    "created_at",
    "consumed_at",
  ];
  if (
    version !== 1 ||
    columns.rows.map((row) => row.column_name).join(",") !== expected.join(",")
  )
    throw new RunStoreError("postgres_schema_version_unsupported");
}

export async function publishPostgresWorkflowToolApproval(
  client: PoolClient,
  schema: string,
  input: PublishWorkflowToolApprovalInput,
  currentRun: RunState,
  digester: WorkflowContentDigester,
): Promise<WorkflowToolApprovalPublicationResult> {
  const fingerprint = postgresWorkflowToolApprovalFingerprint(
    digester,
    "publish",
    input,
  );
  const replay = await loadPostgresWorkflowToolApprovalHandoff(
    client,
    schema,
    input,
  );
  if (replay !== null) {
    if (replay.publication_fingerprint !== fingerprint)
      throw new RunStoreError("workflow_tool_approval_operation_conflict");
    const result =
      decodePostgresWorkflowToolApprovalResult<WorkflowToolApprovalPublicationResult>(
        replay.publication_result_json,
      );
    const approval = await loadPostgresToolApproval(
      client,
      schema,
      input.approval,
    );
    if (
      approval === null ||
      stableJson(approval) !== stableJson(result.approval) ||
      result.resumeWorkItemId !== approval.workItemId
    )
      throw new RunStoreError("workflow_tool_approval_receipt_corrupt");
    return { ...result, disposition: "replay" };
  }
  validatePublicationEnvelope(input, currentRun);
  await validatePublicationAuthority(client, schema, input, digester);
  const nextRun = reduceRunLifecycleEvent(currentRun, input.requiredEvent);
  if (nextRun.status !== "waitingApproval")
    throw new RunStoreError("workflow_tool_approval_event_mismatch");
  await insertResumeWorkItem(client, schema, input);
  await insertPostgresToolApproval(client, schema, input.approval);
  await writePostgresRunSnapshot(
    client,
    schema,
    currentRun,
    nextRun,
    currentRun.revision,
  );
  await writePostgresRunEvents(
    client,
    schema,
    [input.requiredEvent],
    currentRun.tenantId,
  );
  await writePostgresOutbox(client, schema, [input.publicationOutbox]);
  const result: WorkflowToolApprovalPublicationResult = {
    disposition: "published",
    approval: input.approval,
    resumeWorkItemId: input.approval.workItemId,
  };
  await client.query(
    `INSERT INTO ${schema}.workflow_tool_approval_handoffs
     (tenant_id,run_id,approval_id,action_digest,receipt_id,node_id,claim_id,
      claim_epoch,step_id,attempt_id,agent_work_item_id,resume_work_item_id,
      publication_operation_id,publication_fingerprint,publication_result_json,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      input.authority.tenantId,
      input.authority.runId,
      input.approval.approvalId,
      input.approval.actionDigest,
      input.approval.receiptId,
      input.authority.nodeId,
      input.authority.claimId,
      input.authority.claimEpoch,
      input.authority.attempt.stepId,
      input.authority.attempt.attemptId,
      input.authority.workItemId,
      input.approval.workItemId,
      input.operationId,
      fingerprint,
      stableJson(result),
      input.requiredEvent.occurredAt,
    ],
  );
  return result;
}

async function validatePublicationAuthority(
  client: PoolClient,
  schema: string,
  input: PublishWorkflowToolApprovalInput,
  digester: WorkflowContentDigester,
): Promise<void> {
  if (
    !Number.isSafeInteger(input.approvalRecheckMs) ||
    input.approvalRecheckMs < 1 ||
    input.approvalRecheckMs > 86_400_000
  )
    throw new RunStoreError("workflow_tool_approval_recheck_invalid");
  const version = await client.query<{ definition_json: string }>(
    `SELECT definition_json FROM ${schema}.workflow_versions
     WHERE tenant_id=$1 AND workflow_version_id=$2`,
    [input.authority.tenantId, input.binding.workflowVersionId],
  );
  parseBoundWorkflow(
    version.rows[0]?.definition_json ?? "",
    input.binding,
    digester,
  );
  await validatePublicationLease(client, schema, input);
  const attempt = await loadPostgresRunAttempt(
    client,
    schema,
    { ...input.authority, ...input.authority.attempt },
    true,
  );
  const execution = await loadPostgresWorkflowExecution(
    client,
    schema,
    input.authority,
    true,
  );
  const node = execution?.nodes.find(
    (candidate) => candidate.nodeId === input.authority.nodeId,
  );
  if (
    attempt?.status !== "running" ||
    attempt.workItemId !== input.authority.workItemId ||
    attempt.leaseEpoch !== input.authority.leaseEpoch ||
    node?.status !== "running" ||
    node.claimId !== input.authority.claimId ||
    node.claimEpoch !== input.authority.claimEpoch ||
    node.agentVersionId !== input.authority.agentVersionId
  )
    throw new RunStoreError("workflow_tool_approval_authority_mismatch");
  const checkpoint = await loadPostgresWorkflowApprovalCheckpoint(
    client,
    schema,
    input.authority,
    true,
  );
  if (
    checkpoint === null ||
    checkpoint.revision !== input.expectedContinuationRevision ||
    stableJson(checkpoint.authority) !== stableJson(input.authority)
  )
    throw new RunStoreError("workflow_node_continuation_revision_conflict");
  const receipt = await loadPostgresToolExecutionReceipt(
    client,
    schema,
    input.receipt,
    true,
  );
  if (
    receipt === null ||
    stableJson(receipt) !== stableJson(input.receipt) ||
    receipt.status !== "prepared" ||
    receipt.workItemId !== input.authority.workItemId ||
    receipt.actionDigest !== input.approval.actionDigest ||
    receipt.receiptId !== input.approval.receiptId
  )
    throw new RunStoreError("workflow_tool_approval_receipt_mismatch");
  const pending = checkpoint.history.find(
    (item) =>
      item.type === "tool_call" &&
      item.callId === receipt.call.callId &&
      item.kind === receipt.call.kind &&
      item.name === receipt.call.name,
  );
  if (
    pending?.type !== "tool_call" ||
    digester.sha256(pending.input) !== receipt.call.inputDigest
  )
    throw new RunStoreError("workflow_tool_approval_pending_call_missing");
}

async function validatePublicationLease(
  client: PoolClient,
  schema: string,
  input: PublishWorkflowToolApprovalInput,
): Promise<void> {
  const work = await client.query<{
    tenant_id: string;
    run_id: string;
    status: string;
    lease_owner_id: string | null;
    lease_id: string | null;
    lease_epoch: string | number;
    lease_expires_at: Date | string | null;
    database_now: Date | string;
  }>(
    `SELECT tenant_id,run_id,status,lease_owner_id,lease_id,lease_epoch,
            lease_expires_at,clock_timestamp() AS database_now
     FROM ${schema}.work_items WHERE work_item_id=$1 FOR UPDATE`,
    [input.lease.workItemId],
  );
  const current = work.rows[0];
  if (
    current?.tenant_id !== input.authority.tenantId ||
    current.run_id !== input.authority.runId ||
    current.status !== "leased" ||
    current.lease_owner_id !== input.lease.ownerId ||
    current.lease_id !== input.lease.leaseId ||
    Number(current.lease_epoch) !== input.lease.leaseEpoch ||
    current.lease_expires_at === null ||
    postgresDate(current.lease_expires_at).getTime() <=
      postgresDate(current.database_now).getTime()
  )
    throw new RunStoreError("stale_lease");
}

function validatePublicationEnvelope(
  input: PublishWorkflowToolApprovalInput,
  run: RunState,
): void {
  validateToolApprovalState(input.approval);
  if (
    input.approval.status !== "required" ||
    input.approval.tenantId !== input.authority.tenantId ||
    input.approval.runId !== input.authority.runId ||
    input.approval.workItemId === input.authority.workItemId ||
    input.requiredEvent.type !== "run.approval.required" ||
    input.requiredEvent.data.approvalId !== input.approval.approvalId ||
    input.requiredEvent.data.actionDigest !== input.approval.actionDigest ||
    input.requiredEvent.identity.runId !== run.runId ||
    input.requiredEvent.sequence !== run.lastSequence + 1 ||
    input.publicationOutbox.tenantId !== run.tenantId ||
    input.publicationOutbox.runId !== run.runId ||
    input.publicationOutbox.topic !== "run.updated" ||
    input.publicationOutbox.createdAt !== input.requiredEvent.occurredAt ||
    stableJson(input.publicationOutbox.payload) !==
      stableJson({
        eventId: input.requiredEvent.eventId,
        eventType: input.requiredEvent.type,
        throughSequence: input.requiredEvent.sequence,
      })
  )
    throw new RunStoreError("workflow_tool_approval_event_mismatch");
}

async function insertResumeWorkItem(
  client: PoolClient,
  schema: string,
  input: PublishWorkflowToolApprovalInput,
): Promise<void> {
  const item = {
    workItemId: input.approval.workItemId,
    tenantId: input.authority.tenantId,
    runId: input.authority.runId,
    kind: "run.execute" as const,
    payload: postgresWorkflowToolApprovalResumePayload(
      {
        binding: input.binding,
        authority: input.authority,
        approvalId: input.approval.approvalId,
        actionDigest: input.approval.actionDigest,
      },
      input.approval.receiptId,
    ),
    createdAt: input.requiredEvent.occurredAt,
  };
  await client.query(
    `INSERT INTO ${schema}.work_items
     (work_item_id,tenant_id,run_id,kind,work_item_json,created_at,available_at)
     VALUES ($1,$2,$3,$4,$5,$6,
       clock_timestamp()+$7*interval '1 millisecond')`,
    [
      item.workItemId,
      item.tenantId,
      item.runId,
      item.kind,
      stableJson(item),
      item.createdAt,
      input.approvalRecheckMs,
    ],
  );
}
