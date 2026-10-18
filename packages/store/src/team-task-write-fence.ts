import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import type { TeamTaskWriteFence } from "@crewon/application/team-task-journal";
import { RunStoreError } from "@crewon/application";

function validateFenceShape(fence: TeamTaskWriteFence): void {
  const values = [
    fence.tenantId,
    fence.spaceId,
    fence.taskId,
    fence.ownerId,
    fence.leaseId,
  ];
  if (
    values.some(
      (value) =>
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > 256 ||
        value.trim() !== value,
    ) ||
    !Number.isSafeInteger(fence.epoch) ||
    fence.epoch < 1
  )
    throw new RunStoreError("team_task_reservation_invalid");
}

function assertLease(
  fence: TeamTaskWriteFence,
  row:
    | { owner: unknown; lease: unknown; epoch: unknown; expires: unknown }
    | undefined,
  now: number,
): void {
  if (
    row === undefined ||
    row.owner !== fence.ownerId ||
    row.lease !== fence.leaseId ||
    Number(row.epoch) !== fence.epoch ||
    !Number.isSafeInteger(Number(row.expires)) ||
    Number(row.expires) <= now
  )
    throw new RunStoreError("team_task_reservation_lost");
}

export function assertSqliteTeamTaskWriteFence(
  database: DatabaseSync,
  fence: TeamTaskWriteFence | undefined,
  threadId: string,
  now: number,
): void {
  if (fence === undefined) {
    try {
      const reserved = database
        .prepare(
          `SELECT 1 FROM team_task_journals
           WHERE thread_id=? AND status='coordinating' LIMIT 1`,
        )
        .get(threadId);
      if (reserved !== undefined)
        throw new RunStoreError("team_task_main_reserved");
      return;
    } catch (error) {
      if (error instanceof RunStoreError) throw error;
      if (String(error).includes("no such table: team_task_journals")) return;
      throw new RunStoreError("team_task_reservation_unavailable", {
        cause: error,
      });
    }
  }
  validateFenceShape(fence);
  try {
    const row = database
      .prepare(
        `SELECT lease_owner AS owner, lease_id AS lease, lease_epoch AS epoch,
                lease_expires_at AS expires
         FROM team_task_journals
         WHERE tenant_id=? AND space_id=? AND task_id=?
           AND status='coordinating'`,
      )
      .get(fence.tenantId, fence.spaceId, fence.taskId) as
      | { owner: unknown; lease: unknown; epoch: unknown; expires: unknown }
      | undefined;
    assertLease(fence, row, now);
  } catch (error) {
    if (error instanceof RunStoreError) throw error;
    throw new RunStoreError("team_task_reservation_unavailable", {
      cause: error,
    });
  }
}

export async function assertPostgresTeamTaskWriteFence(
  client: PoolClient,
  schema: string,
  fence: TeamTaskWriteFence | undefined,
  threadId: string,
  now: number,
): Promise<void> {
  if (fence === undefined) {
    try {
      const present = await client.query<{ present: string | null }>(
        "SELECT to_regclass($1) AS present",
        [`${schema}.team_task_journals`],
      );
      if (present.rows[0]?.present === null) return;
      const result = await client.query(
        `SELECT 1 FROM ${schema}.team_task_journals
         WHERE thread_id=$1 AND status='coordinating' LIMIT 1`,
        [threadId],
      );
      if (result.rows.length !== 0)
        throw new RunStoreError("team_task_main_reserved");
      return;
    } catch (error) {
      if (error instanceof RunStoreError) throw error;
      if (
        (error as { code?: string }).code === "42P01" ||
        String(error).includes("does not exist")
      )
        return;
      throw new RunStoreError("team_task_reservation_unavailable", {
        cause: error,
      });
    }
  }
  validateFenceShape(fence);
  try {
    const result = await client.query(
      `SELECT lease_owner AS owner, lease_id AS lease, lease_epoch AS epoch,
              lease_expires_at AS expires
       FROM ${schema}.team_task_journals
       WHERE tenant_id=$1 AND space_id=$2 AND task_id=$3
         AND status='coordinating'
       FOR SHARE`,
      [fence.tenantId, fence.spaceId, fence.taskId],
    );
    assertLease(fence, result.rows[0], now);
  } catch (error) {
    if (error instanceof RunStoreError) throw error;
    throw new RunStoreError("team_task_reservation_unavailable", {
      cause: error,
    });
  }
}
