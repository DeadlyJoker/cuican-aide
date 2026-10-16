import type { Pool, PoolClient } from "pg";
import {
  ApplicationError,
  RunStoreError,
  type WorkflowSchedulerInput,
} from "@crewon/application";
import { parseWorkflowVersionIdentityId, type RunState } from "@crewon/domain";
import type { PostgresWorkflowCompositionDependencies } from "./postgres-workflow-run-composition.ts";
import { readPostgresWorkflowCompositionContext } from "./postgres-workflow-composition-context.ts";
import { assertPostgresWorkflowCompositionSchema } from "./postgres-workflow-composition-schema.ts";
import { lockProviderSettingsTenant } from "./postgres-model-provider-settings-store.ts";
import { advisoryLock } from "./postgres-thread-lock.ts";
import {
  normalizePostgresError,
  rollbackPostgres,
} from "./postgres-store-support.ts";
export type WorkflowTransactionMode = Readonly<{
  lease: "current" | "settling";
}>;
export type WorkflowTransactionCallback<T> = (
  client: PoolClient,
  run: RunState,
  context: Awaited<ReturnType<typeof readPostgresWorkflowCompositionContext>>,
  time: { now: number; expiresAt: number; alreadySettled: boolean },
) => Promise<T>;
/** Shared parent transaction fence. Queue acknowledgement cannot extend the original lease deadline. */
export async function withPostgresWorkflowTransaction<T>(
  input: WorkflowSchedulerInput,
  execute: WorkflowTransactionCallback<T>,
  options: WorkflowTransactionMode,
  adapter: {
    pool: Pool;
    sql: string;
    schema: string;
    dependencies: PostgresWorkflowCompositionDependencies;
  },
): Promise<T> {
  adapter.dependencies.assertOpen();
  for (const id of [
    input.tenantId,
    input.runId,
    input.schedulerOperationId,
    input.lease.workItemId,
    input.lease.ownerId,
    input.lease.leaseId,
  ])
    parseWorkflowVersionIdentityId(id, "workflow_composition_input_invalid");
  if (
    !Number.isSafeInteger(input.lease.leaseEpoch) ||
    input.lease.leaseEpoch < 1
  )
    throw new RunStoreError("workflow_composition_input_invalid");
  const client = await adapter.pool.connect();
  try {
    await client.query("BEGIN");
    await lockProviderSettingsTenant(client, adapter.sql, input.tenantId);
    await advisoryLock(client, `run:${input.tenantId}:${input.runId}`);
    const bytes = await client.query<{ bytes: number }>(
      `SELECT octet_length(state_json::text) AS bytes FROM ${adapter.sql}.run_snapshots WHERE tenant_id=$1 AND run_id=$2`,
      [input.tenantId, input.runId],
    );
    if (bytes.rows[0] && bytes.rows[0].bytes > 16384)
      throw new RunStoreError("workflow_root_state_limit");
    const run = await adapter.dependencies.loadRoot(client, input);
    if (!run) throw new RunStoreError("run_not_found");
    let alreadySettled = false;
    if (options.lease === "settling" && terminal(run.status)) {
      const row = (
        await client.query<{
          tenant_id: string;
          run_id: string;
          status: string;
          lease_epoch: string;
        }>(
          `SELECT tenant_id,run_id,status,lease_epoch FROM ${adapter.sql}.work_items WHERE work_item_id=$1 FOR UPDATE`,
          [input.lease.workItemId],
        )
      ).rows[0];
      if (
        !row ||
        row.tenant_id !== input.tenantId ||
        row.run_id !== input.runId
      )
        throw new RunStoreError("work_item_scope_mismatch");
      if (Number(row.lease_epoch) !== input.lease.leaseEpoch)
        throw new RunStoreError("stale_lease");
      alreadySettled = row.status === "completed";
    }
    const clock = alreadySettled
      ? (
          await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")
        ).rows[0]!.now.getTime()
      : null;
    const time = {
      ...(alreadySettled
        ? { now: clock!, expiresAt: clock! }
        : await adapter.dependencies.validateLease(client, input)),
      alreadySettled,
    };
    const context = await readPostgresWorkflowCompositionContext(
      client,
      adapter.sql,
      { ...input, run },
    );
    await assertPostgresWorkflowCompositionSchema(client, adapter.schema);
    const result = await execute(client, run, context, time);
    if (options.lease === "current")
      await adapter.dependencies.validateLease(client, input);
    else {
      const row = (
        await client.query<{
          tenant_id: string;
          run_id: string;
          status: string;
          lease_epoch: string;
        }>(
          `SELECT tenant_id,run_id,status,lease_epoch FROM ${adapter.sql}.work_items WHERE work_item_id=$1`,
          [input.lease.workItemId],
        )
      ).rows[0];
      if (
        !row ||
        row.tenant_id !== input.tenantId ||
        row.run_id !== input.runId ||
        row.status !== "completed" ||
        Number(row.lease_epoch) !== input.lease.leaseEpoch
      )
        throw new RunStoreError("workflow_scheduler_ack_missing");
      if (!alreadySettled) {
        const now = (
          await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")
        ).rows[0]!.now.getTime();
        if (now >= time.expiresAt) throw new RunStoreError("lease_expired");
      }
    }
    await client.query("COMMIT");
    return structuredClone(result);
  } catch (error) {
    await rollbackPostgres(client);
    throw error instanceof ApplicationError
      ? error
      : normalizePostgresError(error);
  } finally {
    client.release();
  }
}
function terminal(status: RunState["status"]) {
  return ["completed", "failed", "canceled"].includes(status);
}
