import type { PoolClient } from "pg";
import {
  canonicalJson,
  projectWorkflowExecution,
  RunStoreError,
  type WorkflowExecutionState,
} from "@crewon/application";
import type { CompiledWorkflowVersion, RunState } from "@crewon/domain";
import type {
  PostgresWorkflowChildOperations,
  PostgresWorkflowChildRow,
} from "./postgres-workflow-children.ts";
import {
  readPostgresWorkflowNodes,
  postgresWorkflowNodeAdmission,
} from "./postgres-workflow-node-authority.ts";
import type { WorkflowNodeRow } from "./workflow-node-authority.ts";
import { readPostgresWorkflowChildWork } from "./postgres-workflow-child-work.ts";
import { prepareWorkflowChildCancellation } from "./workflow-child-cancellation.ts";
import { cancelPostgresWorkflowUnstartedNodes } from "./postgres-workflow-unstarted-cancellation.ts";
import { writePostgresWorkflowExecution } from "./postgres-workflow-execution-authority.ts";
import { workflowAdmissionDigest } from "./workflow-run-admission-validation.ts";
import { RECONCILIATION_CANCEL_WAKE } from "./reconciliation-cancellation-wake.ts";

/** Caller owns the parent Run. Child/receipt/queue locks are try-only, never wait while holding the parent. */
export async function stopPostgresWorkflowFailedSiblings(
  client: PoolClient,
  sql: string,
  input: {
    parent: RunState;
    state: WorkflowExecutionState;
    workflow: CompiledWorkflowVersion;
    children: ReadonlyMap<string, PostgresWorkflowChildRow & { run: RunState }>;
    now: string;
    nextId(): string;
  },
  ops: PostgresWorkflowChildOperations,
): Promise<WorkflowExecutionState> {
  const { parent, state, workflow } = input;
  if (state.status !== "failed" || state.cancelRequested) return state;
  const rows = await readPostgresWorkflowNodes(client, sql, state, workflow);
  for (const row of rows.values())
    await postgresWorkflowNodeAdmission(client, sql, state, workflow, row);
  const source = state.nodes.find((node) => node.status === "failed");
  if (!source) corrupt();
  const failure = rows.get(source.nodeId)!;
  for (const target of input.children.values()) {
    if (terminal(target.run.status)) continue;
    // A sibling may have changed since authority was loaded. Fence it before re-reading or writing.
    await reserve(client, `run:${parent.tenantId}:${target.child_run_id}`);
    const child = await ops.loadChild(client, {
      tenantId: parent.tenantId,
      runId: target.child_run_id,
    });
    if (!child) corrupt();
    if (terminal(child.status)) continue;
    const work = await readPostgresWorkflowChildWork(
      client,
      sql,
      parent,
      child,
      target,
    );
    if (work.kind !== "live") corrupt();
    if (child.cancelRequested) {
      await hasPostgresWorkflowFailureCancellation(
        client,
        sql,
        parent,
        child,
        target,
        state,
        rows,
      );
      continue;
    }
    const idempotency = {
      scope: scope(parent),
      key: target.claim_id,
      requestFingerprint: fingerprint(parent, child, target, failure),
    };
    await reserve(
      client,
      `idempotency:${idempotency.scope}:${idempotency.key}`,
    );
    await reserve(client, `thread:${child.tenantId}:${child.threadId}`);
    // NOWAIT row locks prevent deadlock with a Worker that owns this queue before acquiring the Run.
    try {
      const locked = await client.query(
        `SELECT work_item_id FROM ${sql}.work_items WHERE work_item_id=$1 AND tenant_id=$2 AND run_id=$3 AND status IN ('pending','leased') FOR UPDATE NOWAIT`,
        [work.work.workItemId, child.tenantId, child.runId],
      );
      if (locked.rowCount !== 1)
        throw new RunStoreError("workflow_child_work_authority_missing");
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "55P03"
      )
        throw new RunStoreError("postgres_retryable");
      throw error;
    }
    const result = await ops.commitChildRun(
      client,
      prepareWorkflowChildCancellation(
        { child, actorId: parent.createdByActorId, idempotency },
        (
          await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")
        ).rows[0]!.now.toISOString(),
        input.nextId,
      ),
    );
    if (result.disposition !== "committed") corrupt();
    const woke = await client.query(
      `UPDATE ${sql}.work_items SET available_at=LEAST(available_at,clock_timestamp()),last_error_code=$1 WHERE work_item_id=$2 AND tenant_id=$3 AND run_id=$4 AND status IN ('pending','leased')`,
      [
        RECONCILIATION_CANCEL_WAKE,
        work.work.workItemId,
        child.tenantId,
        child.runId,
      ],
    );
    if (woke.rowCount !== 1)
      throw new RunStoreError("workflow_child_work_authority_missing");
  }
  const nodes = await cancelPostgresWorkflowUnstartedNodes(
    client,
    sql,
    state,
    workflow,
    input.now,
  );
  if (nodes.every((node, i) => node === state.nodes[i])) return state;
  const next = projectWorkflowExecution(state, nodes, input.now);
  await writePostgresWorkflowExecution(client, sql, state, next);
  return next;
}

export async function hasPostgresWorkflowFailureCancellation(
  client: PoolClient,
  sql: string,
  parent: RunState,
  child: RunState,
  target: PostgresWorkflowChildRow,
  state: WorkflowExecutionState,
  nodes: ReadonlyMap<string, WorkflowNodeRow>,
): Promise<boolean> {
  const row = (
    await client.query<{
      tenant_id: string;
      run_id: string;
      fingerprint: string | null;
      json: unknown;
    }>(
      `SELECT tenant_id,run_id,CASE WHEN octet_length(fingerprint)<=128 THEN fingerprint ELSE NULL END AS fingerprint,
     CASE WHEN octet_length(result_json::text)<=16384 THEN result_json ELSE NULL END AS json FROM ${sql}.idempotency_receipts WHERE scope=$1 AND idempotency_key=$2`,
      [scope(parent), target.claim_id],
    )
  ).rows[0];
  if (!row) return false;
  if (
    row.tenant_id !== child.tenantId ||
    row.run_id !== child.runId ||
    !row.json ||
    !child.cancelRequested ||
    !state.nodes.some(
      (node) =>
        node.status === "failed" &&
        nodes.get(node.nodeId)?.settlement_fingerprint &&
        fingerprint(parent, child, target, nodes.get(node.nodeId)!) ===
          row.fingerprint,
    )
  )
    corrupt();
  const receipt = row.json as {
    state?: RunState;
    events?: {
      type: string;
      identity: { runId: string };
      data: { actorId: string };
      sequence: number;
    }[];
    workItems?: unknown[];
  };
  const event = receipt.events?.[0];
  if (
    receipt.state?.runId !== child.runId ||
    receipt.state.tenantId !== child.tenantId ||
    receipt.state.threadId !== child.threadId ||
    receipt.state.cancelRequested !== true ||
    !Array.isArray(receipt.events) ||
    !Array.isArray(receipt.workItems) ||
    receipt.events.length !== 1 ||
    receipt.workItems.length !== 0 ||
    event?.type !== "run.cancel.requested" ||
    event.identity?.runId !== child.runId ||
    event.data?.actorId !== parent.createdByActorId ||
    !Number.isSafeInteger(event.sequence) ||
    event.sequence < 1 ||
    event.sequence > child.lastSequence ||
    receipt.state.lastSequence !== event.sequence
  )
    corrupt();
  const canonical = (
    await client.query<{ json: unknown }>(
      `SELECT CASE WHEN octet_length(event_json::text)<=16384 THEN event_json ELSE NULL END AS json FROM ${sql}.run_events WHERE tenant_id=$1 AND run_id=$2 AND sequence=$3`,
      [child.tenantId, child.runId, event.sequence],
    )
  ).rows[0];
  if (
    !canonical?.json ||
    canonicalJson(canonical.json) !== canonicalJson(event)
  )
    corrupt();
  return true;
}
function scope(parent: RunState) {
  return canonicalJson({
    namespace: "workflow.failure-child-cancel.v1",
    tenantId: parent.tenantId,
    runId: parent.runId,
  });
}
function fingerprint(
  parent: RunState,
  child: RunState,
  target: PostgresWorkflowChildRow,
  source: WorkflowNodeRow,
) {
  return workflowAdmissionDigest.sha256(
    canonicalJson({
      binding: parent.workflowVersionBinding,
      sourceSettlement: source.settlement_fingerprint,
      childRunId: child.runId,
      claimId: target.claim_id,
    }),
  );
}
async function reserve(client: PoolClient, key: string) {
  if (
    (
      await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired",
        [key],
      )
    ).rows[0]?.acquired !== true
  )
    throw new RunStoreError("postgres_retryable");
}
function terminal(status: string) {
  return ["completed", "failed", "canceled"].includes(status);
}
function corrupt(): never {
  throw new RunStoreError("workflow_failure_cancel_authority_conflict");
}
