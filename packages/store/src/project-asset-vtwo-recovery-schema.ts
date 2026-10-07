import {
  assertSqliteAssetMediaAdoptionSchema,
  assertPostgresAssetMediaAdoptionSchema,
} from "./project-asset-media-adoption-schema.ts";
import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import {
  assertSqliteAssetOwnedSchema,
  assertPostgresAssetOwnedSchema,
  migrateSqliteAssetOwnedSchema,
  migratePostgresAssetOwnedSchema,
  type AssetOwnedSchema,
} from "./project-asset-owned-schema.ts";
export const assetVtwoIntentTable = "project_asset_versioned_intents";
const marker = "project_asset_versioned_intent_schema_version";
const definition: AssetOwnedSchema = {
  tables: [assetVtwoIntentTable, marker],
  marker,
  functions: ["project_asset_versioned_intent_immutable"],
  error: "project_asset_v2_recovery_schema_invalid",
  sql(pg, p) {
    const t = assetVtwoIntentTable,
      j = pg ? "JSONB" : "TEXT",
      strict = pg ? "" : " STRICT",
      integer = pg ? "BIGINT" : "INTEGER";
    const bound = pg
      ? "jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=65536"
      : "json_valid(record_json) AND json_type(record_json)='object' AND length(CAST(record_json AS BLOB))<=65536";
    const ddl = `CREATE TABLE ${p}${t}(intent_id TEXT PRIMARY KEY,scope_digest TEXT NOT NULL,tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,principal_id TEXT NOT NULL,actor_id TEXT NOT NULL,project_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN('save-content','select-content','set-lock','save-reference','select-reference','adopt-media')),idempotency_key TEXT NOT NULL,request_digest TEXT NOT NULL,revision ${integer} NOT NULL CHECK(revision BETWEEN 1 AND 3),phase TEXT NOT NULL CHECK(phase IN('pending','accepted','cancelled')),acknowledged INTEGER NOT NULL CHECK(acknowledged IN(0,1) AND (phase!='pending' OR acknowledged=0)),record_json ${j} NOT NULL CHECK(${bound}),FOREIGN KEY(tenant_id,space_id,project_id,principal_id) REFERENCES ${p}creative_projects(tenant_id,space_id,project_id,owner_principal_id) ON DELETE RESTRICT)${strict}; CREATE UNIQUE INDEX project_asset_versioned_intents_active ON ${p}${t}(scope_digest) WHERE acknowledged=0; CREATE UNIQUE INDEX project_asset_versioned_intents_key ON ${p}${t}(tenant_id,space_id,principal_id,actor_id,kind,idempotency_key); CREATE TABLE ${p}${marker}(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,migration_digest TEXT NOT NULL,schema_digest TEXT NOT NULL)${strict};`;
    const diff = (key: string) =>
      pg
        ? `NEW.${key} IS DISTINCT FROM OLD.${key}`
        : `NEW.${key} IS NOT OLD.${key}`;
    const jsondiff = (path: string) =>
      pg
        ? `NEW.record_json#>'{${path.replaceAll(".", ",")}}' IS DISTINCT FROM OLD.record_json#>'{${path.replaceAll(".", ",")}}'`
        : `json_extract(NEW.record_json,'$.${path}') IS NOT json_extract(OLD.record_json,'$.${path}')`;
    const changed = [
      ...[
        "intent_id",
        "scope_digest",
        "tenant_id",
        "space_id",
        "principal_id",
        "actor_id",
        "project_id",
        "kind",
        "idempotency_key",
        "request_digest",
      ].map(diff),
      ...[
        "version",
        "scope",
        "createdAt",
        "intent.intentId",
        "intent.request",
        "intent.requestDigest",
      ].map(jsondiff),
      "NEW.revision<>OLD.revision+1",
      "OLD.acknowledged=1",
      "(OLD.phase!='pending' AND NEW.phase!=OLD.phase)",
      `(OLD.phase!='pending' AND (${jsondiff("intent.confirmed")}))`,
    ].join(" OR ");
    return (
      ddl +
      (pg
        ? `CREATE FUNCTION ${p}project_asset_versioned_intent_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP='DELETE' OR TG_TABLE_NAME='${marker}' THEN RAISE EXCEPTION 'project_asset_v2_recovery_immutable'; END IF; IF ${changed} THEN RAISE EXCEPTION 'project_asset_v2_recovery_immutable'; END IF; RETURN NEW; END; $$; CREATE TRIGGER ${t}_immutable BEFORE UPDATE OR DELETE ON ${p}${t} FOR EACH ROW EXECUTE FUNCTION ${p}project_asset_versioned_intent_immutable(); CREATE TRIGGER ${marker}_immutable BEFORE UPDATE OR DELETE ON ${p}${marker} FOR EACH ROW EXECUTE FUNCTION ${p}project_asset_versioned_intent_immutable();`
        : `CREATE TRIGGER ${t}_immutable BEFORE UPDATE ON ${t} WHEN ${changed} BEGIN SELECT RAISE(ABORT,'project_asset_v2_recovery_immutable'); END; CREATE TRIGGER ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT,'project_asset_v2_recovery_immutable'); END; CREATE TRIGGER ${marker}_immutable BEFORE UPDATE ON ${marker} BEGIN SELECT RAISE(ABORT,'project_asset_v2_recovery_immutable'); END; CREATE TRIGGER ${marker}_no_delete BEFORE DELETE ON ${marker} BEGIN SELECT RAISE(ABORT,'project_asset_v2_recovery_immutable'); END;`)
    );
  },
};
export const assertSqliteAssetVtwoRecoverySchema = (
  db: DatabaseSync,
  optional = false,
) => assertSqliteAssetOwnedSchema(db, definition, optional);
export const assertPostgresAssetVtwoRecoverySchema = (
  c: PoolClient,
  s: string,
  optional = false,
) => assertPostgresAssetOwnedSchema(c, s, definition, optional);
export function migrateSqliteAssetVtwoRecovery(db: DatabaseSync) {
  assertSqliteAssetMediaAdoptionSchema(db);
  migrateSqliteAssetOwnedSchema(db, definition);
}
export async function migratePostgresAssetVtwoRecovery(
  c: PoolClient,
  s: string,
) {
  await assertPostgresAssetMediaAdoptionSchema(c, s);
  await migratePostgresAssetOwnedSchema(c, s, definition);
}
