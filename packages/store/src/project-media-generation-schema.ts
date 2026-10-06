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
  assertSqliteProjectMediaInputSchema,
  assertPostgresProjectMediaInputSchema,
} from "./project-media-input-schema.ts";
import {
  assertSqliteMaterialPreparationSchema,
  assertPostgresMaterialPreparationSchema,
} from "./project-material-preparation-schema.ts";
const links = "project_media_generation_links",
  materials = "project_media_generation_materials",
  marker = "project_media_generation_schema_version";
const definition: AssetOwnedSchema = {
  tables: [links, materials, marker],
  marker,
  functions: ["project_media_generation_immutable"],
  error: "project_media_generation_schema_invalid",
  sql(pg, p) {
    const i = pg ? "BIGINT" : "INTEGER",
      j = pg ? "JSONB" : "TEXT",
      strict = pg ? "" : " STRICT";
    const ddl = `CREATE TABLE ${p}${links}(tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,project_id TEXT NOT NULL,media_input_id TEXT NOT NULL,input_revision ${i} NOT NULL,media_input_digest TEXT NOT NULL,principal_id TEXT NOT NULL,actor_id TEXT NOT NULL,execution_id TEXT NOT NULL,plugin_id TEXT NOT NULL CHECK(plugin_id='crewon.short-drama'),run_id TEXT NOT NULL,receipt_kind TEXT NOT NULL CHECK(receipt_kind='task'),idempotency_key TEXT NOT NULL,request_digest TEXT NOT NULL,content_digest TEXT NOT NULL,record_json ${j} NOT NULL CHECK(${pg ? "jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=32768" : "json_valid(record_json) AND json_type(record_json)='object' AND length(CAST(record_json AS BLOB))<=32768"}),PRIMARY KEY(tenant_id,run_id),UNIQUE(tenant_id,space_id,project_id,principal_id,actor_id,execution_id),FOREIGN KEY(tenant_id,space_id,project_id,media_input_id,input_revision,media_input_digest) REFERENCES ${p}project_media_input_revisions(tenant_id,space_id,project_id,media_input_id,input_revision,content_digest) ON DELETE RESTRICT,FOREIGN KEY(tenant_id,run_id) REFERENCES ${p}extension_run_bindings(tenant_id,run_id) ON DELETE RESTRICT,FOREIGN KEY(tenant_id,run_id) REFERENCES ${p}plugin_task_admissions(tenant_id,run_id) ON DELETE RESTRICT,FOREIGN KEY(tenant_id,space_id,plugin_id,receipt_kind,actor_id,idempotency_key) REFERENCES ${p}extension_mutation_receipts(tenant_id,space_id,plugin_id,kind,actor_id,idempotency_key) ON DELETE RESTRICT)${strict};
  CREATE TABLE ${p}${materials}(tenant_id TEXT NOT NULL,run_id TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN('character','scene','characterOne','characterTwo')),intent_id TEXT NOT NULL,initial_digest TEXT NOT NULL,event_revision ${i} NOT NULL,phase TEXT NOT NULL CHECK(phase='verified'),PRIMARY KEY(tenant_id,run_id,role),FOREIGN KEY(tenant_id,run_id) REFERENCES ${p}${links}(tenant_id,run_id) ON DELETE RESTRICT,FOREIGN KEY(intent_id,initial_digest) REFERENCES ${p}project_material_preparations(intent_id,content_digest) ON DELETE RESTRICT,FOREIGN KEY(intent_id,event_revision,phase) REFERENCES ${p}project_material_preparation_events(intent_id,revision,phase) ON DELETE RESTRICT)${strict};
  CREATE TABLE ${p}${marker}(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,migration_digest TEXT NOT NULL,schema_digest TEXT NOT NULL)${strict};`;
    if (!pg)
      return (
        ddl +
        [links, materials, marker]
          .map(
            (t) =>
              `CREATE TRIGGER ${t}_immutable BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT,'project_media_generation_immutable'); END; CREATE TRIGGER ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT,'project_media_generation_immutable'); END;`,
          )
          .join("")
      );
    return (
      ddl +
      `CREATE FUNCTION ${p}project_media_generation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'project_media_generation_immutable'; END; $$;` +
      [links, materials, marker]
        .map(
          (t) =>
            `CREATE TRIGGER ${t}_immutable BEFORE UPDATE OR DELETE ON ${p}${t} FOR EACH ROW EXECUTE FUNCTION ${p}project_media_generation_immutable();`,
        )
        .join("")
    );
  },
};
export function assertSqliteProjectMediaGenerationSchema(db: DatabaseSync) {
  assertSqliteProjectMediaInputSchema(db);
  assertSqliteMaterialPreparationSchema(db);
  return assertSqliteAssetOwnedSchema(db, definition);
}
export async function assertPostgresProjectMediaGenerationSchema(
  c: PoolClient,
  schema: string,
) {
  await assertPostgresProjectMediaInputSchema(c, schema);
  await assertPostgresMaterialPreparationSchema(c, schema);
  return assertPostgresAssetOwnedSchema(c, schema, definition);
}
export function migrateSqliteProjectMediaGenerations(db: DatabaseSync) {
  assertSqliteProjectMediaInputSchema(db);
  assertSqliteMaterialPreparationSchema(db);
  migrateSqliteAssetOwnedSchema(db, definition);
}
export async function migratePostgresProjectMediaGenerations(
  c: PoolClient,
  schema: string,
) {
  await assertPostgresProjectMediaInputSchema(c, schema);
  await assertPostgresMaterialPreparationSchema(c, schema);
  await migratePostgresAssetOwnedSchema(c, schema, definition);
}
