import type { DatabaseSync } from "node:sqlite";
import { workflowNodeReviewContext } from "./workflow-gate-review-context.ts";
import type { WorkflowHumanGateRow } from "./workflow-human-gate-authority.ts";
import {
  canonicalJson,
  prepareWorkflowChildRun,
  RunStoreError,
  type CommitRunInput,
  type CommitRunResult,
  type CommitThreadInput,
  type CommitThreadResult,
  type RunLocator,
  type RunRoute,
  type WorkflowExecutionState,
  type WorkflowNodeAttemptAdmission,
} from "@crewon/application";
import type { RunState, WorkflowNodeDefinition } from "@crewon/domain";
import {
  assertSqliteWorkflowChildSchema,
  migrateSqliteWorkflowChildren,
} from "./sqlite-workflow-child-schema.ts";
import type { readSqliteWorkflowCompositionContext } from "./sqlite-workflow-composition-context.ts";
import { readSqliteWorkflowNodes } from "./sqlite-workflow-node-authority.ts";
import {
  validateWorkflowSchedulerWorkItems,
  workflowAdmissionDigest,
} from "./workflow-run-admission-validation.ts";

export type SqliteWorkflowChildDispatchOptions = Readonly<{
  /** Server-only authorization/route check. Must be synchronous and perform no external I/O. */
  resolveRoute(input: {
    database: DatabaseSync;
    parent: RunState;
    node: WorkflowNodeDefinition;
  }): RunRoute;
}>;
export type WorkflowChildOperations = {
  loadRun(input: RunLocator): RunState | null;
  commitChildThread(input: CommitThreadInput): CommitThreadResult;
  commitChildRun(input: CommitRunInput): CommitRunResult;
  hasPendingProviderSwitch(tenantId: string): boolean;
};
export type WorkflowChildRow = {
  node_id: string;
  claim_id: string;
  child_thread_id: string;
  child_run_id: string;
  input_digest: string;
  wake_work_item_id: string;
  wake_json: string | null;
};

export function readSqliteWorkflowChildren(
  db: DatabaseSync,
  state: WorkflowExecutionState,
  parent: RunState,
  loadRun: WorkflowChildOperations["loadRun"],
): Map<string, WorkflowChildRow> {
  if (!assertSqliteWorkflowChildSchema(db)) return new Map();
  const rootInput = db
    .prepare(
      "SELECT value_id,value_digest FROM workflow_run_inputs WHERE tenant_id=? AND run_id=?",
    )
    .get(state.tenantId, state.runId);
  if (!rootInput) corrupt();
  const rows = db
    .prepare(
      `SELECT node_id,claim_id,child_thread_id,child_run_id,input_digest,wake_work_item_id,
    CASE WHEN length(CAST(wake_json AS BLOB))<=65536 THEN wake_json ELSE NULL END AS wake_json
    FROM workflow_node_children WHERE tenant_id=? AND run_id=? LIMIT 65`,
    )
    .all(state.tenantId, state.runId) as unknown as WorkflowChildRow[];
  if (rows.length > 64) corrupt();
  for (const row of rows) {
    const node = state.nodes.find((value) => value.nodeId === row.node_id);
    if (
      !node ||
      node.kind === "humanGate" ||
      node.claimId !== row.claim_id ||
      node.inputDigest !== row.input_digest ||
      row.wake_json === null
    )
      corrupt();
    const bytes = db
      .prepare(
        "SELECT length(CAST(state_json AS BLOB)) AS bytes FROM run_snapshots WHERE tenant_id=? AND run_id=?",
      )
      .get(state.tenantId, row.child_run_id);
    if (!bytes || Number(bytes.bytes) > 65536) corrupt();
    const child = loadRun({
      tenantId: state.tenantId,
      runId: row.child_run_id,
    });
    if (
      !child ||
      child.threadId !== row.child_thread_id ||
      child.spaceId !== parent.spaceId ||
      child.purpose !== "turn" ||
      child.agentVersionId !== node.agentVersionId ||
      child.authorityId !== parent.authorityId ||
      child.policySnapshotId !== parent.policySnapshotId ||
      child.runtimeGeneration !== parent.runtimeGeneration ||
      child.workspaceBindingId !== parent.workspaceBindingId ||
      child.goalBinding !== null ||
      child.goalAccounting !== null ||
      child.collaborationMode !== "default" ||
      (child.origin ?? null) !== null ||
      child.createdByActorId !== parent.createdByActorId ||
      child.toolPermissionMode !== parent.toolPermissionMode
    )
      corrupt();
    const wake = JSON.parse(row.wake_json);
    validateWorkflowSchedulerWorkItems(
      [wake],
      state.runId,
      state.tenantId,
      () => false,
    );
    if (
      wake.workItemId !== row.wake_work_item_id ||
      canonicalJson(wake.payload.binding) !==
        canonicalJson(parent.workflowVersionBinding) ||
      canonicalJson(wake.payload.workflowInput) !==
        canonicalJson({
          valueId: rootInput.value_id,
          valueDigest: rootInput.value_digest,
        })
    )
      corrupt();
  }
  return new Map(rows.map((row) => [row.claim_id, row]));
}

export class SqliteWorkflowChildDispatcher {
  readonly #db: DatabaseSync;
  readonly #operations: WorkflowChildOperations;
  readonly #options: SqliteWorkflowChildDispatchOptions;
  constructor(
    db: DatabaseSync,
    operations: WorkflowChildOperations,
    options: SqliteWorkflowChildDispatchOptions,
  ) {
    migrateSqliteWorkflowChildren(db);
    this.#db = db;
    this.#operations = operations;
    this.#options = options;
  }

  assertSchema(): void {
    if (!assertSqliteWorkflowChildSchema(this.#db))
      throw new RunStoreError("workflow_child_schema_corrupt");
  }

  dispatch(input: {
    parent: RunState;
    context: ReturnType<typeof readSqliteWorkflowCompositionContext>;
    state: WorkflowExecutionState;
    admissions: readonly WorkflowNodeAttemptAdmission[];
    gates: ReadonlyMap<string, WorkflowHumanGateRow>;
    now: string;
    nextId(): string;
  }): void {
    if (input.admissions.length === 0) return;
    if (this.#operations.hasPendingProviderSwitch(input.parent.tenantId))
      throw new RunStoreError("model_provider_settings_switch_pending");
    const rows = readSqliteWorkflowNodes(
      this.#db,
      input.state,
      input.context.workflow,
    );
    for (const admission of input.admissions) {
      const node = admission.claim.node,
        row = rows.get(node.nodeId)!;
      if (node.kind === "humanGate")
        throw new RunStoreError("workflow_child_gate_unsupported");
      const route = this.#options.resolveRoute({
        database: this.#db,
        parent: input.parent,
        node,
      });
      const prepared = prepareWorkflowChildRun({
        parent: input.parent,
        node,
        claimId: admission.claim.claimId,
        value: JSON.parse(row.input_json!),
        route,
        now: input.now,
        nextId: input.nextId,
        digester: workflowAdmissionDigest,
        reviewContext: workflowNodeReviewContext(
          input.context.workflow,
          node.nodeId,
          input.gates,
        ),
      });
      this.#operations.commitChildThread(prepared.thread);
      this.#operations.commitChildRun(prepared.run);
      const wake = {
        ...input.context.workItem,
        workItemId: input.nextId(),
        createdAt: input.now,
        payload: {
          ...input.context.workItem.payload,
          schedulerOperationId: input.nextId(),
        },
      };
      validateWorkflowSchedulerWorkItems(
        [wake],
        input.state.runId,
        input.state.tenantId,
        () => false,
      );
      this.#db
        .prepare(
          `INSERT INTO workflow_node_children (tenant_id,run_id,node_id,claim_id,child_thread_id,child_run_id,input_digest,wake_work_item_id,wake_json)
        VALUES(?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          input.state.tenantId,
          input.state.runId,
          node.nodeId,
          admission.claim.claimId,
          prepared.childThreadId,
          prepared.childRunId,
          admission.claim.inputDigest,
          wake.workItemId,
          canonicalJson(wake),
        );
    }
  }
}
function corrupt(): never {
  throw new RunStoreError("workflow_child_authority_corrupt");
}
