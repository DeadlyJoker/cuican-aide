import type { Pool, PoolClient } from "pg";
import {
  canonicalJson,
  projectWorkflowExecution,
  RunStoreError,
  validateWorkflowHumanGateRequest,
  type WorkflowHumanGateStore,
  type WorkflowHumanGateAuthorization,
  type WorkflowHumanGateAuthority,
  type AuthorizationDecision,
  type ActorContext,
  type WorkflowHumanGateDecision,
  type WorkflowExecutionState,
  type WorkflowNodeAttemptAdmission,
  type WorkItem,
} from "@crewon/application";
import type { RunState, RunStepState } from "@crewon/domain";
import type { PostgresWorkflowCompositionDependencies } from "./postgres-workflow-run-composition.ts";
import { assertPostgresWorkflowCompositionSchema } from "./postgres-workflow-composition-schema.ts";
import { readPostgresWorkflowCompositionContext } from "./postgres-workflow-composition-context.ts";
import { readPostgresWorkflowSchedulerAuthority } from "./postgres-workflow-scheduler-authority.ts";
import { readPostgresWorkflowHumanGates } from "./postgres-workflow-human-gate-authority.ts";
import {
  workflowHumanGateAuthority,
  type GateContext,
} from "./workflow-human-gate-authority.ts";
import { writePostgresWorkflowExecution } from "./postgres-workflow-execution-authority.ts";
import { stopPostgresWorkflowFailedSiblings } from "./postgres-workflow-failure-cancellation.ts";
import { lockProviderSettingsTenant } from "./postgres-model-provider-settings-store.ts";
import { advisoryLock } from "./postgres-thread-lock.ts";
import { writePostgresWorkItems } from "./postgres-run-writer.ts";
import {
  rollbackPostgres,
  normalizePostgresError,
} from "./postgres-store-support.ts";

/** Resolve current durable policy through this transaction's client; no external I/O. */
export type PostgresWorkflowHumanGateAuthorization = (
  input: Parameters<WorkflowHumanGateAuthorization>[0] & { client: PoolClient },
) => AuthorizationDecision | Promise<AuthorizationDecision>;

/** Caller owns the scheduler transaction; gates never have a model Attempt or child Run. */
export async function insertPostgresWorkflowGate(
  client: PoolClient,
  sql: string,
  input: { tenantId: string; runId: string; stepId: string; now: string },
): Promise<RunStepState> {
  const step: RunStepState = {
    schemaVersion: "crewon.run-step.v0",
    tenantId: input.tenantId,
    runId: input.runId,
    stepId: input.stepId,
    kind: "gate",
    status: "waitingApproval",
    revision: 1,
    currentAttemptId: null,
    attemptCount: 0,
    createdAt: input.now,
    updatedAt: input.now,
    terminalAt: null,
  };
  await client.query(
    `INSERT INTO ${sql}.run_steps(tenant_id,run_id,step_id,kind,status,revision,current_attempt_id,attempt_count,state_json,created_at,updated_at,terminal_at)
    VALUES($1,$2,$3,'gate','waitingApproval',1,NULL,0,$4,$5,$5,NULL)`,
    [step.tenantId, step.runId, step.stepId, canonicalJson(step), input.now],
  );
  return step;
}
export async function publishPostgresWorkflowGates(
  client: PoolClient,
  sql: string,
  input: {
    parent: RunState;
    state: WorkflowExecutionState;
    context: GateContext;
    admissions: readonly WorkflowNodeAttemptAdmission[];
  },
) {
  for (const { claim } of input.admissions) {
    if (claim.node.kind !== "humanGate") continue;
    const authority = workflowHumanGateAuthority(
      input.state,
      input.parent,
      input.context,
      claim.node.nodeId,
    );
    const json = canonicalJson(authority);
    if (Buffer.byteLength(json) > 8192)
      throw new RunStoreError("workflow_gate_authority_limit");
    await client.query(
      `INSERT INTO ${sql}.workflow_human_gates(tenant_id,run_id,node_id,request_id,authority_json) VALUES($1,$2,$3,$4,$5)`,
      [
        authority.tenantId,
        authority.runId,
        authority.nodeId,
        authority.gateRequestId,
        json,
      ],
    );
  }
  await readPostgresWorkflowHumanGates(
    client,
    sql,
    input.state,
    input.parent,
    input.context,
    true,
  );
}

export class PostgresWorkflowHumanGates implements WorkflowHumanGateStore {
  readonly #pool: Pool;
  readonly #sql: string;
  readonly #ops: PostgresWorkflowCompositionDependencies;
  readonly #authorize: PostgresWorkflowHumanGateAuthorization;
  readonly #nextId: () => string;
  constructor(
    pool: Pool,
    sql: string,
    ops: PostgresWorkflowCompositionDependencies,
    authorize: PostgresWorkflowHumanGateAuthorization,
    nextId: () => string,
  ) {
    this.#pool = pool;
    this.#sql = sql;
    this.#ops = ops;
    this.#authorize = authorize;
    this.#nextId = nextId;
  }
  async loadWorkflowHumanGate(
    input: Parameters<WorkflowHumanGateStore["loadWorkflowHumanGate"]>[0],
  ) {
    validateWorkflowHumanGateRequest(input.actor, input.locator);
    const actor = structuredClone(input.actor),
      locator = structuredClone(input.locator);
    return this.#transaction(actor, locator, async (client, current) => {
      await this.#checkAuthorization(
        client,
        actor,
        "read",
        current.gate.authority,
      );
      return {
        authority: current.gate.authority,
        title: current.definition.title,
        instruction: current.definition.instruction,
        input: JSON.parse(current.row.input_json!),
        status: current.node.status as
          | "waitingHuman"
          | "completed"
          | "failed"
          | "canceled",
        decision: current.gate.decision,
      };
    });
  }
  async decideWorkflowHumanGate(
    input: Parameters<WorkflowHumanGateStore["decideWorkflowHumanGate"]>[0],
  ) {
    validateWorkflowHumanGateRequest(input.actor, input.command);
    const actor = structuredClone(input.actor),
      command = structuredClone(input.command);
    if (
      command.kind !== "workflowHumanGate.decide" ||
      !["approved", "rejected"].includes(command.decision) ||
      !/^sha256:[a-f0-9]{64}$/u.test(command.inputDigest) ||
      Object.keys(command).sort().join() !==
        "decision,gateRequestId,inputDigest,kind,nodeId,runId"
    )
      throw new RunStoreError("workflow_gate_command_invalid");
    return this.#transaction(actor, command, async (client, current) => {
      const { run, execution: state, row, node, gate, context } = current;
      await this.#checkAuthorization(client, actor, "decide", gate.authority);
      if (command.inputDigest !== gate.authority.inputDigest)
        throw new RunStoreError("workflow_gate_input_conflict");
      if (gate.decision) {
        if (
          canonicalJson(gate.decision.actor) !== canonicalJson(actor) ||
          gate.decision.outcome !== command.decision
        )
          throw new RunStoreError("workflow_gate_decision_conflict");
        await this.#checkAuthorization(client, actor, "decide", gate.authority);
        return { disposition: "replayed" as const, decision: gate.decision };
      }
      if (
        run.cancelRequested ||
        run.status !== "running" ||
        state.cancelRequested ||
        !["running", "waitingHuman"].includes(state.status) ||
        node.status !== "waitingHuman"
      )
        throw new RunStoreError("workflow_gate_not_decidable");
      const now = (
        await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")
      ).rows[0]!.now.toISOString();
      const approved = command.decision === "approved";
      const step = current.admission.step;
      const nextStep = {
        ...step,
        status: approved ? "completed" : "failed",
        revision: step.revision + 1,
        updatedAt: now,
        terminalAt: now,
      };
      const update = await client.query(
        `UPDATE ${this.#sql}.run_steps SET status=$1,revision=$2,state_json=$3,updated_at=$4,terminal_at=$4
        WHERE tenant_id=$5 AND run_id=$6 AND step_id=$7 AND revision=$8 AND status='waitingApproval'`,
        [
          nextStep.status,
          nextStep.revision,
          canonicalJson(nextStep),
          now,
          run.tenantId,
          run.runId,
          step.stepId,
          step.revision,
        ],
      );
      if (update.rowCount !== 1)
        throw new RunStoreError("workflow_gate_decision_conflict");
      const outcome = approved
        ? { status: "completed" as const, digest: row.input_digest }
        : {
            status: "failed" as const,
            failureCode: "workflow_human_gate_rejected",
          };
      const changed = await client.query(
        `UPDATE ${this.#sql}.workflow_node_admissions SET output_digest=$1,output_json=$2,settlement_fingerprint=$3 WHERE tenant_id=$4 AND run_id=$5 AND node_id=$6 AND settlement_fingerprint IS NULL`,
        [
          approved ? row.input_digest : null,
          approved ? row.input_json : null,
          canonicalJson({
            kind: "workflow.node-settle.v1",
            nodeId: node.nodeId,
            claimId: node.claimId,
            outcome,
          }),
          run.tenantId,
          run.runId,
          node.nodeId,
        ],
      );
      if (changed.rowCount !== 1)
        throw new RunStoreError("workflow_gate_decision_conflict");
      const nodes = state.nodes.map((n) =>
        n.nodeId === node.nodeId
          ? {
              ...n,
              status: outcome.status,
              resultDigest: approved ? row.input_digest : null,
              failureCode: approved ? null : "workflow_human_gate_rejected",
            }
          : n,
      );
      let next = projectWorkflowExecution(state, nodes, now);
      await writePostgresWorkflowExecution(client, this.#sql, state, next);
      const decision: WorkflowHumanGateDecision = {
        authority: gate.authority,
        actor,
        outcome: command.decision,
        decidedAt: now,
      };
      const wake: WorkItem = {
        ...context.workItem,
        workItemId: this.#nextId(),
        createdAt: now,
        payload: {
          ...context.workItem.payload,
          schedulerOperationId: this.#nextId(),
        },
      };
      const json = canonicalJson(decision);
      if (Buffer.byteLength(json) > 16384)
        throw new RunStoreError("workflow_gate_decision_limit");
      if (Buffer.byteLength(canonicalJson(wake)) > 65536)
        throw new RunStoreError("workflow_scheduler_payload_invalid");
      await writePostgresWorkItems(client, this.#sql, [wake]);
      const written = await client.query(
        `UPDATE ${this.#sql}.workflow_human_gates SET decision_json=$1,wake_work_item_id=$2,wake_json=$3 WHERE tenant_id=$4 AND run_id=$5 AND node_id=$6 AND decision_json IS NULL`,
        [
          json,
          wake.workItemId,
          canonicalJson(wake),
          run.tenantId,
          run.runId,
          node.nodeId,
        ],
      );
      if (written.rowCount !== 1)
        throw new RunStoreError("workflow_gate_decision_conflict");
      if (!approved)
        next = await stopPostgresWorkflowFailedSiblings(
          client,
          this.#sql,
          {
            parent: run,
            state: next,
            workflow: context.workflow,
            children: current.children,
            now,
            nextId: this.#nextId,
          },
          this.#ops,
        );
      await readPostgresWorkflowHumanGates(
        client,
        this.#sql,
        next,
        run,
        context,
        true,
      );
      await this.#checkAuthorization(client, actor, "decide", gate.authority);
      return { disposition: "committed" as const, decision };
    });
  }
  async #transaction<T>(
    actor: ActorContext,
    locator: { runId: string; nodeId: string; gateRequestId: string },
    execute: (
      client: PoolClient,
      context: Awaited<ReturnType<PostgresWorkflowHumanGates["context"]>>,
    ) => Promise<T>,
  ) {
    this.#ops.assertOpen();
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await lockProviderSettingsTenant(client, this.#sql, actor.tenantId);
      await advisoryLock(client, `run:${actor.tenantId}:${locator.runId}`);
      const current = await this.context(client, actor, locator);
      const result = await execute(client, current);
      await client.query("COMMIT");
      return structuredClone(result);
    } catch (error) {
      await rollbackPostgres(client);
      throw normalizePostgresError(error);
    } finally {
      client.release();
    }
  }
  private async context(
    client: PoolClient,
    actor: ActorContext,
    locator: { runId: string; nodeId: string; gateRequestId: string },
  ) {
    const bytes = (
      await client.query<{ n: number }>(
        `SELECT octet_length(state_json::text) AS n FROM ${this.#sql}.run_snapshots WHERE tenant_id=$1 AND run_id=$2`,
        [actor.tenantId, locator.runId],
      )
    ).rows[0];
    if (bytes && bytes.n > 16384)
      throw new RunStoreError("workflow_root_state_limit");
    const run = await this.#ops.loadRoot(client, {
      tenantId: actor.tenantId,
      runId: locator.runId,
    });
    if (!run || run.spaceId !== actor.spaceId || run.purpose !== "workflow")
      throw new RunStoreError("workflow_gate_not_found");
    await assertPostgresWorkflowCompositionSchema(
      client,
      this.#sql.slice(1, -1),
    );
    const original = (
      await client.query<{ work_item_id: string }>(
        `SELECT work_item_id FROM ${this.#sql}.workflow_node_admissions WHERE tenant_id=$1 AND run_id=$2 AND node_id=$3`,
        [run.tenantId, run.runId, locator.nodeId],
      )
    ).rows[0];
    if (!original) throw new RunStoreError("workflow_gate_not_found");
    const context = await readPostgresWorkflowCompositionContext(
      client,
      this.#sql,
      {
        run,
        binding: run.workflowVersionBinding!,
        lease: { workItemId: original.work_item_id },
      },
    );
    const authority = await readPostgresWorkflowSchedulerAuthority(
      client,
      this.#sql,
      {
        tenantId: run.tenantId,
        runId: run.runId,
        binding: run.workflowVersionBinding!,
      },
      run,
      context,
      this.#ops,
      { humanGatesEnabled: true },
    );
    const gate = authority.gates.get(locator.nodeId);
    if (!gate || gate.authority.gateRequestId !== locator.gateRequestId)
      throw new RunStoreError("workflow_gate_not_found");
    const row = authority.rows.get(locator.nodeId)!;
    const admission = authority.admissions.get(locator.nodeId)!;
    return {
      ...authority,
      run,
      context,
      row,
      admission,
      gate,
      node: authority.execution.nodes.find((n) => n.nodeId === locator.nodeId)!,
      definition: context.workflow.nodes.find(
        (n) => n.nodeId === locator.nodeId,
      )!,
    };
  }
  async #checkAuthorization(
    client: PoolClient,
    actor: ActorContext,
    action: "read" | "decide",
    authority: WorkflowHumanGateAuthority,
  ) {
    try {
      const result = await this.#authorize({
        client,
        actor: structuredClone(actor),
        action,
        authority: structuredClone(authority),
      });
      if (result?.outcome !== "allow")
        throw new RunStoreError("workflow_gate_authorization_denied");
    } catch (error) {
      if (error instanceof RunStoreError) throw error;
      throw new RunStoreError("workflow_gate_authorization_unavailable", {
        cause: error,
      });
    }
  }
}
