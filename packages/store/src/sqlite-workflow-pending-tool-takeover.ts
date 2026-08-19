import { DatabaseSync } from "node:sqlite";

import { canonicalActionIntent } from "@crewon/contracts/runtime";
import {
  MAX_WORKFLOW_CONTINUATION_HISTORY_ITEMS,
  MAX_WORKFLOW_PENDING_TOOL_RESUMES,
  RunStoreError,
  type WorkItemLeaseInput,
  type WorkflowAgentAttemptAuthority,
  type WorkflowNodeContinuationCheckpoint,
  type WorkflowPendingToolResume,
} from "@crewon/application";
import {
  validateToolExecutionReceipt,
  type RunAttemptState,
  type RunLifecycleEvent,
  type ToolExecutionReceiptState,
  type WorkflowContentDigester,
} from "@crewon/domain";

import {
  loadSqliteRunAttempt,
  loadSqliteRunStep,
} from "./sqlite-execution-authority.ts";
import { loadSqliteToolExecutionReceipt } from "./sqlite-tool-execution-receipts.ts";
import { stableJson } from "./store-invariants.ts";

type RequestedEvent = Extract<RunLifecycleEvent, { type: "tool.requested" }>;

export function takeOverSqliteWorkflowPendingTools(
  database: DatabaseSync,
  input: Readonly<{
    priorAuthority: WorkflowAgentAttemptAuthority;
    reconciliationLease: WorkItemLeaseInput;
    checkpoint: WorkflowNodeContinuationCheckpoint;
    adoptedAt: string;
    digester: WorkflowContentDigester;
  }>,
): readonly WorkflowPendingToolResume[] {
  const pending = loadPendingRequests(database, input);
  const adopted: Array<
    WorkflowPendingToolResume & Readonly<{ segmentSequence: number }>
  > = [];
  const receiptIds = new Set<string>();
  const callIds = new Set<string>();
  const segmentSequences = new Set<number>();
  for (const requested of pending) {
    if (
      callIds.has(requested.data.callId) ||
      segmentSequences.has(requested.data.segmentSequence)
    ) {
      corrupt();
    }
    callIds.add(requested.data.callId);
    segmentSequences.add(requested.data.segmentSequence);
    const rows = database
      .prepare(
        `SELECT receipt_id FROM tool_execution_receipts
         WHERE tenant_id=? AND run_id=?
           AND json_extract(state_json,'$.call.callId')=?
         ORDER BY receipt_id LIMIT 2`,
      )
      .all(
        input.priorAuthority.tenantId,
        input.priorAuthority.runId,
        requested.data.callId,
      ) as unknown as { receipt_id: string }[];
    if (rows.length > 1) corrupt();
    const receiptId = rows[0]?.receipt_id;
    if (receiptId === undefined) continue;
    const receipt = loadSqliteToolExecutionReceipt(database, {
      tenantId: input.priorAuthority.tenantId,
      runId: input.priorAuthority.runId,
      receiptId,
    });
    if (receipt === null || receiptIds.has(receipt.receiptId)) corrupt();
    receiptIds.add(receipt.receiptId);
    adopted.push({
      ...adoptPendingTool(database, input, requested, receipt),
      segmentSequence: requested.data.segmentSequence,
    });
  }
  if (adopted.length > MAX_WORKFLOW_PENDING_TOOL_RESUMES) corrupt();
  requireNoOrphanPendingReceipt(database, input, receiptIds);
  return adopted
    .sort((left, right) => left.segmentSequence - right.segmentSequence)
    .map(({ segmentSequence: _sequence, ...resume }) => resume);
}

function adoptPendingTool(
  database: DatabaseSync,
  input: Parameters<typeof takeOverSqliteWorkflowPendingTools>[1],
  requested: RequestedEvent,
  receipt: ToolExecutionReceiptState,
): WorkflowPendingToolResume {
  const historyCalls = input.checkpoint.history.filter(
    (item) =>
      item.type === "tool_call" && item.callId === requested.data.callId,
  );
  const historyResults = input.checkpoint.history.filter(
    (item) =>
      item.type === "tool_result" && item.callId === requested.data.callId,
  );
  const historyCall = historyCalls[0];
  const step = loadSqliteRunStep(database, {
    tenantId: receipt.tenantId,
    runId: receipt.runId,
    stepId: receipt.stepId,
  });
  const attempt = loadSqliteRunAttempt(database, {
    tenantId: receipt.tenantId,
    runId: receipt.runId,
    stepId: receipt.stepId,
    attemptId: receipt.attemptId,
  });
  let actionDigest: string;
  try {
    actionDigest =
      receipt.actionIntent === null
        ? ""
        : input.digester.sha256(canonicalActionIntent(receipt.actionIntent));
  } catch {
    corrupt();
  }
  if (
    receipt.status === "completed" ||
    receipt.status === "canceled" ||
    receipt.tenantId !== input.priorAuthority.tenantId ||
    receipt.runId !== input.priorAuthority.runId ||
    receipt.workItemId !== input.priorAuthority.workItemId ||
    receipt.call.segmentId !== input.checkpoint.segmentId ||
    receipt.call.segmentId !== requested.data.segmentId ||
    receipt.call.callId !== requested.data.callId ||
    receipt.call.kind !== requested.data.kind ||
    receipt.call.name !== requested.data.name ||
    receipt.call.inputDigest !== input.digester.sha256(requested.data.input) ||
    receipt.actionIntent === null ||
    receipt.actionDigest !== actionDigest ||
    receipt.result !== null ||
    receipt.resolvedAt !== null ||
    ((receipt.status === "prepared" || receipt.status === "dispatched") &&
      receipt.providerReceiptId !== null) ||
    historyCalls.length !== 1 ||
    historyResults.length !== 0 ||
    historyCall?.type !== "tool_call" ||
    historyCall.kind !== requested.data.kind ||
    historyCall.name !== requested.data.name ||
    historyCall.input !== requested.data.input ||
    step?.kind !== "tool" ||
    step.status !== "running" ||
    step.currentAttemptId !== receipt.attemptId ||
    attempt?.status !== "running" ||
    attempt.stepId !== receipt.stepId ||
    attempt.attemptId !== receipt.attemptId ||
    attempt.workItemId !== input.priorAuthority.workItemId ||
    attempt.leaseEpoch !== input.priorAuthority.leaseEpoch ||
    attempt.checkpointDigest !== null ||
    attempt.providerCheckpoint !== null ||
    attempt.providerTurnState !== null ||
    attempt.failure !== null ||
    attempt.terminalAt !== null
  ) {
    corrupt();
  }
  if (
    receipt.workItemId === input.reconciliationLease.workItemId &&
    attempt.leaseEpoch === input.reconciliationLease.leaseEpoch
  ) {
    return {
      receipt: pendingReceipt(receipt),
      step: { ...step, kind: "tool", status: "running" },
      attempt: { ...attempt, status: "running" },
    };
  }
  if (Date.parse(input.adoptedAt) < Date.parse(receipt.updatedAt)) corrupt();
  const resumedAttempt = {
    ...attempt,
    workItemId: input.reconciliationLease.workItemId,
    leaseEpoch: input.reconciliationLease.leaseEpoch,
    updatedAt: input.adoptedAt,
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
      attempt.tenantId,
      attempt.runId,
      attempt.stepId,
      attempt.attemptId,
      attempt.workItemId,
      attempt.leaseEpoch,
      stableJson(attempt),
    );
  if (attemptUpdate.changes !== 1) corrupt();
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
  const receiptUpdate = database
    .prepare(
      `UPDATE tool_execution_receipts
       SET work_item_id=?,revision=?,state_json=?,updated_at=?
       WHERE tenant_id=? AND run_id=? AND receipt_id=? AND status=?
         AND work_item_id=? AND revision=? AND state_json=?`,
    )
    .run(
      resumedReceipt.workItemId,
      resumedReceipt.revision,
      stableJson(resumedReceipt),
      resumedReceipt.updatedAt,
      receipt.tenantId,
      receipt.runId,
      receipt.receiptId,
      receipt.status,
      receipt.workItemId,
      receipt.revision,
      stableJson(receipt),
    );
  if (receiptUpdate.changes !== 1) corrupt();
  return {
    receipt: pendingReceipt(resumedReceipt),
    step: { ...step, kind: "tool", status: "running" },
    attempt: { ...resumedAttempt, status: "running" },
  };
}

function loadPendingRequests(
  database: DatabaseSync,
  input: Parameters<typeof takeOverSqliteWorkflowPendingTools>[1],
): readonly RequestedEvent[] {
  const rows = database
    .prepare(
      `SELECT requested.sequence,event_json FROM run_events requested
       WHERE requested.tenant_id=? AND requested.run_id=?
         AND json_extract(requested.event_json,'$.type')='tool.requested'
         AND json_extract(requested.event_json,'$.data.segmentId')=?
         AND NOT EXISTS (
           SELECT 1 FROM run_events completed
           WHERE completed.tenant_id=requested.tenant_id
             AND completed.run_id=requested.run_id
             AND json_extract(completed.event_json,'$.type')='tool.completed'
             AND json_extract(completed.event_json,'$.data.segmentId')=
               json_extract(requested.event_json,'$.data.segmentId')
             AND json_extract(completed.event_json,'$.data.callId')=
               json_extract(requested.event_json,'$.data.callId'))
       ORDER BY CAST(json_extract(event_json,'$.data.segmentSequence') AS INTEGER),
                requested.sequence
       LIMIT ?`,
    )
    .all(
      input.priorAuthority.tenantId,
      input.priorAuthority.runId,
      input.checkpoint.segmentId,
      MAX_WORKFLOW_CONTINUATION_HISTORY_ITEMS + 1,
    ) as unknown as { sequence: number; event_json: string }[];
  if (rows.length > MAX_WORKFLOW_CONTINUATION_HISTORY_ITEMS) corrupt();
  return rows.map((row) => parseRequestedEvent(row, input));
}

function parseRequestedEvent(
  row: { sequence: number; event_json: string },
  input: Parameters<typeof takeOverSqliteWorkflowPendingTools>[1],
): RequestedEvent {
  let event: RunLifecycleEvent;
  try {
    event = JSON.parse(row.event_json) as RunLifecycleEvent;
  } catch {
    corrupt();
  }
  const rawIdentity: unknown = event.identity;
  const rawData: unknown = event.data;
  const identity: Record<string, unknown> = isRecord(rawIdentity)
    ? rawIdentity
    : {};
  const data: Record<string, unknown> = isRecord(rawData) ? rawData : {};
  if (
    Object.keys(event).sort().join(",") !==
      "data,eventId,identity,occurredAt,schemaVersion,sequence,type" ||
    event.schemaVersion !== "crewon.run-event.v0" ||
    event.type !== "tool.requested" ||
    Object.keys(identity).join(",") !== "runId" ||
    identity.runId !== input.priorAuthority.runId ||
    typeof event.eventId !== "string" ||
    event.eventId.length === 0 ||
    event.sequence !== row.sequence ||
    typeof event.occurredAt !== "string" ||
    Number.isNaN(Date.parse(event.occurredAt)) ||
    Object.keys(data).sort().join(",") !==
      "callId,input,kind,name,segmentId,segmentSequence" ||
    data.segmentId !== input.checkpoint.segmentId ||
    !Number.isSafeInteger(data.segmentSequence) ||
    Number(data.segmentSequence) < 1 ||
    typeof data.callId !== "string" ||
    data.callId.length === 0 ||
    (data.kind !== "function" && data.kind !== "custom") ||
    typeof data.name !== "string" ||
    data.name.length === 0 ||
    typeof data.input !== "string"
  ) {
    corrupt();
  }
  return event as RequestedEvent;
}

function requireNoOrphanPendingReceipt(
  database: DatabaseSync,
  input: Parameters<typeof takeOverSqliteWorkflowPendingTools>[1],
  receiptIds: ReadonlySet<string>,
): void {
  const rows = database
    .prepare(
      `SELECT receipt_id FROM tool_execution_receipts receipt
         WHERE tenant_id=? AND run_id=?
         AND json_extract(state_json,'$.call.segmentId')=?
         AND NOT EXISTS (
           SELECT 1 FROM run_events completed
           WHERE completed.tenant_id=receipt.tenant_id
             AND completed.run_id=receipt.run_id
             AND json_extract(completed.event_json,'$.type')='tool.completed'
             AND json_extract(completed.event_json,'$.data.segmentId')=
               json_extract(receipt.state_json,'$.call.segmentId')
             AND json_extract(completed.event_json,'$.data.callId')=
               json_extract(receipt.state_json,'$.call.callId'))
       ORDER BY receipt_id LIMIT ?`,
    )
    .all(
      input.priorAuthority.tenantId,
      input.priorAuthority.runId,
      input.checkpoint.segmentId,
      MAX_WORKFLOW_PENDING_TOOL_RESUMES + 1,
    ) as unknown as { receipt_id: string }[];
  if (
    rows.length > MAX_WORKFLOW_PENDING_TOOL_RESUMES ||
    rows.some((row) => !receiptIds.has(row.receipt_id))
  ) {
    corrupt();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pendingReceipt(
  receipt: ToolExecutionReceiptState,
): WorkflowPendingToolResume["receipt"] {
  if (
    receipt.status !== "prepared" &&
    receipt.status !== "dispatched" &&
    receipt.status !== "unknownOutcome"
  ) {
    corrupt();
  }
  return receipt as WorkflowPendingToolResume["receipt"];
}

function corrupt(): never {
  throw new RunStoreError("workflow_reconciliation_evidence_corrupt");
}
