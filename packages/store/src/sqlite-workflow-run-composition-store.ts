import { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  RunStoreError,
  type WorkflowRunCompositionStore,
} from "@crewon/application";
import {
  composeWorkflowNodeInput,
  composeWorkflowOutput,
  reduceRunLifecycleEvent,
  validateWorkflowSchemaValue,
  workflowNodeInputSchema,
  type RunState,
  type WorkflowContentDigester,
  type WorkflowSchemaValue,
} from "@crewon/domain";

import {
  readLeaseClock,
  SystemLeaseClock,
  type LeaseClock,
} from "./lease-clock.ts";
import {
  beginSqliteRunAttempt,
  finishSqliteRunAttempt,
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
  settleWorkflowClaim,
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
          assertAdmissionReplayAuthority(admission as Parameters<typeof assertAdmissionReplayAuthority>[0], step, attempt);
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

  async settleWorkflowNode(
    input: Parameters<WorkflowRunCompositionStore["settleWorkflowNode"]>[0],
  ): ReturnType<WorkflowRunCompositionStore["settleWorkflowNode"]> {
    const nowMs = readLeaseClock(this.#clock);
    const now = new Date(nowMs).toISOString();
    const fingerprint = this.#fingerprint("settleNode", input);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const replay = this.#receipt(input, "settleNode", fingerprint);
      if (replay !== null) {
        this.#database.exec("COMMIT");
        return structuredClone({
          ...(replay as object),
          disposition: "replay",
        } as Awaited<
          ReturnType<WorkflowRunCompositionStore["settleWorkflowNode"]>
        >);
      }
      this.#validateLease(input, nowMs);
      assertCanonicalRun(
        this.#loadRun(input.tenantId, input.runId),
        input.binding,
      );
      const execution = this.#loadExecution(input.tenantId, input.runId);
      const step = loadSqliteRunStep(this.#database, input);
      const attempt = loadSqliteRunAttempt(this.#database, input);
      if (
        execution === null ||
        step === null ||
        attempt === null ||
        input.stepId !== input.nodeId ||
        step.currentAttemptId !== input.attemptId ||
        attempt.workItemId !== input.lease.workItemId ||
        attempt.leaseEpoch !== input.lease.leaseEpoch
      )
        throw new RunStoreError("workflow_composition_attempt_mismatch");
      const workflow = this.#loadWorkflow(input);
      const definition = workflow.nodes.find((node) => node.nodeId === input.nodeId);
      if (definition === undefined)
        throw new RunStoreError("workflow_composition_claim_mismatch");
      let resultDigest: string | undefined;
      if (input.outcome.status === "completed") {
        const value = validateWorkflowSchemaValue(input.outcome.value, definition.outputSchema);
        const valueJson = canonicalJson(value);
        resultDigest = this.#digester.sha256(valueJson);
        const valueId = workflowAuthorityId("value", {
          tenantId: input.tenantId, runId: input.runId, nodeId: input.nodeId,
          claimId: input.claimId, claimEpoch: input.claimEpoch, resultDigest,
        }, this.#digester);
        this.#insertExecutionValue({ ...input, valueId, role: "nodeOutput",
          nodeId: input.nodeId, valueDigest: resultDigest, valueJson, now });
      }
      const next = settleWorkflowClaim({ execution, ...input, resultDigest, now });
      if (input.outcome.status !== "unknown") {
        finishSqliteRunAttempt(this.#database, {
          tenantId: input.tenantId,
          runId: input.runId,
          workItemId: input.lease.workItemId,
          leaseEpoch: input.lease.leaseEpoch,
          attempt: terminalAttempt(input, now),
        });
      }
      this.#writeExecution(next, now);
      const runDisposition = this.#convergeTerminalRun(input, workflow, next, now, nowMs);
      let schedulerContinuationWorkItemId: string | null = null;
      let reconciliationWorkItemId: string | null = null;
      if (input.outcome.status === "unknown") {
        reconciliationWorkItemId = workflowAuthorityId(
          "reconcile",
          { tenantId: input.tenantId, runId: input.runId, binding: input.binding,
            operationId: input.operationId, nodeId: input.nodeId,
            claimId: input.claimId, claimEpoch: input.claimEpoch },
          this.#digester,
        );
        this.#insertWorkflowWorkItem(reconciliationWorkItemId, input, {
          schemaVersion: "crewon.workflow-reconcile-work-item.v0",
          trigger: "workflowReconcile", binding: input.binding,
          nodeId: input.nodeId, claimId: input.claimId,
          claimEpoch: input.claimEpoch,
          reconciliationOperationId: input.operationId,
        }, now, nowMs);
      } else if (
        !next.nodes.some((node) =>
          ["queued", "running", "unknown", "waitingHuman"].includes(node.status),
        ) &&
        next.status === "running"
      ) {
        schedulerContinuationWorkItemId = workflowAuthorityId(
          "scheduler",
          {
            tenantId: input.tenantId,
            runId: input.runId,
            binding: input.binding,
            settledNodeId: input.nodeId,
            claimId: input.claimId,
            claimEpoch: input.claimEpoch,
          },
          this.#digester,
        );
        this.#insertWorkflowWorkItem(
          schedulerContinuationWorkItemId,
          input,
          {
            schemaVersion: "crewon.workflow-scheduler-work-item.v1",
            trigger: "workflowScheduler",
            binding: input.binding,
            schedulerOperationId: schedulerContinuationWorkItemId,
            workflowInput: this.#rootInputRef(input),
          },
          now,
          nowMs,
        );
      }
      const result = {
        disposition:
          input.outcome.status === "unknown"
            ? ("reconciliationScheduled" as const)
            : ("settled" as const),
        execution: next,
        schedulerContinuationWorkItemId,
        handoff: {
          currentWorkItem: "completed" as const,
          nextWorkItemId: reconciliationWorkItemId ?? schedulerContinuationWorkItemId,
          kind: reconciliationWorkItemId !== null
            ? "reconcile" as const
            : schedulerContinuationWorkItemId === null ? "none" as const : "scheduler" as const,
        },
        runDisposition,
      };
      this.#insertReceipt(input, "settleNode", fingerprint, result);
      this.#completeLease(input, nowMs);
      this.#database.exec("COMMIT");
      return structuredClone(result);
    } catch (error) {
      rollback(this.#database);
      throw normalizeCompositionError(error);
    }
  }

  async settleWorkflowHumanGate(
    input: Parameters<
      WorkflowRunCompositionStore["settleWorkflowHumanGate"]
    >[0],
  ): ReturnType<WorkflowRunCompositionStore["settleWorkflowHumanGate"]> {
    const nowMs = readLeaseClock(this.#clock);
    const now = new Date(nowMs).toISOString();
    const fingerprint = this.#fingerprint("settleGate", input);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const replay = this.#receipt(input, "settleGate", fingerprint);
      if (replay !== null) {
        this.#database.exec("COMMIT");
        return structuredClone({
          ...(replay as object),
          disposition: "replay",
        } as Awaited<
          ReturnType<WorkflowRunCompositionStore["settleWorkflowHumanGate"]>
        >);
      }
      this.#validateLease(input, nowMs);
      assertCanonicalRun(
        this.#loadRun(input.tenantId, input.runId),
        input.binding,
      );
      const gate = this.#loadGate(input);
      if (
        gate.decisionReceiptId !== input.decisionReceiptId ||
        gate.status === "published"
      )
        throw new RunStoreError("workflow_gate_decision_mismatch");
      this.#assertGateResumePayload(input, gate);
      const execution = this.#loadExecution(input.tenantId, input.runId);
      const step = loadSqliteRunStep(this.#database, {
        ...input,
        stepId: input.nodeId,
      });
      if (
        execution === null ||
        step === null ||
        step.kind !== "gate" ||
        step.status !== "waitingApproval"
      )
        throw new RunStoreError("workflow_composition_gate_mismatch");
      const outcome = gate.outcome as
        | { status: "completed" }
        | { status: "failed"; failureCode: string };
      const terminalStep = {
        ...step,
        status: outcome.status,
        revision: step.revision + 1,
        updatedAt: now,
        terminalAt: now,
      };
      this.#database
        .prepare(
          `UPDATE run_steps SET status=?,revision=?,state_json=?,updated_at=?,terminal_at=?
         WHERE tenant_id=? AND run_id=? AND step_id=? AND revision=?`,
        )
        .run(
          terminalStep.status,
          terminalStep.revision,
          stableJson(terminalStep),
          now,
          now,
          input.tenantId,
          input.runId,
          input.nodeId,
          step.revision,
        );
      const node = execution.nodes.find((candidate) => candidate.nodeId === input.nodeId);
      if (node === undefined) throw new RunStoreError("workflow_composition_gate_mismatch");
      let gateValue: WorkflowSchemaValue | undefined;
      if (outcome.status === "completed") {
        const inputAuthority = this.#composeNodeInputValue({
          ...input, schedulerOperationId: node.claimOperationId!,
          admissionOperationId: input.operationId, attemptLeaseDurationMs: 1,
        }, this.#loadWorkflow(input), now);
        gateValue = inputAuthority.value as WorkflowSchemaValue;
        this.#insertExecutionValue({ ...input,
          valueId: workflowAuthorityId("value", { tenantId: input.tenantId,
            runId: input.runId, nodeId: input.nodeId, claimId: input.claimId,
            claimEpoch: input.claimEpoch, resultDigest: inputAuthority.valueDigest }, this.#digester),
          role: "nodeOutput", nodeId: input.nodeId,
          valueDigest: inputAuthority.valueDigest,
          valueJson: canonicalJson(gateValue), now });
      }
      const next = settleWorkflowClaim({ execution, ...input,
        outcome: outcome.status === "completed"
          ? { status: "completed", value: gateValue! }
          : outcome,
        resultDigest: outcome.status === "completed" ? node.inputDigest! : undefined, now });
      this.#writeExecution(next, now);
      const runDisposition = this.#convergeTerminalRun(
        input, this.#loadWorkflow(input), next, now, nowMs);
      let schedulerContinuationWorkItemId: string | null = null;
      if (
        next.status === "running" &&
        !next.nodes.some((node) =>
          ["queued", "running", "unknown", "waitingHuman"].includes(node.status),
        )
      ) {
        schedulerContinuationWorkItemId = workflowAuthorityId(
          "scheduler",
          {
            tenantId: input.tenantId,
            runId: input.runId,
            binding: input.binding,
            gateRequestId: input.gateRequestId,
            decisionReceiptId: input.decisionReceiptId,
          },
          this.#digester,
        );
        this.#insertWorkflowWorkItem(
          schedulerContinuationWorkItemId,
          input,
          {
            schemaVersion: "crewon.workflow-scheduler-work-item.v1",
            trigger: "workflowScheduler",
            binding: input.binding,
            schedulerOperationId: schedulerContinuationWorkItemId,
            workflowInput: this.#rootInputRef(input),
          },
          now,
          nowMs,
        );
      }
      const result = {
        disposition: "settled" as const,
        execution: next,
        schedulerContinuationWorkItemId,
        handoff: {
          currentWorkItem: "completed" as const,
          nextWorkItemId: schedulerContinuationWorkItemId,
          kind: schedulerContinuationWorkItemId === null ? "none" as const : "scheduler" as const,
        },
        runDisposition,
      };
      this.#insertReceipt(input, "settleGate", fingerprint, result);
      this.#completeLease(input, nowMs);
      this.#database.exec("COMMIT");
      return structuredClone(result);
    } catch (error) {
      rollback(this.#database);
      throw normalizeCompositionError(error);
    }
  }

  async scheduleWorkflowReconciliation(
    input: Parameters<
      WorkflowRunCompositionStore["scheduleWorkflowReconciliation"]
    >[0],
  ): ReturnType<WorkflowRunCompositionStore["scheduleWorkflowReconciliation"]> {
    const nowMs = readLeaseClock(this.#clock);
    const now = new Date(nowMs).toISOString();
    const fingerprint = this.#fingerprint("scheduleReconciliation", input);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const replay = this.#receipt(
        input,
        "scheduleReconciliation",
        fingerprint,
      );
      if (replay !== null) {
        this.#database.exec("COMMIT");
        return structuredClone({
          ...(replay as object),
          disposition: "replay",
        } as Awaited<
          ReturnType<
            WorkflowRunCompositionStore["scheduleWorkflowReconciliation"]
          >
        >);
      }
      this.#validateLease(input, nowMs);
      assertCanonicalRun(
        this.#loadRun(input.tenantId, input.runId),
        input.binding,
      );
      const reconciliationWorkItemId = workflowAuthorityId(
        "reconcile",
        {
          tenantId: input.tenantId,
          runId: input.runId,
          binding: input.binding,
          operationId: input.operationId,
          nodeId: input.nodeId,
          claimId: input.claimId,
          claimEpoch: input.claimEpoch,
        },
        this.#digester,
      );
      this.#insertWorkflowWorkItem(
        reconciliationWorkItemId,
        input,
        {
          schemaVersion: "crewon.workflow-reconcile-work-item.v0",
          trigger: "workflowReconcile",
          binding: input.binding,
          nodeId: input.nodeId,
          claimId: input.claimId,
          claimEpoch: input.claimEpoch,
          reconciliationOperationId: input.operationId,
        },
        now,
        nowMs,
      );
      const result = {
        disposition: "scheduled" as const,
        reconciliationWorkItemId,
        handoff: { currentWorkItem: "completed" as const, nextWorkItemId: reconciliationWorkItemId, kind: "reconcile" as const },
      };
      this.#insertReceipt(input, "scheduleReconciliation", fingerprint, result);
      this.#completeLease(input, nowMs);
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      rollback(this.#database);
      throw normalizeCompositionError(error);
    }
  }

  async cancelWorkflowExecution(
    input: Parameters<WorkflowRunCompositionStore["cancelWorkflowExecution"]>[0],
  ): ReturnType<WorkflowRunCompositionStore["cancelWorkflowExecution"]> {
    const nowMs = readLeaseClock(this.#clock);
    const now = new Date(nowMs).toISOString();
    const fingerprint = this.#fingerprint("cancelExecution", input);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const replay = this.#receipt(input, "cancelExecution", fingerprint);
      if (replay !== null) {
        this.#database.exec("COMMIT");
        return structuredClone({ ...(replay as object), disposition: "replay" } as
          Awaited<ReturnType<WorkflowRunCompositionStore["cancelWorkflowExecution"]>>);
      }
      this.#validateLease(input, nowMs);
      assertCanonicalRun(this.#loadRun(input.tenantId, input.runId), input.binding);
      const execution = this.#loadExecution(input.tenantId, input.runId);
      if (execution === null) throw new RunStoreError("workflow_execution_not_found");
      let requiresReconciliation = false;
      const nodes = execution.nodes.map((node) => {
        if (node.status === "queued") {
          const work = this.#database.prepare(
            `SELECT status FROM work_items WHERE tenant_id=? AND run_id=?
             AND json_extract(work_item_json,'$.payload.nodeId')=?`,
          ).get(input.tenantId, input.runId, node.nodeId) as { status: string } | undefined;
          if (work?.status !== "pending") { requiresReconciliation = true; return node; }
          this.#database.prepare(
            `UPDATE work_items SET status='completed',completed_at_ms=?
             WHERE tenant_id=? AND run_id=? AND status='pending'
             AND json_extract(work_item_json,'$.payload.nodeId')=?`,
          ).run(nowMs, input.tenantId, input.runId, node.nodeId);
          return { ...node, status: "canceled" as const };
        }
        if (["running", "unknown"].includes(node.status)) requiresReconciliation = true;
        if (node.status === "waitingHuman") {
          const changed = this.#database.prepare(
            `UPDATE workflow_gate_requests SET status='canceled',updated_at=?
             WHERE tenant_id=? AND run_id=? AND node_id=? AND status='published'`,
          ).run(now, input.tenantId, input.runId, node.nodeId);
          if (changed.changes === 1) return { ...node, status: "canceled" as const };
          requiresReconciliation = true;
        }
        return node;
      });
      const active = nodes.some((node) =>
        ["queued", "running", "unknown", "waitingHuman"].includes(node.status));
      const next = { ...execution, revision: execution.revision + 1,
        cancelRequested: true, nodes,
        status: active ? "running" as const : "canceled" as const, updatedAt: now };
      this.#writeExecution(next, now);
      let reconciliationWorkItemId: string | null = null;
      if (requiresReconciliation) {
        reconciliationWorkItemId = workflowAuthorityId("reconcile", input, this.#digester);
        this.#insertWorkflowWorkItem(reconciliationWorkItemId, input, {
          schemaVersion: "crewon.workflow-reconcile-work-item.v0",
          trigger: "workflowReconcile", binding: input.binding,
          nodeId: null, claimId: null, claimEpoch: null,
          reconciliationOperationId: input.operationId,
        }, now, nowMs);
      }
      const runDisposition = this.#convergeTerminalRun(
        input, this.#loadWorkflow(input), next, now, nowMs);
      const result = { disposition: requiresReconciliation
        ? "reconciliationScheduled" as const : "canceled" as const,
        execution: next, handoff: { currentWorkItem: "completed" as const,
          nextWorkItemId: reconciliationWorkItemId,
          kind: reconciliationWorkItemId === null ? "none" as const : "reconcile" as const },
        runDisposition };
      this.#insertReceipt(input, "cancelExecution", fingerprint, result);
      this.#completeLease(input, nowMs);
      this.#database.exec("COMMIT");
      return structuredClone(result);
    } catch (error) {
      rollback(this.#database);
      throw normalizeCompositionError(error);
    }
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
      const scheduled = recovery.length === 0
        ? scheduleReadyNodes({ execution, workflow,
            operationId: input.schedulerOperationId, now, digester: this.#digester,
            inputDigest: (nodeId) => this.#nodeInputDigest(input, workflow, nodeId) })
        : { execution, claims: [] };
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
      const reconciliationWorkItemId = recovery.length === 0
        ? null
        : workflowAuthorityId("reconcile", {
            tenantId: input.tenantId, runId: input.runId,
            binding: input.binding, operationId: input.schedulerOperationId,
            claims: recovery.map((claim) => ({ nodeId: claim.node.nodeId,
              claimId: claim.claimId, claimEpoch: claim.claimEpoch })),
          }, this.#digester);
      if (reconciliationWorkItemId !== null) {
        const claim = recovery[0]!;
        this.#insertWorkflowWorkItem(reconciliationWorkItemId, input, {
          schemaVersion: "crewon.workflow-reconcile-work-item.v0",
          trigger: "workflowReconcile", binding: input.binding,
          nodeId: claim.node.nodeId, claimId: claim.claimId,
          claimEpoch: claim.claimEpoch,
          reconciliationOperationId: input.schedulerOperationId,
        }, now, nowMs);
      }
      const result =
        recovery.length > 0
          ? {
              disposition: "reconcileRequired" as const,
              execution,
              nodeWorkItems: [],
              gatePublications: [],
              reconciliationClaims: recovery,
              handoff: { currentWorkItem: "completed" as const, nextWorkItemId: reconciliationWorkItemId, kind: "reconcile" as const },
              runDisposition: "nonTerminal" as const,
            }
          : {
              disposition: "scheduled" as const,
              execution,
              nodeWorkItems,
              gatePublications,
              reconciliationClaims: [],
              handoff: { currentWorkItem: "completed" as const, nextWorkItemId: null, kind: "none" as const },
              runDisposition: "nonTerminal" as const,
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
      const inputValue = this.#composeNodeInputValue(input, workflow, now);
      const result = {
        disposition: "fresh" as const,
        execution: next,
        admission: { claim, step: started.step, attempt: started.attempt, inputValue },
        handoff: { currentWorkItem: "retained" as const, nextWorkItemId: null, kind: "none" as const },
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

  async recordWorkflowHumanGateDecision(
    input: Parameters<
      WorkflowRunCompositionStore["recordWorkflowHumanGateDecision"]
    >[0],
  ): ReturnType<
    WorkflowRunCompositionStore["recordWorkflowHumanGateDecision"]
  > {
    const nowMs = readLeaseClock(this.#clock);
    const now = new Date(nowMs).toISOString();
    const fingerprint = this.#fingerprint("recordGateDecision", input);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const replay = this.#receipt(
        { ...input, operationId: input.decisionReceiptId },
        "recordGateDecision",
        fingerprint,
      );
      if (replay !== null) {
        this.#database.exec("COMMIT");
        return structuredClone({
          ...(replay as object),
          disposition: "replay",
        } as Awaited<
          ReturnType<
            WorkflowRunCompositionStore["recordWorkflowHumanGateDecision"]
          >
        >);
      }
      assertCanonicalRun(
        this.#loadRun(input.tenantId, input.runId),
        input.binding,
      );
      const gate = this.#loadGate(input);
      if (
        gate.status !== "published" ||
        gate.claimId !== input.claimId ||
        gate.claimEpoch !== input.claimEpoch
      )
        throw new RunStoreError("workflow_gate_decision_mismatch");
      const state = {
        ...gate,
        status: input.outcome.status,
        decisionReceiptId: input.decisionReceiptId,
        outcome: input.outcome,
        updatedAt: now,
      };
      const approvalResumeWorkItemId = gate.approvalResumeWorkItemId;
      if (typeof approvalResumeWorkItemId !== "string")
        throw new RunStoreError("workflow_gate_store_corrupt");
      this.#database
        .prepare(
          `UPDATE workflow_gate_requests SET status=?,state_json=?,updated_at=?
         WHERE tenant_id=? AND run_id=? AND node_id=? AND status='published'`,
        )
        .run(
          input.outcome.status,
          stableJson(state),
          now,
          input.tenantId,
          input.runId,
          input.nodeId,
        );
      this.#insertWorkflowWorkItem(
        approvalResumeWorkItemId,
        input,
        {
          schemaVersion: "crewon.workflow-gate-resume-work-item.v0",
          trigger: "workflowGateResume",
          binding: input.binding,
          nodeId: input.nodeId,
          claimId: input.claimId,
          claimEpoch: input.claimEpoch,
          gateRequestId: input.gateRequestId,
          decisionReceiptId: input.decisionReceiptId,
        },
        now,
        nowMs,
      );
      const result = {
        disposition: "recorded" as const,
        approvalResumeWorkItemId,
      };
      this.#insertReceipt(
        { ...input, operationId: input.decisionReceiptId },
        "recordGateDecision",
        fingerprint,
        result,
      );
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      rollback(this.#database);
      throw normalizeCompositionError(error);
    }
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

  #loadGate(input: {
    tenantId: string;
    runId: string;
    nodeId: string;
    gateRequestId: string;
  }): Record<string, unknown> {
    const row = this.#database
      .prepare(
        `SELECT state_json FROM workflow_gate_requests
       WHERE tenant_id=? AND run_id=? AND node_id=? AND gate_request_id=?`,
      )
      .get(input.tenantId, input.runId, input.nodeId, input.gateRequestId) as
      | { state_json: string }
      | undefined;
    if (row === undefined) throw new RunStoreError("workflow_gate_not_found");
    return JSON.parse(row.state_json) as Record<string, unknown>;
  }

  #assertGateResumePayload(
    input: Parameters<
      WorkflowRunCompositionStore["settleWorkflowHumanGate"]
    >[0],
    gate: Record<string, unknown>,
  ): void {
    const row = this.#database
      .prepare("SELECT work_item_json FROM work_items WHERE work_item_id=?")
      .get(input.lease.workItemId) as { work_item_json: string } | undefined;
    const item =
      row === undefined
        ? null
        : (JSON.parse(row.work_item_json) as { payload?: unknown });
    const expected = {
      schemaVersion: "crewon.workflow-gate-resume-work-item.v0",
      trigger: "workflowGateResume",
      binding: input.binding,
      nodeId: input.nodeId,
      claimId: input.claimId,
      claimEpoch: input.claimEpoch,
      gateRequestId: input.gateRequestId,
      decisionReceiptId: input.decisionReceiptId,
    };
    if (
      input.lease.workItemId !== gate.approvalResumeWorkItemId ||
      stableJson(item?.payload) !== stableJson(expected)
    )
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

  #composeNodeInputValue(
    input: Parameters<WorkflowRunCompositionStore["admitWorkflowNodeWork"]>[0],
    workflow: import("@crewon/domain").CompiledWorkflowVersion,
    now?: string,
  ): import("@crewon/application").WorkflowExecutionValue {
    const root = this.#loadExecutionValue(input.tenantId, input.runId, "rootInput", null);
    const node = workflow.nodes.find((candidate) => candidate.nodeId === input.nodeId);
    if (root === null || node === undefined)
      throw new RunStoreError("workflow_execution_value_not_found");
    const dependencyOutputs = node.dependsOn.map((nodeId) => {
      const output = this.#loadExecutionValue(input.tenantId, input.runId, "nodeOutput", nodeId);
      if (output === null) throw new RunStoreError("workflow_execution_value_not_found");
      return { nodeId, value: output.value };
    });
    const value = validateWorkflowSchemaValue(
      composeWorkflowNodeInput({ workflow, nodeId: input.nodeId,
        rootInput: root.value, dependencyOutputs }),
      workflowNodeInputSchema(workflow, input.nodeId),
    );
    const valueJson = canonicalJson(value);
    const valueDigest = this.#digester.sha256(valueJson);
    if (valueDigest !== executionNode(input, this.#loadExecution(input.tenantId, input.runId)).inputDigest)
      throw new RunStoreError("workflow_execution_value_digest_mismatch");
    const authority = { schemaVersion: "crewon.workflow-execution-value.v0" as const,
      valueId: workflowAuthorityId("value", { tenantId: input.tenantId,
        runId: input.runId, nodeId: input.nodeId, claimId: input.claimId,
        claimEpoch: input.claimEpoch, valueDigest }, this.#digester),
      value: structuredClone(value) as import("@crewon/contracts").JsonValue, valueDigest };
    if (now !== undefined) this.#insertExecutionValue({ ...input,
      valueId: authority.valueId, role: "nodeInput", nodeId: input.nodeId,
      valueDigest, valueJson, now });
    return authority;
  }

  #nodeInputDigest(
    input: { tenantId: string; runId: string },
    workflow: import("@crewon/domain").CompiledWorkflowVersion,
    nodeId: string,
  ): string {
    const root = this.#loadExecutionValue(input.tenantId, input.runId, "rootInput", null);
    const node = workflow.nodes.find((candidate) => candidate.nodeId === nodeId);
    if (root === null || node === undefined)
      throw new RunStoreError("workflow_execution_value_not_found");
    const dependencyOutputs = node.dependsOn.map((dependencyNodeId) => {
      const output = this.#loadExecutionValue(input.tenantId, input.runId,
        "nodeOutput", dependencyNodeId);
      if (output === null) throw new RunStoreError("workflow_execution_value_not_found");
      return { nodeId: dependencyNodeId, value: output.value };
    });
    return this.#digester.sha256(canonicalJson(composeWorkflowNodeInput({
      workflow, nodeId, rootInput: root.value, dependencyOutputs,
    })));
  }

  #loadExecutionValue(tenantId: string, runId: string, role: string, nodeId: string | null) {
    const row = this.#database.prepare(
      `SELECT value_id,value_digest,value_json FROM workflow_execution_values
       WHERE tenant_id=? AND run_id=? AND role=? AND node_id IS ?`,
    ).get(tenantId, runId, role, nodeId) as
      | { value_id: string; value_digest: string; value_json: string }
      | undefined;
    return row === undefined ? null : { valueId: row.value_id,
      valueDigest: row.value_digest, value: JSON.parse(row.value_json) as WorkflowSchemaValue };
  }

  #insertExecutionValue(input: { tenantId: string; runId: string; valueId: string;
    role: string; nodeId: string | null; valueDigest: string; valueJson: string; now: string }): void {
    const existing = this.#database.prepare(
      `SELECT role,node_id,value_digest,value_json FROM workflow_execution_values
       WHERE tenant_id=? AND run_id=? AND value_id=?`,
    ).get(input.tenantId, input.runId, input.valueId) as Record<string, unknown> | undefined;
    if (existing !== undefined) {
      if (existing.role !== input.role || existing.node_id !== input.nodeId ||
          existing.value_digest !== input.valueDigest || existing.value_json !== input.valueJson)
        throw new RunStoreError("workflow_execution_value_conflict");
      return;
    }
    this.#database.prepare(
      `INSERT INTO workflow_execution_values
       (tenant_id,run_id,value_id,role,node_id,value_digest,value_json,created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(input.tenantId, input.runId, input.valueId, input.role, input.nodeId,
      input.valueDigest, input.valueJson, input.now);
  }

  #rootInputRef(input: { tenantId: string; runId: string }) {
    const root = this.#loadExecutionValue(input.tenantId, input.runId, "rootInput", null);
    if (root === null) throw new RunStoreError("workflow_execution_value_not_found");
    return { valueId: root.valueId, valueDigest: root.valueDigest };
  }

  #convergeTerminalRun(
    input: { tenantId: string; runId: string; operationId: string },
    workflow: import("@crewon/domain").CompiledWorkflowVersion,
    execution: import("@crewon/application").WorkflowExecutionState,
    now: string,
    nowMs: number,
  ): import("@crewon/application").WorkflowRunDisposition {
    if (!["completed", "failed", "canceled"].includes(execution.status))
      return "nonTerminal";
    const current = this.#loadRun(input.tenantId, input.runId);
    if (current === null || current.goalBinding !== null)
      throw new RunStoreError("workflow_composition_run_authority_mismatch");
    let outputRef: string | null = null;
    if (execution.status === "completed") {
      const outputValues = workflow.outputNodeIds.map((nodeId) => {
        const authority = this.#loadExecutionValue(input.tenantId, input.runId,
          "nodeOutput", nodeId);
        if (authority === null) throw new RunStoreError("workflow_execution_value_not_found");
        return { nodeId, value: authority.value };
      });
      const value = validateWorkflowSchemaValue(
        composeWorkflowOutput({ workflow, outputValues }), workflow.outputSchema);
      const valueJson = canonicalJson(value);
      const valueDigest = this.#digester.sha256(valueJson);
      outputRef = workflowAuthorityId("value", { tenantId: input.tenantId,
        runId: input.runId, role: "workflowOutput", valueDigest }, this.#digester);
      this.#insertExecutionValue({ ...input, valueId: outputRef,
        role: "workflowOutput", nodeId: null, valueDigest, valueJson, now });
    }
    const eventId = workflowAuthorityId("run-event", input, this.#digester);
    const event = {
      schemaVersion: "crewon.run-event.v0" as const,
      identity: { runId: input.runId }, eventId,
      sequence: current.lastSequence + 1, occurredAt: now,
      ...(execution.status === "completed"
        ? { type: "run.completed" as const, data: { outputRef } }
        : execution.status === "failed"
          ? { type: "run.failed" as const,
              data: { code: "workflow_node_failed", retryable: false } }
          : { type: "run.canceled" as const,
              data: { reasonCode: "workflow_canceled" } }),
    };
    const next = reduceRunLifecycleEvent(current, event);
    const updated = this.#database.prepare(
      `UPDATE run_snapshots SET revision=?,last_sequence=?,state_json=?,updated_at=?
       WHERE tenant_id=? AND run_id=? AND revision=?`,
    ).run(next.revision, next.lastSequence, stableJson(next), now,
      input.tenantId, input.runId, current.revision);
    if (updated.changes !== 1) throw new RunStoreError("revision_conflict");
    this.#database.prepare(
      `INSERT INTO run_events(tenant_id,run_id,sequence,event_id,event_json)
       VALUES (?,?,?,?,?)`,
    ).run(input.tenantId, input.runId, event.sequence, eventId, stableJson(event));
    const messageId = workflowAuthorityId("run-outbox", input, this.#digester);
    const message = { messageId, tenantId: input.tenantId, runId: input.runId,
      topic: "run.updated", payload: { eventId, eventType: event.type,
        throughSequence: event.sequence }, createdAt: now };
    this.#database.prepare(
      `INSERT INTO outbox(message_id,tenant_id,run_id,topic,message_json,created_at,
       status,available_at_ms,lease_epoch,attempt_count)
       VALUES (?,?,?,?,?,?,'pending',?,0,0)`,
    ).run(messageId, input.tenantId, input.runId, message.topic,
      stableJson(message), now, nowMs);
    return "terminalConverged";
  }
}

function executionNode(input: { nodeId: string }, execution: import("@crewon/application").WorkflowExecutionState | null) {
  const node = execution?.nodes.find((candidate) => candidate.nodeId === input.nodeId);
  if (node === undefined) throw new RunStoreError("workflow_execution_not_found");
  return node;
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

function terminalAttempt(
  input: Parameters<WorkflowRunCompositionStore["settleWorkflowNode"]>[0],
  now: string,
) {
  const common = {
    stepId: input.stepId,
    attemptId: input.attemptId,
    finishedAt: now,
    checkpointDigest: null,
  };
  switch (input.outcome.status) {
    case "completed":
      return { ...common, status: "completed" as const };
    case "failed":
      return {
        ...common,
        status: "failed" as const,
        failure: { code: input.outcome.failureCode, retryable: false },
      };
    case "canceled":
      return { ...common, status: "canceled" as const };
    case "unknown":
      throw new RunStoreError("workflow_composition_unknown_not_terminal");
  }
}
