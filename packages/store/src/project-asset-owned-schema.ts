import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";

export type AssetOwnedSchema = Readonly<{
  tables: readonly string[];
  marker: string;
  functions: readonly string[];
  sql(pg: boolean, prefix: string): string;
  error: string;
}>;
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const quoted = (names: readonly string[]) =>
  names
    .map((n) => {
      if (!/^[a-z_]+$/u.test(n))
        throw new Error("project_asset_schema_invalid");
      return `'${n}'`;
    })
    .join(",");
function sqliteSnapshot(db: DatabaseSync, d: AssetOwnedSchema) {
  return db
    .prepare(
      `SELECT type,name,tbl_name,sql FROM main.sqlite_schema WHERE tbl_name IN (${quoted(d.tables)}) ORDER BY type,name`,
    )
    .all();
}
async function pgSnapshot(c: PoolClient, schema: string, d: AssetOwnedSchema) {
  return (
    await c.query(
      `SELECT 'table' AS type,c.relname AS name,jsonb_build_object('columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'constraints',(SELECT jsonb_agg(jsonb_build_array(x.conname,pg_get_constraintdef(x.oid),x.convalidated) ORDER BY x.conname) FROM pg_constraint x WHERE x.conrelid=c.oid),'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgname,pg_get_triggerdef(t.oid),t.tgenabled) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),'indexes',(SELECT jsonb_agg(pg_get_indexdef(i.indexrelid) ORDER BY i.indexrelid::regclass::text) FROM pg_index i WHERE i.indrelid=c.oid)) AS definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r' AND c.relname=ANY($2::text[])
  UNION ALL SELECT 'function',p.proname,to_jsonb(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname=ANY($3::text[]) ORDER BY type,name`,
      [schema, d.tables, d.functions],
    )
  ).rows;
}
function check(
  d: AssetOwnedSchema,
  rows: readonly Record<string, unknown>[],
  snapshot: readonly Record<string, unknown>[],
  pg: boolean,
  p: string,
): void {
  if (
    snapshot.filter((r) => r.type === "table").length !== d.tables.length ||
    rows.length !== 1 ||
    rows[0]?.id !== 1 ||
    rows[0]?.version !== 1 ||
    rows[0]?.migration_digest !== hash(d.sql(pg, p)) ||
    rows[0]?.schema_digest !== hash(snapshot)
  )
    throw new Error(d.error);
}
export function assertSqliteAssetOwnedSchema(
  db: DatabaseSync,
  d: AssetOwnedSchema,
  optional = false,
): boolean {
  const snapshot = sqliteSnapshot(db, d);
  const shadows = db
    .prepare(
      `SELECT name FROM temp.sqlite_schema WHERE tbl_name IN (${quoted(d.tables)})`,
    )
    .all();
  if (shadows.length) throw new Error(d.error);
  if (snapshot.length === 0 && optional) return false;
  if (!snapshot.some((r) => r.name === d.marker && r.type === "table"))
    throw new Error(d.error);
  check(
    d,
    db.prepare(`SELECT * FROM ${d.marker} LIMIT 2`).all(),
    snapshot,
    false,
    "",
  );
  return true;
}
export async function assertPostgresAssetOwnedSchema(
  c: PoolClient,
  schema: string,
  d: AssetOwnedSchema,
  optional = false,
): Promise<boolean> {
  const snapshot = await pgSnapshot(c, schema, d),
    p = `${creativeProjectSchemaName(schema)}.`;
  if (snapshot.length === 0 && optional) return false;
  if (!snapshot.some((r) => r.name === d.marker && r.type === "table"))
    throw new Error(d.error);
  check(
    d,
    (await c.query(`SELECT * FROM ${p}${d.marker} LIMIT 2`)).rows,
    snapshot,
    true,
    p,
  );
  return true;
}
export function migrateSqliteAssetOwnedSchema(
  db: DatabaseSync,
  d: AssetOwnedSchema,
): void {
  if (assertSqliteAssetOwnedSchema(db, d, true)) return;
  db.exec(d.sql(false, ""));
  db.prepare(`INSERT INTO ${d.marker} VALUES(1,1,?,?)`).run(
    hash(d.sql(false, "")),
    hash(sqliteSnapshot(db, d)),
  );
  assertSqliteAssetOwnedSchema(db, d);
}
export async function migratePostgresAssetOwnedSchema(
  c: PoolClient,
  schema: string,
  d: AssetOwnedSchema,
): Promise<void> {
  const p = `${creativeProjectSchemaName(schema)}.`;
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    JSON.stringify([d.marker, schema]),
  ]);
  if (await assertPostgresAssetOwnedSchema(c, schema, d, true)) return;
  await c.query(d.sql(true, p));
  await c.query(`INSERT INTO ${p}${d.marker} VALUES(1,1,$1,$2)`, [
    hash(d.sql(true, p)),
    hash(await pgSnapshot(c, schema, d)),
  ]);
  await assertPostgresAssetOwnedSchema(c, schema, d);
}
