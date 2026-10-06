import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import {
  assertSqliteAssetOwnedSchema,
  assertPostgresAssetOwnedSchema,
  migrateSqliteAssetOwnedSchema,
  migratePostgresAssetOwnedSchema,
  type AssetOwnedSchema,
} from "./project-asset-owned-schema.ts";
import {
  assertSqliteProjectMediaOperationSchema,
  assertPostgresProjectMediaOperationSchema,
} from "./project-media-operation-schema.ts";
const table = "project_media_result_candidates",
  marker = "project_media_result_schema_version";
const definition: AssetOwnedSchema = {
  tables: [table, marker],
  marker,
  functions: ["project_media_result_immutable"],
  error: "project_media_result_schema_invalid",
  sql(pg, p) {
    const j = pg ? "JSONB" : "TEXT",
      strict = pg ? "" : " STRICT";
    const ddl = `CREATE TABLE ${p}${table}(tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,project_id TEXT NOT NULL,owner_principal_id TEXT NOT NULL,run_id TEXT NOT NULL,result_index INTEGER NOT NULL CHECK(result_index>=0 AND result_index<=15),candidate_id TEXT NOT NULL,source_digest TEXT NOT NULL,content_digest TEXT NOT NULL,record_json ${j} NOT NULL CHECK(${pg ? "jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=32768" : "json_valid(record_json) AND json_type(record_json)='object' AND length(CAST(record_json AS BLOB))<=32768"}),PRIMARY KEY(tenant_id,run_id,result_index),UNIQUE(tenant_id,candidate_id),FOREIGN KEY(tenant_id,run_id) REFERENCES ${p}project_media_operations(tenant_id,run_id) ON DELETE RESTRICT)${strict}; CREATE TABLE ${p}${marker}(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,migration_digest TEXT NOT NULL,schema_digest TEXT NOT NULL)${strict};`;
    if (!pg)
      return (
        ddl +
        [table, marker]
          .map(
            (t) =>
              `CREATE TRIGGER ${t}_immutable BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT,'project_media_result_immutable'); END; CREATE TRIGGER ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT,'project_media_result_immutable'); END;`,
          )
          .join("")
      );
    return (
      ddl +
      `CREATE FUNCTION ${p}project_media_result_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'project_media_result_immutable'; END; $$;` +
      [table, marker]
        .map(
          (t) =>
            `CREATE TRIGGER ${t}_immutable BEFORE UPDATE OR DELETE ON ${p}${t} FOR EACH ROW EXECUTE FUNCTION ${p}project_media_result_immutable();`,
        )
        .join("")
    );
  },
};
export function assertSqliteProjectMediaResultSchema(db: DatabaseSync) {
  assertSqliteProjectMediaOperationSchema(db);
  assertSqliteAssetOwnedSchema(db, definition);
}
export async function assertPostgresProjectMediaResultSchema(
  c: PoolClient,
  schema: string,
) {
  await assertPostgresProjectMediaOperationSchema(c, schema);
  await assertPostgresAssetOwnedSchema(c, schema, definition);
}
export function migrateSqliteProjectMediaResults(db: DatabaseSync) {
  assertSqliteProjectMediaOperationSchema(db);
  migrateSqliteAssetOwnedSchema(db, definition);
}
export async function migratePostgresProjectMediaResults(
  c: PoolClient,
  schema: string,
) {
  await assertPostgresProjectMediaOperationSchema(c, schema);
  await migratePostgresAssetOwnedSchema(c, schema, definition);
}
