import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import {
  assertSqliteAssetOwnedSchema,
  assertPostgresAssetOwnedSchema,
  migrateSqliteAssetOwnedSchema,
  migratePostgresAssetOwnedSchema,
  type AssetOwnedSchema,
} from "./project-asset-owned-schema.ts";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
const definition: AssetOwnedSchema = Object.freeze({
  tables: [
    "project_asset_stage_run_admissions",
    "project_asset_stage_schema_version",
  ],
  marker: "project_asset_stage_schema_version",
  functions: ["project_asset_stage_immutable"],
  error: "project_asset_stage_schema_incomplete",
  sql(pg, p) {
    const j = pg ? "JSONB" : "TEXT",
      i = pg ? "BIGINT" : "INTEGER",
      strict = pg ? "" : " STRICT",
      check = pg
        ? "jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=32768"
        : "json_valid(record_json) AND json_type(record_json)='object' AND length(CAST(record_json AS BLOB))<=32768";
    const tables = `CREATE TABLE ${p}project_asset_stage_run_admissions(tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,run_id TEXT NOT NULL,thread_id TEXT NOT NULL,binding_id TEXT NOT NULL,binding_revision ${i} NOT NULL CHECK(binding_revision BETWEEN 1 AND 9007199254740991),content_digest TEXT NOT NULL,record_json ${j} NOT NULL CHECK(${check}),PRIMARY KEY(tenant_id,run_id),FOREIGN KEY(tenant_id,run_id) REFERENCES ${p}run_snapshots(tenant_id,run_id),FOREIGN KEY(tenant_id,space_id,binding_id) REFERENCES ${p}project_conversation_bindings(tenant_id,space_id,binding_id))${strict}; CREATE TABLE ${p}project_asset_stage_schema_version(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,migration_digest TEXT NOT NULL,schema_digest TEXT NOT NULL)${strict};`;
    return (
      tables +
      (pg
        ? `CREATE FUNCTION ${p}project_asset_stage_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'project_asset_stage_immutable'; END; $$;` +
          [
            "project_asset_stage_run_admissions",
            "project_asset_stage_schema_version",
          ]
            .map(
              (t) =>
                `CREATE TRIGGER ${t}_immutable BEFORE UPDATE OR DELETE ON ${p}${t} FOR EACH ROW EXECUTE FUNCTION ${p}project_asset_stage_immutable();`,
            )
            .join("")
        : [
            "project_asset_stage_run_admissions",
            "project_asset_stage_schema_version",
          ]
            .map(
              (t) =>
                `CREATE TRIGGER ${t}_immutable BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT,'project_asset_stage_immutable'); END; CREATE TRIGGER ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT,'project_asset_stage_immutable'); END;`,
            )
            .join(""))
    );
  },
});
export function assertSqliteAssetStageSchema(
  db: DatabaseSync,
  optional = false,
): boolean {
  const exists = assertSqliteAssetOwnedSchema(db, definition, optional);
  if (
    exists &&
    !db
      .prepare("PRAGMA main.table_xinfo(plugin_task_admissions)")
      .all()
      .some((c) => c.name === "project_asset_stage_digest")
  )
    throw new Error("project_asset_stage_marker_invalid");
  return exists;
}
export async function assertPostgresAssetStageSchema(
  c: PoolClient,
  s: string,
  optional = false,
): Promise<boolean> {
  const exists = await assertPostgresAssetOwnedSchema(
    c,
    s,
    definition,
    optional,
  );
  if (
    exists &&
    !(
      await c.query(
        "SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass AND attname='project_asset_stage_digest' AND attnum>0 AND NOT attisdropped",
        [`${creativeProjectSchemaName(s)}.plugin_task_admissions`],
      )
    ).rows.length
  )
    throw new Error("project_asset_stage_marker_invalid");
  return exists;
}
export function migrateSqliteAssetStage(db: DatabaseSync): void {
  db.prepare("SELECT run_id FROM plugin_task_admissions LIMIT 0").all();
  db.prepare("SELECT asset_id FROM project_assets LIMIT 0").all();
  const columns = db
    .prepare("PRAGMA main.table_xinfo(plugin_task_admissions)")
    .all();
  if (!columns.some((c) => c.name === "project_asset_stage_digest")) {
    if (assertSqliteAssetStageSchema(db, true))
      throw new Error("project_asset_stage_marker_invalid");
    db.exec(
      "ALTER TABLE plugin_task_admissions ADD COLUMN project_asset_stage_digest TEXT CHECK(project_asset_stage_digest IS NULL OR (length(project_asset_stage_digest)=71 AND substr(project_asset_stage_digest,1,7)='sha256:'))",
    );
  }
  migrateSqliteAssetOwnedSchema(db, definition);
}
export async function migratePostgresAssetStage(
  c: PoolClient,
  s: string,
): Promise<void> {
  const p = `${creativeProjectSchemaName(s)}.`;
  await c.query(`SELECT run_id FROM ${p}plugin_task_admissions LIMIT 0`);
  await c.query(`SELECT asset_id FROM ${p}project_assets LIMIT 0`);
  const col = (
    await c.query(
      "SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass AND attname='project_asset_stage_digest' AND attnum>0 AND NOT attisdropped",
      [`${p}plugin_task_admissions`],
    )
  ).rows;
  if (!col.length) {
    if (await assertPostgresAssetStageSchema(c, s, true))
      throw new Error("project_asset_stage_marker_invalid");
    await c.query(
      `ALTER TABLE ${p}plugin_task_admissions ADD COLUMN project_asset_stage_digest TEXT CHECK(project_asset_stage_digest IS NULL OR project_asset_stage_digest ~ '^sha256:[a-f0-9]{64}$')`,
    );
  }
  await migratePostgresAssetOwnedSchema(c, s, definition);
}
