import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { ThreadScopedLocator } from "@crewon/application";
import type { RunState } from "@crewon/domain";
import {
  activeRunFromRows,
  MAX_ACTIVE_RUN_SNAPSHOT_BYTES,
  SQLITE_LIVE_RUN_PREDICATE,
} from "./active-run-read.ts";
import { validateThreadScopedLocator } from "./store-invariants.ts";

export function readSqliteActiveRun<Row extends Record<string, SQLOutputValue>>(
  database: DatabaseSync,
  locator: ThreadScopedLocator,
  decode: (row: Row) => RunState,
): RunState | null {
  validateThreadScopedLocator(locator);
  const rows = database
    .prepare(sqliteActiveRunReadSql())
    .all(locator.tenantId, locator.spaceId, locator.threadId) as (Row & {
    stored_bytes: number;
  })[];
  return activeRunFromRows(rows, locator, decode);
}

export function sqliteActiveRunReadSql(): string {
  return `SELECT snapshots.tenant_id, snapshots.space_id, snapshots.run_id,
    snapshots.revision, snapshots.last_sequence, bindings.thread_id,
    length(CAST(state_json AS BLOB)) AS stored_bytes,
    CASE WHEN length(CAST(state_json AS BLOB)) <= ${MAX_ACTIVE_RUN_SNAPSHOT_BYTES} THEN state_json ELSE NULL END AS state_json
    FROM run_snapshots AS snapshots INDEXED BY run_snapshots_live_scope_idx
    LEFT JOIN run_thread_bindings AS bindings ON bindings.tenant_id=snapshots.tenant_id AND bindings.run_id=snapshots.run_id
    WHERE snapshots.tenant_id=? AND snapshots.space_id=? AND (bindings.thread_id=? OR bindings.thread_id IS NULL)
    AND ${SQLITE_LIVE_RUN_PREDICATE} ORDER BY snapshots.run_id ASC LIMIT 2`;
}
