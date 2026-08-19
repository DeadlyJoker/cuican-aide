import {
  canonicalJson,
  MAX_WORKFLOW_CONTINUATION_HISTORY_ITEMS,
  MAX_WORKFLOW_PENDING_TOOL_RESUMES,
  RunStoreError,
  type WorkItemLeaseInput,
  type WorkflowAgentAttemptAuthority,
  type WorkflowNodeContinuationCheckpoint,
  type WorkflowPendingToolResume,
} from "@crewon/application";
import { canonicalActionIntent } from "@crewon/contracts/runtime";
import type {
  RunAttemptState,
  RunLifecycleEvent,
  ToolExecutionReceiptState,
  WorkflowContentDigester,
} from "@crewon/domain";
import { validateToolExecutionReceipt } from "@crewon/domain";
import type { PoolClient } from "pg";

import {
  loadPostgresRunAttempt,
  loadPostgresRunStep,
} from "./postgres-execution-authority.ts";
import {
  decodePostgresRunEvent,
  type PostgresRunEventRow,
} from "./postgres-run-codec.ts";
import { loadPostgresToolExecutionReceipt } from "./postgres-tool-execution.ts";
import { stableJson } from "./store-invariants.ts";

type Requested = Extract<RunLifecycleEvent, { type: "tool.requested" }>;

export async function adoptPostgresWorkflowPendingTools(
  client: PoolClient,
  schema: string,
  input: Readonly<{
    sourceAuthority: WorkflowAgentAttemptAuthority;
    reconciliationLease: WorkItemLeaseInput;
    continuation: WorkflowNodeContinuationCheckpoint;
    adoptedAt: string;
    digester: WorkflowContentDigester;
  }>,
): Promise<readonly WorkflowPendingToolResume[]> {
  const expectedAuthority = {
    ...input.sourceAuthority,
    workItemId: input.reconciliationLease.workItemId,
    leaseEpoch: input.reconciliationLease.leaseEpoch,
  };
  if (
    stableJson(input.continuation.authority) !==
      stableJson(expectedAuthority) ||
    !toolSegmentMatchesParent(
      input.sourceAuthority.attempt.attemptId,
      input.continuation.segmentId,
    )
  )
    corrupt();
  const pending = await loadPendingRequests(client, schema, input);
  const receiptIds = await client.query<{ receipt_id: string }>(
    `SELECT receipt_id FROM ${schema}.tool_execution_receipts receipt
     WHERE tenant_id=$1 AND run_id=$2
       AND state_json->'call'->>'segmentId'=$3
       AND NOT EXISTS (
         SELECT 1 FROM ${schema}.run_events completed
         WHERE completed.tenant_id=receipt.tenant_id
           AND completed.run_id=receipt.run_id
           AND completed.event_json->>'type'='tool.completed'
           AND completed.event_json->'data'->>'segmentId'=
             receipt.state_json->'call'->>'segmentId'
           AND completed.event_json->'data'->>'callId'=
             receipt.state_json->'call'->>'callId')
     ORDER BY receipt_id LIMIT $4 FOR UPDATE`,
    [
      input.sourceAuthority.tenantId,
      input.sourceAuthority.runId,
      input.continuation.segmentId,
      MAX_WORKFLOW_PENDING_TOOL_RESUMES + 1,
    ],
  );
  if (receiptIds.rows.length > MAX_WORKFLOW_PENDING_TOOL_RESUMES) corrupt();
  const receipts: ToolExecutionReceiptState[] = [];
  for (const row of receiptIds.rows) {
    const receipt = await loadPostgresToolExecutionReceipt(
      client,
      schema,
      {
        tenantId: input.sourceAuthority.tenantId,
        runId: input.sourceAuthority.runId,
        receiptId: row.receipt_id,
      },
      true,
    );
    if (receipt === null) corrupt();
    receipts.push(receipt);
  }
  const byCall = new Map<string, ToolExecutionReceiptState[]>();
  for (const receipt of receipts) {
    const matches = byCall.get(receipt.call.callId) ?? [];
    matches.push(receipt);
    byCall.set(receipt.call.callId, matches);
  }
  const adopted: WorkflowPendingToolResume[] = [];
  const adoptedReceiptIds = new Set<string>();
  for (const request of pending) {
    const matches = byCall.get(request.data.callId) ?? [];
    if (matches.length === 0) continue;
    if (matches.length !== 1) corrupt();
    adoptedReceiptIds.add(matches[0]!.receiptId);
    adopted.push(
      await adoptPendingTool(client, schema, input, request, matches[0]!),
    );
  }
  if (
    adopted.length > MAX_WORKFLOW_PENDING_TOOL_RESUMES ||
    receipts.some((receipt) => !adoptedReceiptIds.has(receipt.receiptId))
  )
    corrupt();
  return structuredClone(adopted);
}

async function loadPendingRequests(
  client: PoolClient,
  schema: string,
  input: Parameters<typeof adoptPostgresWorkflowPendingTools>[2],
): Promise<readonly Requested[]> {
  const events = await client.query<PostgresRunEventRow>(
    `SELECT tenant_id,run_id,sequence,event_id,event_json
     FROM ${schema}.run_events requested
     WHERE tenant_id=$1 AND run_id=$2
       AND event_json->'data'->>'segmentId'=$3
       AND event_json->>'type'='tool.requested'
       AND NOT EXISTS (
         SELECT 1 FROM ${schema}.run_events completed
         WHERE completed.tenant_id=requested.tenant_id
           AND completed.run_id=requested.run_id
           AND completed.event_json->>'type'='tool.completed'
           AND completed.event_json->'data'->>'segmentId'=
             requested.event_json->'data'->>'segmentId'
           AND completed.event_json->'data'->>'callId'=
             requested.event_json->'data'->>'callId')
     ORDER BY (event_json->'data'->>'segmentSequence')::bigint,sequence
     LIMIT $4`,
    [
      input.sourceAuthority.tenantId,
      input.sourceAuthority.runId,
      input.continuation.segmentId,
      MAX_WORKFLOW_CONTINUATION_HISTORY_ITEMS + 1,
    ],
  );
  if (events.rows.length > MAX_WORKFLOW_CONTINUATION_HISTORY_ITEMS) corrupt();
  const requested: Requested[] = [];
  const callIds = new Set<string>();
  const segmentSequences = new Set<number>();
  for (const row of events.rows) {
    const event = decodePostgresRunEvent(row, input.sourceAuthority);
    if (
      event.schemaVersion !== "crewon.run-event.v0" ||
      event.type !== "tool.requested"
    )
      corrupt();
    if (
      event.data.segmentId !== input.continuation.segmentId ||
      !Number.isSafeInteger(event.data.segmentSequence) ||
      event.data.segmentSequence < 1 ||
      typeof event.data.callId !== "string" ||
      event.data.callId.length === 0 ||
      (event.data.kind !== "function" && event.data.kind !== "custom") ||
      typeof event.data.name !== "string" ||
      event.data.name.length === 0 ||
      typeof event.data.input !== "string" ||
      callIds.has(event.data.callId) ||
      segmentSequences.has(event.data.segmentSequence)
    )
      corrupt();
    callIds.add(event.data.callId);
    segmentSequences.add(event.data.segmentSequence);
    requested.push(event);
  }
  const calls = input.continuation.history.filter(
    (item) => item.type === "tool_call",
  );
  const results = new Set(
    input.continuation.history
      .filter((item) => item.type === "tool_result")
      .map((item) => item.callId),
  );
  if (new Set(calls.map((call) => call.callId)).size !== calls.length)
    corrupt();
  for (const event of requested) {
    const call = calls.find((item) => item.callId === event.data.callId);
    if (
      call === undefined ||
      call.kind !== event.data.kind ||
      call.name !== event.data.name ||
      call.input !== event.data.input ||
      results.has(event.data.callId)
    )
      corrupt();
  }
  return requested;
}

async function adoptPendingTool(
  client: PoolClient,
  schema: string,
  input: Parameters<typeof adoptPostgresWorkflowPendingTools>[2],
  request: Requested,
  receipt: ToolExecutionReceiptState,
): Promise<WorkflowPendingToolResume> {
  const intent = receipt.actionIntent;
  let actionDigest: string;
  try {
    actionDigest =
      intent === null
        ? ""
        : input.digester.sha256(canonicalActionIntent(intent));
  } catch {
    corrupt();
  }
  if (
    receipt.status === "completed" ||
    receipt.status === "canceled" ||
    receipt.tenantId !== input.sourceAuthority.tenantId ||
    receipt.runId !== input.sourceAuthority.runId ||
    receipt.workItemId !== input.sourceAuthority.workItemId ||
    receipt.call.segmentId !== input.continuation.segmentId ||
    receipt.call.callId !== request.data.callId ||
    receipt.call.kind !== request.data.kind ||
    receipt.call.name !== request.data.name ||
    receipt.call.inputDigest !== input.digester.sha256(request.data.input) ||
    receipt.result !== null ||
    receipt.resolvedAt !== null ||
    ((receipt.status === "prepared" || receipt.status === "dispatched") &&
      receipt.providerReceiptId !== null) ||
    intent === null ||
    intent.runId !== receipt.runId ||
    intent.segmentId !== receipt.call.segmentId ||
    intent.callId !== receipt.call.callId ||
    actionDigest !== receipt.actionDigest
  )
    corrupt();
  const step = await loadPostgresRunStep(client, schema, receipt, true);
  const attempt = await loadPostgresRunAttempt(client, schema, receipt, true);
  if (
    step?.kind !== "tool" ||
    step.status !== "running" ||
    step.currentAttemptId !== receipt.attemptId ||
    attempt?.status !== "running" ||
    attempt.stepId !== receipt.stepId ||
    attempt.attemptId !== receipt.attemptId ||
    attempt.workItemId !== receipt.workItemId ||
    attempt.leaseEpoch !== input.sourceAuthority.leaseEpoch ||
    attempt.providerCheckpoint !== null ||
    attempt.checkpointDigest !== null ||
    attempt.providerTurnState !== null ||
    attempt.failure !== null ||
    attempt.terminalAt !== null
  )
    corrupt();
  if (
    receipt.workItemId === input.reconciliationLease.workItemId &&
    attempt.leaseEpoch === input.reconciliationLease.leaseEpoch
  )
    return {
      receipt: pendingReceipt(receipt),
      step: { ...step, kind: "tool", status: "running" },
      attempt: { ...attempt, status: "running" },
    };
  if (Date.parse(input.adoptedAt) < Date.parse(receipt.updatedAt)) corrupt();
  const resumedAttempt = {
    ...attempt,
    workItemId: input.reconciliationLease.workItemId,
    leaseEpoch: input.reconciliationLease.leaseEpoch,
    updatedAt: input.adoptedAt,
    status: "running" as const,
  } satisfies RunAttemptState;
  const attemptUpdate = await client.query(
    `UPDATE ${schema}.run_attempts
     SET work_item_id=$1,lease_epoch=$2,state_json=$3::jsonb,updated_at=$4
     WHERE tenant_id=$5 AND run_id=$6 AND step_id=$7 AND attempt_id=$8
       AND status='running' AND work_item_id=$9 AND lease_epoch=$10
       AND state_json=$11::jsonb`,
    [
      resumedAttempt.workItemId,
      resumedAttempt.leaseEpoch,
      stableJson(resumedAttempt),
      resumedAttempt.updatedAt,
      receipt.tenantId,
      receipt.runId,
      receipt.stepId,
      receipt.attemptId,
      attempt.workItemId,
      attempt.leaseEpoch,
      stableJson(attempt),
    ],
  );
  if (attemptUpdate.rowCount !== 1) corrupt();
  const resumedReceipt = {
    ...receipt,
    workItemId: input.reconciliationLease.workItemId,
    revision: receipt.revision + 1,
    updatedAt: input.adoptedAt,
  } satisfies ToolExecutionReceiptState;
  try {
    validateToolExecutionReceipt(resumedReceipt);
  } catch {
    corrupt();
  }
  const receiptUpdate = await client.query(
    `UPDATE ${schema}.tool_execution_receipts
     SET work_item_id=$1,revision=$2,state_json=$3::jsonb,updated_at=$4
     WHERE tenant_id=$5 AND run_id=$6 AND receipt_id=$7
       AND status=$8 AND revision=$9 AND work_item_id=$10
       AND state_json=$11::jsonb`,
    [
      resumedReceipt.workItemId,
      resumedReceipt.revision,
      stableJson(resumedReceipt),
      resumedReceipt.updatedAt,
      receipt.tenantId,
      receipt.runId,
      receipt.receiptId,
      receipt.status,
      receipt.revision,
      receipt.workItemId,
      stableJson(receipt),
    ],
  );
  if (receiptUpdate.rowCount !== 1) corrupt();
  return {
    receipt: pendingReceipt(resumedReceipt),
    step: { ...step, kind: "tool", status: "running" },
    attempt: resumedAttempt,
  };
}

function pendingReceipt(
  receipt: ToolExecutionReceiptState,
): WorkflowPendingToolResume["receipt"] {
  if (
    receipt.status !== "prepared" &&
    receipt.status !== "dispatched" &&
    receipt.status !== "unknownOutcome"
  )
    corrupt();
  return receipt as WorkflowPendingToolResume["receipt"];
}

function toolSegmentMatchesParent(
  parentAttemptId: string,
  segmentId: string,
): boolean {
  const prefix = `segment:${parentAttemptId}`;
  if (segmentId === prefix) return true;
  return /^:round:[1-9][0-9]{0,3}$/u.test(segmentId.slice(prefix.length));
}

function corrupt(): never {
  throw new RunStoreError("workflow_reconciliation_evidence_corrupt");
}
