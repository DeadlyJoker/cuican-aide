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
  reconciliationClaims,
  scheduleReadyNodes,
  workflowAuthorityId,
  type WorkflowCompositionResult,
} from "./workflow-run-composition-support.ts";

type Dependencies = Readonly<{
  digester: WorkflowContentDigester;
  clock?: LeaseClock;
}>;
type LegacyAdmissionInput = Readonly<{
  tenantId: string;
  runId: string;
  lease: import("@crewon/application").WorkItemLeaseInput;
  binding: import("@crewon/domain").FrozenWorkflowVersionBinding;
  schedulerOperationId: string;
  leaseDurationMs: number;
}>;

/** SQLite production composition authority. Every admission is one IMMEDIATE transaction. */
export class SqliteWorkflowRunCompositionStore {
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
    input: LegacyAdmissionInput,
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
          `SELECT fingerprint,result_json FROM workflow_composition_receipts
           WHERE tenant_id=? AND run_id=? AND operation_id=? AND kind='admit'`,
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
        return {
          disposition: "replay" as const,
          execution: structuredClone(result.execution),
          admissions: [],
          reconciliationClaims: [],
        };
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
      const recovery = reconciliationClaims(execution, workflow);
      const result: WorkflowCompositionResult =
        recovery.length === 0
          ? {
              disposition: "fresh",
              execution,
              admissions,
              reconciliationClaims: [],
            }
          : {
              disposition: "reconcileRequired",
              execution,
              admissions: [],
              reconciliationClaims: recovery,
            };
      this.#database
        .prepare(
          `INSERT INTO workflow_composition_receipts
           (tenant_id,run_id,operation_id,kind,fingerprint,result_json)
           VALUES (?,?,?,'admit',?,?)`,
        )
        .run(
          input.tenantId,
          input.runId,
          input.schedulerOperationId,
          fingerprint,
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

  async settleWorkflowNode(): Promise<never> {
    throw new RunStoreError("workflow_composition_contract_incomplete");
  }

  async publishWorkflowHumanGate(): Promise<never> {
    throw new RunStoreError("workflow_composition_contract_incomplete");
  }

  async settleWorkflowHumanGate(): Promise<never> {
    throw new RunStoreError("workflow_composition_contract_incomplete");
  }

  async scheduleWorkflowReconciliation(): Promise<never> {
    throw new RunStoreError("workflow_composition_contract_incomplete");
  }

  async scheduleWorkflowNodes(
    input: Parameters<WorkflowRunCompositionStore["scheduleWorkflowNodes"]>[0],
  ): ReturnType<WorkflowRunCompositionStore["scheduleWorkflowNodes"]> {
    const nowMs = readLeaseClock(this.#clock);
    const now = new Date(nowMs).toISOString();
    const fingerprint = this.#fingerprint("scheduleNodes", input);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const replay = this.#receipt(input, "scheduleNodes", fingerprint);
      if (replay !== null) {
        this.#database.exec("COMMIT");
        return structuredClone({
          ...(replay as object),
          disposition: "replay",
        } as Awaited<
          ReturnType<WorkflowRunCompositionStore["scheduleWorkflowNodes"]>
        >);
      }
      this.#validateLease(input, nowMs);
      assertCanonicalRun(
        this.#loadRun(input.tenantId, input.runId),
        input.binding,
      );
      const workflow = this.#loadWorkflow(input);
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
            `INSERT INTO workflow_executions(tenant_id,run_id,revision,state_json,updated_at)
           VALUES (?,?,?,?,?)`,
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
      const recovery = reconciliationClaims(execution, workflow);
      const scheduled = scheduleReadyNodes({
        execution,
        workflow,
        operationId: input.schedulerOperationId,
        now,
        digester: this.#digester,
      });
      execution = scheduled.execution;
      const nodeWorkItems = [];
      const gatePublications = [];
      for (const claim of scheduled.claims) {
        const authority = {
          tenantId: input.tenantId,
          runId: input.runId,
          binding: input.binding,
          nodeId: claim.node.nodeId,
          claimId: claim.claimId,
          claimEpoch: claim.claimEpoch,
          schedulerOperationId: input.schedulerOperationId,
        };
        if (claim.node.kind === "humanGate") {
          const gateRequestId = claim.gateRequestId!;
          const publicationOutboxMessageId = workflowAuthorityId(
            "gate-outbox",
            authority,
            this.#digester,
          );
          const approvalResumeWorkItemId = workflowAuthorityId(
            "gate-resume",
            authority,
            this.#digester,
          );
          const gate = {
            ...authority,
            gateRequestId,
            approvalPolicyId: claim.node.approvalPolicyId,
            inputDigest: claim.inputDigest,
            publicationOutboxMessageId,
            approvalResumeWorkItemId,
            status: "published",
            createdAt: now,
            updatedAt: now,
          };
          const step = gateStep({
            tenantId: input.tenantId,
            runId: input.runId,
            nodeId: claim.node.nodeId,
            now,
          });
          this.#database
            .prepare(
              `INSERT INTO run_steps
             (tenant_id,run_id,step_id,kind,status,revision,current_attempt_id,attempt_count,state_json,created_at,updated_at,terminal_at)
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
          this.#database
            .prepare(
              `INSERT INTO workflow_gate_requests
             (tenant_id,run_id,node_id,gate_request_id,claim_id,claim_epoch,step_id,
              approval_policy_id,input_digest,publication_outbox_message_id,
              approval_resume_work_item_id,status,state_json,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,'published',?,?,?)`,
            )
            .run(
              input.tenantId,
              input.runId,
              claim.node.nodeId,
              gateRequestId,
              claim.claimId,
              claim.claimEpoch,
              claim.node.nodeId,
              claim.node.approvalPolicyId,
              claim.inputDigest,
              publicationOutboxMessageId,
              approvalResumeWorkItemId,
              stableJson(gate),
              now,
              now,
            );
          const message = {
            messageId: publicationOutboxMessageId,
            tenantId: input.tenantId,
            runId: input.runId,
            topic: "workflow.gate.requested",
            payload: gate,
            createdAt: now,
          };
          this.#database
            .prepare(
              `INSERT INTO outbox(message_id,tenant_id,run_id,topic,message_json,created_at,status,available_at_ms,lease_epoch,attempt_count)
             VALUES (?,?,?,?,?,?,'pending',?,0,0)`,
            )
            .run(
              publicationOutboxMessageId,
              input.tenantId,
              input.runId,
              message.topic,
              stableJson(message),
              now,
              nowMs,
            );
          gatePublications.push({
            nodeId: claim.node.nodeId,
            claimId: claim.claimId,
            claimEpoch: claim.claimEpoch,
            gateRequestId,
            publicationOutboxMessageId,
            approvalResumeWorkItemId,
          });
        } else {
          const workItemId = workflowAuthorityId(
            "node",
            authority,
            this.#digester,
          );
          this.#insertWorkflowWorkItem(
            workItemId,
            input,
            {
              schemaVersion: "crewon.workflow-node-work-item.v0",
              trigger: "workflowNode",
              binding: input.binding,
              nodeId: claim.node.nodeId,
              claimId: claim.claimId,
              claimEpoch: claim.claimEpoch,
              schedulerOperationId: input.schedulerOperationId,
            },
            now,
            nowMs,
          );
          nodeWorkItems.push({
            nodeId: claim.node.nodeId,
            claimId: claim.claimId,
            claimEpoch: claim.claimEpoch,
            workItemId,
          });
        }
      }
      this.#writeExecution(execution, now);
      const result =
        recovery.length > 0
          ? {
              disposition: "reconcileRequired" as const,
              execution,
              nodeWorkItems: [],
              gatePublications: [],
              reconciliationClaims: recovery,
            }
          : {
              disposition: "scheduled" as const,
              execution,
              nodeWorkItems,
              gatePublications,
              reconciliationClaims: [],
            };
      this.#insertReceipt(input, "scheduleNodes", fingerprint, result);
      this.#completeLease(input, nowMs);
      this.#database.exec("COMMIT");
      return structuredClone(result);
    } catch (error) {
      rollback(this.#database);
      throw normalizeCompositionError(error);
    }
  }

  async admitWorkflowNodeWork(
    input: Parameters<WorkflowRunCompositionStore["admitWorkflowNodeWork"]>[0],
  ): ReturnType<WorkflowRunCompositionStore["admitWorkflowNodeWork"]> {
    const nowMs = readLeaseClock(this.#clock);
    const now = new Date(nowMs).toISOString();
    const fingerprint = this.#fingerprint("admitNode", input);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const replay = this.#receipt(
        { ...input, operationId: input.admissionOperationId },
        "admitNode",
        fingerprint,
      );
      if (replay !== null) {
        this.#database.exec("COMMIT");
        return structuredClone({
          ...(replay as object),
          disposition: "replay",
          admission: null,
        } as Awaited<
          ReturnType<WorkflowRunCompositionStore["admitWorkflowNodeWork"]>
        >);
      }
      this.#validateLease(input, nowMs);
      assertCanonicalRun(
        this.#loadRun(input.tenantId, input.runId),
        input.binding,
      );
      const workflow = this.#loadWorkflow(input);
      const execution = this.#loadExecution(input.tenantId, input.runId);
      if (execution === null)
        throw new RunStoreError("workflow_execution_not_found");
      const node = execution.nodes.find(
        (candidate) => candidate.nodeId === input.nodeId,
      );
      const definition = workflow.nodes.find(
        (candidate) => candidate.nodeId === input.nodeId,
      );
      if (
        node === undefined ||
        definition === undefined ||
        definition.kind === "humanGate" ||
        node.status !== "queued" ||
        node.claimId !== input.claimId ||
        node.claimEpoch !== input.claimEpoch ||
        node.claimOperationId !== input.schedulerOperationId
      )
        throw new RunStoreError("workflow_composition_claim_mismatch");
      this.#assertNodeWorkPayload(input);
      const attemptIdValue = workflowAuthorityId(
        "attempt",
        {
          tenantId: input.tenantId,
          runId: input.runId,
          nodeId: input.nodeId,
          claimId: input.claimId,
          claimEpoch: input.claimEpoch,
        },
        this.#digester,
      );
      const started = beginSqliteRunAttempt(this.#database, {
        tenantId: input.tenantId,
        runId: input.runId,
        lease: input.lease,
        stepId: input.nodeId,
        kind: definition.kind === "verification" ? "verification" : "agent",
        attemptId: attemptIdValue,
        startedAt: now,
      });
      const expiresAt = new Date(
        nowMs + input.attemptLeaseDurationMs,
      ).toISOString();
      const next = {
        ...execution,
        revision: execution.revision + 1,
        nodes: execution.nodes.map((candidate) =>
          candidate.nodeId === input.nodeId
            ? {
                ...candidate,
                status: "running" as const,
                leaseExpiresAt: expiresAt,
              }
            : candidate,
        ),
        updatedAt: now,
      };
      this.#writeExecution(next, now);
      const claim = {
        node: definition,
        claimId: input.claimId,
        claimEpoch: input.claimEpoch,
        gateRequestId: null,
        inputDigest: node.inputDigest!,
      };
      const result = {
        disposition: "fresh" as const,
        execution: next,
        admission: { claim, step: started.step, attempt: started.attempt },
      };
      this.#insertReceipt(
        { ...input, operationId: input.admissionOperationId },
        "admitNode",
        fingerprint,
        result,
      );
      this.#database.exec("COMMIT");
      return structuredClone(result);
    } catch (error) {
      rollback(this.#database);
      throw normalizeCompositionError(error);
    }
  }

  async recordWorkflowHumanGateDecision(): Promise<never> {
    throw new RunStoreError("workflow_composition_contract_incomplete");
  }

  #validateLease(
    input: Readonly<{
      tenantId: string;
      runId: string;
      lease: import("@crewon/application").WorkItemLeaseInput;
    }>,
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

  #loadWorkflow(input: {
    tenantId: string;
    binding: import("@crewon/domain").FrozenWorkflowVersionBinding;
  }) {
    const row = this.#database
      .prepare(
        "SELECT definition_json FROM workflow_versions WHERE tenant_id=? AND workflow_version_id=?",
      )
      .get(input.tenantId, input.binding.workflowVersionId) as
      | { definition_json: string }
      | undefined;
    if (row === undefined)
      throw new RunStoreError("workflow_composition_version_not_found");
    return parseBoundWorkflow(
      row.definition_json,
      input.binding,
      this.#digester,
    );
  }

  #fingerprint(kind: string, input: unknown): string {
    return this.#digester.sha256(stableJson({ kind, input }));
  }

  #receipt(
    input: {
      tenantId: string;
      runId: string;
      operationId?: string;
      schedulerOperationId?: string;
    },
    kind: string,
    fingerprint: string,
  ): unknown | null {
    const operationId = input.operationId ?? input.schedulerOperationId!;
    const row = this.#database
      .prepare(
        `SELECT kind,fingerprint,result_json FROM workflow_composition_receipts
       WHERE tenant_id=? AND run_id=? AND operation_id=?`,
      )
      .get(input.tenantId, input.runId, operationId) as
      | { kind: string; fingerprint: string; result_json: string }
      | undefined;
    if (row === undefined) return null;
    if (row.kind !== kind || row.fingerprint !== fingerprint)
      throw new RunStoreError("workflow_composition_idempotency_conflict");
    return JSON.parse(row.result_json);
  }

  #insertReceipt(
    input: {
      tenantId: string;
      runId: string;
      operationId?: string;
      schedulerOperationId?: string;
    },
    kind: string,
    fingerprint: string,
    result: unknown,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO workflow_composition_receipts
       (tenant_id,run_id,operation_id,kind,fingerprint,result_json) VALUES (?,?,?,?,?,?)`,
      )
      .run(
        input.tenantId,
        input.runId,
        input.operationId ?? input.schedulerOperationId!,
        kind,
        fingerprint,
        stableJson(result),
      );
  }

  #writeExecution(
    execution: import("@crewon/application").WorkflowExecutionState,
    now: string,
  ): void {
    validateWorkflowExecutionState(execution);
    const result = this.#database
      .prepare(
        `UPDATE workflow_executions SET revision=?,state_json=?,updated_at=? WHERE tenant_id=? AND run_id=?`,
      )
      .run(
        execution.revision,
        stableJson(execution),
        now,
        execution.tenantId,
        execution.runId,
      );
    if (result.changes !== 1)
      throw new RunStoreError("workflow_execution_not_found");
  }

  #insertWorkflowWorkItem(
    workItemId: string,
    input: { tenantId: string; runId: string },
    payload: Record<string, unknown>,
    now: string,
    nowMs: number,
  ): void {
    const item = {
      workItemId,
      tenantId: input.tenantId,
      runId: input.runId,
      kind: "run.execute",
      payload,
      createdAt: now,
    };
    this.#database
      .prepare(
        `INSERT INTO work_items(work_item_id,tenant_id,run_id,kind,work_item_json,created_at,status,available_at_ms,lease_epoch,attempt_count)
       VALUES (?,?,?,?,?,?,'pending',?,0,0)`,
      )
      .run(
        workItemId,
        input.tenantId,
        input.runId,
        "run.execute",
        stableJson(item),
        now,
        nowMs,
      );
  }

  #completeLease(
    input: { lease: import("@crewon/application").WorkItemLeaseInput },
    nowMs: number,
  ): void {
    const result = this.#database
      .prepare(
        `UPDATE work_items SET status='completed',lease_owner_id=NULL,lease_id=NULL,lease_expires_at_ms=NULL,completed_at_ms=?
       WHERE work_item_id=? AND status='leased' AND lease_owner_id=? AND lease_id=? AND lease_epoch=? AND lease_expires_at_ms>?`,
      )
      .run(
        nowMs,
        input.lease.workItemId,
        input.lease.ownerId,
        input.lease.leaseId,
        input.lease.leaseEpoch,
        nowMs,
      );
    if (result.changes !== 1) throw new RunStoreError("stale_lease");
  }

  #assertNodeWorkPayload(
    input: Parameters<WorkflowRunCompositionStore["admitWorkflowNodeWork"]>[0],
  ): void {
    const row = this.#database
      .prepare("SELECT work_item_json FROM work_items WHERE work_item_id=?")
      .get(input.lease.workItemId) as { work_item_json: string } | undefined;
    if (row === undefined) throw new RunStoreError("queue_item_not_found");
    const item = JSON.parse(row.work_item_json) as { payload?: unknown };
    const expected = {
      schemaVersion: "crewon.workflow-node-work-item.v0",
      trigger: "workflowNode",
      binding: input.binding,
      nodeId: input.nodeId,
      claimId: input.claimId,
      claimEpoch: input.claimEpoch,
      schedulerOperationId: input.schedulerOperationId,
    };
    if (stableJson(item.payload) !== stableJson(expected))
      throw new RunStoreError("workflow_composition_work_item_mismatch");
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
    WorkflowRunCompositionStore["scheduleWorkflowNodes"]
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
  input: LegacyAdmissionInput,
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

function normalizeCompositionError(error: unknown): Error {
  return error instanceof RunStoreError
    ? error
    : new RunStoreError("workflow_composition_store_failed", {
        cause: error instanceof Error ? error : undefined,
      });
}
