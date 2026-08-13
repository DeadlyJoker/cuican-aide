import type { DatabaseSync } from "node:sqlite";
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
import { readLeaseClock, type LeaseClock } from "./lease-clock.ts";
import { rollback } from "./sqlite-schema.ts";
import { insertSqliteToolApproval } from "./sqlite-tool-approvals.ts";
import { loadSqliteToolExecutionReceipt } from "./sqlite-tool-execution-receipts.ts";
import { stableJson } from "./store-invariants.ts";

export type WorkflowApprovalPublicationSupport = Readonly<{
  fingerprint(input: PublishWorkflowToolApprovalInput): string;
  loadReplay(input: PublishWorkflowToolApprovalInput): Readonly<{
    publication_fingerprint: string;
    publication_result_json: string;
  }> | null;
  validateReplay(
    input: PublishWorkflowToolApprovalInput,
    result: WorkflowToolApprovalPublicationResult,
  ): void;
  validateAuthority(
    input: PublishWorkflowToolApprovalInput,
    nowMs: number,
  ): void;
  loadCheckpoint(input: PublishWorkflowToolApprovalInput): Readonly<{
    revision: number;
    history: readonly import("@crewon/application").WorkflowContinuationHistoryItem[];
  }>;
  loadRun(tenantId: string, runId: string): RunState;
  insertResume(input: PublishWorkflowToolApprovalInput, nowMs: number): void;
  writeRun(
    input: PublishWorkflowToolApprovalInput,
    current: RunState,
    next: RunState,
  ): void;
  completeLease(input: PublishWorkflowToolApprovalInput, nowMs: number): void;
}>;

export async function publishSqliteWorkflowToolApproval(
  dependencies: Readonly<{
    database: DatabaseSync;
    clock: LeaseClock;
    digester: WorkflowContentDigester;
    support: WorkflowApprovalPublicationSupport;
  }>,
  input: PublishWorkflowToolApprovalInput,
): Promise<WorkflowToolApprovalPublicationResult> {
  const { database, clock, digester, support } = dependencies;
  const fingerprint = support.fingerprint(input);
  try {
    database.exec("BEGIN IMMEDIATE");
    const replay = support.loadReplay(input);
    if (replay !== null) {
      if (replay.publication_fingerprint !== fingerprint)
        throw new RunStoreError("workflow_tool_approval_operation_conflict");
      const result = JSON.parse(
        replay.publication_result_json,
      ) as WorkflowToolApprovalPublicationResult;
      support.validateReplay(input, result);
      database.exec("COMMIT");
      return { ...result, disposition: "replay" };
    }
    const nowMs = readLeaseClock(clock);
    if (
      !Number.isSafeInteger(input.approvalRecheckMs) ||
      input.approvalRecheckMs < 1 ||
      input.approvalRecheckMs > 86_400_000
    )
      throw new RunStoreError("workflow_tool_approval_recheck_invalid");
    support.validateAuthority(input, nowMs);
    const checkpoint = support.loadCheckpoint(input);
    if (checkpoint.revision !== input.expectedContinuationRevision)
      throw new RunStoreError("workflow_node_continuation_revision_conflict");
    const receipt = loadSqliteToolExecutionReceipt(database, input.receipt);
    if (
      receipt === null ||
      stableJson(receipt) !== stableJson(input.receipt) ||
      receipt.workItemId !== input.authority.workItemId ||
      receipt.actionDigest !== input.approval.actionDigest ||
      receipt.receiptId !== input.approval.receiptId ||
      receipt.status !== "prepared"
    )
      throw new RunStoreError("workflow_tool_approval_receipt_mismatch");
    const pendingCall = checkpoint.history.find(
      (item) =>
        item.type === "tool_call" &&
        item.callId === receipt.call.callId &&
        item.kind === receipt.call.kind &&
        item.name === receipt.call.name,
    );
    if (
      pendingCall === undefined ||
      pendingCall.type !== "tool_call" ||
      digester.sha256(pendingCall.input) !== receipt.call.inputDigest
    )
      throw new RunStoreError("workflow_tool_approval_pending_call_missing");
    validateToolApprovalState(input.approval);
    if (
      input.approval.status !== "required" ||
      input.approval.tenantId !== input.authority.tenantId ||
      input.approval.runId !== input.authority.runId ||
      input.approval.workItemId === input.authority.workItemId ||
      input.requiredEvent.type !== "run.approval.required" ||
      input.requiredEvent.data.approvalId !== input.approval.approvalId ||
      input.requiredEvent.data.actionDigest !== input.approval.actionDigest
    )
      throw new RunStoreError("workflow_tool_approval_binding_mismatch");
    const currentRun = support.loadRun(
      input.authority.tenantId,
      input.authority.runId,
    );
    if (
      input.requiredEvent.identity.runId !== currentRun.runId ||
      input.requiredEvent.sequence !== currentRun.lastSequence + 1 ||
      input.publicationOutbox.tenantId !== currentRun.tenantId ||
      input.publicationOutbox.runId !== currentRun.runId ||
      input.publicationOutbox.topic !== "run.updated" ||
      stableJson(input.publicationOutbox.payload) !==
        stableJson({
          eventId: input.requiredEvent.eventId,
          eventType: input.requiredEvent.type,
          throughSequence: input.requiredEvent.sequence,
        }) ||
      input.publicationOutbox.createdAt !== input.requiredEvent.occurredAt
    )
      throw new RunStoreError("workflow_tool_approval_event_mismatch");
    const nextRun = reduceRunLifecycleEvent(currentRun, input.requiredEvent);
    if (nextRun.status !== "waitingApproval")
      throw new RunStoreError("workflow_tool_approval_event_mismatch");
    support.insertResume(input, nowMs);
    insertSqliteToolApproval(database, input.approval);
    support.writeRun(input, currentRun, nextRun);
    support.completeLease(input, nowMs);
    const result: WorkflowToolApprovalPublicationResult = {
      disposition: "published",
      approval: input.approval,
      resumeWorkItemId: input.approval.workItemId,
    };
    database
      .prepare(
        `INSERT INTO workflow_tool_approval_handoffs
      (tenant_id,run_id,approval_id,action_digest,receipt_id,node_id,claim_id,
       claim_epoch,step_id,attempt_id,agent_work_item_id,resume_work_item_id,
       publication_operation_id,publication_fingerprint,publication_result_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
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
      );
    database.exec("COMMIT");
    return result;
  } catch (error) {
    rollback(database);
    throw error instanceof RunStoreError
      ? error
      : new RunStoreError("workflow_tool_approval_store_failed", {
          cause: error instanceof Error ? error : undefined,
        });
  }
}
