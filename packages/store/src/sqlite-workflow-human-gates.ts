import type { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  projectWorkflowExecution,
  RunStoreError,
  validateWorkflowHumanGateRequest,
  captureWorkflowHumanGateReviewRead,
  captureWorkflowHumanGateReviewRequest,
  type WorkflowHumanGateReviewStore,
  type WorkflowHumanGateReview,
  type WorkflowHumanGateStore,
  type WorkflowHumanGateAuthorization,
  type WorkflowHumanGateView,
  type WorkflowHumanGateDecision,
  type WorkflowExecutionState,
  type WorkflowNodeAttemptAdmission,
  type ActorContext,
  type WorkItem,
} from "@crewon/application";
import type { RunState } from "@crewon/domain";
import { readSqliteWorkflowCompositionContext } from "./sqlite-workflow-composition-context.ts";
import {
  readSqliteWorkflowExecution,
  writeSqliteWorkflowExecution,
} from "./sqlite-workflow-execution-authority.ts";
import {
  readSqliteWorkflowNodes,
  sqliteWorkflowNodeAdmission,
} from "./sqlite-workflow-node-authority.ts";
import {
  readSqliteWorkflowChildren,
  type WorkflowChildOperations,
} from "./sqlite-workflow-child-dispatch.ts";
import { stopSqliteWorkflowFailedSiblings } from "./sqlite-workflow-failure-cancellation.ts";
import {
  assertSqliteWorkflowHumanGateSchema,
  migrateSqliteWorkflowHumanGates,
} from "./sqlite-workflow-human-gate-schema.ts";
import {
  readSqliteWorkflowHumanGates,
  workflowHumanGateAuthority,
  type GateContext,
} from "./sqlite-workflow-human-gate-authority.ts";

import {
  WORKFLOW_GATE_REVIEW_SCOPE,
  WORKFLOW_GATE_REVIEW_MAX_BYTES,
  workflowGateReviewKey,
  workflowGateReviewReceipt,
  readWorkflowGateReviewReceipt,
  type WorkflowGateReviewReceiptRow,
} from "./workflow-human-gate-review-receipt.ts";

type Ops = WorkflowChildOperations & {
  now(): number;
  enqueue(work: WorkItem): void;
  assertOpen(): void;
};
export class SqliteWorkflowHumanGates
  implements WorkflowHumanGateStore, WorkflowHumanGateReviewStore
{
  readonly #db: DatabaseSync;
  readonly #ops: Ops;
  readonly #authorize: WorkflowHumanGateAuthorization;
  readonly #nextId: () => string;
  constructor(
    db: DatabaseSync,
    ops: Ops,
    authorize: WorkflowHumanGateAuthorization,
    nextId: () => string,
  ) {
    this.#db = db;
    this.#ops = ops;
    this.#authorize = authorize;
    this.#nextId = nextId;
    migrateSqliteWorkflowHumanGates(db);
  }
  /** Caller owns the scheduler transaction that creates the Gate Step and claim. */
  publish(input: {
    parent: RunState;
    state: WorkflowExecutionState;
    context: GateContext;
    admissions: readonly WorkflowNodeAttemptAdmission[];
  }): void {
    assertSqliteWorkflowHumanGateSchema(this.#db);
    for (const { claim } of input.admissions) {
      if (claim.node.kind !== "humanGate") continue;
      const authority = workflowHumanGateAuthority(
          input.state,
          input.parent,
          input.context,
          claim.node.nodeId,
        ),
        json = canonicalJson(authority);
      if (Buffer.byteLength(json) > 8192)
        throw new RunStoreError("workflow_gate_authority_limit");
      this.#db
        .prepare(
          "INSERT INTO workflow_human_gates(tenant_id,run_id,node_id,request_id,authority_json) VALUES(?,?,?,?,?)",
        )
        .run(
          authority.tenantId,
          authority.runId,
          authority.nodeId,
          authority.gateRequestId,
          json,
        );
    }
    readSqliteWorkflowHumanGates(
      this.#db,
      input.state,
      input.parent,
      input.context,
      { requirePublishedGates: true },
    );
  }
  async loadWorkflowHumanGate(
    input: Parameters<WorkflowHumanGateStore["loadWorkflowHumanGate"]>[0],
  ): Promise<WorkflowHumanGateView> {
    this.#ops.assertOpen();
    validateWorkflowHumanGateRequest(input.actor, input.locator);
    this.#db.exec("BEGIN");
    try {
      const current = this.context(input.actor, input.locator);
      this.checkAuthorization(input.actor, "read", current.gate.authority);
      const result: WorkflowHumanGateView = {
        authority: current.gate.authority,
        title: current.definition.title,
        instruction: current.definition.instruction,
        input: JSON.parse(current.row.input_json!),
        status: current.node.status as WorkflowHumanGateView["status"],
        decision: current.gate.decision,
      };
      this.#db.exec("COMMIT");
      return structuredClone(result);
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }
  async decideWorkflowHumanGate(
    input: Parameters<WorkflowHumanGateStore["decideWorkflowHumanGate"]>[0],
  ) {
    const { disposition, decision } = await this.#decide(input);
    return { disposition, decision };
  }
  async reviewWorkflowHumanGate(
    input: Parameters<
      WorkflowHumanGateReviewStore["reviewWorkflowHumanGate"]
    >[0],
  ) {
    const captured = captureWorkflowHumanGateReviewRequest(input);
    const { comment, ...command } = captured.command;
    const result = await this.#decide(
      {
        actor: captured.actor,
        command: { ...command, kind: "workflowHumanGate.decide" },
      },
      { comment },
    );
    if (!result.review) throw new RunStoreError("workflow_gate_review_corrupt");
    return { disposition: result.disposition, review: result.review };
  }
  async #decide(
    input: Parameters<WorkflowHumanGateStore["decideWorkflowHumanGate"]>[0],
    intent?: Readonly<{ comment: string | null }>,
  ) {
    this.#ops.assertOpen();
    validateWorkflowHumanGateRequest(input.actor, input.command);
    const command = structuredClone(input.command),
      actor = structuredClone(input.actor);
    if (
      command.kind !== "workflowHumanGate.decide" ||
      !["approved", "rejected"].includes(command.decision) ||
      !/^sha256:[a-f0-9]{64}$/u.test(command.inputDigest) ||
      Object.keys(command).sort().join() !==
        "decision,gateRequestId,inputDigest,kind,nodeId,runId"
    )
      throw new RunStoreError("workflow_gate_command_invalid");
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.context(actor, command),
        { gate, run, state, row, context, node } = current;
      this.checkAuthorization(actor, "decide", gate.authority);
      if (command.inputDigest !== gate.authority.inputDigest)
        throw new RunStoreError("workflow_gate_input_conflict");
      const previousReview = intent
        ? this.#readReview(gate.authority, gate.decision)
        : null;
      if (gate.decision) {
        if (
          canonicalJson(gate.decision.actor) !== canonicalJson(actor) ||
          gate.decision.outcome !== command.decision
        )
          throw new RunStoreError("workflow_gate_decision_conflict");
        if (intent && previousReview?.comment !== intent.comment)
          throw new RunStoreError("workflow_gate_review_comment_conflict");
        this.#db.exec("COMMIT");
        return {
          disposition: "replayed" as const,
          decision: structuredClone(gate.decision),
          review: structuredClone(previousReview),
        };
      }
      if (
        run.cancelRequested ||
        run.status !== "running" ||
        state.cancelRequested ||
        !["running", "waitingHuman"].includes(state.status) ||
        node.status !== "waitingHuman"
      )
        throw new RunStoreError("workflow_gate_not_decidable");
      const now = new Date(this.#ops.now()).toISOString(),
        approved = command.decision === "approved";
      const { step } = sqliteWorkflowNodeAdmission(
        this.#db,
        state,
        context.workflow,
        row,
      );
      const nextStep = {
        ...step,
        status: approved ? "completed" : "failed",
        revision: step.revision + 1,
        updatedAt: now,
        terminalAt: now,
      };
      const update = this.#db
        .prepare(
          "UPDATE run_steps SET status=?,revision=?,state_json=?,updated_at=?,terminal_at=? WHERE tenant_id=? AND run_id=? AND step_id=? AND revision=? AND status='waitingApproval'",
        )
        .run(
          nextStep.status,
          nextStep.revision,
          canonicalJson(nextStep),
          now,
          now,
          run.tenantId,
          run.runId,
          step.stepId,
          step.revision,
        );
      if (update.changes !== 1)
        throw new RunStoreError("workflow_gate_decision_conflict");
      const outcome = approved
        ? { status: "completed" as const, digest: row.input_digest }
        : {
            status: "failed" as const,
            failureCode: "workflow_human_gate_rejected",
          };
      const changed = this.#db
        .prepare(
          "UPDATE workflow_node_admissions SET output_digest=?,output_json=?,settlement_fingerprint=? WHERE tenant_id=? AND run_id=? AND node_id=? AND settlement_fingerprint IS NULL",
        )
        .run(
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
        );
      if (changed.changes !== 1)
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
      writeSqliteWorkflowExecution(this.#db, state, next);
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
      const written = this.#db
        .prepare(
          "UPDATE workflow_human_gates SET decision_json=?,wake_work_item_id=?,wake_json=? WHERE tenant_id=? AND run_id=? AND node_id=? AND decision_json IS NULL",
        )
        .run(
          json,
          wake.workItemId,
          canonicalJson(wake),
          run.tenantId,
          run.runId,
          node.nodeId,
        );
      if (written.changes !== 1)
        throw new RunStoreError("workflow_gate_decision_conflict");
      this.#ops.enqueue(wake);
      // Rejection is an authorized control decision; the frozen fail-fast policy may signal siblings here.
      // No running sibling is settled by this transaction.
      if (!approved)
        next = stopSqliteWorkflowFailedSiblings(
          this.#db,
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
      const review = intent ? { decision, comment: intent.comment } : null;
      if (review) this.#writeReview(review);
      const persistedGates = readSqliteWorkflowHumanGates(
        this.#db,
        next,
        run,
        context,
        {
          requirePublishedGates: true,
        },
      );
      const persistedDecision = persistedGates.get(node.nodeId)?.decision;
      if (
        !persistedDecision ||
        canonicalJson(persistedDecision) !== canonicalJson(decision)
      )
        throw new RunStoreError("workflow_gate_authority_conflict");
      this.checkAuthorization(actor, "decide", gate.authority);
      this.#db.exec("COMMIT");
      return {
        review: structuredClone(review),
        disposition: "committed" as const,
        decision: structuredClone(decision),
      };
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }
  async loadWorkflowHumanGateReview(
    input: Parameters<
      WorkflowHumanGateReviewStore["loadWorkflowHumanGateReview"]
    >[0],
  ) {
    const { actor, locator } = captureWorkflowHumanGateReviewRead(input);
    this.#ops.assertOpen();
    this.#db.exec("BEGIN");
    try {
      const current = this.context(actor, locator);
      this.checkAuthorization(actor, "read", current.gate.authority);
      const review = this.#readReview(
        current.gate.authority,
        current.gate.decision,
      );
      const result = {
        authority: current.gate.authority,
        title: current.definition.title,
        instruction: current.definition.instruction,
        input: JSON.parse(current.row.input_json!),
        status: current.node.status as WorkflowHumanGateView["status"],
        review,
      };
      this.checkAuthorization(actor, "read", current.gate.authority);
      this.#db.exec("COMMIT");
      return structuredClone(result);
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }
  #readReview(
    authority: WorkflowHumanGateDecision["authority"],
    decision: WorkflowHumanGateDecision | null,
  ) {
    const row = this.#db
      .prepare(
        "SELECT tenant_id,run_id,fingerprint,CASE WHEN length(CAST(result_json AS BLOB))<=? THEN result_json ELSE NULL END AS result_json FROM idempotency_receipts WHERE scope=? AND idempotency_key=?",
      )
      .get(
        WORKFLOW_GATE_REVIEW_MAX_BYTES,
        WORKFLOW_GATE_REVIEW_SCOPE,
        workflowGateReviewKey(authority),
      ) as WorkflowGateReviewReceiptRow | undefined;
    return readWorkflowGateReviewReceipt(row, authority, decision);
  }
  #writeReview(review: WorkflowHumanGateReview) {
    const receipt = workflowGateReviewReceipt(review),
      authority = review.decision.authority;
    this.#db
      .prepare(
        "INSERT INTO idempotency_receipts(tenant_id,scope,idempotency_key,run_id,fingerprint,result_json) VALUES(?,?,?,?,?,?)",
      )
      .run(
        authority.tenantId,
        WORKFLOW_GATE_REVIEW_SCOPE,
        workflowGateReviewKey(authority),
        authority.runId,
        receipt.fingerprint,
        receipt.json,
      );
    const stored = this.#readReview(authority, review.decision);
    if (canonicalJson(stored) !== canonicalJson(review))
      throw new RunStoreError("workflow_gate_review_corrupt");
  }
  private context(
    actor: ActorContext,
    locator: { runId: string; nodeId: string; gateRequestId: string },
  ) {
    assertSqliteWorkflowHumanGateSchema(this.#db);
    const size = this.#db
      .prepare(
        "SELECT length(CAST(state_json AS BLOB)) AS bytes FROM run_snapshots WHERE tenant_id=? AND run_id=?",
      )
      .get(actor.tenantId, locator.runId);
    if (size && Number(size.bytes) > 16384)
      throw new RunStoreError("workflow_root_state_limit");
    const run = this.#ops.loadRun({
      tenantId: actor.tenantId,
      runId: locator.runId,
    });
    if (!run || run.spaceId !== actor.spaceId || run.purpose !== "workflow")
      throw new RunStoreError("workflow_gate_not_found");
    const admission = this.#db
      .prepare(
        "SELECT work_item_id FROM workflow_node_admissions WHERE tenant_id=? AND run_id=? AND node_id=?",
      )
      .get(run.tenantId, run.runId, locator.nodeId);
    if (!admission) throw new RunStoreError("workflow_gate_not_found");
    const context = readSqliteWorkflowCompositionContext(this.#db, {
      run,
      binding: run.workflowVersionBinding!,
      lease: { workItemId: String(admission.work_item_id) },
    });
    const state = readSqliteWorkflowExecution(this.#db, run);
    if (
      !state ||
      state.workflowId !== context.workflow.workflowId ||
      state.workflowVersionId !== context.workflow.workflowVersionId ||
      state.contentDigest !== context.workflow.contentDigest
    )
      throw new RunStoreError("workflow_execution_binding_mismatch");
    const rows = readSqliteWorkflowNodes(this.#db, state, context.workflow);
    for (const row of rows.values())
      sqliteWorkflowNodeAdmission(this.#db, state, context.workflow, row);
    const gates = readSqliteWorkflowHumanGates(this.#db, state, run, context, {
        requirePublishedGates: true,
      }),
      gate = gates.get(locator.nodeId);
    if (!gate || gate.authority.gateRequestId !== locator.gateRequestId)
      throw new RunStoreError("workflow_gate_not_found");
    const children = readSqliteWorkflowChildren(
      this.#db,
      state,
      run,
      this.#ops.loadRun,
    );
    if (
      state.nodes.some(
        (n) =>
          n.kind !== "humanGate" &&
          n.claimId !== null &&
          !children.has(n.claimId),
      )
    )
      throw new RunStoreError("workflow_child_handoff_missing");
    return {
      run,
      state,
      context,
      gate,
      children,
      row: rows.get(locator.nodeId)!,
      node: state.nodes.find((n) => n.nodeId === locator.nodeId)!,
      definition: context.workflow.nodes.find(
        (n) => n.nodeId === locator.nodeId,
      )!,
    };
  }
  private checkAuthorization(
    actor: ActorContext,
    action: "read" | "decide",
    authority: WorkflowHumanGateDecision["authority"],
  ) {
    try {
      const result = this.#authorize({
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
