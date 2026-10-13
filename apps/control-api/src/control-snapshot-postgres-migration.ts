import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Pool, PoolClient } from "pg";
import {
  validateModelHistoryItem,
  type ModelHistoryItem,
} from "@crewon/domain";

type Column = Readonly<{
  name: string;
  type: string;
  primaryOrder: number;
  sourceName: string | null;
}>;
type Table = Readonly<{
  name: string;
  columns: readonly Column[];
  sourceColumns: readonly string[];
  rows: number;
  identityColumns: readonly string[];
}>;
export type ControlSnapshotMigrationReport = Readonly<{
  sourceDigest: string;
  tables: readonly Readonly<{
    table: string;
    rows: number;
    rowDigest: string;
  }>[];
}>;
const metadataTables = new Set([
  "schema_migrations",
  "workflow_version_schema",
]);
const batchSize = 128;

/** Operator-only migration of a frozen backup into a freshly migrated schema.
 * Preserves all record values and identities. No merge, in-place rewriting or silent table skipping.
 */
export async function migrateControlSnapshotToPostgres(input: {
  sourcePath: string;
  expectedSourceDigest: string;
  pool: Pool;
  schema: string;
  signal: AbortSignal;
}): Promise<ControlSnapshotMigrationReport> {
  if (
    !isAbsolute(input.sourcePath) ||
    (await realpath(input.sourcePath)) !== input.sourcePath ||
    !/^[a-z][a-z0-9_]{0,62}$/u.test(input.schema) ||
    !/^sha256:[a-f0-9]{64}$/u.test(input.expectedSourceDigest)
  )
    throw new Error("control_snapshot_migration_input_invalid");
  const stat = await lstat(input.sourcePath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new Error("control_snapshot_migration_source_not_private");
  input.signal.throwIfAborted();
  if ((await fileDigest(input.sourcePath)) !== input.expectedSourceDigest)
    throw new Error("control_snapshot_migration_source_changed");
  const source = new DatabaseSync(input.sourcePath, { readOnly: true });
  let target: PoolClient | undefined;
  const schema = identifier(input.schema);
  let sourceTransaction = false;
  try {
    target = await input.pool.connect();
    source.exec("BEGIN");
    sourceTransaction = true;
    await target.query("BEGIN");
    await target.query("SET CONSTRAINTS ALL DEFERRED");
    await target.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "control-snapshot-import:" + input.schema,
    ]);
    const tables = await captureTables(source, target, input.schema);
    const targetNames = (
      await target.query<{ name: string }>(
        "SELECT table_name AS name FROM information_schema.tables WHERE table_schema=$1 ORDER BY table_name",
        [input.schema],
      )
    ).rows
      .map((x) => x.name)
      .filter((x) => !metadataTables.has(x));
    if (targetNames.length === 0)
      throw new Error("control_snapshot_migration_target_not_prepared");
    await target.query(
      `LOCK TABLE ${targetNames.map((name) => `${schema}.${identifier(name)}`).join(",")} IN ACCESS EXCLUSIVE MODE`,
    );
    for (const name of targetNames) {
      if (name === "outbox_maintenance") {
        const fresh = await target.query(
          `SELECT 1 FROM ${schema}.outbox_maintenance WHERE singleton=1 AND next_due='-infinity'`,
        );
        if (fresh.rowCount !== 1)
          throw new Error("control_snapshot_migration_target_not_empty");
        continue;
      }
      const count = await target.query(
        `SELECT count(*)::text AS rows FROM ${schema}.${identifier(name)}`,
      );
      if (count.rows[0].rows !== "0")
        throw new Error("control_snapshot_migration_target_not_empty");
    }
    const ordered = await orderTables(target, input.schema, tables);
    const reports: ControlSnapshotMigrationReport["tables"][number][] = [];
    for (const table of ordered) {
      input.signal.throwIfAborted();
      const order = table.columns
        .filter((x) => x.primaryOrder > 0)
        .sort((a, b) => a.primaryOrder - b.primaryOrder);
      if (order.length === 0)
        throw new Error("control_snapshot_migration_primary_key_missing");
      const sourceOrder = order
        .map(
          (x) =>
            `${identifier(x.sourceName ?? x.name)}${isText(x.type) ? " COLLATE BINARY" : ""}`,
        )
        .join(",");
      const pgOrder = order
        .map(
          (x) => `${identifier(x.name)}${isText(x.type) ? ' COLLATE "C"' : ""}`,
        )
        .join(",");
      const sourceStatement = source.prepare(
        `SELECT ${table.sourceColumns.map(identifier).join(",")} FROM ${identifier(table.name)} ORDER BY ${sourceOrder}`,
      );
      sourceStatement.setReadBigInts(true);
      const expected = createHash("sha256");
      const sourceRows = sourceStatement.iterate();
      for (let offset = 0; offset < table.rows; offset += batchSize) {
        input.signal.throwIfAborted();
        const rows: Record<string, unknown>[] = [];
        for (let i = 0; i < batchSize; i++) {
          const next = sourceRows.next();
          if (next.done) break;
          rows.push(expandRow(next.value, table));
        }
        if (rows.length === 0)
          throw new Error("control_snapshot_migration_source_incomplete");
        const values: unknown[] = [];
        const placeholders = rows.map(
          (row) =>
            "(" +
            table.columns
              .map((column) => {
                values.push(sqlValue(row[column.name], column.type));
                return `$${values.length}`;
              })
              .join(",") +
            ")",
        );
        if (table.name === "outbox_maintenance") {
          if (rows.length !== 1 || rows[0]!.singleton !== 1n)
            throw new Error("control_snapshot_migration_maintenance_invalid");
          const updated = await target.query(
            `UPDATE ${schema}.outbox_maintenance SET next_due=$1 WHERE singleton=1`,
            [rows[0]!.next_due],
          );
          if (updated.rowCount !== 1)
            throw new Error("control_snapshot_migration_maintenance_invalid");
        } else {
          const conflict =
            table.name === "outbox_deduplication"
              ? ` ON CONFLICT(message_id) DO UPDATE SET replay_message_json=EXCLUDED.replay_message_json WHERE outbox_deduplication.tenant_id=EXCLUDED.tenant_id AND outbox_deduplication.run_id=EXCLUDED.run_id`
              : "";
          const inserted = await target.query(
            `INSERT INTO ${schema}.${identifier(table.name)} (${table.columns.map((x) => identifier(x.name)).join(",")})${table.identityColumns.length ? " OVERRIDING SYSTEM VALUE" : ""} VALUES ${placeholders.join(",")}${conflict}`,
            values,
          );
          if (inserted.rowCount !== rows.length)
            throw new Error("control_snapshot_migration_insert_incomplete");
        }
        for (const row of rows)
          expected.update(rowDigest(row, table.columns) + "\n");
      }
      const actual = createHash("sha256");
      let readRows = 0;
      // One bounded server cursor sorts once; repeated OFFSET scans become
      // quadratic on large event histories and can exhaust a small server.
      await target.query(
        `DECLARE snapshot_rows NO SCROLL CURSOR FOR SELECT ${table.columns.map((x) => identifier(x.name)).join(",")} FROM ${schema}.${identifier(table.name)} ORDER BY ${pgOrder}`,
      );
      for (let offset = 0; offset < table.rows; offset += batchSize) {
        input.signal.throwIfAborted();
        const page = await target.query(
          `FETCH FORWARD ${batchSize} FROM snapshot_rows`,
        );
        for (const row of page.rows) {
          actual.update(rowDigest(row, table.columns) + "\n");
          readRows++;
        }
      }
      await target.query("CLOSE snapshot_rows");
      const digest = expected.digest("hex");
      if (readRows !== table.rows || actual.digest("hex") !== digest)
        throw new Error("control_snapshot_migration_row_verification_failed");
      reports.push({
        table: table.name,
        rows: table.rows,
        rowDigest: `sha256:${digest}`,
      });
    }
    await restoreIdentitySequences(source, target, input.schema, ordered);
    input.signal.throwIfAborted();
    if ((await fileDigest(input.sourcePath)) !== input.expectedSourceDigest)
      throw new Error("control_snapshot_migration_source_changed");
    await target.query(`CREATE TABLE ${schema}.control_snapshot_import (
      source_digest text PRIMARY KEY CHECK(source_digest ~ '^sha256:[a-f0-9]{64}$'),
      report_json jsonb NOT NULL CHECK(jsonb_typeof(report_json)='object'),
      imported_at timestamptz NOT NULL)`);
    await target.query(
      `INSERT INTO ${schema}.control_snapshot_import VALUES($1,$2,now())`,
      [
        input.expectedSourceDigest,
        JSON.stringify({
          sourceDigest: input.expectedSourceDigest,
          tables: reports,
        }),
      ],
    );
    source.exec("COMMIT");
    sourceTransaction = false;
    await target.query("COMMIT");
    return Object.freeze({
      sourceDigest: input.expectedSourceDigest,
      tables: Object.freeze(reports),
    });
  } catch (error) {
    await target?.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    if (sourceTransaction) source.exec("ROLLBACK");
    source.close();
    target?.release();
  }
}
async function captureTables(
  source: DatabaseSync,
  target: PoolClient,
  schema: string,
): Promise<Table[]> {
  const result: Table[] = [];
  const names = source
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  for (const row of names) {
    const name = String(row.name);
    identifier(name);
    if (metadataTables.has(name)) continue;
    const rows = Number(
      source.prepare(`SELECT count(*) AS rows FROM ${identifier(name)}`).get()!
        .rows,
    );
    if (!Number.isSafeInteger(rows) || rows < 0)
      throw new Error("control_snapshot_migration_count_invalid");
    if (rows === 0) continue;
    const columns = source
      .prepare(`PRAGMA table_info(${identifier(name)})`)
      .all();
    const pg = await target.query<{
      name: string;
      type: string;
      is_identity: string;
    }>(
      "SELECT column_name AS name,udt_name AS type,is_identity FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND is_generated='NEVER' ORDER BY ordinal_position",
      [schema, name],
    );
    const mapped = columns.map((x) => {
      const direct = pg.rows.find((y) => y.name === x.name);
      const timestamp =
        typeof x.name === "string" &&
        x.name.endsWith("_ms") &&
        x.type === "INTEGER"
          ? pg.rows.find(
              (y) =>
                y.name === String(x.name).slice(0, -3) &&
                y.type === "timestamptz",
            )
          : undefined;
      return { source: x, target: direct ?? timestamp };
    });
    if (
      mapped.some((x) => x.target === undefined) ||
      pg.rows.some(
        (x) =>
          !mapped.some((y) => y.target?.name === x.name) &&
          !(
            name === "model_history_items" &&
            ["call_id", "tool_kind"].includes(x.name)
          ),
      )
    )
      throw new Error(
        `control_snapshot_migration_columns_incompatible:${name}`,
      );
    result.push({
      name,
      rows,
      identityColumns: pg.rows
        .filter((x) => x.is_identity === "YES")
        .map((x) => x.name),
      sourceColumns: columns.map((x) => String(x.name)),
      columns: pg.rows.map((x) => ({
        name: x.name,
        type: x.type,
        primaryOrder: Number(
          mapped.find((y) => y.target?.name === x.name)?.source.pk ?? 0,
        ),
        sourceName:
          (mapped.find((y) => y.target?.name === x.name)?.source
            .name as string) ?? null,
      })),
    });
  }
  return result;
}

async function restoreIdentitySequences(
  source: DatabaseSync,
  target: PoolClient,
  schema: string,
  tables: readonly Table[],
): Promise<void> {
  const hasSequence =
    source
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'",
      )
      .get() !== undefined;
  for (const table of tables)
    for (const column of table.identityColumns) {
      const seq = await target.query<{ name: string }>(
        "SELECT pg_get_serial_sequence($1,$2) AS name",
        [`${identifier(schema)}.${identifier(table.name)}`, column],
      );
      if (!seq.rows[0]?.name)
        throw new Error("control_snapshot_migration_sequence_missing");
      let original = 0n;
      if (hasSequence) {
        const q = source.prepare(
          "SELECT seq FROM sqlite_sequence WHERE name=?",
        );
        q.setReadBigInts(true);
        original = (q.get(table.name)?.seq as bigint) ?? 0n;
      }
      const maximum = await target.query<{ value: string }>(
        `SELECT coalesce(max(${identifier(column)}),0)::text AS value FROM ${identifier(schema)}.${identifier(table.name)}`,
      );
      const max = BigInt(maximum.rows[0]!.value);
      const high = original > max ? original : max;
      if (high > 0n)
        await target.query("SELECT setval($1::regclass,$2::bigint,true)", [
          seq.rows[0].name,
          high.toString(),
        ]);
    }
}

function expandRow(
  row: Record<string, unknown>,
  table: Table,
): Record<string, unknown> {
  const expanded: Record<string, unknown> = {};
  for (const column of table.columns) {
    if (column.sourceName === null) continue;
    const value = row[column.sourceName];
    if (column.name !== column.sourceName && column.type === "timestamptz") {
      if (value === null) expanded[column.name] = null;
      else {
        if (
          typeof value !== "bigint" ||
          value < 0n ||
          value > BigInt(Number.MAX_SAFE_INTEGER)
        )
          throw new Error("control_snapshot_migration_timestamp_invalid");
        expanded[column.name] = new Date(Number(value)).toISOString();
      }
    } else expanded[column.name] = value;
  }
  row = expanded;
  if (table.name !== "model_history_items") return row;
  if (typeof row.item_json !== "string")
    throw new Error("control_snapshot_migration_history_invalid");
  const history = parseJson(row.item_json) as ModelHistoryItem;
  validateModelHistoryItem(history);
  const pairs = [
    ["tenant_id", history.tenantId],
    ["thread_id", history.threadId],
    ["sequence", history.sequence],
    ["item_id", history.itemId],
    ["run_id", history.runId],
    ["segment_id", history.segmentId],
    ["item_type", history.type],
  ] as const;
  if (pairs.some(([key, value]) => String(row[key]) !== String(value)))
    throw new Error("control_snapshot_migration_history_identity_mismatch");
  const tool = history.type === "tool_call" || history.type === "tool_result";
  const extra = {
    call_id: tool ? history.callId : null,
    tool_kind: tool ? history.kind : null,
  };
  for (const [key, value] of Object.entries(extra))
    if (Object.hasOwn(row, key) && row[key] !== value)
      throw new Error("control_snapshot_migration_history_identity_mismatch");
  // Only the existing PG writer's denormalized indexes are derived; item_json stays intact.
  return { ...row, ...extra };
}
async function orderTables(
  target: PoolClient,
  schema: string,
  tables: Table[],
): Promise<Table[]> {
  const rows = await target.query<{ child: string; parent: string }>(
    `SELECT child.relname AS child,parent.relname AS parent FROM pg_constraint fk
    JOIN pg_class child ON child.oid=fk.conrelid JOIN pg_namespace n ON n.oid=child.relnamespace
    JOIN pg_class parent ON parent.oid=fk.confrelid WHERE fk.contype='f' AND NOT fk.condeferrable AND n.nspname=$1`,
    [schema],
  );
  const ordered: Table[] = [];
  rows.rows.push({ child: "outbox_deduplication", parent: "outbox" });
  const pending = new Map(tables.map((x) => [x.name, x]));
  while (pending.size > 0) {
    const next = [...pending.values()].find(
      (table) =>
        !rows.rows.some(
          (fk) =>
            fk.child === table.name &&
            fk.parent !== table.name &&
            pending.has(fk.parent),
        ),
    );
    if (!next) throw new Error("control_snapshot_migration_dependency_cycle");
    ordered.push(next);
    pending.delete(next.name);
  }
  return ordered;
}
function identifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(value))
    throw new Error("control_snapshot_migration_identifier_invalid");
  return `"${value}"`;
}
function isText(type: string): boolean {
  return ["text", "varchar", "bpchar"].includes(type);
}
function sqlValue(value: unknown, type: string): unknown {
  if (value === null) return null;
  if (type === "bool") {
    if (value !== 0n && value !== 1n && value !== false && value !== true)
      throw new Error("control_snapshot_migration_boolean_invalid");
    return value === 1n || value === true;
  }
  if (["int2", "int4", "int8", "numeric", "float4", "float8"].includes(type))
    return String(value);
  if (type === "jsonb" || type === "json")
    return typeof value === "string" ? value : JSON.stringify(value);
  if (type === "bytea" && value instanceof Uint8Array)
    return Buffer.from(value);
  if (isText(type) || ["uuid", "timestamptz", "timestamp"].includes(type)) {
    if (typeof value !== "string")
      throw new Error("control_snapshot_migration_scalar_invalid");
    return value;
  }
  throw new Error("control_snapshot_migration_type_unsupported");
}
function rowDigest(
  row: Record<string, unknown>,
  columns: readonly Column[],
): string {
  const values = columns.map((column) => {
    const value = row[column.name];
    if (value === null) return null;
    if (column.type === "jsonb" || column.type === "json")
      return canonical(typeof value === "string" ? parseJson(value) : value);
    if (column.type === "bool") return value === true || value === 1n;
    if (column.type === "bytea" && value instanceof Uint8Array)
      return Buffer.from(value).toString("hex");
    if (["timestamp", "timestamptz"].includes(column.type))
      return value instanceof Date
        ? value.toISOString()
        : new Date(String(value)).toISOString();
    return String(value);
  });
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}
function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("control_snapshot_migration_json_invalid");
  }
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, v]) => [key, canonical(v)]),
    );
  return value;
}
async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}
