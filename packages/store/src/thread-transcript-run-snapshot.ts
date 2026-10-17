import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import { parseRunView, type RunView } from "@crewon/contracts";
import {
  RunStoreError,
  type ThreadMessageRunBinding,
  type ThreadScopedLocator,
  type ThreadTranscriptRunSnapshot,
} from "@crewon/application";
import type { RunState } from "@crewon/domain";
import {
  SQLITE_LIVE_RUN_PREDICATE,
  POSTGRES_LIVE_RUN_PREDICATE,
} from "./active-run-read.ts";

const FIELDS = [
  "runId",
  "threadId",
  "status",
  "revision",
  "lastSequence",
  "cancelRequested",
  "waitingApproval",
  "collaborationMode",
  "purpose",
  "workflowVersionBinding",
  "goalBinding",
  "outputRef",
  "failure",
  "createdAt",
  "updatedAt",
  "terminalAt",
] as const;
const MAX_RUN_BYTES = 64 * 1024;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
type Row = {
  run_id: string;
  identity_valid: number | boolean;
  stored_bytes: string | number;
  run_view: unknown;
};
const terminal = new Set(["completed", "failed", "canceled"]);

function ids(bindings: readonly ThreadMessageRunBinding[]) {
  if (bindings.length > 100)
    throw new RunStoreError("transcript_runs_limit_invalid");
  return [
    ...new Set(bindings.flatMap((b) => (b.runId === null ? [] : [b.runId]))),
  ];
}
function finish(
  locator: ThreadScopedLocator,
  requested: string[],
  active: Row[],
  history: Row[],
): ThreadTranscriptRunSnapshot {
  if (active.length > 1) throw new RunStoreError("thread_active_run_invariant");
  let bytes = 0;
  const decode = (row: Row): RunView => {
    const size = Number(row.stored_bytes);
    bytes += size;
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > MAX_RUN_BYTES ||
      bytes > MAX_PAGE_BYTES
    )
      throw new RunStoreError("transcript_runs_too_large");
    if (row.identity_valid !== true && row.identity_valid !== 1)
      throw new RunStoreError("transcript_run_identity_invalid");
    const run = parseRunView(
      typeof row.run_view === "string"
        ? JSON.parse(row.run_view)
        : row.run_view,
      locator.threadId,
    );
    if (run.runId !== row.run_id)
      throw new RunStoreError("transcript_run_identity_invalid");
    return run;
  };
  const activeRun = active[0] === undefined ? null : decode(active[0]);
  if (activeRun !== null && terminal.has(activeRun.status))
    throw new RunStoreError("thread_active_run_identity_invalid");
  const runs = new Map<string, RunView>();
  if (activeRun) runs.set(activeRun.runId, activeRun);
  for (const row of history) {
    if (!requested.includes(row.run_id) || runs.has(row.run_id))
      throw new RunStoreError("transcript_run_identity_invalid");
    runs.set(row.run_id, decode(row));
  }
  if (requested.some((id) => !runs.has(id)))
    throw new RunStoreError("transcript_run_missing");
  return { runs: [...runs.values()], activeRunId: activeRun?.runId ?? null };
}
function expressions(postgres: boolean) {
  const value = (key: string) =>
    postgres
      ? `s.state_json->'${key}'`
      : `json_extract(s.state_json, '$.${key}')`;
  const text = (key: string) =>
    postgres ? `s.state_json->>'${key}'` : value(key);
  const fields = FIELDS.map((key) => {
    let v = value(key);
    if (key === "cancelRequested" && !postgres)
      v =
        "json(CASE json_type(s.state_json, '$.cancelRequested') WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' ELSE 'null' END)";
    if (key === "waitingApproval") {
      const approval = postgres
        ? "s.state_json->'waitingApproval'->'approvalId'"
        : "json_extract(s.state_json, '$.waitingApproval.approvalId')";
      v = `CASE WHEN ${approval} IS NULL THEN NULL ELSE ${postgres ? "jsonb_build_object" : "json_object"}('approvalId', ${approval}) END`;
    }
    if (key === "purpose")
      v = postgres
        ? `COALESCE(${v}, '"turn"'::jsonb)`
        : `COALESCE(${v}, 'turn')`;
    return `'${key}', ${v}`;
  });
  const view = `${postgres ? "jsonb_build_object" : "json_object"}(${fields.join(",")})`;
  const size = postgres
    ? `octet_length((${view})::text)`
    : `length(CAST(${view} AS BLOB))`;
  const identity = ["tenantId", "spaceId", "runId", "threadId"]
    .map(
      (key, i) =>
        `${text(key)} = ${["s.tenant_id", "s.space_id", "s.run_id", "b.thread_id"][i]}`,
    )
    .concat([
      `${text("revision")} ${postgres ? "= s.revision::text" : "= s.revision"}`,
      `${text("lastSequence")} ${postgres ? "= s.last_sequence::text" : "= s.last_sequence"}`,
    ])
    .join(" AND ");
  return `s.run_id, (${identity}) AS identity_valid, ${size} AS stored_bytes, CASE WHEN ${size} <= ${MAX_RUN_BYTES} THEN ${view} ELSE NULL END AS run_view`;
}

/** Shared bounded public projection; the query supplies snapshots as s and bindings as b. */
export function postgresPublicRunSummaryColumns(): string {
  return expressions(true);
}

/** Caller owns the existing short message-window transaction; no full Run/tool bodies leave SQL. */
export function readSqliteTranscriptRuns(
  database: DatabaseSync,
  locator: ThreadScopedLocator,
  bindings: readonly ThreadMessageRunBinding[],
): ThreadTranscriptRunSnapshot {
  const requested = ids(bindings);
  const from = `FROM run_snapshots s LEFT JOIN run_thread_bindings b ON b.tenant_id=s.tenant_id AND b.run_id=s.run_id`;
  const select = expressions(false);
  const active = database
    .prepare(
      `SELECT ${select} ${from.replace("run_snapshots s", "run_snapshots s INDEXED BY run_snapshots_live_scope_idx")} WHERE s.tenant_id=? AND s.space_id=? AND (b.thread_id=? OR b.thread_id IS NULL) AND s.${SQLITE_LIVE_RUN_PREDICATE} ORDER BY s.run_id LIMIT 2`,
    )
    .all(locator.tenantId, locator.spaceId, locator.threadId) as Row[];
  const historicalIds = requested.filter((id) => id !== active[0]?.run_id);
  const history =
    historicalIds.length === 0
      ? []
      : (database
          .prepare(
            `SELECT ${select} ${from} WHERE s.tenant_id=? AND s.space_id=? AND b.thread_id=? AND s.run_id IN (${historicalIds.map(() => "?").join(",")})`,
          )
          .all(
            locator.tenantId,
            locator.spaceId,
            locator.threadId,
            ...historicalIds,
          ) as Row[]);
  return finish(locator, requested, active, history);
}
export async function readPostgresTranscriptRuns(
  client: PoolClient,
  schema: string,
  locator: ThreadScopedLocator,
  bindings: readonly ThreadMessageRunBinding[],
): Promise<ThreadTranscriptRunSnapshot> {
  const requested = ids(bindings);
  const from = `FROM ${schema}.run_snapshots s LEFT JOIN ${schema}.run_thread_bindings b ON b.tenant_id=s.tenant_id AND b.run_id=s.run_id`;
  const select = expressions(true);
  const params = [locator.tenantId, locator.spaceId, locator.threadId];
  const active = (
    await client.query<Row>(
      `SELECT ${select} ${from} WHERE s.tenant_id=$1 AND s.space_id=$2 AND (b.thread_id=$3 OR b.thread_id IS NULL) AND s.${POSTGRES_LIVE_RUN_PREDICATE} ORDER BY s.run_id LIMIT 2`,
      params,
    )
  ).rows;
  const historicalIds = requested.filter((id) => id !== active[0]?.run_id);
  const history =
    historicalIds.length === 0
      ? []
      : (
          await client.query<Row>(
            `SELECT ${select} ${from} WHERE s.tenant_id=$1 AND s.space_id=$2 AND b.thread_id=$3 AND s.run_id=ANY($4::text[])`,
            [...params, historicalIds],
          )
        ).rows;
  return finish(locator, requested, active, history);
}
export function readInMemoryTranscriptRuns(
  locator: ThreadScopedLocator,
  bindings: readonly ThreadMessageRunBinding[],
  active: readonly RunState[],
  load: (id: string) => RunState | undefined,
): ThreadTranscriptRunSnapshot {
  const row = (run: RunState): Row => {
    const view = Object.fromEntries(
      FIELDS.map((key) => [
        key,
        key === "waitingApproval"
          ? run.waitingApproval === null
            ? null
            : { approvalId: run.waitingApproval.approvalId }
          : (run[key] ?? (key === "purpose" ? "turn" : null)),
      ]),
    );
    const json = JSON.stringify(view);
    return {
      run_id: run.runId,
      identity_valid:
        run.tenantId === locator.tenantId &&
        run.spaceId === locator.spaceId &&
        run.threadId === locator.threadId,
      stored_bytes: new TextEncoder().encode(json).byteLength,
      run_view: view,
    };
  };
  const requested = ids(bindings);
  return finish(
    locator,
    requested,
    active.map(row),
    requested
      .filter((id) => id !== active[0]?.runId)
      .flatMap((id) => {
        const run = load(id);
        return run === undefined ? [] : [row(run)];
      }),
  );
}
