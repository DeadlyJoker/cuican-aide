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

const initial = "project_material_preparations",
  events = "project_material_preparation_events",
  heads = "project_material_preparation_heads",
  marker = "project_material_preparation_schema_version";
const transitions = (old: string, next: string) =>
  `(${old}='reserved' AND ${next}='dispatching') OR (${old}='dispatching' AND ${next} IN('unknownOutcome','verified','rejected')) OR (${old}='unknownOutcome' AND ${next} IN('verified','rejected'))`;
const definition: AssetOwnedSchema = {
  tables: [initial, events, heads, marker],
  marker,
  functions: [
    "project_material_preparation_immutable",
    "project_material_preparation_event_guard",
    "project_material_preparation_head_guard",
  ],
  error: "project_material_preparation_schema_invalid",
  sql(pg, p) {
    const j = pg ? "JSONB" : "TEXT",
      i = pg ? "BIGINT" : "INTEGER",
      strict = pg ? "" : " STRICT";
    const object = (max: number) =>
      pg
        ? `jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=${max}`
        : `json_valid(record_json) AND json_type(record_json)='object' AND length(CAST(record_json AS BLOB))<=${max}`;
    const phases =
      "'reserved','dispatching','unknownOutcome','verified','rejected'";
    const ddl = `CREATE TABLE ${p}${initial}(intent_id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,principal_id TEXT NOT NULL,actor_id TEXT NOT NULL,project_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,request_digest TEXT NOT NULL,preparation_id TEXT NOT NULL UNIQUE,content_digest TEXT NOT NULL,record_json ${j} NOT NULL CHECK(${object(96 * 1024)}),UNIQUE(intent_id,content_digest),UNIQUE(tenant_id,space_id,principal_id,actor_id,project_id,idempotency_key),FOREIGN KEY(tenant_id,space_id,project_id,principal_id) REFERENCES ${p}creative_projects(tenant_id,space_id,project_id,owner_principal_id) ON DELETE RESTRICT)${strict};
      CREATE TABLE ${p}${events}(intent_id TEXT NOT NULL,initial_digest TEXT NOT NULL,revision ${i} NOT NULL CHECK(revision BETWEEN 1 AND 4),phase TEXT NOT NULL CHECK(phase IN(${phases})),record_json ${j} NOT NULL CHECK(${object(8192)}),PRIMARY KEY(intent_id,revision),UNIQUE(intent_id,revision,phase),FOREIGN KEY(intent_id,initial_digest) REFERENCES ${p}${initial}(intent_id,content_digest) ON DELETE RESTRICT)${strict};
      CREATE TABLE ${p}${heads}(intent_id TEXT PRIMARY KEY,revision ${i} NOT NULL CHECK(revision BETWEEN 1 AND 4),phase TEXT NOT NULL CHECK(phase IN(${phases})),FOREIGN KEY(intent_id,revision,phase) REFERENCES ${p}${events}(intent_id,revision,phase) ON DELETE RESTRICT)${strict};
      CREATE TABLE ${p}${marker}(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,migration_digest TEXT NOT NULL,schema_digest TEXT NOT NULL)${strict};`;
    const immutable = [initial, events, marker];
    const eventInvalid = `(NEW.revision=1 AND (NEW.phase!='reserved' OR EXISTS(SELECT 1 FROM ${p}${heads} h WHERE h.intent_id=NEW.intent_id))) OR (NEW.revision>1 AND NOT EXISTS(SELECT 1 FROM ${p}${heads} h WHERE h.intent_id=NEW.intent_id AND h.revision=NEW.revision-1 AND (${transitions("h.phase", "NEW.phase")})))`;
    const headInvalid = `NEW.intent_id ${pg ? "IS DISTINCT FROM" : "IS NOT"} OLD.intent_id OR NEW.revision!=OLD.revision+1 OR NOT(${transitions("OLD.phase", "NEW.phase")})`;
    if (!pg)
      return (
        ddl +
        immutable
          .map(
            (t) =>
              `CREATE TRIGGER ${t}_immutable BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT,'project_material_preparation_immutable'); END; CREATE TRIGGER ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT,'project_material_preparation_immutable'); END;`,
          )
          .join("") +
        `CREATE TRIGGER ${events}_guard BEFORE INSERT ON ${events} WHEN ${eventInvalid} BEGIN SELECT RAISE(ABORT,'project_material_preparation_transition_invalid'); END; CREATE TRIGGER ${heads}_guard BEFORE UPDATE ON ${heads} WHEN ${headInvalid} BEGIN SELECT RAISE(ABORT,'project_material_preparation_transition_invalid'); END; CREATE TRIGGER ${heads}_no_delete BEFORE DELETE ON ${heads} BEGIN SELECT RAISE(ABORT,'project_material_preparation_immutable'); END;`
      );
    return (
      ddl +
      `CREATE FUNCTION ${p}project_material_preparation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'project_material_preparation_immutable'; END; $$;` +
      immutable
        .map(
          (t) =>
            `CREATE TRIGGER ${t}_immutable BEFORE UPDATE OR DELETE ON ${p}${t} FOR EACH ROW EXECUTE FUNCTION ${p}project_material_preparation_immutable();`,
        )
        .join("") +
      `CREATE FUNCTION ${p}project_material_preparation_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${eventInvalid} THEN RAISE EXCEPTION 'project_material_preparation_transition_invalid'; END IF; RETURN NEW; END; $$; CREATE TRIGGER ${events}_guard BEFORE INSERT ON ${p}${events} FOR EACH ROW EXECUTE FUNCTION ${p}project_material_preparation_event_guard(); CREATE FUNCTION ${p}project_material_preparation_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP='DELETE' THEN RAISE EXCEPTION 'project_material_preparation_immutable'; END IF; IF ${headInvalid} THEN RAISE EXCEPTION 'project_material_preparation_transition_invalid'; END IF; RETURN NEW; END; $$; CREATE TRIGGER ${heads}_guard BEFORE UPDATE OR DELETE ON ${p}${heads} FOR EACH ROW EXECUTE FUNCTION ${p}project_material_preparation_head_guard();`
    );
  },
};
export const assertSqliteMaterialPreparationSchema = (
  db: DatabaseSync,
  optional = false,
) => assertSqliteAssetOwnedSchema(db, definition, optional);
export const assertPostgresMaterialPreparationSchema = (
  c: PoolClient,
  s: string,
  optional = false,
) => assertPostgresAssetOwnedSchema(c, s, definition, optional);
export function migrateSqliteMaterialPreparations(db: DatabaseSync) {
  assertSqliteProjectAssetSchema(db);
  migrateSqliteAssetOwnedSchema(db, definition);
}
export async function migratePostgresMaterialPreparations(
  c: PoolClient,
  s: string,
) {
  await assertPostgresProjectAssetSchema(c, s);
  await migratePostgresAssetOwnedSchema(c, s, definition);
}
