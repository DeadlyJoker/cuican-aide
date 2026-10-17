import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  initialWorkflowExecution,
  planWorkflowNodeClaims,
  projectWorkflowExecution,
  RunStoreError,
  type RunLocator,
  type WorkflowExecutionState,
  type WorkflowNodeAttemptAdmission,
  type WorkflowNodeSettlementStore,
  type WorkflowRunCompositionStore,
  type WorkflowRunFinalizationStore,
  type WorkflowRunCancellationStore,
  type WorkItem,
  type WorkItemLeaseInput,
  type WorkflowHumanGateStore,
  type WorkflowHumanGateReviewStore,
  type WorkflowHumanGateAuthorization,
  type WorkflowSchedulerAuthorization,
  type WorkflowRunSchedulerStore,
} from "@crewon/application";
import {
  composeWorkflowNodeInput,
  parseWorkflowVersionIdentityId,
  type RunState,
} from "@crewon/domain";
import {
  beginSqliteRunAttempt,
  finishSqliteRunAttempt,
} from "./sqlite-execution-authority.ts";
import { migrateSqliteWorkflowComposition } from "./sqlite-workflow-composition-schema.ts";
import { readSqliteWorkflowCompositionContext } from "./sqlite-workflow-composition-context.ts";
import {
  readSqliteWorkflowExecution,
  writeSqliteWorkflowExecution,
} from "./sqlite-workflow-execution-authority.ts";
import {
  insertSqliteWorkflowGate,
  readSqliteWorkflowNodes,
  sqliteWorkflowNodeAdmission,
} from "./sqlite-workflow-node-authority.ts";
import { workflowNodeValue } from "./workflow-node-value.ts";
import {
  readSqliteWorkflowChildren,
  SqliteWorkflowChildDispatcher,
  type SqliteWorkflowChildDispatchOptions,
  type WorkflowChildOperations,
} from "./sqlite-workflow-child-dispatch.ts";
import { reconcileSqliteWorkflowChildren } from "./sqlite-workflow-child-reconciliation.ts";
import { stopSqliteWorkflowFailedSiblings } from "./sqlite-workflow-failure-cancellation.ts";
import { propagateSqliteWorkflowCancellation } from "./sqlite-workflow-cancellation.ts";
import { SqliteWorkflowHumanGates } from "./sqlite-workflow-human-gates.ts";
import { readSqliteWorkflowHumanGates } from "./sqlite-workflow-human-gate-authority.ts";
import {
  authorizeSqliteWorkflowScheduler,
  prepareSqliteWorkflowRun,
  finishSqliteWorkflowSchedulerPass,
} from "./sqlite-workflow-scheduler.ts";
import {
  migrateSqliteWorkflowCancellation,
  assertSqliteWorkflowCancellationSchema,
} from "./sqlite-workflow-cancellation-schema.ts";
import {
  finalizeSqliteWorkflowRoot,
  type WorkflowRootOperations,
} from "./sqlite-workflow-root-finalization.ts";

type AdmitInput = Parameters<
  WorkflowRunCompositionStore["admitWorkflowNodes"]
>[0];
type SettleInput = Parameters<
  WorkflowNodeSettlementStore["settleWorkflowNode"]
>[0];
export type SqliteWorkflowCompositionOptions = Readonly<{
  maximumParallelNodes?: number;
  nextId?: () => string;
  dispatchChildren?: SqliteWorkflowChildDispatchOptions;
  humanGates?: Readonly<{ authorize: WorkflowHumanGateAuthorization }>;
  scheduler?: Readonly<{ authorize: WorkflowSchedulerAuthorization }>;
}>;
type Dependencies = WorkflowChildOperations &
  WorkflowRootOperations & {
    assertOpen(): void;
    now(): number;
    loadRun(input: RunLocator): RunState | null;
    validateLease(
      input: RunLocator & { lease: WorkItemLeaseInput },
      now: number,
    ): number;
    enqueue(input: WorkItem): void;
  };

/** Experimental until Worker node dispatch, recovery, gates and writer fencing are composed. */
export class ExperimentalSqliteWorkflowRunCompositionStore
  implements
    WorkflowRunCompositionStore,
    WorkflowNodeSettlementStore,
    WorkflowRunFinalizationStore,
    WorkflowRunCancellationStore,
    WorkflowHumanGateStore,
    WorkflowHumanGateReviewStore,
    WorkflowRunSchedulerStore
{
  readonly #database: DatabaseSync;
  readonly #dependencies: Dependencies;
  readonly #maximumParallelNodes: number;
  readonly #id: () => string;
  readonly #children: SqliteWorkflowChildDispatcher | null;
  readonly #gates: SqliteWorkflowHumanGates | null;
  readonly #scheduler: WorkflowSchedulerAuthorization | null;

  constructor(
    database: DatabaseSync,
    dependencies: Dependencies,
    options: SqliteWorkflowCompositionOptions = {},
  ) {
    const maximum = options.maximumParallelNodes ?? 4;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 4)
      throw new RunStoreError("workflow_parallelism_invalid");
    if (options.humanGates && !options.dispatchChildren)
      throw new RunStoreError("workflow_gate_children_required");
    if (
      options.scheduler &&
      (!options.dispatchChildren ||
        typeof options.scheduler.authorize !== "function")
    )
      throw new RunStoreError("workflow_scheduler_configuration_invalid");
    dependencies.assertOpen();
    migrateSqliteWorkflowComposition(database);
    migrateSqliteWorkflowCancellation(database);
    this.#children = options.dispatchChildren
      ? new SqliteWorkflowChildDispatcher(
          database,
          dependencies,
          options.dispatchChildren,
        )
      : null;
    this.#database = database;
    this.#dependencies = dependencies;
    this.#maximumParallelNodes = maximum;
    this.#scheduler = options.scheduler?.authorize ?? null;
    this.#id = () =>
      parseWorkflowVersionIdentityId(
        (options.nextId ?? randomUUID)(),
        "workflow_generated_id_invalid",
      );
    this.#gates = options.humanGates
      ? new SqliteWorkflowHumanGates(
          database,
          dependencies,
          options.humanGates.authorize,
          this.#id,
        )
      : null;
  }

  async admitWorkflowNodes(input: AdmitInput) {
    this.#dependencies.assertOpen();
    validateInput(input);
    const db = this.#database;
    db.exec("BEGIN IMMEDIATE");
    try {
      assertSqliteWorkflowCancellationSchema(db);
      const now = this.#dependencies.now();
      const leaseExpiry = this.#dependencies.validateLease(input, now);
      const run = this.#runningRun(input);
      const context = readSqliteWorkflowCompositionContext(db, {
        ...input,
        run,
      });
      if (this.#scheduler)
        authorizeSqliteWorkflowScheduler(
          this.#scheduler,
          run,
          context.workItem,
        );
      let current = readSqliteWorkflowExecution(db, input);
      const existed = current !== null;
      if (current === null) {
        current = initialWorkflowExecution({
          ...input,
          workflow: context.workflow,
          now: iso(now),
        });
        writeSqliteWorkflowExecution(db, null, current);
      }
      this.#binding(current, input.binding);
      this.#children?.assertSchema();
      const children = readSqliteWorkflowChildren(
        db,
        current,
        run,
        this.#dependencies.loadRun,
      );
      if (children.size > 0 && !this.#children)
        throw new RunStoreError("workflow_child_dispatch_unavailable");
      if (
        this.#children &&
        current.nodes.some(
          (node) =>
            node.kind !== "humanGate" &&
            node.claimId !== null &&
            !children.has(node.claimId),
        )
      )
        throw new RunStoreError("workflow_child_handoff_missing");
      const hasGates = current.nodes.some(
        (node) => node.kind === "humanGate" && node.claimId !== null,
      );
      if (this.#children && hasGates && !this.#gates)
        throw new RunStoreError("workflow_gate_unavailable");
      readSqliteWorkflowHumanGates(db, current, run, context, {
        requirePublishedGates: this.#gates !== null,
      });
      if (this.#children && children.size > 0)
        current = reconcileSqliteWorkflowChildren(db, {
          parent: run,
          state: current,
          children,
          context,
          loadRun: this.#dependencies.loadRun,
          now: iso(now),
        });
      if (this.#children && children.size > 0)
        current = stopSqliteWorkflowFailedSiblings(
          db,
          {
            parent: run,
            state: current,
            workflow: context.workflow,
            children,
            now: iso(now),
            nextId: this.#id,
          },
          this.#dependencies,
        );
      const rows = readSqliteWorkflowNodes(db, current, context.workflow);
      if (existed && rows.size === 0)
        throw new RunStoreError("workflow_composition_authority_missing");
      const fingerprint = canonicalJson({
        kind: "workflow.node-admission.v1",
        tenantId: input.tenantId,
        runId: input.runId,
        binding: input.binding,
        workItemId: input.lease.workItemId,
        leaseDurationMs: input.leaseDurationMs,
      });
      const prior = db
        .prepare(
          `SELECT work_item_id,
        CASE WHEN length(CAST(fingerprint AS BLOB))<=4096 THEN fingerprint ELSE NULL END AS fingerprint,
        CASE WHEN length(CAST(node_ids_json AS BLOB))<=65536 THEN node_ids_json ELSE NULL END AS node_ids_json
        FROM workflow_node_passes WHERE tenant_id=? AND run_id=? AND operation_id=?`,
        )
        .get(input.tenantId, input.runId, input.schedulerOperationId) as
        | {
            work_item_id: string;
            fingerprint: string | null;
            node_ids_json: string | null;
          }
        | undefined;
      if (
        prior &&
        (prior.fingerprint !== fingerprint ||
          prior.work_item_id !== input.lease.workItemId)
      )
        throw new RunStoreError("workflow_composition_idempotency_conflict");
      const lost = new Set<string>();
      for (const row of rows.values()) {
        // Validate both halves of the persisted execution identity before returning any admission.
        sqliteWorkflowNodeAdmission(db, current, context.workflow, row);
        if (
          row.queue_status !== "leased" ||
          row.queue_epoch !== row.lease_epoch ||
          (row.queue_expires ?? 0) <= now
        )
          lost.add(row.claim_id);
      }
      const inputs = new Map<string, ReturnType<typeof workflowNodeValue>>();
      const active = current.nodes.filter(
        (node) => node.status === "running" || node.status === "unknown",
      ).length;
      const plan = planWorkflowNodeClaims({
        current,
        workflow: context.workflow,
        now: iso(now),
        expiresAt: iso(Math.min(leaseExpiry, now + input.leaseDurationMs)),
        operationId: input.schedulerOperationId,
        maximumClaims: prior
          ? 0
          : Math.max(0, this.#maximumParallelNodes - active),
        lostClaimIds: lost,
        delegatedClaimIds: new Set(children.keys()),
        nextId: this.#id,
        inputDigest: (node) => {
          const value = workflowNodeValue(
            composeWorkflowNodeInput({
              workflow: context.workflow,
              nodeId: node.nodeId,
              rootInput: context.rootInput.value,
              dependencyOutputs: node.dependsOn.map((nodeId) => {
                const dependency = rows.get(nodeId);
                if (!dependency?.output_json)
                  throw new RunStoreError("workflow_dependency_output_missing");
                return { nodeId, value: JSON.parse(dependency.output_json) };
              }),
            }),
            node.inputSchema,
          );
          inputs.set(node.nodeId, value);
          return value.digest;
        },
      });
      const next = plan.next;
      if (next !== current) writeSqliteWorkflowExecution(db, current, next);
      const admissions: WorkflowNodeAttemptAdmission[] = [];
      for (const claim of plan.claims) {
        const value = inputs.get(claim.node.nodeId)!;
        const stepId = this.#id();
        const execution =
          claim.node.kind === "humanGate"
            ? {
                step: insertSqliteWorkflowGate(db, {
                  ...input,
                  stepId,
                  now: iso(now),
                }),
                attempt: null,
              }
            : beginSqliteRunAttempt(db, {
                ...input,
                stepId,
                kind:
                  claim.node.kind === "verification"
                    ? "verification"
                    : "workflowNode",
                attemptId: this.#id(),
                startedAt: iso(now),
              });
        db.prepare(
          `INSERT INTO workflow_node_admissions
          (tenant_id,run_id,node_id,claim_id,step_id,attempt_id,work_item_id,lease_epoch,operation_id,input_digest,input_json)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          input.tenantId,
          input.runId,
          claim.node.nodeId,
          claim.claimId,
          stepId,
          execution.attempt?.attemptId ?? null,
          input.lease.workItemId,
          input.lease.leaseEpoch,
          input.schedulerOperationId,
          value.digest,
          value.json,
        );
        admissions.push({
          claim,
          step: execution.step,
          attempt: execution.attempt,
        });
      }
      if (plan.claims.length > 0) {
        db.prepare(
          "INSERT INTO workflow_node_passes (tenant_id,run_id,operation_id,work_item_id,fingerprint,node_ids_json) VALUES (?,?,?,?,?,?)",
        ).run(
          input.tenantId,
          input.runId,
          input.schedulerOperationId,
          input.lease.workItemId,
          fingerprint,
          canonicalJson(plan.claims.map((claim) => claim.node.nodeId)),
        );
      } else if (prior) {
        if (prior.node_ids_json === null)
          throw new RunStoreError("workflow_composition_receipt_invalid");
        const nodeIds: unknown = JSON.parse(prior.node_ids_json);
        if (
          !Array.isArray(nodeIds) ||
          nodeIds.length > 4 ||
          new Set(nodeIds).size !== nodeIds.length
        )
          throw new RunStoreError("workflow_composition_receipt_invalid");
        for (const id of nodeIds) {
          const row = rows.get(id),
            state = next.nodes.find((node) => node.nodeId === id);
          if (!row || !state || row.operation_id !== input.schedulerOperationId)
            throw new RunStoreError("workflow_composition_receipt_invalid");
          if (children.has(row.claim_id)) continue;
          if (state.kind === "humanGate" && this.#gates) continue;
          if (state.status === "running" || state.status === "waitingHuman") {
            if (row.lease_epoch !== input.lease.leaseEpoch) continue;
            admissions.push(
              sqliteWorkflowNodeAdmission(db, next, context.workflow, row),
            );
          }
        }
      }
      this.#dependencies.validateLease(input, this.#dependencies.now());
      if (
        admissions.some(
          ({ claim }) =>
            claim.node.kind !== "humanGate" &&
            Date.parse(
              next.nodes.find((node) => node.nodeId === claim.node.nodeId)!
                .leaseExpiresAt!,
            ) <= this.#dependencies.now(),
        )
      )
        throw new RunStoreError("workflow_node_lease_expired");
      if (this.#children && plan.claims.length > 0) {
        if (
          plan.claims.some((claim) => claim.node.kind === "humanGate") &&
          !this.#gates
        )
          throw new RunStoreError("workflow_child_gate_unsupported");
        this.#gates?.publish({ parent: run, state: next, context, admissions });
        this.#children.dispatch({
          parent: run,
          context,
          state: next,
          admissions: admissions.filter(
            (admission) => admission.claim.node.kind !== "humanGate",
          ),
          now: iso(now),
          nextId: this.#id,
        });
        this.#dependencies.validateLease(input, this.#dependencies.now());
        // The child queue owns execution now. Do not return a second dispatch permission.
        admissions.length = 0;
      }
      db.exec("COMMIT");
      return structuredClone({ execution: next, admissions });
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  async prepareWorkflowRun(
    input: Parameters<WorkflowRunSchedulerStore["prepareWorkflowRun"]>[0],
  ) {
    return this.#schedulerTransaction(() =>
      prepareSqliteWorkflowRun(
        this.#database,
        input,
        this.#dependencies,
        this.#schedulerOptions(),
      ),
    );
  }

  async finishWorkflowSchedulerPass(
    input: Parameters<
      WorkflowRunSchedulerStore["finishWorkflowSchedulerPass"]
    >[0],
  ) {
    return this.#schedulerTransaction(() =>
      finishSqliteWorkflowSchedulerPass(
        this.#database,
        input,
        this.#dependencies,
        this.#schedulerOptions(),
      ),
    );
  }

  #schedulerOptions() {
    if (!this.#scheduler || !this.#children)
      throw new RunStoreError("workflow_scheduler_unavailable");
    return {
      authorize: this.#scheduler,
      maximumParallelNodes: this.#maximumParallelNodes,
      humanGatesEnabled: this.#gates !== null,
      nextId: this.#id,
    };
  }

  #schedulerTransaction<T>(operation: () => T): T {
    this.#dependencies.assertOpen();
    this.#schedulerOptions();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      assertSqliteWorkflowCancellationSchema(this.#database);
      this.#children!.assertSchema();
      const result = operation();
      this.#database.exec("COMMIT");
      return structuredClone(result);
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  async loadWorkflowHumanGateReview(
    input: Parameters<
      WorkflowHumanGateReviewStore["loadWorkflowHumanGateReview"]
    >[0],
  ) {
    if (!this.#gates) throw new RunStoreError("workflow_gate_unavailable");
    return this.#gates.loadWorkflowHumanGateReview(input);
  }
  async reviewWorkflowHumanGate(
    input: Parameters<
      WorkflowHumanGateReviewStore["reviewWorkflowHumanGate"]
    >[0],
  ) {
    if (!this.#gates) throw new RunStoreError("workflow_gate_unavailable");
    return this.#gates.reviewWorkflowHumanGate(input);
  }
  async loadWorkflowHumanGate(
    input: Parameters<WorkflowHumanGateStore["loadWorkflowHumanGate"]>[0],
  ) {
    if (!this.#gates) throw new RunStoreError("workflow_gate_unavailable");
    return this.#gates.loadWorkflowHumanGate(input);
  }
  async decideWorkflowHumanGate(
    input: Parameters<WorkflowHumanGateStore["decideWorkflowHumanGate"]>[0],
  ) {
    if (!this.#gates) throw new RunStoreError("workflow_gate_unavailable");
    return this.#gates.decideWorkflowHumanGate(input);
  }

  async finalizeWorkflowRun(
    input: Parameters<WorkflowRunFinalizationStore["finalizeWorkflowRun"]>[0],
  ) {
    this.#dependencies.assertOpen();
    for (const id of [input.tenantId, input.runId, input.schedulerOperationId])
      parseWorkflowVersionIdentityId(id, "workflow_composition_input_invalid");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      assertSqliteWorkflowCancellationSchema(this.#database);
      this.#children?.assertSchema();
      const result = finalizeSqliteWorkflowRoot(
        this.#database,
        input,
        this.#dependencies,
        {
          childrenEnabled: this.#children !== null,
          humanGatesEnabled: this.#gates !== null,
          nextId: this.#id,
        },
      );
      this.#database.exec("COMMIT");
      return structuredClone(result);
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  async propagateWorkflowCancellation(
    input: Parameters<
      WorkflowRunCancellationStore["propagateWorkflowCancellation"]
    >[0],
  ) {
    this.#dependencies.assertOpen();
    for (const id of [input.tenantId, input.runId, input.schedulerOperationId])
      parseWorkflowVersionIdentityId(id, "workflow_composition_input_invalid");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      assertSqliteWorkflowCancellationSchema(this.#database);
      this.#children?.assertSchema();
      const result = propagateSqliteWorkflowCancellation(
        this.#database,
        input,
        this.#dependencies,
        {
          childrenEnabled: this.#children !== null,
          humanGatesEnabled: this.#gates !== null,
          nextId: this.#id,
        },
      );
      this.#database.exec("COMMIT");
      return structuredClone(result);
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  async settleWorkflowNode(
    input: SettleInput,
  ): Promise<WorkflowExecutionState> {
    this.#dependencies.assertOpen();
    for (const id of [input.tenantId, input.runId, input.nodeId, input.claimId])
      parseWorkflowVersionIdentityId(id, "workflow_settlement_input_invalid");
    const db = this.#database;
    db.exec("BEGIN IMMEDIATE");
    try {
      const run = this.#dependencies.loadRun(input);
      if (!run) throw new RunStoreError("run_not_found");
      const context = readSqliteWorkflowCompositionContext(db, {
        ...input,
        run,
      });
      const current = readSqliteWorkflowExecution(db, input);
      if (!current) throw new RunStoreError("workflow_execution_not_found");
      this.#binding(current, input.binding);
      const rows = readSqliteWorkflowNodes(db, current, context.workflow),
        row = rows.get(input.nodeId);
      const node = current.nodes.find((value) => value.nodeId === input.nodeId);
      if (!node || !row || node.claimId !== input.claimId)
        throw new RunStoreError("workflow_node_claim_stale");
      if (
        readSqliteWorkflowChildren(
          db,
          current,
          run,
          this.#dependencies.loadRun,
        ).has(input.claimId)
      )
        throw new RunStoreError("workflow_child_settlement_required");
      if (node.kind === "humanGate")
        throw new RunStoreError("workflow_human_gate_decision_required");
      const definition = context.workflow.nodes.find(
        (value) => value.nodeId === input.nodeId,
      )!;
      const outcomeKeys = Object.keys(input.outcome).sort().join(",");
      if (
        outcomeKeys !==
        (input.outcome.status === "completed"
          ? "status,value"
          : input.outcome.status === "failed"
            ? "failureCode,status"
            : "status")
      )
        throw new RunStoreError("workflow_node_outcome_invalid");
      let value: ReturnType<typeof workflowNodeValue> | null = null;
      if (input.outcome.status === "completed")
        value = workflowNodeValue(input.outcome.value, definition.outputSchema);
      else if (input.outcome.status === "failed")
        parseWorkflowVersionIdentityId(
          input.outcome.failureCode,
          "workflow_failure_code_invalid",
        );
      else if (input.outcome.status !== "canceled")
        throw new RunStoreError("workflow_node_outcome_invalid");
      const fingerprint = canonicalJson({
        kind: "workflow.node-settle.v1",
        nodeId: node.nodeId,
        claimId: node.claimId,
        outcome:
          input.outcome.status === "completed"
            ? { status: "completed", digest: value!.digest }
            : input.outcome,
      });
      if (row.settlement_fingerprint !== null) {
        if (row.settlement_fingerprint !== fingerprint)
          throw new RunStoreError("workflow_node_settlement_conflict");
        sqliteWorkflowNodeAdmission(db, current, context.workflow, row);
        db.exec("COMMIT");
        return current;
      }
      const now = this.#dependencies.now();
      this.#dependencies.validateLease(input, now);
      this.#runningRun(input);
      if (
        node.status !== "running" ||
        Date.parse(node.leaseExpiresAt!) <= now ||
        row.work_item_id !== input.lease.workItemId ||
        row.lease_epoch !== input.lease.leaseEpoch
      )
        throw new RunStoreError("workflow_node_recovery_required");
      const admission = sqliteWorkflowNodeAdmission(
        db,
        current,
        context.workflow,
        row,
      );
      finishSqliteRunAttempt(db, {
        tenantId: input.tenantId,
        runId: input.runId,
        workItemId: input.lease.workItemId,
        leaseEpoch: input.lease.leaseEpoch,
        attempt: {
          stepId: admission.step.stepId,
          attemptId: admission.attempt!.attemptId,
          finishedAt: iso(now),
          checkpointDigest: null,
          ...(input.outcome.status === "failed"
            ? {
                status: "failed",
                failure: { code: input.outcome.failureCode, retryable: false },
              }
            : { status: input.outcome.status }),
        },
      });
      const settled = {
        ...node,
        status: input.outcome.status,
        leaseExpiresAt: null,
        resultDigest: value?.digest ?? null,
        failureCode:
          input.outcome.status === "failed" ? input.outcome.failureCode : null,
      };
      const next = projectWorkflowExecution(
        current,
        current.nodes.map((candidate) =>
          candidate.nodeId === node.nodeId ? settled : candidate,
        ),
        iso(now),
      );
      writeSqliteWorkflowExecution(db, current, next);
      const updated = db
        .prepare(
          "UPDATE workflow_node_admissions SET output_digest=?,output_json=?,settlement_fingerprint=? WHERE tenant_id=? AND run_id=? AND node_id=? AND settlement_fingerprint IS NULL",
        )
        .run(
          value?.digest ?? null,
          value?.json ?? null,
          fingerprint,
          input.tenantId,
          input.runId,
          input.nodeId,
        );
      if (updated.changes !== 1)
        throw new RunStoreError("workflow_node_settlement_conflict");
      this.#dependencies.enqueue({
        ...context.workItem,
        workItemId: this.#id(),
        createdAt: iso(now),
        payload: {
          ...context.workItem.payload,
          schedulerOperationId: this.#id(),
        },
      });
      this.#dependencies.validateLease(input, this.#dependencies.now());
      db.exec("COMMIT");
      return next;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  #runningRun(input: RunLocator): RunState {
    const run = this.#dependencies.loadRun(input);
    if (!run || run.status !== "running" || run.cancelRequested)
      throw new RunStoreError("workflow_run_not_executable");
    return run;
  }

  #binding(state: WorkflowExecutionState, binding: AdmitInput["binding"]) {
    if (
      state.workflowId !== binding.workflowId ||
      state.workflowVersionId !== binding.workflowVersionId ||
      state.contentDigest !== binding.contentDigest
    )
      throw new RunStoreError("workflow_execution_binding_mismatch");
  }
}

function validateInput(input: AdmitInput): void {
  for (const value of [input.tenantId, input.runId, input.schedulerOperationId])
    parseWorkflowVersionIdentityId(value, "workflow_composition_input_invalid");
  if (
    !Number.isSafeInteger(input.leaseDurationMs) ||
    input.leaseDurationMs < 1 ||
    input.leaseDurationMs > 300000
  )
    throw new RunStoreError("workflow_lease_duration_invalid");
}
function iso(now: number) {
  return new Date(now).toISOString();
}
