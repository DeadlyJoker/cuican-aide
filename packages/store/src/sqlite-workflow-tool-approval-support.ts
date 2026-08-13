import type { DatabaseSync } from "node:sqlite";
import {
  RunStoreError,
  type ConsumeWorkflowToolApprovalInput,
  type PublishWorkflowToolApprovalInput,
} from "@crewon/application";
import type { RunState, WorkflowContentDigester } from "@crewon/domain";
import { loadSqliteToolApproval } from "./sqlite-tool-approvals.ts";
import { stableJson } from "./store-invariants.ts";
import { normalizeStoredRunState } from "./stored-run-state.ts";
import { decodeWorkflowExecutionState } from "./workflow-execution-state.ts";
import { parseBoundWorkflow } from "./workflow-run-composition-support.ts";

/** Shared exact-authority and queue helpers for Workflow Tool approval transactions. */
export class SqliteWorkflowToolApprovalSupport {
  private readonly database: DatabaseSync;
  private readonly digester: WorkflowContentDigester;

  constructor(database: DatabaseSync, digester: WorkflowContentDigester) {
    this.database = database;
    this.digester = digester;
  }

  validateAuthority(
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
    const resume = input as ConsumeWorkflowToolApprovalInput;
    if (
      row === undefined ||
      (itemKind === "agent"
        ? input.lease.workItemId !== input.authority.workItemId ||
          input.lease.leaseEpoch !== input.authority.leaseEpoch
        : stableJson(payload) !==
          stableJson(
            this.resumePayload({
              ...resume,
              receiptId: this.approvalReceiptId(
                resume.authority.tenantId,
                resume.approvalId,
              ),
            }),
          ))
    )
      throw new RunStoreError("stale_lease");
  }

  resumePayload(
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

  insertResume(input: PublishWorkflowToolApprovalInput, nowMs: number): void {
    const payload = this.resumePayload({
      binding: input.binding,
      authority: input.authority,
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
      (work_item_id,tenant_id,run_id,kind,work_item_json,created_at,status,
       available_at_ms,lease_epoch,attempt_count)
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

  writeRun(
    input: PublishWorkflowToolApprovalInput,
    current: RunState,
    next: RunState,
  ): void {
    const update = this.database
      .prepare(
        `UPDATE run_snapshots
      SET revision=?,last_sequence=?,state_json=?,updated_at=?
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
        `INSERT INTO run_events
      (tenant_id,run_id,sequence,event_id,event_json) VALUES (?,?,?,?,?)`,
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
        `INSERT INTO outbox
      (message_id,tenant_id,run_id,topic,message_json,created_at,status,
       available_at_ms,lease_epoch,attempt_count)
      VALUES (?,?,?,?,?,?,'pending',0,0,0)`,
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

  completeLease(input: PublishWorkflowToolApprovalInput, nowMs: number): void {
    const lease = input.lease;
    const update = this.database
      .prepare(
        `UPDATE work_items SET status='completed',
      completed_at_ms=?,lease_owner_id=NULL,lease_id=NULL,lease_expires_at_ms=NULL
      WHERE work_item_id=? AND status='leased' AND lease_owner_id=? AND lease_id=?
      AND lease_epoch=? AND lease_expires_at_ms>?`,
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

  loadCheckpoint(input: PublishWorkflowToolApprovalInput) {
    const row = this.database
      .prepare(
        `SELECT revision,checkpoint_json
      FROM workflow_node_continuations WHERE tenant_id=? AND run_id=?
      AND step_id=? AND attempt_id=?`,
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

  loadRun(tenantId: string, runId: string): RunState {
    const row = this.database
      .prepare(
        `SELECT state_json FROM run_snapshots
      WHERE tenant_id=? AND run_id=?`,
      )
      .get(tenantId, runId) as { state_json: string } | undefined;
    if (row === undefined) throw new RunStoreError("run_not_found");
    return normalizeStoredRunState(
      JSON.parse(row.state_json) as RunState,
      "stored_run_invalid",
    );
  }

  approvalReceiptId(tenantId: string, approvalId: string): string {
    const approval = loadSqliteToolApproval(this.database, {
      tenantId,
      approvalId,
    });
    if (approval === null)
      throw new RunStoreError("workflow_tool_approval_not_found");
    return approval.receiptId;
  }
}
