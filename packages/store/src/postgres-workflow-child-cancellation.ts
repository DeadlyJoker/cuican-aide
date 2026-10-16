import type { PoolClient } from "pg";
import {
  RunStoreError,
  type CommitRunInput,
  type WorkItem,
} from "@crewon/application";
import type { RunState } from "@crewon/domain";
import type {
  PostgresWorkflowChildOperations,
  PostgresWorkflowChildRow,
} from "./postgres-workflow-children.ts";
import { prepareWorkflowChildCancellation } from "./workflow-child-cancellation.ts";
import { RECONCILIATION_CANCEL_WAKE } from "./reconciliation-cancellation-wake.ts";
export type PostgresWorkflowCancellationOperations = Pick<
  PostgresWorkflowChildOperations,
  "loadChild" | "commitChildRun"
>;

export async function lockPostgresWorkflowChild(
  client: PoolClient,
  parent: RunState,
  target: PostgresWorkflowChildRow,
  ops: PostgresWorkflowCancellationOperations,
) {
  await reserve(client, `run:${parent.tenantId}:${target.child_run_id}`);
  const child = await ops.loadChild(client, {
    tenantId: parent.tenantId,
    runId: target.child_run_id,
  });
  if (!child)
    throw new RunStoreError("workflow_child_cancel_authority_conflict");
  return child;
}
/** Both root cancellation and frozen failure policy use the ordinary child cancellation protocol. */
export async function commitPostgresWorkflowChildCancellation(
  client: PoolClient,
  sql: string,
  input: {
    child: RunState;
    actorId: string;
    idempotency: CommitRunInput["idempotency"];
    work: WorkItem;
  },
  ops: PostgresWorkflowCancellationOperations,
  nextId: () => string,
) {
  await reserve(
    client,
    `idempotency:${input.idempotency.scope}:${input.idempotency.key}`,
  );
  await reserve(
    client,
    `thread:${input.child.tenantId}:${input.child.threadId}`,
  );
  await lockQueue(client, sql, input.child, input.work);
  const now = (
    await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")
  ).rows[0]!.now.toISOString();
  if (
    (
      await ops.commitChildRun(
        client,
        prepareWorkflowChildCancellation(input, now, nextId),
      )
    ).disposition !== "committed"
  )
    throw new RunStoreError("workflow_child_cancel_authority_conflict");
  await updateWake(client, sql, input.child, input.work);
}
export async function wakePostgresWorkflowChildCancellation(
  client: PoolClient,
  sql: string,
  child: RunState,
  work: WorkItem,
) {
  await lockQueue(client, sql, child, work);
  await updateWake(client, sql, child, work);
}
async function lockQueue(
  client: PoolClient,
  sql: string,
  child: RunState,
  work: WorkItem,
) {
  try {
    const locked = await client.query(
      `SELECT work_item_id FROM ${sql}.work_items WHERE work_item_id=$1 AND tenant_id=$2 AND run_id=$3 AND status IN ('pending','leased') FOR UPDATE NOWAIT`,
      [work.workItemId, child.tenantId, child.runId],
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
}
async function updateWake(
  client: PoolClient,
  sql: string,
  child: RunState,
  work: WorkItem,
) {
  const woke = await client.query(
    `UPDATE ${sql}.work_items SET available_at=LEAST(available_at,clock_timestamp()),last_error_code=$1 WHERE work_item_id=$2 AND tenant_id=$3 AND run_id=$4 AND status IN ('pending','leased')`,
    [RECONCILIATION_CANCEL_WAKE, work.workItemId, child.tenantId, child.runId],
  );
  if (woke.rowCount !== 1)
    throw new RunStoreError("workflow_child_work_authority_missing");
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
