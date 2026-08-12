import { DatabaseSync } from "node:sqlite";
import {
  RunStoreError,
  validateWorkflowNodeContinuationCheckpoint,
  type CommitWorkflowAssistantContinuationInput,
  type WorkflowAgentAttemptAuthority,
  type WorkflowNodeContinuationCheckpoint,
} from "@crewon/application";

import { readLeaseClock, type LeaseClock } from "./lease-clock.ts";
import {
  loadSqliteRunAttempt,
  loadSqliteRunStep,
} from "./sqlite-execution-authority.ts";
import { rollback } from "./sqlite-schema.ts";
import { stableJson } from "./store-invariants.ts";
import { loadSqliteModelDispatchReceipt } from "./sqlite-model-dispatch-evidence.ts";
import {
  decodeWorkflowExecutionState,
  validateWorkflowExecutionState,
} from "./workflow-execution-store.ts";

export class SqliteWorkflowNodeContinuationAuthority {
  readonly #database: DatabaseSync;
  readonly #clock: LeaseClock;

  constructor(database: DatabaseSync, clock: LeaseClock) {
    this.#database = database;
    this.#clock = clock;
  }

  async load(
    authority: WorkflowAgentAttemptAuthority,
  ): Promise<WorkflowNodeContinuationCheckpoint | null> {
    const row = this.#database
      .prepare(
        `SELECT checkpoint_json FROM workflow_node_continuations
         WHERE tenant_id=? AND run_id=? AND step_id=? AND attempt_id=?`,
      )
      .get(
        authority.tenantId,
        authority.runId,
        authority.attempt.stepId,
        authority.attempt.attemptId,
      ) as { checkpoint_json: string } | undefined;
    if (row === undefined) return null;
    try {
      this.#validateAuthority(authority);
      const checkpoint = validateWorkflowNodeContinuationCheckpoint(
        JSON.parse(row.checkpoint_json),
      );
      if (stableJson(checkpoint.authority) !== stableJson(authority))
        throw new Error("authority mismatch");
      this.#validateCheckpointCorrelation(authority, checkpoint);
      return checkpoint;
    } catch (error) {
      throw new RunStoreError("workflow_node_continuation_corrupt", {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  async commitAssistant(
    input: CommitWorkflowAssistantContinuationInput,
  ): Promise<WorkflowNodeContinuationCheckpoint> {
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      this.#validateLease(input, readLeaseClock(this.#clock));
      this.#validateAuthority(input.authority);
      const current = await this.load(input.authority);
      if ((current?.revision ?? null) !== input.expectedContinuationRevision)
        throw new RunStoreError("workflow_node_continuation_revision_conflict");
      const checkpoint = validateWorkflowNodeContinuationCheckpoint({
        ...input.next,
        revision: (current?.revision ?? 0) + 1,
        updatedAt: input.committedAt,
      });
      if (stableJson(checkpoint.authority) !== stableJson(input.authority))
        throw new RunStoreError("workflow_node_continuation_authority_mismatch");
      this.#validateCheckpointCorrelation(input.authority, checkpoint);
      const write = this.#database
        .prepare(
          `INSERT INTO workflow_node_continuations
           (tenant_id,run_id,step_id,attempt_id,revision,checkpoint_json,updated_at)
           VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(tenant_id,run_id,step_id,attempt_id) DO UPDATE SET
             revision=excluded.revision,checkpoint_json=excluded.checkpoint_json,
             updated_at=excluded.updated_at WHERE revision=?`,
        )
        .run(
          input.authority.tenantId,
          input.authority.runId,
          input.authority.attempt.stepId,
          input.authority.attempt.attemptId,
          checkpoint.revision,
          stableJson(checkpoint),
          checkpoint.updatedAt,
          current?.revision ?? 0,
        );
      if (write.changes !== 1)
        throw new RunStoreError("workflow_node_continuation_revision_conflict");
      this.#database.exec("COMMIT");
      return checkpoint;
    } catch (error) {
      rollback(this.#database);
      throw error instanceof RunStoreError
        ? error
        : new RunStoreError("workflow_node_continuation_store_failed", {
            cause: error instanceof Error ? error : undefined,
          });
    }
  }

  #validateLease(
    input: Pick<CommitWorkflowAssistantContinuationInput, "lease"> &
      Readonly<{ authority: WorkflowAgentAttemptAuthority }>,
    nowMs: number,
  ): void {
    if (
      input.lease.workItemId !== input.authority.workItemId ||
      input.lease.leaseEpoch !== input.authority.leaseEpoch
    )
      throw new RunStoreError("workflow_node_continuation_authority_mismatch");
    const row = this.#database
      .prepare(
        `SELECT tenant_id,run_id,status,lease_owner_id,lease_id,lease_epoch,
                lease_expires_at_ms
         FROM work_items WHERE work_item_id=?`,
      )
      .get(input.lease.workItemId) as Record<string, unknown> | undefined;
    if (
      row === undefined ||
      row.tenant_id !== input.authority.tenantId ||
      row.run_id !== input.authority.runId ||
      row.status !== "leased" ||
      row.lease_owner_id !== input.lease.ownerId ||
      row.lease_id !== input.lease.leaseId ||
      row.lease_epoch !== input.lease.leaseEpoch ||
      typeof row.lease_expires_at_ms !== "number" ||
      row.lease_expires_at_ms <= nowMs
    )
      throw new RunStoreError("stale_lease");
  }

  #validateAuthority(authority: WorkflowAgentAttemptAuthority): void {
    const row = this.#database
      .prepare(
        `SELECT state_json FROM workflow_executions
         WHERE tenant_id=? AND run_id=?`,
      )
      .get(authority.tenantId, authority.runId) as
      | { state_json: string }
      | undefined;
    if (row === undefined)
      throw new RunStoreError("workflow_node_continuation_authority_mismatch");
    let execution;
    try {
      execution = decodeWorkflowExecutionState(JSON.parse(row.state_json));
      validateWorkflowExecutionState(execution);
    } catch (error) {
      throw new RunStoreError("workflow_execution_corrupt", {
        cause: error instanceof Error ? error : undefined,
      });
    }
    const node = execution.nodes.find(
      (candidate) => candidate.nodeId === authority.nodeId,
    );
    const step = loadSqliteRunStep(this.#database, {
      tenantId: authority.tenantId,
      runId: authority.runId,
      stepId: authority.attempt.stepId,
    });
    const attempt = loadSqliteRunAttempt(this.#database, {
      tenantId: authority.tenantId,
      runId: authority.runId,
      ...authority.attempt,
    });
    if (
      node?.status !== "running" ||
      node.kind !== authority.nodeKind ||
      node.claimId !== authority.claimId ||
      node.claimEpoch !== authority.claimEpoch ||
      node.agentVersionId !== authority.agentVersionId ||
      step?.currentAttemptId !== authority.attempt.attemptId ||
      step.kind !== authority.nodeKind ||
      step.status !== "running" ||
      attempt?.status !== "running" ||
      attempt.workItemId !== authority.workItemId ||
      attempt.leaseEpoch !== authority.leaseEpoch
    )
      throw new RunStoreError("workflow_node_continuation_authority_mismatch");
  }

  #validateCheckpointCorrelation(
    authority: WorkflowAgentAttemptAuthority,
    checkpoint: WorkflowNodeContinuationCheckpoint,
  ): void {
    const attempt = loadSqliteRunAttempt(this.#database, {
      tenantId: authority.tenantId,
      runId: authority.runId,
      ...authority.attempt,
    });
    if (attempt?.providerTurnState !== checkpoint.providerTurnState)
      throw new RunStoreError("workflow_node_continuation_authority_mismatch");
    if (checkpoint.activeDispatch === null) return;
    const dispatch = loadSqliteModelDispatchReceipt(this.#database, {
      tenantId: authority.tenantId,
      runId: authority.runId,
      ...authority.attempt,
      operationId: checkpoint.activeDispatch.operationId,
    });
    if (
      dispatch === null ||
      dispatch.requestSequence !== checkpoint.activeDispatch.requestSequence ||
      dispatch.revision !== checkpoint.activeDispatch.expectedRevision ||
      dispatch.status !== checkpoint.activeDispatch.status
    )
      throw new RunStoreError("workflow_node_continuation_authority_mismatch");
  }
}
