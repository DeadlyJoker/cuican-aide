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
  assertSqliteProjectMediaGenerationSchema,
  assertPostgresProjectMediaGenerationSchema,
} from "./project-media-generation-schema.ts";
const table = "project_media_operations",
  marker = "project_media_operation_schema_version";
const definition: AssetOwnedSchema = {
  tables: [table, marker],
  marker,
  functions: ["project_media_operation_immutable"],
  error: "project_media_operation_schema_invalid",
  sql(pg, p) {
    const j = pg ? "JSONB" : "TEXT",
      strict = pg ? "" : " STRICT";
    const ddl = `CREATE TABLE ${p}${table}(tenant_id TEXT NOT NULL,run_id TEXT NOT NULL,space_id TEXT NOT NULL,project_id TEXT NOT NULL,execution_id TEXT NOT NULL,generation_digest TEXT NOT NULL,binding_digest TEXT NOT NULL,operation_id TEXT NOT NULL,tool_execution_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,action_digest TEXT NOT NULL,request_digest TEXT NOT NULL,correlation_id TEXT NOT NULL,created_at TEXT NOT NULL,content_digest TEXT NOT NULL,record_json ${j} NOT NULL CHECK(${pg ? "jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=8192" : "json_valid(record_json) AND json_type(record_json)='object' AND length(CAST(record_json AS BLOB))<=8192"}),PRIMARY KEY(tenant_id,run_id),FOREIGN KEY(tenant_id,run_id) REFERENCES ${p}project_media_generation_links(tenant_id,run_id) ON DELETE RESTRICT,FOREIGN KEY(tenant_id,run_id,binding_digest,operation_id) REFERENCES ${p}extension_external_operations(tenant_id,run_id,binding_digest,operation_id) ON DELETE RESTRICT)${strict};
      CREATE TABLE ${p}${marker}(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,migration_digest TEXT NOT NULL,schema_digest TEXT NOT NULL)${strict};`;
    if (!pg)
      return (
        ddl +
        [table, marker]
          .map(
            (t) =>
              `CREATE TRIGGER ${t}_immutable BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT,'project_media_operation_immutable'); END; CREATE TRIGGER ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT,'project_media_operation_immutable'); END;`,
          )
          .join("")
      );
    return (
      ddl +
      `CREATE FUNCTION ${p}project_media_operation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'project_media_operation_immutable'; END; $$;` +
      [table, marker]
        .map(
          (t) =>
            `CREATE TRIGGER ${t}_immutable BEFORE UPDATE OR DELETE ON ${p}${t} FOR EACH ROW EXECUTE FUNCTION ${p}project_media_operation_immutable();`,
        )
        .join("")
    );
  },
};
export function assertSqliteProjectMediaOperationSchema(db: DatabaseSync) {
  assertSqliteProjectMediaGenerationSchema(db);
  assertSqliteAssetOwnedSchema(db, definition);
}
export async function assertPostgresProjectMediaOperationSchema(
  c: PoolClient,
  schema: string,
) {
  await assertPostgresProjectMediaGenerationSchema(c, schema);
  await assertPostgresAssetOwnedSchema(c, schema, definition);
}
export function migrateSqliteProjectMediaOperations(db: DatabaseSync) {
  assertSqliteProjectMediaGenerationSchema(db);
  migrateSqliteAssetOwnedSchema(db, definition);
}
export async function migratePostgresProjectMediaOperations(
  c: PoolClient,
  schema: string,
) {
  await assertPostgresProjectMediaGenerationSchema(c, schema);
  await migratePostgresAssetOwnedSchema(c, schema, definition);
}
