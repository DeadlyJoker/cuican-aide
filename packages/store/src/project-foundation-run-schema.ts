import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";

const tables = [
  "project_foundation_run_schema_version",
  "project_foundation_run_admissions",
  "project_foundation_run_requirements",
] as const;
const immutable = tables.slice(1);
const historyBody =
  "BEGIN RAISE EXCEPTION 'project_foundation_run_history_immutable'; END;";
const normalizedSql = (value: unknown) =>
  typeof value === "string"
    ? value.trim().replace(/\s+/gu, " ").replace(/;$/u, "")
    : "";
const sqliteTrigger = (table: string, action: string) =>
  `CREATE TRIGGER ${table}_no_${action.toLowerCase()} BEFORE ${action.toUpperCase()} ON ${table} BEGIN SELECT RAISE(ABORT,'project_foundation_run_history_immutable'); END;`;
const reads = [
  "SELECT id,version FROM project_foundation_run_schema_version LIMIT 0",
  "SELECT tenant_id,space_id,run_id,content_digest,record_json FROM project_foundation_run_admissions LIMIT 0",
  "SELECT tenant_id,space_id,run_id,content_digest FROM project_foundation_run_requirements LIMIT 0",
];

function ddl(pg: boolean, schema: string): string {
  const p = pg ? `${creativeProjectSchemaName(schema)}.` : "";
  const strict = pg ? "" : " STRICT";
  const json = pg ? "JSONB" : "TEXT";
  const field = (name: string) =>
    pg ? `(record_json->>'${name}')` : `json_extract(record_json,'$.${name}')`;
  const check = pg
    ? "jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=16384"
    : "json_valid(record_json) AND json_type(record_json)='object' AND length(CAST(record_json AS BLOB))<=16384";
  return `CREATE TABLE ${p}${tables[0]} (id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL CHECK(version=1))${strict};
  INSERT INTO ${p}${tables[0]} VALUES(1,1);
  CREATE TABLE ${p}${tables[1]} (
    tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,run_id TEXT NOT NULL,content_digest TEXT NOT NULL,
    record_json ${json} NOT NULL CHECK(${check} AND ${field("runId")}=run_id AND ${field("contentDigest")}=content_digest),
    PRIMARY KEY(tenant_id,space_id,run_id),UNIQUE(tenant_id,space_id,run_id,content_digest),
    FOREIGN KEY(tenant_id,run_id) REFERENCES ${p}run_snapshots(tenant_id,run_id) ON DELETE RESTRICT
  )${strict};
  CREATE TABLE ${p}${tables[2]} (
    tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,run_id TEXT NOT NULL,content_digest TEXT NOT NULL,
    PRIMARY KEY(tenant_id,space_id,run_id),
    FOREIGN KEY(tenant_id,space_id,run_id,content_digest) REFERENCES ${p}${tables[1]}(tenant_id,space_id,run_id,content_digest) ON DELETE RESTRICT
  )${strict};`;
}
function incomplete(): never {
  throw new Error("project_foundation_run_schema_incomplete");
}
function version(rows: readonly Record<string, unknown>[]) {
  if (
    rows.length !== 1 ||
    Number(rows[0]!.id) !== 1 ||
    Number(rows[0]!.version) !== 1
  )
    throw new Error("project_foundation_run_schema_version_unsupported");
}
/** Optional extension absence is compatible; a partial or foreign schema fails closed. */
export function assertSqliteProjectFoundationRunSchema(
  db: DatabaseSync,
): boolean {
  const marks = tables.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT name,type FROM main.sqlite_schema WHERE name IN (${marks}) UNION ALL SELECT name,type FROM temp.sqlite_schema WHERE name IN (${marks})`,
    )
    .all(...tables, ...tables);
  if (rows.length === 0) return false;
  if (rows.length !== tables.length || rows.some((r) => r.type !== "table"))
    incomplete();
  version(db.prepare(`SELECT id,version FROM ${tables[0]} LIMIT 2`).all());
  try {
    for (const sql of reads) db.prepare(sql).all();
    for (const table of immutable)
      for (const action of ["update", "delete"]) {
        const row = db
          .prepare(
            "SELECT type,tbl_name,sql FROM main.sqlite_schema WHERE name=?",
          )
          .get(`${table}_no_${action}`);
        if (
          row?.type !== "trigger" ||
          row.tbl_name !== table ||
          normalizedSql(row.sql) !== normalizedSql(sqliteTrigger(table, action))
        )
          incomplete();
      }
  } catch {
    incomplete();
  }
  return true;
}
export async function assertPostgresProjectFoundationRunSchema(
  c: PoolClient,
  schema: string,
): Promise<boolean> {
  const p = `${creativeProjectSchemaName(schema)}.`;
  const rows = (
    await c.query(
      "SELECT relname,relkind FROM pg_catalog.pg_class WHERE relnamespace=$1::regnamespace AND relname=ANY($2::text[])",
      [schema, [...tables]],
    )
  ).rows;
  if (rows.length === 0) return false;
  if (rows.length !== tables.length || rows.some((r) => r.relkind !== "r"))
    incomplete();
  version(
    (await c.query(`SELECT id,version FROM ${p}${tables[0]} LIMIT 2`)).rows,
  );
  try {
    for (const sql of reads)
      await c.query(sql.replace(/FROM ([a-z_]+)/u, `FROM ${p}$1`));
    for (const table of immutable) {
      const row = await c.query(
        `SELECT p.prosrc FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_language l ON l.oid=p.prolang
        WHERE t.tgrelid=$1::regclass AND t.tgname=$2 AND NOT t.tgisinternal AND t.tgenabled='O'
        AND t.tgtype=27 AND t.tgnargs=0 AND t.tgattr::text='' AND t.tgqual IS NULL
        AND p.pronamespace=$3::regnamespace AND p.proname='project_foundation_run_history_immutable'
        AND p.prorettype='trigger'::regtype AND p.prokind='f' AND NOT p.prosecdef AND l.lanname='plpgsql'`,
        [`${p}${table}`, `${table}_immutable`, schema],
      );
      if (
        row.rows.length !== 1 ||
        normalizedSql(row.rows[0].prosrc) !== normalizedSql(historyBody)
      )
        incomplete();
    }
  } catch {
    incomplete();
  }
  return true;
}
/** Explicit caller-owned migration transaction; reads and constructors perform no DDL. */
export function migrateSqliteProjectFoundationRuns(db: DatabaseSync): void {
  if (assertSqliteProjectFoundationRunSchema(db)) return;
  // Standalone metadata stores remain independent. Only an initialized original Run parent
  // can install this optional sidecar; no second Run schema is created here.
  const parent = db
    .prepare("SELECT type FROM main.sqlite_schema WHERE name='run_snapshots'")
    .get();
  if (parent === undefined) return;
  if (parent.type !== "table") incomplete();
  db.exec(ddl(false, "public"));
  for (const table of immutable)
    for (const action of ["UPDATE", "DELETE"])
      db.exec(sqliteTrigger(table, action));
  assertSqliteProjectFoundationRunSchema(db);
}
export async function migratePostgresProjectFoundationRuns(
  c: PoolClient,
  schema: string,
): Promise<void> {
  if (await assertPostgresProjectFoundationRunSchema(c, schema)) return;
  const p = `${creativeProjectSchemaName(schema)}.`;
  const parent = await c.query(
    "SELECT relkind FROM pg_catalog.pg_class WHERE relnamespace=$1::regnamespace AND relname='run_snapshots'",
    [schema],
  );
  if (parent.rows.length === 0) return;
  if (parent.rows.length !== 1 || parent.rows[0].relkind !== "r") incomplete();
  await c.query(ddl(true, schema));
  await c.query(
    `CREATE FUNCTION ${p}project_foundation_run_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ ${historyBody} $$;`,
  );
  for (const table of immutable)
    await c.query(
      `CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON ${p}${table} FOR EACH ROW EXECUTE FUNCTION ${p}project_foundation_run_history_immutable();`,
    );
  await assertPostgresProjectFoundationRunSchema(c, schema);
}
