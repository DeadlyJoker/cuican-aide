import type { DatabaseSync } from "node:sqlite";
import {
  AUTONOMOUS_TASK_EDGE_LIST_MAX_LIMIT,
  captureAutonomousTaskEdgeLink,
  type AutonomousTaskEdge,
  type AutonomousTaskEdgeLink,
  type AutonomousTaskEdgeStore,
} from "@crewon/application";
import { RunStoreError } from "@crewon/application";

const TABLE = "autonomous_task_edges";
const SCHEMA = "autonomous_task_edge_schema";
export const AUTONOMOUS_TASK_CHILD_ADMISSIONS_TABLE =
  "autonomous_task_child_admissions";
const COLUMNS = `tenant_id TEXT NOT NULL, space_id TEXT NOT NULL,
 root_task_id TEXT NOT NULL, parent_task_id TEXT NOT NULL, child_task_id TEXT NOT NULL,
 depth INTEGER NOT NULL CHECK(depth>=1 AND depth<=8),
 child_ordinal INTEGER NOT NULL CHECK(child_ordinal>=1 AND child_ordinal<=32),
 created_at INTEGER NOT NULL CHECK(created_at>=0),
 PRIMARY KEY(tenant_id,space_id,parent_task_id,child_ordinal),
 UNIQUE(tenant_id,space_id,child_task_id)`;
const ADMISSION_COLUMNS = `tenant_id TEXT NOT NULL, space_id TEXT NOT NULL,
 parent_task_id TEXT NOT NULL, child_task_id TEXT NOT NULL,
 idempotency_key TEXT NOT NULL, budget_json TEXT NOT NULL,
 capability_json TEXT NOT NULL, intent_json TEXT NOT NULL,
 wake_key TEXT NOT NULL, created_at INTEGER NOT NULL CHECK(created_at>=0),
 PRIMARY KEY(tenant_id,space_id,child_task_id),
 UNIQUE(tenant_id,space_id,parent_task_id,idempotency_key),
 UNIQUE(tenant_id,space_id,wake_key)`;

type Host = Readonly<{ assertOpen(): void; now(): number }>;
type Row = Record<string, unknown>;

export class ExperimentalSqliteAutonomousTaskEdgeStore
  implements AutonomousTaskEdgeStore
{
  readonly #database: DatabaseSync;
  readonly #host: Host;

  constructor(database: DatabaseSync, host: Host) {
    this.#database = database;
    this.#host = host;
  }

  #schema(): void {
    const names = this.#database
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('${SCHEMA}','${TABLE}','${AUTONOMOUS_TASK_CHILD_ADMISSIONS_TABLE}')`,
      )
      .all();
    if (names.length !== 3)
      throw new RunStoreError("autonomous_task_edge_schema_unavailable");
    const versions = this.#database
      .prepare(`SELECT version FROM ${SCHEMA}`)
      .all();
    if (versions.length !== 1 || versions[0]!.version !== 1)
      throw new RunStoreError("autonomous_task_edge_schema_unsupported");
  }

  #transaction<T>(work: () => T, checkSchema = true): T {
    this.#host.assertOpen();
    if (this.#database.isTransaction)
      throw new RunStoreError("autonomous_task_edge_nested_transaction");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      if (checkSchema) this.#schema();
      const result = work();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  async migrate(): Promise<void> {
    this.#transaction(() => {
      const names = this.#database
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('${SCHEMA}','${TABLE}','${AUTONOMOUS_TASK_CHILD_ADMISSIONS_TABLE}')`,
        )
        .all();
      if (names.length !== 0) {
        const present = new Set(names.map((row) => String(row.name)));
        if (
          names.length === 2 &&
          present.has(SCHEMA) &&
          present.has(TABLE) &&
          !present.has(AUTONOMOUS_TASK_CHILD_ADMISSIONS_TABLE)
        ) {
          this.#database.exec(
            `CREATE TABLE ${AUTONOMOUS_TASK_CHILD_ADMISSIONS_TABLE} (${ADMISSION_COLUMNS}) STRICT;`,
          );
        }
        this.#schema();
        return;
      }
      this.#database
        .exec(`CREATE TABLE ${SCHEMA} (singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL CHECK(version=1)) STRICT;
        INSERT INTO ${SCHEMA} VALUES(1,1);
        CREATE TABLE ${TABLE} (${COLUMNS}) STRICT;
        CREATE TABLE ${AUTONOMOUS_TASK_CHILD_ADMISSIONS_TABLE} (${ADMISSION_COLUMNS}) STRICT;
        CREATE INDEX autonomous_task_edge_root_lookup ON ${TABLE}(tenant_id,space_id,root_task_id,depth,child_ordinal);`);
    }, false);
  }

  async link(input: Parameters<AutonomousTaskEdgeStore["link"]>[0]) {
    const edge = captureAutonomousTaskEdgeLink({
      schemaVersion: input.schemaVersion,
      rootTaskId: input.rootTaskId,
      parentTaskId: input.parentTaskId,
      childTaskId: input.childTaskId,
      depth: input.depth,
      childOrdinal: input.childOrdinal,
    });
    validateScope(input.tenantId, input.spaceId);
    return this.#transaction(() => {
      const parentRow = this.#database
        .prepare(
          `SELECT * FROM ${TABLE} WHERE tenant_id=? AND space_id=? AND parent_task_id=? AND child_ordinal=?`,
        )
        .get(
          input.tenantId,
          input.spaceId,
          edge.parentTaskId,
          edge.childOrdinal,
        ) as Row | undefined;
      const childRow = this.#database
        .prepare(
          `SELECT * FROM ${TABLE} WHERE tenant_id=? AND space_id=? AND child_task_id=?`,
        )
        .get(input.tenantId, input.spaceId, edge.childTaskId) as
        | Row
        | undefined;
      if (parentRow || childRow) {
        const row = parentRow ?? childRow;
        if (!row) throw new RunStoreError("autonomous_task_edge_corrupt");
        const existing = decode(row);
        if (!sameEdge(existing, edge))
          throw new RunStoreError("autonomous_task_edge_conflict");
        return { disposition: "replayed" as const, edge: existing };
      }
      const createdAt = this.#host.now();
      if (!Number.isSafeInteger(createdAt) || createdAt < 0)
        throw new RunStoreError("autonomous_task_edge_clock_invalid");
      this.#database
        .prepare(
          `INSERT INTO ${TABLE} (tenant_id,space_id,root_task_id,parent_task_id,child_task_id,depth,child_ordinal,created_at) VALUES(?,?,?,?,?,?,?,?)`,
        )
        .run(
          input.tenantId,
          input.spaceId,
          edge.rootTaskId,
          edge.parentTaskId,
          edge.childTaskId,
          edge.depth,
          edge.childOrdinal,
          createdAt,
        );
      return {
        disposition: "created" as const,
        edge: { ...edge, createdAt },
      };
    });
  }

  async listChildren(
    input: Parameters<AutonomousTaskEdgeStore["listChildren"]>[0],
  ) {
    validateScope(input.tenantId, input.spaceId);
    const parentTaskId = captureId(input.parentTaskId);
    const limit = listLimit(input.limit);
    this.#host.assertOpen();
    this.#schema();
    return this.#database
      .prepare(
        `SELECT * FROM ${TABLE} WHERE tenant_id=? AND space_id=? AND parent_task_id=? ORDER BY child_ordinal LIMIT ?`,
      )
      .all(input.tenantId, input.spaceId, parentTaskId, limit)
      .map((row) => decode(row as Row));
  }

  async listDescendants(
    input: Parameters<AutonomousTaskEdgeStore["listDescendants"]>[0],
  ) {
    validateScope(input.tenantId, input.spaceId);
    const rootTaskId = captureId(input.rootTaskId);
    const maxDepth = depthLimit(input.maxDepth);
    const limit = listLimit(input.limit);
    this.#host.assertOpen();
    this.#schema();
    return this.#database
      .prepare(
        `WITH RECURSIVE descendants AS (
           SELECT e.*, 1 AS hops FROM ${TABLE} e
           WHERE e.tenant_id=? AND e.space_id=? AND e.root_task_id=? AND e.parent_task_id=?
           UNION ALL
           SELECT e.*, d.hops + 1 FROM ${TABLE} e JOIN descendants d
             ON e.tenant_id=d.tenant_id AND e.space_id=d.space_id AND e.parent_task_id=d.child_task_id
           WHERE d.hops < ? AND e.root_task_id=?
         )
         SELECT tenant_id,space_id,root_task_id,parent_task_id,child_task_id,depth,child_ordinal,created_at
         FROM descendants ORDER BY depth,parent_task_id,child_ordinal LIMIT ?`,
      )
      .all(
        input.tenantId,
        input.spaceId,
        rootTaskId,
        rootTaskId,
        maxDepth,
        rootTaskId,
        limit,
      )
      .map((row) => decode(row as Row));
  }
}

function decode(row: Row): AutonomousTaskEdge {
  const edge = captureAutonomousTaskEdgeLink({
    schemaVersion: "crewon.autonomous-task-edge.v0",
    rootTaskId: row.root_task_id,
    parentTaskId: row.parent_task_id,
    childTaskId: row.child_task_id,
    depth: Number(row.depth),
    childOrdinal: Number(row.child_ordinal),
  });
  const createdAt = Number(row.created_at);
  if (!Number.isSafeInteger(createdAt) || createdAt < 0)
    throw new RunStoreError("autonomous_task_edge_corrupt");
  return Object.freeze({ ...edge, createdAt });
}

function sameEdge(
  actual: AutonomousTaskEdge,
  expected: AutonomousTaskEdgeLink,
): boolean {
  return (
    actual.rootTaskId === expected.rootTaskId &&
    actual.parentTaskId === expected.parentTaskId &&
    actual.childTaskId === expected.childTaskId &&
    actual.depth === expected.depth &&
    actual.childOrdinal === expected.childOrdinal
  );
}

function validateScope(tenantId: unknown, spaceId: unknown): void {
  captureId(tenantId);
  captureId(spaceId);
}
function captureId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new RunStoreError("autonomous_task_edge_scope_invalid");
  return value;
}
function listLimit(value: number | undefined): number {
  const limit = value ?? AUTONOMOUS_TASK_EDGE_LIST_MAX_LIMIT;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > AUTONOMOUS_TASK_EDGE_LIST_MAX_LIMIT
  )
    throw new RunStoreError("autonomous_task_edge_limit_invalid");
  return limit;
}
function depthLimit(value: number | undefined): number {
  const depth = value ?? 8;
  if (!Number.isSafeInteger(depth) || depth < 1 || depth > 8)
    throw new RunStoreError("autonomous_task_edge_depth_invalid");
  return depth;
}
