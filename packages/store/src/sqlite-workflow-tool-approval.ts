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
import type { WorkflowContentDigester } from "@crewon/domain";

import { readLeaseClock, type LeaseClock } from "./lease-clock.ts";
import { rollback } from "./sqlite-schema.ts";
import { loadSqliteToolApproval } from "./sqlite-tool-approvals.ts";
import { loadSqliteToolExecutionReceipt } from "./sqlite-tool-execution-receipts.ts";
import { stableJson } from "./store-invariants.ts";
import { publishSqliteWorkflowToolApproval } from "./sqlite-workflow-tool-approval-publication.ts";
import { SqliteWorkflowToolApprovalSupport } from "./sqlite-workflow-tool-approval-support.ts";

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
  private readonly support: SqliteWorkflowToolApprovalSupport;

  constructor(
    database: DatabaseSync,
    clock: LeaseClock,
    digester: WorkflowContentDigester,
  ) {
    this.database = database;
    this.clock = clock;
    this.digester = digester;
    this.support = new SqliteWorkflowToolApprovalSupport(database, digester);
  }

  async publish(
    input: PublishWorkflowToolApprovalInput,
  ): Promise<WorkflowToolApprovalPublicationResult> {
    return publishSqliteWorkflowToolApproval(
      {
        database: this.database,
        clock: this.clock,
        digester: this.digester,
        support: {
          fingerprint: (value) => this.fingerprint("publish", value),
          loadReplay: (value) => this.loadHandoff(value),
          validateReplay: (value, result) =>
            this.validatePublicationReplay(value, result),
          validateAuthority: (value, nowMs) =>
            this.support.validateAuthority(value, nowMs, "agent"),
          loadCheckpoint: (value) => this.support.loadCheckpoint(value),
          loadRun: (tenantId, runId) => this.support.loadRun(tenantId, runId),
          insertResume: (value, nowMs) =>
            this.support.insertResume(value, nowMs),
          writeRun: (value, current, next) =>
            this.support.writeRun(value, current, next),
          completeLease: (value, nowMs) =>
            this.support.completeLease(value, nowMs),
        },
      },
      input,
    );
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
        if (
          replay.outcome !== null &&
          "authority" in replay.outcome &&
          (replay.outcome.authority.leaseEpoch !== input.lease.leaseEpoch ||
            replay.outcome.authority.workItemId !== input.lease.workItemId)
        ) {
          this.validateResumeLease(input, readLeaseClock(this.clock));
          const currentReceipt = loadSqliteToolExecutionReceipt(
            this.database,
            replay.outcome.receipt,
          );
          if (currentReceipt === null)
            throw new RunStoreError("workflow_tool_approval_receipt_corrupt");
          const adopted = this.adoptResumeAuthority(
            input,
            currentReceipt,
            replay.outcome.authority,
          );
          const refreshed = {
            ...replay,
            outcome: { ...replay.outcome, ...adopted },
          };
          this.database
            .prepare(
              `UPDATE workflow_tool_approval_handoffs
            SET consumption_result_json=? WHERE tenant_id=? AND run_id=? AND approval_id=?
            AND consumption_operation_id=?`,
            )
            .run(
              stableJson(refreshed),
              input.authority.tenantId,
              input.authority.runId,
              input.approvalId,
              input.operationId,
            );
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
      this.support.validateAuthority(input, nowMs, "resume");
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
      return {
        kind: "failed",
        failureCode: "tool_approval_rejected",
        approval,
        ...adopted,
      };
    if (approval.status === "expired")
      return {
        kind: "failed",
        failureCode: "tool_approval_expired",
        approval,
        ...adopted,
      };
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

  private validateResumeLease(
    input: ConsumeWorkflowToolApprovalInput,
    nowMs: number,
  ): void {
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
    const expected = this.support.resumePayload({
      binding: input.binding,
      authority: input.authority,
      approvalId: input.approvalId,
      actionDigest: input.actionDigest,
      receiptId: this.support.approvalReceiptId(
        input.authority.tenantId,
        input.approvalId,
      ),
    });
    if (stableJson(payload) !== stableJson(expected))
      throw new RunStoreError("stale_lease");
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
