import type { Pool, PoolClient } from "pg";
import {
  AUTONOMOUS_TASK_EDGE_LIST_MAX_LIMIT,
  captureAutonomousTaskEdgeLink,
  type AutonomousTaskEdge,
  type AutonomousTaskEdgeLink,
  type AutonomousTaskEdgeStore,
} from "@crewon/application";
import { RunStoreError } from "@crewon/application";
import { advisoryLock } from "./postgres-thread-lock.ts";
import { rollbackPostgres } from "./postgres-store-support.ts";

const SCHEMA = "autonomous_task_edge_schema";
const TABLE = "autonomous_task_edges";
const COLUMNS = `tenant_id TEXT NOT NULL, space_id TEXT NOT NULL,
 root_task_id TEXT NOT NULL, parent_task_id TEXT NOT NULL, child_task_id TEXT NOT NULL,
 depth INTEGER NOT NULL CHECK(depth>=1 AND depth<=8),
 child_ordinal INTEGER NOT NULL CHECK(child_ordinal>=1 AND child_ordinal<=32),
 created_at BIGINT NOT NULL CHECK(created_at>=0),
 PRIMARY KEY(tenant_id,space_id,parent_task_id,child_ordinal),
 UNIQUE(tenant_id,space_id,child_task_id)`;

type Row = Record<string, unknown>;

export class ExperimentalPostgresAutonomousTaskEdgeStore
  implements AutonomousTaskEdgeStore
{
  readonly #pool: Pool;
  readonly #schemaSql: string;
  readonly #assertOpen: () => void;

  constructor(pool: Pool, schemaSql: string, assertOpen: () => void) {
    this.#pool = pool;
    this.#schemaSql = schemaSql;
    this.#assertOpen = assertOpen;
  }

  #table(name: string): string {
    return `${this.#schemaSql}.${name}`;
  }

  async #schema(client: PoolClient | Pool): Promise<void> {
    const { rows } = await client.query(
      "SELECT to_regclass($1) AS schema_table,to_regclass($2) AS edge_table",
      [this.#table(SCHEMA), this.#table(TABLE)],
    );
    if (
      rows.length !== 1 ||
      rows[0]!.schema_table === null ||
      rows[0]!.edge_table === null
    )
      throw new RunStoreError("autonomous_task_edge_schema_unavailable");
    const version = await client.query(
      `SELECT version FROM ${this.#table(SCHEMA)} LIMIT 2`,
    );
    if (version.rows.length !== 1 || Number(version.rows[0]!.version) !== 1)
      throw new RunStoreError("autonomous_task_edge_schema_unsupported");
  }

  async #transaction<T>(
    scope: { tenantId: string; spaceId: string } | null,
    work: (client: PoolClient) => Promise<T>,
    checkSchema = true,
  ): Promise<T> {
    this.#assertOpen();
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await advisoryLock(
        client,
        JSON.stringify([
          "autonomous-task-edge",
          this.#schemaSql,
          scope === null ? "schema" : [scope.tenantId, scope.spaceId],
        ]),
      );
      if (checkSchema) await this.#schema(client);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollbackPostgres(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async #now(client: PoolClient): Promise<number> {
    const { rows } = await client.query(
      "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now",
    );
    const now = Number(rows[0]!.now);
    if (!Number.isSafeInteger(now) || now < 0)
      throw new RunStoreError("autonomous_task_edge_clock_invalid");
    return now;
  }

  async migrate(): Promise<void> {
    await this.#transaction(
      null,
      async (client) => {
        const { rows } = await client.query(
          "SELECT to_regclass($1) AS schema_table,to_regclass($2) AS edge_table",
          [this.#table(SCHEMA), this.#table(TABLE)],
        );
        const present =
          rows.length === 1 &&
          rows[0]!.schema_table !== null &&
          rows[0]!.edge_table !== null;
        if (present) {
          await this.#schema(client);
          return;
        }
        if (
          rows.length === 1 &&
          (rows[0]!.schema_table !== null || rows[0]!.edge_table !== null)
        )
          throw new RunStoreError("autonomous_task_edge_schema_corrupt");
        await client.query(`CREATE TABLE ${this.#table(SCHEMA)} (singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL CHECK(version=1));
          INSERT INTO ${this.#table(SCHEMA)} VALUES(1,1);
          CREATE TABLE ${this.#table(TABLE)} (${COLUMNS});
          CREATE INDEX autonomous_task_edge_root_lookup ON ${this.#table(TABLE)}(tenant_id,space_id,root_task_id,depth,child_ordinal);`);
      },
      false,
    );
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
    return this.#transaction(input, async (client) => {
      const existing = await client.query(
        `SELECT * FROM ${this.#table(TABLE)} WHERE tenant_id=$1 AND space_id=$2 AND ((parent_task_id=$3 AND child_ordinal=$4) OR child_task_id=$5) LIMIT 2`,
        [
          input.tenantId,
          input.spaceId,
          edge.parentTaskId,
          edge.childOrdinal,
          edge.childTaskId,
        ],
      );
      if (existing.rows.length !== 0) {
        const prior = decode(existing.rows[0] as Row);
        if (!sameEdge(prior, edge))
          throw new RunStoreError("autonomous_task_edge_conflict");
        return { disposition: "replayed" as const, edge: prior };
      }
      const createdAt = await this.#now(client);
      await client.query(
        `INSERT INTO ${this.#table(TABLE)} (tenant_id,space_id,root_task_id,parent_task_id,child_task_id,depth,child_ordinal,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          input.tenantId,
          input.spaceId,
          edge.rootTaskId,
          edge.parentTaskId,
          edge.childTaskId,
          edge.depth,
          edge.childOrdinal,
          createdAt,
        ],
      );
      return { disposition: "created" as const, edge: { ...edge, createdAt } };
    });
  }

  async listChildren(
    input: Parameters<AutonomousTaskEdgeStore["listChildren"]>[0],
  ) {
    validateScope(input.tenantId, input.spaceId);
    const parentTaskId = captureId(input.parentTaskId);
    const limit = listLimit(input.limit);
    this.#assertOpen();
    await this.#schema(this.#pool);
    const { rows } = await this.#pool.query(
      `SELECT * FROM ${this.#table(TABLE)} WHERE tenant_id=$1 AND space_id=$2 AND parent_task_id=$3 ORDER BY child_ordinal LIMIT $4`,
      [input.tenantId, input.spaceId, parentTaskId, limit],
    );
    return rows.map((row) => decode(row as Row));
  }

  async listDescendants(
    input: Parameters<AutonomousTaskEdgeStore["listDescendants"]>[0],
  ) {
    validateScope(input.tenantId, input.spaceId);
    const rootTaskId = captureId(input.rootTaskId);
    const maxDepth = depthLimit(input.maxDepth);
    const limit = listLimit(input.limit);
    this.#assertOpen();
    await this.#schema(this.#pool);
    const { rows } = await this.#pool.query(
      `WITH RECURSIVE descendants AS (
         SELECT e.*,1 AS hops FROM ${this.#table(TABLE)} e
         WHERE e.tenant_id=$1 AND e.space_id=$2 AND e.root_task_id=$3 AND e.parent_task_id=$3
         UNION ALL
         SELECT e.*,d.hops+1 FROM ${this.#table(TABLE)} e JOIN descendants d
           ON e.tenant_id=d.tenant_id AND e.space_id=d.space_id AND e.parent_task_id=d.child_task_id
         WHERE d.hops<$4 AND e.root_task_id=$3
       )
       SELECT tenant_id,space_id,root_task_id,parent_task_id,child_task_id,depth,child_ordinal,created_at
       FROM descendants ORDER BY depth,parent_task_id,child_ordinal LIMIT $5`,
      [input.tenantId, input.spaceId, rootTaskId, maxDepth, limit],
    );
    return rows.map((row) => decode(row as Row));
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
    !value ||
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
