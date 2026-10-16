import { RunStoreError, type ThreadScopedLocator } from "@crewon/application";
import type { RunState } from "@crewon/domain";

export const MAX_ACTIVE_RUN_SNAPSHOT_BYTES = 1024 * 1024;
export const SQLITE_LIVE_RUN_PREDICATE = "active_read = 1";
export const POSTGRES_LIVE_RUN_PREDICATE = "active_read";
const SQLITE_LIVE_VALUE =
  "COALESCE(json_extract(state_json, '$.status'), '') NOT IN ('completed', 'failed', 'canceled')";
const POSTGRES_LIVE_VALUE =
  "COALESCE(state_json->>'status', '') NOT IN ('completed', 'failed', 'canceled')";

export function migrateSqliteActiveRunIndex(
  database: import("node:sqlite").DatabaseSync,
): void {
  const column = database
    .prepare("PRAGMA table_xinfo(run_snapshots)")
    .all()
    .find((row) => row.name === "active_read");
  if (column === undefined)
    database.exec(
      `ALTER TABLE run_snapshots ADD COLUMN active_read INTEGER GENERATED ALWAYS AS (${SQLITE_LIVE_VALUE}) VIRTUAL`,
    );
  else if (column.hidden !== 2)
    throw new RunStoreError("active_run_index_column_invalid");
  database.exec(sqliteActiveRunIndexSql());
}

export function sqliteActiveRunIndexSql(): string {
  return `CREATE INDEX IF NOT EXISTS run_snapshots_live_scope_idx
    ON run_snapshots(tenant_id, space_id, run_id)
    WHERE ${SQLITE_LIVE_RUN_PREDICATE};`;
}

export function postgresActiveRunIndexSql(schema: string): string {
  return `DO $active_read$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='${schema}.run_snapshots'::regclass AND attname='active_read' AND NOT attisdropped) THEN
        ALTER TABLE ${schema}.run_snapshots ADD COLUMN IF NOT EXISTS active_read boolean GENERATED ALWAYS AS (${POSTGRES_LIVE_VALUE}) STORED;
      END IF;
    END $active_read$;
    DO $existing_index$ BEGIN
      IF to_regclass('${schema}.run_snapshots_live_scope_idx') IS NULL THEN
        CREATE INDEX IF NOT EXISTS run_snapshots_live_scope_idx
    ON ${schema}.run_snapshots(tenant_id, space_id, run_id)
    WHERE ${POSTGRES_LIVE_RUN_PREDICATE};
      END IF;
    END $existing_index$;`;
}

/** The query returns at most two rows and suppresses oversized JSON before decoding. */
export function activeRunFromRows<
  Row extends { stored_bytes: number | string },
>(
  rows: readonly Row[],
  locator: ThreadScopedLocator,
  decode: (row: Row) => RunState,
): RunState | null {
  if (rows.length > 1) throw new RunStoreError("thread_active_run_invariant");
  const row = rows[0];
  if (row === undefined) return null;
  const bytes = Number(row.stored_bytes);
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    bytes > MAX_ACTIVE_RUN_SNAPSHOT_BYTES
  )
    throw new RunStoreError("thread_active_run_too_large");
  const state = decode(row);
  if (
    state.tenantId !== locator.tenantId ||
    state.spaceId !== locator.spaceId ||
    state.threadId !== locator.threadId ||
    ![
      "queued",
      "running",
      "waitingApproval",
      "suspended",
      "reconciling",
    ].includes(state.status)
  )
    throw new RunStoreError("thread_active_run_identity_invalid");
  return state;
}
