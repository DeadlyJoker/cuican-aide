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
  assertSqliteProjectAssetSchema,
  assertPostgresProjectAssetSchema,
} from "./project-asset-schema.ts";
import {
  assertSqliteProjectMediaResultSchema,
  assertPostgresProjectMediaResultSchema,
} from "./project-media-result-schema.ts";
export const assetMediaAdoptionTable = "project_asset_media_adoption_receipts";
const marker = "project_asset_media_adoption_schema_version";
const definition: AssetOwnedSchema = {
  tables: [assetMediaAdoptionTable, marker],
  marker,
  functions: ["project_asset_media_adoption_immutable"],
  error: "project_asset_media_adoption_schema_invalid",
  sql(pg, p) {
    const j = pg ? "JSONB" : "TEXT",
      integer = pg ? "BIGINT" : "INTEGER",
      strict = pg ? "" : " STRICT",
      object = pg
        ? "jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=49152"
        : "json_valid(record_json) AND json_type(record_json)='object' AND length(CAST(record_json AS BLOB))<=49152",
      ddl = `CREATE TABLE ${p}${assetMediaAdoptionTable}(tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,owner_principal_id TEXT NOT NULL,actor_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,request_digest TEXT NOT NULL,project_id TEXT NOT NULL,asset_id TEXT NOT NULL,reference_revision ${integer} NOT NULL CHECK(reference_revision BETWEEN 1 AND 9007199254740991),record_json ${j} NOT NULL CHECK(${object}),PRIMARY KEY(tenant_id,space_id,owner_principal_id,actor_id,idempotency_key),UNIQUE(tenant_id,space_id,project_id,asset_id,reference_revision),FOREIGN KEY(tenant_id,space_id,project_id,owner_principal_id) REFERENCES ${p}creative_projects(tenant_id,space_id,project_id,owner_principal_id) ON DELETE RESTRICT,FOREIGN KEY(tenant_id,space_id,project_id,asset_id,reference_revision) REFERENCES ${p}project_asset_reference_revisions(tenant_id,space_id,project_id,asset_id,reference_revision) ON DELETE RESTRICT)${strict}; CREATE TABLE ${p}${marker}(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,migration_digest TEXT NOT NULL,schema_digest TEXT NOT NULL)${strict};`;
    if (!pg)
      return (
        ddl +
        [assetMediaAdoptionTable, marker]
          .map(
            (t) =>
              `CREATE TRIGGER ${t}_immutable BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT,'project_asset_media_adoption_immutable'); END; CREATE TRIGGER ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT,'project_asset_media_adoption_immutable'); END;`,
          )
          .join("")
      );
    return (
      ddl +
      `CREATE FUNCTION ${p}project_asset_media_adoption_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'project_asset_media_adoption_immutable'; END; $$;` +
      [assetMediaAdoptionTable, marker]
        .map(
          (t) =>
            `CREATE TRIGGER ${t}_immutable BEFORE UPDATE OR DELETE ON ${p}${t} FOR EACH ROW EXECUTE FUNCTION ${p}project_asset_media_adoption_immutable();`,
        )
        .join("")
    );
  },
};
export function assertSqliteAssetMediaAdoptionSchema(db: DatabaseSync) {
  assertSqliteProjectAssetSchema(db);
  assertSqliteProjectMediaResultSchema(db);
  assertSqliteAssetOwnedSchema(db, definition);
}
export async function assertPostgresAssetMediaAdoptionSchema(
  c: PoolClient,
  schema: string,
) {
  await assertPostgresProjectAssetSchema(c, schema);
  await assertPostgresProjectMediaResultSchema(c, schema);
  await assertPostgresAssetOwnedSchema(c, schema, definition);
}
export function migrateSqliteAssetMediaAdoptions(db: DatabaseSync) {
  assertSqliteProjectAssetSchema(db);
  assertSqliteProjectMediaResultSchema(db);
  migrateSqliteAssetOwnedSchema(db, definition);
}
export async function migratePostgresAssetMediaAdoptions(
  c: PoolClient,
  schema: string,
) {
  await assertPostgresProjectAssetSchema(c, schema);
  await assertPostgresProjectMediaResultSchema(c, schema);
  await migratePostgresAssetOwnedSchema(c, schema, definition);
}
