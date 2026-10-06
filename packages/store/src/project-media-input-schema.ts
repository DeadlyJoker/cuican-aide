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
const heads = "project_media_inputs",
  revisions = "project_media_input_revisions",
  receipts = "project_media_input_receipts",
  marker = "project_media_input_schema_version";
const definition: AssetOwnedSchema = {
  tables: [heads, revisions, receipts, marker],
  marker,
  functions: [
    "project_media_input_immutable",
    "project_media_input_head_guard",
  ],
  error: "project_media_input_schema_invalid",
  sql(pg, p) {
    const j = pg ? "JSONB" : "TEXT",
      i = pg ? "BIGINT" : "INTEGER",
      strict = pg ? "" : " STRICT",
      scope =
        "tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,project_id TEXT NOT NULL,media_input_id TEXT NOT NULL",
      primary = "tenant_id,space_id,project_id,media_input_id",
      object = (name: string, max: number) =>
        pg
          ? `jsonb_typeof(${name})='object' AND octet_length(${name}::text)<=${max}`
          : `json_valid(${name}) AND json_type(${name})='object' AND length(CAST(${name} AS BLOB))<=${max}`,
      latestFk = `FOREIGN KEY(${primary},latest_input_revision) REFERENCES ${p}${revisions}(${primary},input_revision) DEFERRABLE INITIALLY DEFERRED`,
      immutable = [revisions, receipts, marker];
    const ddl = `CREATE TABLE ${p}${heads}(${scope},owner_principal_id TEXT NOT NULL,latest_input_revision ${i} NOT NULL CHECK(latest_input_revision BETWEEN 1 AND 9007199254740991),item_json ${j} NOT NULL CHECK(${object("item_json", 4096)}),workflow_id TEXT NOT NULL CHECK(workflow_id IN('krea2-reference-four-view','flux2-three-reference-storyboard')),PRIMARY KEY(${primary}),FOREIGN KEY(tenant_id,space_id,project_id,owner_principal_id) REFERENCES ${p}creative_projects(tenant_id,space_id,project_id,owner_principal_id) ON DELETE RESTRICT${pg ? "" : `,${latestFk}`})${strict};
      CREATE TABLE ${p}${revisions}(${scope},input_revision ${i} NOT NULL CHECK(input_revision BETWEEN 1 AND 9007199254740991),content_digest TEXT NOT NULL,record_json ${j} NOT NULL CHECK(${object("record_json", 96 * 1024)}),PRIMARY KEY(${primary},input_revision),UNIQUE(${primary},input_revision,content_digest),FOREIGN KEY(${primary}) REFERENCES ${p}${heads}(${primary}) ON DELETE RESTRICT)${strict};
      ${pg ? `ALTER TABLE ${p}${heads} ADD ${latestFk};` : ""}
      CREATE TABLE ${p}${receipts}(tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,principal_id TEXT NOT NULL,actor_id TEXT NOT NULL,project_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,request_digest TEXT NOT NULL,media_input_id TEXT NOT NULL,input_revision ${i} NOT NULL,content_digest TEXT NOT NULL,PRIMARY KEY(tenant_id,space_id,principal_id,actor_id,project_id,idempotency_key),FOREIGN KEY(${primary},input_revision,content_digest) REFERENCES ${p}${revisions}(${primary},input_revision,content_digest) ON DELETE RESTRICT)${strict};
      CREATE TABLE ${p}${marker}(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,migration_digest TEXT NOT NULL,schema_digest TEXT NOT NULL)${strict};`;
    const changed =
      [
        "tenant_id",
        "space_id",
        "project_id",
        "media_input_id",
        "owner_principal_id",
        "item_json",
        "workflow_id",
      ]
        .map((k) => `NEW.${k} ${pg ? "IS DISTINCT FROM" : "IS NOT"} OLD.${k}`)
        .join(" OR ") +
      " OR NEW.latest_input_revision!=OLD.latest_input_revision+1";
    if (!pg)
      return (
        ddl +
        immutable
          .map(
            (t) =>
              `CREATE TRIGGER ${t}_immutable BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT,'project_media_input_immutable'); END; CREATE TRIGGER ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT,'project_media_input_immutable'); END;`,
          )
          .join("") +
        `CREATE TRIGGER ${heads}_guard BEFORE UPDATE ON ${heads} WHEN ${changed} BEGIN SELECT RAISE(ABORT,'project_media_input_head_invalid'); END; CREATE TRIGGER ${heads}_no_delete BEFORE DELETE ON ${heads} BEGIN SELECT RAISE(ABORT,'project_media_input_immutable'); END;`
      );
    return (
      ddl +
      `CREATE FUNCTION ${p}project_media_input_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'project_media_input_immutable'; END; $$;` +
      immutable
        .map(
          (t) =>
            `CREATE TRIGGER ${t}_immutable BEFORE UPDATE OR DELETE ON ${p}${t} FOR EACH ROW EXECUTE FUNCTION ${p}project_media_input_immutable();`,
        )
        .join("") +
      `CREATE FUNCTION ${p}project_media_input_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP='DELETE' OR ${changed} THEN RAISE EXCEPTION 'project_media_input_head_invalid'; END IF; RETURN NEW; END; $$; CREATE TRIGGER ${heads}_guard BEFORE UPDATE OR DELETE ON ${p}${heads} FOR EACH ROW EXECUTE FUNCTION ${p}project_media_input_head_guard();`
    );
  },
};
export const assertSqliteProjectMediaInputSchema = (
  db: DatabaseSync,
  optional = false,
) => assertSqliteAssetOwnedSchema(db, definition, optional);
export const assertPostgresProjectMediaInputSchema = (
  c: PoolClient,
  schema: string,
  optional = false,
) => assertPostgresAssetOwnedSchema(c, schema, definition, optional);
export function migrateSqliteProjectMediaInputs(db: DatabaseSync) {
  assertSqliteProjectAssetSchema(db);
  migrateSqliteAssetOwnedSchema(db, definition);
}
export async function migratePostgresProjectMediaInputs(
  c: PoolClient,
  schema: string,
) {
  await assertPostgresProjectAssetSchema(c, schema);
  await migratePostgresAssetOwnedSchema(c, schema, definition);
}
