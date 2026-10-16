import type { PoolClient } from "pg";
import {
  RunStoreError,
  canonicalJson,
  prepareWorkflowChildRun,
  type WorkflowExecutionState,
  type WorkflowNodeAttemptAdmission,
  type CommitRunInput,
  type CommitRunResult,
  type CommitThreadInput,
  type CommitThreadResult,
  type RunLocator,
  type RunRoute,
} from "@crewon/application";
import type { RunState, WorkflowNodeDefinition } from "@crewon/domain";
import {
  validateWorkflowSchedulerWorkItems,
  workflowAdmissionDigest,
} from "./workflow-run-admission-validation.ts";
import type { readPostgresWorkflowCompositionContext } from "./postgres-workflow-composition-context.ts";
import type { WorkflowNodeRow } from "./workflow-node-authority.ts";

export type PostgresWorkflowChildOperations = {
  loadChild(client: PoolClient, locator: RunLocator): Promise<RunState | null>;
  commitChildThread(
    client: PoolClient,
    input: CommitThreadInput,
  ): Promise<CommitThreadResult>;
  commitChildRun(
    client: PoolClient,
    input: CommitRunInput,
  ): Promise<CommitRunResult>;
};
export type PostgresWorkflowChildRoute = (input: {
  client: PoolClient;
  parent: RunState;
  node: WorkflowNodeDefinition;
}) => RunRoute | Promise<RunRoute>;
export type PostgresWorkflowChildRow = {
  node_id: string;
  claim_id: string;
  child_thread_id: string;
  child_run_id: string;
  input_digest: string;
  wake_work_item_id: string;
  wake_json: string | null;
};
export async function readPostgresWorkflowChildren(
  client: PoolClient,
  sql: string,
  state: WorkflowExecutionState,
  parent: RunState,
  context: Awaited<ReturnType<typeof readPostgresWorkflowCompositionContext>>,
  ops: PostgresWorkflowChildOperations,
) {
  const rows = await client.query<PostgresWorkflowChildRow>(
    `SELECT node_id,claim_id,child_thread_id,child_run_id,input_digest,wake_work_item_id,
    CASE WHEN octet_length(wake_json::text)<=65536 THEN wake_json::text ELSE NULL END AS wake_json
    FROM ${sql}.workflow_node_children WHERE tenant_id=$1 AND run_id=$2 LIMIT 65`,
    [state.tenantId, state.runId],
  );
  if (rows.rows.length > 64) corrupt();
  const children = new Map<
    string,
    PostgresWorkflowChildRow & { run: RunState }
  >();
  for (const row of rows.rows) {
    const node = state.nodes.find((value) => value.nodeId === row.node_id);
    if (
      !node ||
      node.kind === "humanGate" ||
      node.claimId !== row.claim_id ||
      node.inputDigest !== row.input_digest ||
      row.wake_json === null
    )
      corrupt();
    const bytes = await client.query<{ bytes: number }>(
      `SELECT octet_length(state_json::text) AS bytes FROM ${sql}.run_snapshots WHERE tenant_id=$1 AND run_id=$2`,
      [state.tenantId, row.child_run_id],
    );
    if (!bytes.rows[0] || bytes.rows[0].bytes > 65536) corrupt();
    const child = await ops.loadChild(client, {
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
          valueId: context.rootInput.valueId,
          valueDigest: context.rootInput.valueDigest,
        })
    )
      corrupt();
    children.set(row.claim_id, { ...row, run: child });
  }
  return children;
}

export async function dispatchPostgresWorkflowChildren(
  client: PoolClient,
  sql: string,
  input: {
    parent: RunState;
    context: Awaited<ReturnType<typeof readPostgresWorkflowCompositionContext>>;
    admissions: readonly WorkflowNodeAttemptAdmission[];
    rows: ReadonlyMap<string, WorkflowNodeRow>;
    now: string;
    nextId(): string;
    resolveRoute: PostgresWorkflowChildRoute;
    operations: PostgresWorkflowChildOperations;
  },
): Promise<void> {
  for (const admission of input.admissions) {
    const node = admission.claim.node;
    if (node.kind === "humanGate")
      throw new RunStoreError("workflow_gate_unavailable");
    const route = await input.resolveRoute({
      client,
      parent: structuredClone(input.parent),
      node: structuredClone(node),
    });
    const prepared = prepareWorkflowChildRun({
      parent: input.parent,
      node,
      claimId: admission.claim.claimId,
      value: JSON.parse(input.rows.get(node.nodeId)!.input_json!),
      route,
      now: input.now,
      nextId: input.nextId,
      digester: workflowAdmissionDigest,
    });
    // Never wait on another aggregate or receipt while holding the parent Run.
    for (const key of [
      `idempotency:${prepared.run.idempotency.scope}:${prepared.run.idempotency.key}`,
      `run:${input.parent.tenantId}:${prepared.childRunId}`,
      `thread:${input.parent.tenantId}:${prepared.childThreadId}`,
    ]) {
      const acquired = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired",
        [key],
      );
      if (acquired.rows[0]?.acquired !== true)
        throw new RunStoreError("postgres_retryable");
    }
    const thread = await input.operations.commitChildThread(
      client,
      prepared.thread,
    );
    const run = await input.operations.commitChildRun(client, prepared.run);
    if (
      thread.disposition !== "committed" ||
      run.disposition !== "committed" ||
      thread.state.threadId !== prepared.childThreadId ||
      run.state.runId !== prepared.childRunId
    )
      throw new RunStoreError("workflow_child_handoff_conflict");
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
      input.parent.runId,
      input.parent.tenantId,
      () => false,
    );
    await client.query(
      `INSERT INTO ${sql}.workflow_node_children (tenant_id,run_id,node_id,claim_id,child_thread_id,child_run_id,input_digest,wake_work_item_id,wake_json)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        input.parent.tenantId,
        input.parent.runId,
        node.nodeId,
        admission.claim.claimId,
        prepared.childThreadId,
        prepared.childRunId,
        admission.claim.inputDigest,
        wake.workItemId,
        canonicalJson(wake),
      ],
    );
  }
}
function corrupt(): never {
  throw new RunStoreError("workflow_child_authority_corrupt");
}
