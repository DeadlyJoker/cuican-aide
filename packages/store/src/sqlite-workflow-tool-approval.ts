import { DatabaseSync } from "node:sqlite";
import {
  RunStoreError,
  canonicalJson,
  type ConsumeWorkflowToolApprovalInput,
  type PublishWorkflowToolApprovalInput,
  type WorkflowToolApprovalConsumptionResult,
  type WorkflowToolApprovalOutcome,
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
import {
  loadSqliteToolApproval,
  insertSqliteToolApproval,
} from "./sqlite-tool-approvals.ts";
import { loadSqliteToolExecutionReceipt } from "./sqlite-tool-execution-receipts.ts";
import { stableJson } from "./store-invariants.ts";
import { normalizeStoredRunState } from "./stored-run-state.ts";
import { decodeWorkflowExecutionState } from "./workflow-execution-state.ts";
import { parseBoundWorkflow } from "./workflow-run-composition-support.ts";

type HandoffRow = Readonly<{
  publication_fingerprint: string;
  publication_result_json: string;
  consumption_operation_id: string | null;
  consumption_fingerprint: string | null;
  consumption_result_json: string | null;
}>;

/** SQLite-only first authority slice for Workflow per-action Tool approval. */
export class SqliteWorkflowToolApprovalAuthority {
  private readonly database: DatabaseSync;
  private readonly clock: LeaseClock;
  private readonly digester: WorkflowContentDigester;

  constructor(
    database: DatabaseSync,
    clock: LeaseClock,
    digester: WorkflowContentDigester,
  ) {
    this.database = database;
    this.clock = clock;
    this.digester = digester;
  }

  async publish(
    input: PublishWorkflowToolApprovalInput,
  ): Promise<WorkflowToolApprovalPublicationResult> {
    const fingerprint = this.fingerprint("publish", input);
    try {
      this.database.exec("BEGIN IMMEDIATE");
      const replay = this.loadHandoff(input);
      if (replay !== null) {
        if (replay.publication_fingerprint !== fingerprint)
          throw new RunStoreError("workflow_tool_approval_operation_conflict");
        const result = JSON.parse(
          replay.publication_result_json,
        ) as WorkflowToolApprovalPublicationResult;
        this.validatePublicationReplay(input, result);
        this.database.exec("COMMIT");
        return { ...result, disposition: "replay" };
      }

      const nowMs = readLeaseClock(this.clock);
      if (
        !Number.isSafeInteger(input.approvalRecheckMs) ||
        input.approvalRecheckMs < 1 ||
        input.approvalRecheckMs > 86_400_000
      )
        throw new RunStoreError("workflow_tool_approval_recheck_invalid");
      this.validateCommonAuthority(input, nowMs, "agent");
      const checkpoint = this.loadCheckpoint(input);
      if (checkpoint.revision !== input.expectedContinuationRevision)
        throw new RunStoreError("workflow_node_continuation_revision_conflict");
      const receipt = loadSqliteToolExecutionReceipt(
        this.database,
        input.receipt,
      );
      if (
        receipt === null ||
        stableJson(receipt) !== stableJson(input.receipt) ||
        receipt.workItemId !== input.authority.workItemId ||
        receipt.actionDigest !== input.approval.actionDigest ||
        receipt.receiptId !== input.approval.receiptId ||
        receipt.status === "completed"
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
        this.digester.sha256(pendingCall.input) !== receipt.call.inputDigest
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

      const currentRun = this.loadRun(
        input.authority.tenantId,
        input.authority.runId,
      );
      if (
        input.requiredEvent.identity.runId !== currentRun.runId ||
        input.requiredEvent.sequence !== currentRun.lastSequence + 1 ||
        input.publicationOutbox.tenantId !== currentRun.tenantId ||
        input.publicationOutbox.runId !== currentRun.runId ||
        input.publicationOutbox.createdAt !== input.requiredEvent.occurredAt
      )
        throw new RunStoreError("workflow_tool_approval_event_mismatch");
      const nextRun = reduceRunLifecycleEvent(currentRun, input.requiredEvent);
      if (nextRun.status !== "waitingApproval")
        throw new RunStoreError("workflow_tool_approval_event_mismatch");

      this.insertResumeWorkItem(input, nowMs);
      insertSqliteToolApproval(this.database, input.approval);
      this.writeRunPublication(input, currentRun, nextRun);
      this.completeLease(input.lease, nowMs);
      const result: WorkflowToolApprovalPublicationResult = {
        disposition: "published",
        approval: input.approval,
        resumeWorkItemId: input.approval.workItemId,
      };
      this.database
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
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      rollback(this.database);
      throw error instanceof RunStoreError
        ? error
        : new RunStoreError("workflow_tool_approval_store_failed", {
            cause: error instanceof Error ? error : undefined,
          });
    }
  }

  async consume(
    input: ConsumeWorkflowToolApprovalInput,
  ): Promise<WorkflowToolApprovalConsumptionResult> {
    const fingerprint = this.fingerprint("consume", input);
    try {
      this.database.exec("BEGIN IMMEDIATE");
      const handoff = this.loadHandoff(input);
      if (handoff === null)
        throw new RunStoreError("workflow_tool_approval_not_found");
      if (handoff.consumption_operation_id !== null) {
        if (
          handoff.consumption_operation_id !== input.operationId ||
          handoff.consumption_fingerprint !== fingerprint ||
          handoff.consumption_result_json === null
        )
          throw new RunStoreError("workflow_tool_approval_already_consumed");
        const replay = JSON.parse(
          handoff.consumption_result_json,
        ) as WorkflowToolApprovalConsumptionResult;
        if (replay.outcome !== null && "authority" in replay.outcome &&
            (replay.outcome.authority.leaseEpoch !== input.lease.leaseEpoch ||
             replay.outcome.authority.workItemId !== input.lease.workItemId)) {
          this.validateResumeLease(input, readLeaseClock(this.clock));
          const currentReceipt = loadSqliteToolExecutionReceipt(
            this.database, replay.outcome.receipt);
          if (currentReceipt === null)
            throw new RunStoreError("workflow_tool_approval_receipt_corrupt");
          const adopted = this.adoptResumeAuthority(
            input, currentReceipt, replay.outcome.authority);
          const refreshed = { ...replay, outcome: { ...replay.outcome, ...adopted } };
          this.database.prepare(`UPDATE workflow_tool_approval_handoffs
            SET consumption_result_json=? WHERE tenant_id=? AND run_id=? AND approval_id=?
            AND consumption_operation_id=?`).run(stableJson(refreshed),
              input.authority.tenantId, input.authority.runId, input.approvalId,
              input.operationId);
          this.database.exec("COMMIT");
          return { ...refreshed, disposition: "replay" };
        }
        if (replay.outcome !== null && "receipt" in replay.outcome) {
          const receipt = loadSqliteToolExecutionReceipt(
            this.database,
            replay.outcome.receipt,
          );
          if (
            receipt === null ||
            receipt.receiptId !== replay.outcome.receipt.receiptId ||
            receipt.actionDigest !== replay.outcome.receipt.actionDigest ||
            receipt.workItemId !== replay.outcome.authority.workItemId ||
            receipt.revision < replay.outcome.receipt.revision
          )
            throw new RunStoreError("workflow_tool_approval_receipt_corrupt");
        }
        this.database.exec("COMMIT");
        return { ...replay, disposition: "replay" };
      }
      const nowMs = readLeaseClock(this.clock);
      this.validateCommonAuthority(input, nowMs, "resume");
      const approval = loadSqliteToolApproval(this.database, {
        tenantId: input.authority.tenantId,
        approvalId: input.approvalId,
      });
      if (
        approval === null ||
        approval.actionDigest !== input.actionDigest ||
        approval.workItemId !== input.lease.workItemId
      )
        throw new RunStoreError("workflow_tool_approval_binding_mismatch");
      const outcome = this.outcome(approval, input);
      const result: WorkflowToolApprovalConsumptionResult = {
        disposition: "consumed",
        outcome,
      };
      const update = this.database
        .prepare(
          `UPDATE workflow_tool_approval_handoffs
        SET consumption_operation_id=?,consumption_fingerprint=?,consumption_result_json=?,consumed_at=?
        WHERE tenant_id=? AND run_id=? AND approval_id=? AND consumption_operation_id IS NULL`,
        )
        .run(
          input.operationId,
          fingerprint,
          stableJson(result),
          new Date(nowMs).toISOString(),
          input.authority.tenantId,
          input.authority.runId,
          input.approvalId,
        );
      if (update.changes !== 1)
        throw new RunStoreError("workflow_tool_approval_already_consumed");
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      rollback(this.database);
      throw error instanceof RunStoreError
        ? error
        : new RunStoreError("workflow_tool_approval_store_failed", {
            cause: error instanceof Error ? error : undefined,
          });
    }
  }

  private outcome(
    approval: import("@crewon/domain").ToolApprovalState,
    input: ConsumeWorkflowToolApprovalInput,
  ): WorkflowToolApprovalOutcome {
    const receipt = loadSqliteToolExecutionReceipt(this.database, {
        tenantId: input.authority.tenantId,
        runId: input.authority.runId,
        receiptId: approval.receiptId,
      });
    if (
      receipt === null ||
        receipt.actionDigest !== input.actionDigest ||
        receipt.workItemId !== input.authority.workItemId ||
        receipt.status !== "prepared"
    )
      throw new RunStoreError("workflow_tool_approval_receipt_mismatch");
    const adopted = this.adoptResumeAuthority(input, receipt, input.authority);
    if (approval.status === "approved") {
      return {
        kind: "approved",
        approval,
        receipt: adopted.receipt,
        authority: adopted.authority,
      };
    }
    if (approval.status === "rejected")
      return { kind: "failed", failureCode: "tool_approval_rejected",
        approval, ...adopted };
    if (approval.status === "expired")
      return { kind: "failed", failureCode: "tool_approval_expired",
        approval, ...adopted };
    if (approval.status === "superseded")
      return { kind: "canceled", approval, ...adopted };
    throw new RunStoreError("workflow_tool_approval_not_decided");
  }

  private adoptResumeAuthority(
    input: ConsumeWorkflowToolApprovalInput,
    receipt: import("@crewon/domain").ToolExecutionReceiptState,
    sourceAuthority: import("@crewon/application").WorkflowAgentAttemptAuthority,
  ) {
    const authority = {
      ...input.authority,
      workItemId: input.lease.workItemId,
      leaseEpoch: input.lease.leaseEpoch,
    };
    for (const attempt of [
      sourceAuthority.attempt,
      {
        stepId: receipt.stepId,
        attemptId: receipt.attemptId,
      },
    ]) {
      const row = this.database
        .prepare(
          `SELECT state_json FROM run_attempts
        WHERE tenant_id=? AND run_id=? AND step_id=? AND attempt_id=?`,
        )
        .get(
          input.authority.tenantId,
          input.authority.runId,
          attempt.stepId,
          attempt.attemptId,
        ) as { state_json: string } | undefined;
      if (row === undefined)
        throw new RunStoreError("workflow_tool_approval_authority_mismatch");
      const state = JSON.parse(row.state_json) as Record<string, unknown>;
      const update = this.database
        .prepare(
          `UPDATE run_attempts SET work_item_id=?,lease_epoch=?,
        state_json=? WHERE tenant_id=? AND run_id=? AND step_id=? AND attempt_id=?
        AND work_item_id=? AND lease_epoch=?`,
        )
        .run(
          input.lease.workItemId,
          input.lease.leaseEpoch,
          stableJson({
            ...state,
            workItemId: input.lease.workItemId,
            leaseEpoch: input.lease.leaseEpoch,
          }),
          input.authority.tenantId,
          input.authority.runId,
          attempt.stepId,
          attempt.attemptId,
          sourceAuthority.workItemId,
          sourceAuthority.leaseEpoch,
        );
      if (update.changes !== 1)
        throw new RunStoreError("workflow_tool_approval_authority_mismatch");
    }
    const adoptedReceipt = { ...receipt, workItemId: input.lease.workItemId };
    const receiptUpdate = this.database
      .prepare(
        `UPDATE tool_execution_receipts
      SET work_item_id=?,state_json=? WHERE tenant_id=? AND run_id=? AND receipt_id=?
      AND work_item_id=? AND revision=?`,
      )
      .run(
        input.lease.workItemId,
        stableJson(adoptedReceipt),
        receipt.tenantId,
        receipt.runId,
        receipt.receiptId,
        receipt.workItemId,
        receipt.revision,
      );
    if (receiptUpdate.changes !== 1)
      throw new RunStoreError("workflow_tool_approval_receipt_mismatch");
    const checkpointRow = this.database
      .prepare(
        `SELECT revision,checkpoint_json
      FROM workflow_node_continuations WHERE tenant_id=? AND run_id=? AND step_id=? AND attempt_id=?`,
      )
      .get(
        input.authority.tenantId,
        input.authority.runId,
        input.authority.attempt.stepId,
        input.authority.attempt.attemptId,
      ) as { revision: number; checkpoint_json: string } | undefined;
    if (checkpointRow === undefined)
      throw new RunStoreError("workflow_tool_approval_authority_mismatch");
    const checkpoint = JSON.parse(checkpointRow.checkpoint_json) as Record<
      string,
      unknown
    >;
    const adoptedCheckpoint = {
      ...checkpoint,
      authority,
      revision: checkpointRow.revision + 1,
    };
    this.database
      .prepare(
        `UPDATE workflow_node_continuations SET revision=?,checkpoint_json=?
      WHERE tenant_id=? AND run_id=? AND step_id=? AND attempt_id=? AND revision=?`,
      )
      .run(
        checkpointRow.revision + 1,
        stableJson(adoptedCheckpoint),
        input.authority.tenantId,
        input.authority.runId,
        input.authority.attempt.stepId,
        input.authority.attempt.attemptId,
        checkpointRow.revision,
      );
    return { authority, receipt: adoptedReceipt };
  }

  private validateResumeLease(input: ConsumeWorkflowToolApprovalInput, nowMs: number): void {
    const row = this.database.prepare(`SELECT work_item_json FROM work_items
      WHERE work_item_id=? AND tenant_id=? AND run_id=? AND status='leased'
      AND lease_owner_id=? AND lease_id=? AND lease_epoch=? AND lease_expires_at_ms>?`).get(
        input.lease.workItemId, input.authority.tenantId, input.authority.runId,
        input.lease.ownerId, input.lease.leaseId, input.lease.leaseEpoch, nowMs) as
      { work_item_json: string } | undefined;
    const payload = row === undefined ? null : JSON.parse(row.work_item_json).payload;
    const expected = this.resumePayload({ binding: input.binding, authority: input.authority,
      approvalId: input.approvalId, actionDigest: input.actionDigest,
      receiptId: this.approvalReceiptId(input.authority.tenantId, input.approvalId) });
    if (stableJson(payload) !== stableJson(expected))
      throw new RunStoreError("stale_lease");
  }

  private validateCommonAuthority(
    input: PublishWorkflowToolApprovalInput | ConsumeWorkflowToolApprovalInput,
    nowMs: number,
    itemKind: "agent" | "resume",
  ): void {
    const version = this.database
      .prepare(
        `SELECT definition_json FROM workflow_versions
      WHERE tenant_id=? AND workflow_version_id=?`,
      )
      .get(input.authority.tenantId, input.binding.workflowVersionId) as
      | { definition_json: string }
      | undefined;
    if (version === undefined)
      throw new RunStoreError("workflow_composition_version_not_found");
    parseBoundWorkflow(version.definition_json, input.binding, this.digester);
    const execution = this.database
      .prepare(
        `SELECT state_json FROM workflow_executions
      WHERE tenant_id=? AND run_id=?`,
      )
      .get(input.authority.tenantId, input.authority.runId) as
      | { state_json: string }
      | undefined;
    const claim =
      execution === undefined
        ? undefined
        : decodeWorkflowExecutionState(execution.state_json).nodes.find(
            (node) => node.nodeId === input.authority.nodeId,
          );
    if (
      claim?.claimId !== input.authority.claimId ||
      claim.claimEpoch !== input.authority.claimEpoch ||
      claim.status !== "running"
    )
      throw new RunStoreError("workflow_tool_approval_authority_mismatch");
    const attempt = this.database
      .prepare(
        `SELECT state_json FROM run_attempts
      WHERE tenant_id=? AND run_id=? AND step_id=? AND attempt_id=?`,
      )
      .get(
        input.authority.tenantId,
        input.authority.runId,
        input.authority.attempt.stepId,
        input.authority.attempt.attemptId,
      ) as { state_json: string } | undefined;
    if (
      attempt === undefined ||
      JSON.parse(attempt.state_json).status !== "running"
    )
      throw new RunStoreError("workflow_tool_approval_authority_mismatch");
    const row = this.database
      .prepare(
        `SELECT work_item_json FROM work_items
      WHERE work_item_id=? AND tenant_id=? AND run_id=? AND status='leased'
      AND lease_owner_id=? AND lease_id=? AND lease_epoch=? AND lease_expires_at_ms>?`,
      )
      .get(
        input.lease.workItemId,
        input.authority.tenantId,
        input.authority.runId,
        input.lease.ownerId,
        input.lease.leaseId,
        input.lease.leaseEpoch,
        nowMs,
      ) as { work_item_json: string } | undefined;
    const payload =
      row === undefined ? null : JSON.parse(row.work_item_json).payload;
    if (
      row === undefined ||
      (itemKind === "agent"
        ? input.lease.workItemId !== input.authority.workItemId ||
          input.lease.leaseEpoch !== input.authority.leaseEpoch
        : stableJson(payload) !==
          stableJson(
            this.resumePayload({
              binding: input.binding,
              authority: input.authority,
              approvalId: (input as ConsumeWorkflowToolApprovalInput)
                .approvalId,
              actionDigest: (input as ConsumeWorkflowToolApprovalInput)
                .actionDigest,
              receiptId: this.approvalReceiptId(
                input.authority.tenantId,
                (input as ConsumeWorkflowToolApprovalInput).approvalId,
              ),
            }),
          ))
    )
      throw new RunStoreError("stale_lease");
  }

  private resumePayload(
    input: Pick<
      ConsumeWorkflowToolApprovalInput,
      "binding" | "authority" | "approvalId" | "actionDigest"
    > &
      Readonly<{ receiptId: string }>,
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
      receiptId: input.receiptId,
      actionDigest: input.actionDigest,
    };
  }

  private insertResumeWorkItem(
    input: PublishWorkflowToolApprovalInput,
    nowMs: number,
  ): void {
    const payload = this.resumePayload({
      ...input,
      approvalId: input.approval.approvalId,
      actionDigest: input.approval.actionDigest,
      receiptId: input.approval.receiptId,
    });
    const item = {
      workItemId: input.approval.workItemId,
      tenantId: input.authority.tenantId,
      runId: input.authority.runId,
      kind: "run.execute",
      payload,
      createdAt: input.requiredEvent.occurredAt,
    };
    this.database
      .prepare(
        `INSERT INTO work_items
      (work_item_id,tenant_id,run_id,kind,work_item_json,created_at,status,available_at_ms,lease_epoch,attempt_count)
      VALUES (?,?,?,?,?,?,'pending',?,0,0)`,
      )
      .run(
        input.approval.workItemId,
        input.authority.tenantId,
        input.authority.runId,
        "run.execute",
        stableJson(item),
        input.requiredEvent.occurredAt,
        nowMs + input.approvalRecheckMs,
      );
  }

  private writeRunPublication(
    input: PublishWorkflowToolApprovalInput,
    current: RunState,
    next: RunState,
  ): void {
    const update = this.database
      .prepare(
        `UPDATE run_snapshots SET revision=?,last_sequence=?,state_json=?,updated_at=?
      WHERE tenant_id=? AND run_id=? AND revision=?`,
      )
      .run(
        next.revision,
        next.lastSequence,
        stableJson(next),
        input.requiredEvent.occurredAt,
        current.tenantId,
        current.runId,
        current.revision,
      );
    if (update.changes !== 1) throw new RunStoreError("revision_conflict");
    this.database
      .prepare(
        `INSERT INTO run_events(tenant_id,run_id,sequence,event_id,event_json)
      VALUES (?,?,?,?,?)`,
      )
      .run(
        current.tenantId,
        current.runId,
        input.requiredEvent.sequence,
        input.requiredEvent.eventId,
        stableJson(input.requiredEvent),
      );
    this.database
      .prepare(
        `INSERT INTO outbox(message_id,tenant_id,run_id,topic,message_json,created_at,
      status,available_at_ms,lease_epoch,attempt_count) VALUES (?,?,?,?,?,?,'pending',0,0,0)`,
      )
      .run(
        input.publicationOutbox.messageId,
        current.tenantId,
        current.runId,
        input.publicationOutbox.topic,
        stableJson(input.publicationOutbox),
        input.publicationOutbox.createdAt,
      );
  }

  private completeLease(
    lease: PublishWorkflowToolApprovalInput["lease"],
    nowMs: number,
  ): void {
    const update = this.database
      .prepare(
        `UPDATE work_items SET status='completed',completed_at_ms=?,
      lease_owner_id=NULL,lease_id=NULL,lease_expires_at_ms=NULL WHERE work_item_id=? AND status='leased'
      AND lease_owner_id=? AND lease_id=? AND lease_epoch=? AND lease_expires_at_ms>?`,
      )
      .run(
        nowMs,
        lease.workItemId,
        lease.ownerId,
        lease.leaseId,
        lease.leaseEpoch,
        nowMs,
      );
    if (update.changes !== 1) throw new RunStoreError("stale_lease");
  }

  private loadCheckpoint(input: PublishWorkflowToolApprovalInput): {
    revision: number;
    history: readonly import("@crewon/application").WorkflowContinuationHistoryItem[];
  } {
    const row = this.database
      .prepare(
        `SELECT revision,checkpoint_json FROM workflow_node_continuations
      WHERE tenant_id=? AND run_id=? AND step_id=? AND attempt_id=?`,
      )
      .get(
        input.authority.tenantId,
        input.authority.runId,
        input.authority.attempt.stepId,
        input.authority.attempt.attemptId,
      ) as { revision: number; checkpoint_json: string } | undefined;
    if (
      row === undefined ||
      stableJson(JSON.parse(row.checkpoint_json).authority) !==
        stableJson(input.authority)
    )
      throw new RunStoreError("workflow_tool_approval_authority_mismatch");
    const checkpoint = JSON.parse(row.checkpoint_json) as {
      history: readonly import("@crewon/application").WorkflowContinuationHistoryItem[];
    };
    return { revision: row.revision, history: checkpoint.history };
  }

  private loadRun(tenantId: string, runId: string): RunState {
    const row = this.database
      .prepare(
        "SELECT state_json FROM run_snapshots WHERE tenant_id=? AND run_id=?",
      )
      .get(tenantId, runId) as { state_json: string } | undefined;
    if (row === undefined) throw new RunStoreError("run_not_found");
    return normalizeStoredRunState(
      JSON.parse(row.state_json) as RunState,
      "stored_run_invalid",
    );
  }

  private approvalReceiptId(tenantId: string, approvalId: string): string {
    const approval = loadSqliteToolApproval(this.database, {
      tenantId,
      approvalId,
    });
    if (approval === null)
      throw new RunStoreError("workflow_tool_approval_not_found");
    return approval.receiptId;
  }

  private loadHandoff(input: {
    authority: { tenantId: string; runId: string };
    operationId: string;
    approvalId?: string;
  }): HandoffRow | null {
    const row =
      input.approvalId === undefined
        ? this.database
            .prepare(
              `SELECT publication_fingerprint,publication_result_json,
          consumption_operation_id,consumption_fingerprint,consumption_result_json
          FROM workflow_tool_approval_handoffs WHERE tenant_id=? AND run_id=? AND publication_operation_id=?`,
            )
            .get(
              input.authority.tenantId,
              input.authority.runId,
              input.operationId,
            )
        : this.database
            .prepare(
              `SELECT publication_fingerprint,publication_result_json,
          consumption_operation_id,consumption_fingerprint,consumption_result_json
          FROM workflow_tool_approval_handoffs WHERE tenant_id=? AND run_id=? AND approval_id=?`,
            )
            .get(
              input.authority.tenantId,
              input.authority.runId,
              input.approvalId,
            );
    return (row as HandoffRow | undefined) ?? null;
  }

  private validatePublicationReplay(
    input: PublishWorkflowToolApprovalInput,
    result: WorkflowToolApprovalPublicationResult,
  ): void {
    const approval = loadSqliteToolApproval(this.database, input.approval);
    if (
      approval === null ||
      stableJson(approval) !== stableJson(result.approval) ||
      result.resumeWorkItemId !== approval.workItemId
    )
      throw new RunStoreError("workflow_tool_approval_receipt_corrupt");
  }

  private fingerprint(kind: string, input: unknown): string {
    let value = input;
    if (kind === "consume") {
      const { lease: _lease, ...semantic } =
        input as ConsumeWorkflowToolApprovalInput;
      value = semantic;
    }
    return this.digester.sha256(canonicalJson({ kind, input: value }));
  }
}
