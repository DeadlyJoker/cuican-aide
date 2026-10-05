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
const table = "project_asset_ui_intents",
  marker = "project_asset_ui_intent_schema_version";
const identity = [
  "scope_digest",
  "tenant_id",
  "space_id",
  "principal_id",
  "actor_id",
  "project_id",
  "intent_id",
  "kind",
  "idempotency_key",
  "request_digest",
];
const immutable = [
  "schemaVersion",
  "scope",
  "projectId",
  "intentId",
  "actionId",
  "input",
  "requestDigest",
  "createdAt",
];
const definition: AssetOwnedSchema = {
  tables: [table, marker],
  marker,
  functions: ["project_asset_ui_intent_immutable"],
  error: "project_asset_ui_intent_schema_invalid",
  sql(pg, p) {
    const integer = pg ? "BIGINT" : "INTEGER",
      j = pg ? "JSONB" : "TEXT",
      strict = pg ? "" : " STRICT",
      bounded = pg
        ? "jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=32768"
        : "json_valid(record_json) AND json_type(record_json)='object' AND length(CAST(record_json AS BLOB))<=32768";
    const ddl = `CREATE TABLE ${p}${table}(scope_digest TEXT NOT NULL,tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,principal_id TEXT NOT NULL,actor_id TEXT NOT NULL,project_id TEXT NOT NULL,intent_id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN('save-content','select-content','set-lock','save-reference','select-reference')),idempotency_key TEXT NOT NULL,request_digest TEXT NOT NULL,revision ${integer} NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),phase TEXT NOT NULL CHECK(phase IN('pending','accepted','refused')),acknowledged INTEGER NOT NULL CHECK(acknowledged IN(0,1) AND (phase!='pending' OR acknowledged=0)),record_json ${j} NOT NULL CHECK(${bounded}),FOREIGN KEY(tenant_id,space_id,project_id,principal_id) REFERENCES ${p}creative_projects(tenant_id,space_id,project_id,owner_principal_id) ON DELETE RESTRICT)${strict}; CREATE UNIQUE INDEX project_asset_ui_intents_one_active ON ${p}${table}(scope_digest) WHERE acknowledged=0; CREATE UNIQUE INDEX project_asset_ui_intents_receipt_key ON ${p}${table}(tenant_id,space_id,principal_id,actor_id,kind,idempotency_key); CREATE TABLE ${p}${marker}(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,migration_digest TEXT NOT NULL,schema_digest TEXT NOT NULL)${strict};`;
    const changed = identity
        .map((c) =>
          pg
            ? `NEW.${c} IS DISTINCT FROM OLD.${c}`
            : `NEW.${c} IS NOT OLD.${c}`,
        )
        .join(" OR "),
      jchanged = immutable
        .map((k) =>
          pg
            ? `NEW.record_json->'${k}' IS DISTINCT FROM OLD.record_json->'${k}'`
            : `json_extract(NEW.record_json,'$.${k}') IS NOT json_extract(OLD.record_json,'$.${k}')`,
        )
        .join(" OR ");
    const receipt = pg
        ? "NEW.record_json->'receipt' IS DISTINCT FROM OLD.record_json->'receipt'"
        : "json_extract(NEW.record_json,'$.receipt') IS NOT json_extract(OLD.record_json,'$.receipt')",
      refusal = pg
        ? "NEW.record_json->'refusalCode' IS DISTINCT FROM OLD.record_json->'refusalCode'"
        : "json_extract(NEW.record_json,'$.refusalCode') IS NOT json_extract(OLD.record_json,'$.refusalCode')";
    const check = `${changed} OR ${jchanged} OR NEW.revision<>OLD.revision+1 OR OLD.acknowledged=1 OR (OLD.phase!='pending' AND NEW.phase!=OLD.phase) OR (OLD.phase='accepted' AND (${receipt})) OR (OLD.phase='refused' AND (${refusal}))`;
    return (
      ddl +
      (pg
        ? `CREATE FUNCTION ${p}project_asset_ui_intent_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP='DELETE' OR TG_TABLE_NAME='${marker}' THEN RAISE EXCEPTION 'project_asset_ui_intent_immutable'; END IF; IF ${check} THEN RAISE EXCEPTION 'project_asset_ui_intent_immutable'; END IF; RETURN NEW; END; $$; CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON ${p}${table} FOR EACH ROW EXECUTE FUNCTION ${p}project_asset_ui_intent_immutable(); CREATE TRIGGER ${marker}_immutable BEFORE UPDATE OR DELETE ON ${p}${marker} FOR EACH ROW EXECUTE FUNCTION ${p}project_asset_ui_intent_immutable();`
        : `CREATE TRIGGER ${table}_immutable BEFORE UPDATE ON ${table} WHEN ${check} BEGIN SELECT RAISE(ABORT,'project_asset_ui_intent_immutable'); END; CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'project_asset_ui_intent_immutable'); END; CREATE TRIGGER ${marker}_immutable BEFORE UPDATE ON ${marker} BEGIN SELECT RAISE(ABORT,'project_asset_ui_intent_immutable'); END; CREATE TRIGGER ${marker}_no_delete BEFORE DELETE ON ${marker} BEGIN SELECT RAISE(ABORT,'project_asset_ui_intent_immutable'); END;`)
    );
  },
};
export const assertSqliteAssetIntentSchema = (
  db: DatabaseSync,
  optional = false,
) => assertSqliteAssetOwnedSchema(db, definition, optional);
export const assertPostgresAssetIntentSchema = (
  c: PoolClient,
  s: string,
  optional = false,
) => assertPostgresAssetOwnedSchema(c, s, definition, optional);
export function migrateSqliteAssetIntent(db: DatabaseSync) {
  assertSqliteProjectAssetSchema(db);
  migrateSqliteAssetOwnedSchema(db, definition);
}
export async function migratePostgresAssetIntent(c: PoolClient, s: string) {
  await assertPostgresProjectAssetSchema(c, s);
  await migratePostgresAssetOwnedSchema(c, s, definition);
}
