import { DatabaseSync } from "node:sqlite";
import {
  RunStoreError,
  type WorkflowRunCompositionStore,
} from "@crewon/application";
import type { RunState, WorkflowContentDigester } from "@crewon/domain";

import {
  readLeaseClock,
  SystemLeaseClock,
  type LeaseClock,
} from "./lease-clock.ts";
import {
  beginSqliteRunAttempt,
  loadSqliteRunAttempt,
  loadSqliteRunStep,
} from "./sqlite-execution-authority.ts";
import { configureAndMigrateSqlite, rollback } from "./sqlite-schema.ts";
import { stableJson } from "./store-invariants.ts";
import { normalizeStoredRunState } from "./stored-run-state.ts";
import {
  decodeWorkflowExecutionState,
  validateWorkflowExecutionState,
} from "./workflow-execution-store.ts";
import { migrateSqliteWorkflowExecutions } from "./workflow-execution-schema.ts";
import { migrateSqliteWorkflowVersions } from "./workflow-version-schema.ts";
import {
  assertExecutionBinding,
  assertAdmissionReplayAuthority,
  attemptId,
  claimReadyNodes,
  compositionFingerprint,
  gateStep,
  initialExecution,
  parseBoundWorkflow,
  type WorkflowCompositionResult,
} from "./workflow-run-composition-support.ts";

type Dependencies = Readonly<{
  digester: WorkflowContentDigester;
  clock?: LeaseClock;
}>;

/** SQLite production composition authority. Every admission is one IMMEDIATE transaction. */
export class SqliteWorkflowRunCompositionStore
  implements WorkflowRunCompositionStore
{
  readonly #database: DatabaseSync;
  readonly #digester: WorkflowContentDigester;
  readonly #clock: LeaseClock;
  readonly #ownsDatabase: boolean;

  constructor(database: DatabaseSync, dependencies: Dependencies);
  constructor(path: string, dependencies: Dependencies);
  constructor(
    databaseOrPath: DatabaseSync | string,
    dependencies: Dependencies,
  ) {
    this.#database =
      typeof databaseOrPath === "string"
        ? new DatabaseSync(databaseOrPath, {
            enableForeignKeyConstraints: true,
          })
        : databaseOrPath;
    this.#ownsDatabase = typeof databaseOrPath === "string";
    this.#digester = dependencies.digester;
    this.#clock = dependencies.clock ?? new SystemLeaseClock();
    configureAndMigrateSqlite(this.#database);
    migrateSqliteWorkflowVersions(this.#database);
    migrateSqliteWorkflowExecutions(this.#database);
  }

  async close(): Promise<void> {
    if (this.#ownsDatabase) this.#database.close();
  }

  async admitWorkflowNodes(
    input: Parameters<WorkflowRunCompositionStore["admitWorkflowNodes"]>[0],
  ): Promise<WorkflowCompositionResult> {
    const nowMs = readLeaseClock(this.#clock);
    const now = new Date(nowMs).toISOString();
    const fingerprint = compositionFingerprint({
      ...input,
      digester: this.#digester,
    });
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      this.#validateLease(input, nowMs);
      const run = this.#loadRun(input.tenantId, input.runId);
      assertCanonicalRun(run, input.binding);
      const workflowRow = this.#database
        .prepare(
          `SELECT definition_json FROM workflow_versions
           WHERE tenant_id=? AND workflow_version_id=?`,
        )
        .get(input.tenantId, input.binding.workflowVersionId) as
        | { definition_json: string }
        | undefined;
      if (workflowRow === undefined)
        throw new RunStoreError("workflow_composition_version_not_found");
      const workflow = parseBoundWorkflow(
        workflowRow.definition_json,
        input.binding,
        this.#digester,
      );
      const receipt = this.#database
        .prepare(
          `SELECT fingerprint,result_json FROM workflow_execution_receipts
           WHERE tenant_id=? AND run_id=? AND operation_id=?`,
        )
        .get(input.tenantId, input.runId, input.schedulerOperationId) as
        | { fingerprint: string; result_json: string | null }
        | undefined;
      if (receipt !== undefined) {
        if (receipt.fingerprint !== fingerprint || receipt.result_json === null)
          throw new RunStoreError("workflow_composition_idempotency_conflict");
        const result = JSON.parse(
          receipt.result_json,
        ) as WorkflowCompositionResult;
        validateCompositionReplay(result, input, workflow);
        for (const admission of result.admissions) {
          const locator = {
            tenantId: input.tenantId,
            runId: input.runId,
            stepId: admission.claim.node.nodeId,
          };
          const step = loadSqliteRunStep(this.#database, locator);
          const attempt =
            admission.attempt === null
              ? null
              : loadSqliteRunAttempt(this.#database, {
                  ...locator,
                  attemptId: admission.attempt.attemptId,
                });
          assertAdmissionReplayAuthority(admission, step, attempt);
        }
        this.#validateLease(input, nowMs);
        this.#database.exec("COMMIT");
        return structuredClone({ ...result, disposition: "replay" as const });
      }

      let execution = this.#loadExecution(input.tenantId, input.runId);
      if (execution === null) {
        execution = initialExecution({
          tenantId: input.tenantId,
          runId: input.runId,
          workflow,
          updatedAt: now,
        });
        this.#database
          .prepare(
            `INSERT INTO workflow_executions
             (tenant_id,run_id,revision,state_json,updated_at) VALUES (?,?,?,?,?)`,
          )
          .run(input.tenantId, input.runId, 1, stableJson(execution), now);
      }
      assertExecutionBinding(
        execution,
        input.tenantId,
        input.runId,
        input.binding,
        workflow,
      );
      const claimed = claimReadyNodes({
        execution,
        workflow,
        operationId: input.schedulerOperationId,
        leaseDurationMs: input.leaseDurationMs,
        now,
        digester: this.#digester,
      });
      const admissions = [];
      for (const claim of claimed.claims) {
        if (claim.node.kind === "humanGate") {
          const step = gateStep({
            tenantId: input.tenantId,
            runId: input.runId,
            nodeId: claim.node.nodeId,
            now,
          });
          const existing = loadSqliteRunStep(this.#database, {
            tenantId: input.tenantId,
            runId: input.runId,
            stepId: claim.node.nodeId,
          });
          if (existing !== null)
            throw new RunStoreError("workflow_composition_step_conflict");
          this.#database
            .prepare(
              `INSERT INTO run_steps
               (tenant_id,run_id,step_id,kind,status,revision,current_attempt_id,
                attempt_count,state_json,created_at,updated_at,terminal_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              step.tenantId,
              step.runId,
              step.stepId,
              step.kind,
              step.status,
              step.revision,
              null,
              0,
              stableJson(step),
              now,
              now,
              null,
            );
          admissions.push({ claim, step, attempt: null });
        } else {
          const started = beginSqliteRunAttempt(this.#database, {
            tenantId: input.tenantId,
            runId: input.runId,
            lease: input.lease,
            stepId: claim.node.nodeId,
            kind: claim.node.kind === "verification" ? "verification" : "agent",
            attemptId: attemptId(
              input.schedulerOperationId,
              claim.node.nodeId,
              this.#digester,
            ),
            startedAt: now,
          });
          admissions.push({
            claim,
            step: started.step,
            attempt: started.attempt,
          });
        }
      }
      execution = claimed.execution;
      validateWorkflowExecutionState(execution);
      this.#database
        .prepare(
          `UPDATE workflow_executions SET revision=?,state_json=?,updated_at=?
           WHERE tenant_id=? AND run_id=?`,
        )
        .run(
          execution.revision,
          stableJson(execution),
          now,
          input.tenantId,
          input.runId,
        );
      const result = {
        disposition: claimed.execution.nodes.some(
          (node) => node.status === "unknown",
        )
          ? ("reconcileRequired" as const)
          : ("fresh" as const),
        execution,
        admissions,
      } satisfies WorkflowCompositionResult;
      this.#database
        .prepare(
          `INSERT INTO workflow_execution_receipts
           (tenant_id,run_id,operation_id,fingerprint,state_json,result_json)
           VALUES (?,?,?,?,?,?)`,
        )
        .run(
          input.tenantId,
          input.runId,
          input.schedulerOperationId,
          fingerprint,
          stableJson(execution),
          stableJson(result),
        );
      this.#validateLease(input, readLeaseClock(this.#clock));
      this.#database.exec("COMMIT");
      return structuredClone(result);
    } catch (error) {
      rollback(this.#database);
      throw error instanceof RunStoreError
        ? error
        : new RunStoreError("workflow_composition_store_failed", {
            cause: error instanceof Error ? error : undefined,
          });
    }
  }

  #validateLease(
    input: Parameters<WorkflowRunCompositionStore["admitWorkflowNodes"]>[0],
    nowMs: number,
  ): void {
    const row = this.#database
      .prepare(
        `SELECT tenant_id,run_id,status,lease_owner_id,lease_id,lease_epoch,lease_expires_at_ms
         FROM work_items WHERE work_item_id=?`,
      )
      .get(input.lease.workItemId) as Record<string, unknown> | undefined;
    if (row === undefined) throw new RunStoreError("queue_item_not_found");
    if (row.tenant_id !== input.tenantId || row.run_id !== input.runId)
      throw new RunStoreError("work_item_scope_mismatch");
    if (
      row.status !== "leased" ||
      row.lease_owner_id !== input.lease.ownerId ||
      row.lease_id !== input.lease.leaseId ||
      row.lease_epoch !== input.lease.leaseEpoch
    )
      throw new RunStoreError("stale_lease");
    if (
      typeof row.lease_expires_at_ms !== "number" ||
      row.lease_expires_at_ms <= nowMs
    )
      throw new RunStoreError("lease_expired");
  }

  #loadRun(tenantId: string, runId: string): RunState | null {
    const row = this.#database
      .prepare(
        "SELECT state_json FROM run_snapshots WHERE tenant_id=? AND run_id=?",
      )
      .get(tenantId, runId) as { state_json: string } | undefined;
    return row === undefined
      ? null
      : normalizeStoredRunState(
          JSON.parse(row.state_json) as RunState,
          "stored_run_invalid",
        );
  }

  #loadExecution(tenantId: string, runId: string) {
    const row = this.#database
      .prepare(
        "SELECT state_json FROM workflow_executions WHERE tenant_id=? AND run_id=?",
      )
      .get(tenantId, runId) as { state_json: string } | undefined;
    return row === undefined
      ? null
      : decodeWorkflowExecutionState(row.state_json);
  }
}

function assertCanonicalRun(
  run: RunState | null,
  binding: Parameters<
    WorkflowRunCompositionStore["admitWorkflowNodes"]
  >[0]["binding"],
): void {
  if (run === null)
    throw new RunStoreError("workflow_composition_run_not_found");
  if (
    run.purpose !== "workflow" ||
    run.status !== "running" ||
    run.workflowVersionBinding?.workflowId !== binding.workflowId ||
    run.workflowVersionBinding.workflowVersionId !==
      binding.workflowVersionId ||
    run.workflowVersionBinding.contentDigest !== binding.contentDigest
  )
    throw new RunStoreError("workflow_composition_run_authority_mismatch");
}

function validateCompositionReplay(
  result: WorkflowCompositionResult,
  input: Parameters<WorkflowRunCompositionStore["admitWorkflowNodes"]>[0],
  workflow: import("@crewon/domain").CompiledWorkflowVersion,
): void {
  validateWorkflowExecutionState(result.execution);
  assertExecutionBinding(
    result.execution,
    input.tenantId,
    input.runId,
    input.binding,
    workflow,
  );
  if (!Array.isArray(result.admissions))
    throw new RunStoreError("workflow_composition_receipt_corrupt");
}
