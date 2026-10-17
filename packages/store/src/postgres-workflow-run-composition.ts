import { migratePostgresWorkflowCancellation } from "./postgres-workflow-cancellation-schema.ts";
import { propagatePostgresWorkflowCancellation } from "./postgres-workflow-cancellation.ts";
import {
  withPostgresWorkflowTransaction,
  type WorkflowTransactionCallback,
  type WorkflowTransactionMode,
} from "./postgres-workflow-transaction.ts";
import {
  PostgresWorkflowHumanGates,
  insertPostgresWorkflowGate,
  publishPostgresWorkflowGates,
  type PostgresWorkflowHumanGateAuthorization,
} from "./postgres-workflow-human-gates.ts";
import { migratePostgresWorkflowHumanGates } from "./postgres-workflow-human-gate-schema.ts";
import { readPostgresWorkflowHumanGates } from "./postgres-workflow-human-gate-authority.ts";
import { stopPostgresWorkflowFailedSiblings } from "./postgres-workflow-failure-cancellation.ts";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  RunStoreError,
  canonicalJson,
  initialWorkflowExecution,
  planWorkflowNodeClaims,
  type AuthorizationDecision,
  type CommitRunInput,
  type CommitRunResult,
  type RunLocator,
  type ThreadLocator,
  type CommitThreadInput,
  type CommitThreadResult,
  type WorkflowRunCompositionStore,
  type WorkflowRunFinalizationStore,
  type WorkflowHumanGateStore,
  type WorkflowHumanGateReviewStore,
  type WorkflowRunSchedulerStore,
  type WorkflowSchedulerPassResult,
  type WorkflowSchedulerInput,
  type WorkflowNodeAttemptAdmission,
  type WorkItem,
} from "@crewon/application";
import {
  composeWorkflowNodeInput,
  parseWorkflowVersionIdentityId,
  type RunState,
  type ThreadState,
} from "@crewon/domain";
import { validatePostgresSchemaName } from "./postgres-queue-schema.ts";
import {
  normalizePostgresError,
  rollbackPostgres,
} from "./postgres-store-support.ts";
import { assertPostgresProviderSettingsAdmissionOpen } from "./postgres-model-provider-settings-store.ts";
import { migratePostgresWorkflowComposition } from "./postgres-workflow-composition-schema.ts";
import { readPostgresWorkflowCompositionContext } from "./postgres-workflow-composition-context.ts";
import {
  readPostgresWorkflowExecution,
  writePostgresWorkflowExecution,
} from "./postgres-workflow-execution-authority.ts";
import {
  readPostgresWorkflowNodes,
  postgresWorkflowNodeAdmission,
} from "./postgres-workflow-node-authority.ts";
import {
  readPostgresWorkflowChildren,
  dispatchPostgresWorkflowChildren,
  type PostgresWorkflowChildOperations,
  type PostgresWorkflowChildRoute,
} from "./postgres-workflow-children.ts";
import { workflowNodeValue } from "./workflow-node-value.ts";
import { beginPostgresRunAttempt } from "./postgres-execution-authority.ts";
import { reconcilePostgresWorkflowChildren } from "./postgres-workflow-child-reconciliation.ts";
import { finalizePostgresWorkflowRoot } from "./postgres-workflow-root-finalization.ts";
import { finishPostgresWorkflowSchedulerPass } from "./postgres-workflow-scheduler.ts";

type AdmitInput = Parameters<
  WorkflowRunCompositionStore["admitWorkflowNodes"]
>[0];
export type PostgresWorkflowCompositionOptions = Readonly<{
  maximumParallelNodes?: number;
  nextId?: () => string;
  /** Current server authority only. Use this transaction's client for durable policy reads. */
  authorize(input: {
    client: PoolClient;
    run: RunState;
    workItem: WorkItem;
  }): AuthorizationDecision | Promise<AuthorizationDecision>;
  resolveChildRoute: PostgresWorkflowChildRoute;
  humanGates?: Readonly<{ authorize: PostgresWorkflowHumanGateAuthorization }>;
}>;
export type PostgresWorkflowCompositionDependencies =
  PostgresWorkflowChildOperations &
    Readonly<{
      assertOpen(): void;
      loadRoot(client: PoolClient, input: RunLocator): Promise<RunState | null>;
      loadRootThread(
        client: PoolClient,
        input: ThreadLocator,
      ): Promise<ThreadState | null>;
      commitRootThread(
        client: PoolClient,
        input: CommitThreadInput,
      ): Promise<CommitThreadResult>;
      settleRootWork(
        client: PoolClient,
        input: WorkflowSchedulerInput,
      ): Promise<void>;
      validateLease(
        client: PoolClient,
        input: WorkflowSchedulerInput,
      ): Promise<{ now: number; expiresAt: number }>;
      commitRoot(
        client: PoolClient,
        input: CommitRunInput,
        lease: WorkflowSchedulerInput["lease"],
      ): Promise<CommitRunResult>;
    }>;

/** Experimental persistent execution. Human decisions require explicit policy; production routing remains off. */
export class ExperimentalPostgresWorkflowRunCompositionStore
  implements
    WorkflowRunSchedulerStore,
    WorkflowHumanGateStore,
    WorkflowHumanGateReviewStore
{
  readonly #pool: Pool;
  readonly #schema: string;
  readonly #sql: string;
  readonly #d: PostgresWorkflowCompositionDependencies;
  readonly #options: PostgresWorkflowCompositionOptions;
  readonly #maximum: number;
  readonly #id: () => string;
  readonly #gates: PostgresWorkflowHumanGates | null;
  constructor(
    pool: Pool,
    schema: string,
    dependencies: PostgresWorkflowCompositionDependencies,
    options: PostgresWorkflowCompositionOptions,
  ) {
    validatePostgresSchemaName(schema);
    if (
      !options ||
      typeof options.authorize !== "function" ||
      typeof options.resolveChildRoute !== "function" ||
      (options.humanGates !== undefined &&
        typeof options.humanGates?.authorize !== "function") ||
      (options.nextId !== undefined && typeof options.nextId !== "function")
    )
      throw new RunStoreError("workflow_scheduler_configuration_invalid");
    const maximum = options.maximumParallelNodes ?? 4;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 4)
      throw new RunStoreError("workflow_parallelism_invalid");
    dependencies.assertOpen();
    this.#pool = pool;
    this.#schema = schema;
    this.#sql = `"${schema}"`;
    this.#d = dependencies;
    this.#options = options;
    this.#maximum = maximum;
    this.#id = () =>
      parseWorkflowVersionIdentityId(
        (options.nextId ?? randomUUID)(),
        "workflow_generated_id_invalid",
      );
    this.#gates = options.humanGates
      ? new PostgresWorkflowHumanGates(
          pool,
          this.#sql,
          dependencies,
          options.humanGates.authorize,
          this.#id,
        )
      : null;
  }
  async migrate(): Promise<void> {
    this.#d.assertOpen();
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await migratePostgresWorkflowComposition(client, this.#schema);
      if (this.#gates)
        await migratePostgresWorkflowHumanGates(client, this.#schema);
      await migratePostgresWorkflowCancellation(client, this.#schema);
      await client.query("COMMIT");
    } catch (error) {
      await rollbackPostgres(client);
      throw normalizePostgresError(error);
    } finally {
      client.release();
    }
  }
  async prepareWorkflowRun(input: WorkflowSchedulerInput): Promise<RunState> {
    return this.#transaction(input, async (client, run, context, time) => {
      if (terminal(run.status) || run.cancelRequested) return run;
      if (run.status !== "queued" && run.status !== "running")
        throw new RunStoreError("workflow_root_state_invalid");
      await this.#authorize(client, run, context.workItem);
      if (run.status === "running") return run;
      const now = new Date(time.now).toISOString();
      const event = {
        schemaVersion: "crewon.run-event.v0" as const,
        identity: { runId: run.runId },
        eventId: this.#id(),
        sequence: run.lastSequence + 1,
        occurredAt: now,
        type: "run.started" as const,
        data: {},
      };
      const idempotency = {
        scope: canonicalJson({
          namespace: "workflow.scheduler-start.v1",
          tenantId: run.tenantId,
        }),
        key: run.runId,
        requestFingerprint: canonicalJson(run.workflowVersionBinding),
      };
      const reservation = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired",
        [`idempotency:${idempotency.scope}:${idempotency.key}`],
      );
      if (reservation.rows[0]?.acquired !== true)
        throw new RunStoreError("postgres_retryable");
      const result = await this.#d.commitRoot(
        client,
        {
          tenantId: run.tenantId,
          expectedRevision: run.revision,
          idempotency,
          events: [event],
          workItems: [],
          outbox: [
            {
              messageId: this.#id(),
              tenantId: run.tenantId,
              runId: run.runId,
              topic: "run.updated",
              payload: {
                eventId: event.eventId,
                eventType: event.type,
                throughSequence: event.sequence,
              },
              createdAt: now,
            },
          ],
        },
        input.lease,
      );
      if (result.disposition !== "committed")
        throw new RunStoreError("workflow_scheduler_start_conflict");
      return result.state;
    });
  }
  async admitWorkflowNodes(input: AdmitInput) {
    if (
      !Number.isSafeInteger(input.leaseDurationMs) ||
      input.leaseDurationMs < 1 ||
      input.leaseDurationMs > 300000
    )
      throw new RunStoreError("workflow_lease_duration_invalid");
    return this.#transaction(input, async (client, run, context, time) => {
      if (run.status !== "running" || run.cancelRequested)
        throw new RunStoreError("workflow_run_not_executable");
      await this.#authorize(client, run, context.workItem);
      await assertPostgresProviderSettingsAdmissionOpen(
        client,
        this.#sql,
        run.tenantId,
      );
      let current = await readPostgresWorkflowExecution(
        client,
        this.#sql,
        input,
      );
      const existed = current !== null;
      if (!current) {
        current = initialWorkflowExecution({
          ...input,
          workflow: context.workflow,
          now: new Date(time.now).toISOString(),
        });
        await writePostgresWorkflowExecution(client, this.#sql, null, current);
      }
      if (
        current.workflowId !== input.binding.workflowId ||
        current.workflowVersionId !== input.binding.workflowVersionId ||
        current.contentDigest !== input.binding.contentDigest
      )
        throw new RunStoreError("workflow_execution_binding_mismatch");
      let rows = await readPostgresWorkflowNodes(
        client,
        this.#sql,
        current,
        context.workflow,
      );
      if (existed && rows.size === 0)
        throw new RunStoreError("workflow_composition_authority_missing");
      const children = await readPostgresWorkflowChildren(
        client,
        this.#sql,
        current,
        run,
        context,
        this.#d,
      );
      const existingAdmissions = new Map<
        string,
        WorkflowNodeAttemptAdmission
      >();
      for (const row of rows.values()) {
        existingAdmissions.set(
          row.node_id,
          await postgresWorkflowNodeAdmission(
            client,
            this.#sql,
            current,
            context.workflow,
            row,
          ),
        );
        const node = current.nodes.find((n) => n.nodeId === row.node_id)!;
        if (node.kind === "humanGate") {
          if (!this.#gates)
            throw new RunStoreError("workflow_gate_unavailable");
          continue;
        }
        if (!children.has(row.claim_id))
          throw new RunStoreError("workflow_child_handoff_missing");
      }
      await readPostgresWorkflowHumanGates(
        client,
        this.#sql,
        current,
        run,
        context,
        this.#gates !== null,
      );
      if (children.size) {
        const reconciled = await reconcilePostgresWorkflowChildren(
          client,
          this.#sql,
          {
            parent: run,
            state: current,
            rows,
            admissions: existingAdmissions,
            children,
            now: new Date(time.now).toISOString(),
          },
        );
        if (reconciled !== current)
          rows = await readPostgresWorkflowNodes(
            client,
            this.#sql,
            reconciled,
            context.workflow,
          );
        current = reconciled;
      }
      const stopped = await stopPostgresWorkflowFailedSiblings(
        client,
        this.#sql,
        {
          parent: run,
          state: current,
          workflow: context.workflow,
          children,
          now: new Date(time.now).toISOString(),
          nextId: this.#id,
        },
        this.#d,
      );
      if (stopped !== current)
        rows = await readPostgresWorkflowNodes(
          client,
          this.#sql,
          stopped,
          context.workflow,
        );
      current = stopped;
      const fingerprint = canonicalJson({
        kind: "workflow.node-admission.v1",
        tenantId: input.tenantId,
        runId: input.runId,
        binding: input.binding,
        workItemId: input.lease.workItemId,
        leaseDurationMs: input.leaseDurationMs,
      });
      const result = await client.query<{
        work_item_id: string;
        fingerprint: string | null;
        ids: unknown;
      }>(
        `SELECT work_item_id,CASE WHEN octet_length(fingerprint)<=4096 THEN fingerprint ELSE NULL END AS fingerprint,
         CASE WHEN octet_length(node_ids_json::text)<=65536 THEN node_ids_json ELSE NULL END AS ids
         FROM ${this.#sql}.workflow_node_passes WHERE tenant_id=$1 AND run_id=$2 AND operation_id=$3`,
        [input.tenantId, input.runId, input.schedulerOperationId],
      );
      const prior = result.rows[0];
      if (
        prior &&
        (prior.work_item_id !== input.lease.workItemId ||
          prior.fingerprint !== fingerprint)
      )
        throw new RunStoreError("workflow_composition_idempotency_conflict");
      if (prior) {
        if (
          !Array.isArray(prior.ids) ||
          prior.ids.length > 4 ||
          new Set(prior.ids).size !== prior.ids.length ||
          prior.ids.some(
            (id) =>
              typeof id !== "string" ||
              rows.get(id)?.operation_id !== input.schedulerOperationId,
          )
        )
          throw new RunStoreError("workflow_composition_receipt_invalid");
      }
      const values = new Map<string, ReturnType<typeof workflowNodeValue>>();
      const active = current.nodes.filter(
        (n) => n.status === "running" || n.status === "unknown",
      ).length;
      const plan = planWorkflowNodeClaims({
        current,
        workflow: context.workflow,
        now: new Date(time.now).toISOString(),
        expiresAt: new Date(
          Math.min(time.expiresAt, time.now + input.leaseDurationMs),
        ).toISOString(),
        operationId: input.schedulerOperationId,
        maximumClaims: prior ? 0 : Math.max(0, this.#maximum - active),
        lostClaimIds: new Set(),
        delegatedClaimIds: new Set(children.keys()),
        nextId: this.#id,
        inputDigest: (node) => {
          const value = workflowNodeValue(
            composeWorkflowNodeInput({
              workflow: context.workflow,
              nodeId: node.nodeId,
              rootInput: context.rootInput.value,
              dependencyOutputs: node.dependsOn.map((id) => {
                const row = rows.get(id);
                if (!row?.output_json)
                  throw new RunStoreError("workflow_dependency_output_missing");
                return { nodeId: id, value: JSON.parse(row.output_json) };
              }),
            }),
            node.inputSchema,
          );
          values.set(node.nodeId, value);
          return value.digest;
        },
      });
      if (
        !this.#gates &&
        plan.claims.some((claim) => claim.node.kind === "humanGate")
      )
        throw new RunStoreError("workflow_gate_unavailable");
      if (plan.next !== current)
        await writePostgresWorkflowExecution(
          client,
          this.#sql,
          current,
          plan.next,
        );
      const admissions: WorkflowNodeAttemptAdmission[] = [];
      const now = new Date(time.now).toISOString();
      for (const claim of plan.claims) {
        const value = values.get(claim.node.nodeId)!;
        const stepId = this.#id();
        const execution =
          claim.node.kind === "humanGate"
            ? {
                step: await insertPostgresWorkflowGate(client, this.#sql, {
                  ...input,
                  stepId,
                  now,
                }),
                attempt: null,
              }
            : await beginPostgresRunAttempt(client, this.#sql, {
                ...input,
                stepId,
                attemptId: this.#id(),
                kind:
                  claim.node.kind === "verification"
                    ? "verification"
                    : "workflowNode",
                startedAt: now,
              });
        await client.query(
          `INSERT INTO ${this.#sql}.workflow_node_admissions
          (tenant_id,run_id,node_id,claim_id,step_id,attempt_id,work_item_id,lease_epoch,operation_id,input_digest,input_json)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            input.tenantId,
            input.runId,
            claim.node.nodeId,
            claim.claimId,
            execution.step.stepId,
            execution.attempt?.attemptId ?? null,
            input.lease.workItemId,
            input.lease.leaseEpoch,
            input.schedulerOperationId,
            value.digest,
            value.json,
          ],
        );
        admissions.push({
          claim,
          step: execution.step,
          attempt: execution.attempt,
        });
      }
      if (plan.claims.length) {
        await client.query(
          `INSERT INTO ${this.#sql}.workflow_node_passes(tenant_id,run_id,operation_id,work_item_id,fingerprint,node_ids_json) VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            input.tenantId,
            input.runId,
            input.schedulerOperationId,
            input.lease.workItemId,
            fingerprint,
            JSON.stringify(plan.claims.map((claim) => claim.node.nodeId)),
          ],
        );
        const admitted = await readPostgresWorkflowNodes(
          client,
          this.#sql,
          plan.next,
          context.workflow,
        );
        await dispatchPostgresWorkflowChildren(client, this.#sql, {
          parent: run,
          context,
          admissions: admissions.filter(
            ({ claim }) => claim.node.kind !== "humanGate",
          ),
          rows: admitted,
          now,
          nextId: this.#id,
          resolveRoute: this.#options.resolveChildRoute,
          operations: this.#d,
        });
      }
      if (this.#gates)
        await publishPostgresWorkflowGates(client, this.#sql, {
          parent: run,
          state: plan.next,
          context,
          admissions,
        });
      // Routing may await policy reads. Recheck current authority before publishing any handoff.
      await this.#authorize(client, run, context.workItem);
      // Canonical child queues own execution. A replay never returns another dispatch permission.
      return {
        execution: plan.next,
        admissions: [] as WorkflowNodeAttemptAdmission[],
      };
    });
  }
  async #authorize(
    client: PoolClient,
    run: RunState,
    workItem: WorkItem,
  ): Promise<void> {
    const decision = await this.#options.authorize({
      client,
      run: structuredClone(run),
      workItem: structuredClone(workItem),
    });
    if (decision?.outcome !== "allow")
      throw new RunStoreError("workflow_scheduler_policy_denied");
  }
  async finalizeWorkflowRun(
    input: WorkflowSchedulerInput,
  ): Promise<
    Awaited<ReturnType<WorkflowRunFinalizationStore["finalizeWorkflowRun"]>>
  > {
    return this.#transaction(
      input,
      async (client, run, context, time) => {
        if (!terminal(run.status) && !run.cancelRequested)
          await this.#authorize(client, run, context.workItem);
        const result = await finalizePostgresWorkflowRoot(
          client,
          this.#sql,
          input,
          run,
          context,
          this.#settlingOperations(time),
          {
            now: new Date(time.now).toISOString(),
            nextId: this.#id,
            alreadySettled: time.alreadySettled,
            humanGatesEnabled: this.#gates !== null,
          },
        );
        if (!terminal(run.status) && !run.cancelRequested)
          await this.#authorize(client, run, context.workItem);
        return result;
      },
      { lease: "settling" },
    );
  }
  async finishWorkflowSchedulerPass(
    input: WorkflowSchedulerInput,
  ): Promise<WorkflowSchedulerPassResult> {
    return this.#transaction(
      input,
      async (client, run, context, time) => {
        if (!terminal(run.status) && !run.cancelRequested)
          await this.#authorize(client, run, context.workItem);
        const result = await finishPostgresWorkflowSchedulerPass(
          client,
          this.#sql,
          input,
          run,
          context,
          this.#settlingOperations(time),
          {
            maximum: this.#maximum,
            now: new Date(time.now).toISOString(),
            nextId: this.#id,
            alreadySettled: time.alreadySettled,
            humanGatesEnabled: this.#gates !== null,
          },
        );
        if (!terminal(run.status) && !run.cancelRequested)
          await this.#authorize(client, run, context.workItem);
        return result;
      },
      { lease: "settling" },
    );
  }
  async propagateWorkflowCancellation(input: WorkflowSchedulerInput) {
    return this.#transaction(input, (client, run, context, time) =>
      propagatePostgresWorkflowCancellation(
        client,
        this.#sql,
        input,
        run,
        context,
        this.#d,
        {
          humanGatesEnabled: this.#gates !== null,
          now: new Date(time.now).toISOString(),
          nextId: this.#id,
        },
      ),
    );
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
  #settlingOperations(time: {
    expiresAt: number;
  }): PostgresWorkflowCompositionDependencies {
    return {
      ...this.#d,
      settleRootWork: async (client, input) => {
        const lease = await this.#d.validateLease(client, input);
        time.expiresAt = Math.min(time.expiresAt, lease.expiresAt);
        await this.#d.settleRootWork(client, input);
      },
    };
  }
  async #transaction<T>(
    input: WorkflowSchedulerInput,
    execute: WorkflowTransactionCallback<T>,
    options: WorkflowTransactionMode = { lease: "current" },
  ): Promise<T> {
    return withPostgresWorkflowTransaction(input, execute, options, {
      pool: this.#pool,
      sql: this.#sql,
      schema: this.#schema,
      dependencies: this.#d,
    });
  }
}
function terminal(status: RunState["status"]) {
  return status === "completed" || status === "failed" || status === "canceled";
}
