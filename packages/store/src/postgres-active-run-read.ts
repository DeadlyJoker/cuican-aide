import type { Pool } from "pg";
import type { ThreadScopedLocator } from "@crewon/application";
import {
  activeRunFromRows,
  MAX_ACTIVE_RUN_SNAPSHOT_BYTES,
  POSTGRES_LIVE_RUN_PREDICATE,
} from "./active-run-read.ts";
import {
  decodePostgresRunState,
  type PostgresRunRow,
} from "./postgres-run-codec.ts";
import { validateThreadScopedLocator } from "./store-invariants.ts";

export async function readPostgresActiveRun(
  pool: Pool,
  schema: string,
  locator: ThreadScopedLocator,
) {
  validateThreadScopedLocator(locator);
  const rows = await pool.query<PostgresRunRow & { stored_bytes: string }>(
    postgresActiveRunReadSql(schema),
    [locator.tenantId, locator.spaceId, locator.threadId],
  );
  return activeRunFromRows(rows.rows, locator, (row) =>
    decodePostgresRunState(row, {
      tenantId: locator.tenantId,
      runId: row.run_id,
    }),
  );
}

export function postgresActiveRunReadSql(schema: string): string {
  return `SELECT snapshots.tenant_id, snapshots.space_id, snapshots.run_id,
    snapshots.revision, snapshots.last_sequence, snapshots.updated_at, bindings.thread_id,
    octet_length(state_json::text) AS stored_bytes,
    CASE WHEN octet_length(state_json::text) <= ${MAX_ACTIVE_RUN_SNAPSHOT_BYTES} THEN state_json ELSE NULL END AS state_json
    FROM ${schema}.run_snapshots AS snapshots
    LEFT JOIN ${schema}.run_thread_bindings AS bindings ON bindings.tenant_id=snapshots.tenant_id AND bindings.run_id=snapshots.run_id
    WHERE snapshots.tenant_id=$1 AND snapshots.space_id=$2 AND (bindings.thread_id=$3 OR bindings.thread_id IS NULL)
    AND ${POSTGRES_LIVE_RUN_PREDICATE} ORDER BY snapshots.run_id ASC LIMIT 2`;
}
