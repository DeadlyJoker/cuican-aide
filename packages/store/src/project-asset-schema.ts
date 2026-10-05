import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";

export const PROJECT_ASSET_SCHEMA_VERSION = 1;
const tables = [
  "project_assets",
  "project_asset_revisions",
  "project_asset_reference_revisions",
  "project_asset_mutation_receipts",
  "project_asset_schema_version",
] as const;
const immutable = [
  "project_asset_revisions",
  "project_asset_reference_revisions",
  "project_asset_mutation_receipts",
  "project_asset_schema_version",
] as const;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function definitions(pg: boolean, schema = "main") {
  const p = pg ? `${creativeProjectSchemaName(schema)}.` : "",
    json = pg ? "JSONB" : "TEXT",
    integer = pg ? "BIGINT" : "INTEGER",
    strict = pg ? "" : " STRICT";
  const safe = (name: string, min = 1) =>
    `${name} BETWEEN ${min} AND 9007199254740991`;
  const object = (name: string, max = 32768) =>
    pg
      ? `jsonb_typeof(${name})='object' AND octet_length(${name}::text)<=${max}`
      : `json_valid(${name}) AND json_type(${name})='object' AND length(CAST(${name} AS BLOB))<=${max}`;
  const scope =
    "tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,project_id TEXT NOT NULL,asset_id TEXT NOT NULL";
  const fk = `FOREIGN KEY(tenant_id,space_id,project_id,asset_id) REFERENCES ${p}project_assets(tenant_id,space_id,project_id,asset_id) ON DELETE RESTRICT`;
  const sql = `
    CREATE TABLE ${p}project_assets(${scope},owner_principal_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('character','scene','prop')),
      revision ${integer} NOT NULL CHECK(${safe("revision")}),latest_content_revision ${integer} NOT NULL CHECK(${safe("latest_content_revision")}),selected_content_revision ${integer} CHECK(${safe("selected_content_revision")} AND selected_content_revision<=latest_content_revision),
      latest_reference_revision ${integer} NOT NULL CHECK(${safe("latest_reference_revision", 0)}),selected_reference_revision ${integer} CHECK(${safe("selected_reference_revision")} AND selected_reference_revision<=latest_reference_revision),
      locked INTEGER NOT NULL CHECK(locked IN(0,1) AND (locked=0 OR selected_content_revision IS NOT NULL)),record_json ${json} NOT NULL CHECK(${object("record_json", 8192)}),
      CHECK(latest_content_revision+latest_reference_revision<=revision),PRIMARY KEY(tenant_id,space_id,project_id,asset_id),
      FOREIGN KEY(tenant_id,space_id,project_id,asset_id,selected_content_revision) REFERENCES ${p}project_asset_revisions(tenant_id,space_id,project_id,asset_id,content_revision) DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(tenant_id,space_id,project_id,asset_id,selected_reference_revision) REFERENCES ${p}project_asset_reference_revisions(tenant_id,space_id,project_id,asset_id,reference_revision) DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(tenant_id,space_id,project_id,owner_principal_id) REFERENCES ${p}creative_projects(tenant_id,space_id,project_id,owner_principal_id) ON DELETE RESTRICT)${strict};
    CREATE TABLE ${p}project_asset_revisions(${scope},content_revision ${integer} NOT NULL CHECK(${safe("content_revision")}),content_digest TEXT NOT NULL,
      brief_revision ${integer} NOT NULL CHECK(${safe("brief_revision")}),brief_content_digest TEXT NOT NULL,script_artifact_id TEXT,script_content_revision ${integer},script_content_digest TEXT,
      record_json ${json} NOT NULL CHECK(${object("record_json")}),PRIMARY KEY(tenant_id,space_id,project_id,asset_id,content_revision),UNIQUE(tenant_id,space_id,project_id,asset_id,content_revision,content_digest),${fk},
      CHECK((script_artifact_id IS NULL AND script_content_revision IS NULL AND script_content_digest IS NULL) OR (script_artifact_id IS NOT NULL AND ${safe("script_content_revision")} AND script_content_digest IS NOT NULL)),
      FOREIGN KEY(tenant_id,space_id,project_id,brief_revision,brief_content_digest) REFERENCES ${p}creative_project_briefs(tenant_id,space_id,project_id,brief_revision,content_digest) ON DELETE RESTRICT,
      FOREIGN KEY(tenant_id,space_id,project_id,script_artifact_id,script_content_revision,script_content_digest) REFERENCES ${p}project_text_revisions(tenant_id,space_id,project_id,artifact_id,content_revision,content_digest) ON DELETE RESTRICT)${strict};
    CREATE TABLE ${p}project_asset_reference_revisions(${scope},reference_revision ${integer} NOT NULL CHECK(${safe("reference_revision")}),content_digest TEXT NOT NULL,
      asset_content_revision ${integer} NOT NULL CHECK(${safe("asset_content_revision")}),asset_content_digest TEXT NOT NULL,result_link_digest TEXT NOT NULL,record_json ${json} NOT NULL CHECK(${object("record_json")}),
      PRIMARY KEY(tenant_id,space_id,project_id,asset_id,reference_revision),${fk},
      FOREIGN KEY(tenant_id,space_id,project_id,asset_id,asset_content_revision,asset_content_digest) REFERENCES ${p}project_asset_revisions(tenant_id,space_id,project_id,asset_id,content_revision,content_digest) ON DELETE RESTRICT)${strict};
    CREATE TABLE ${p}project_asset_mutation_receipts(tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,principal_id TEXT NOT NULL,actor_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN('save-content','select-content','set-lock','save-reference','select-reference')),idempotency_key TEXT NOT NULL,request_digest TEXT NOT NULL,project_id TEXT NOT NULL,
      ui_intent_id TEXT,ui_intent_scope_digest TEXT,result_json ${json} NOT NULL CHECK(${object("result_json", 65536)}),CHECK((ui_intent_id IS NULL)=(ui_intent_scope_digest IS NULL)),PRIMARY KEY(tenant_id,space_id,principal_id,actor_id,kind,idempotency_key),
      FOREIGN KEY(tenant_id,space_id,project_id,principal_id) REFERENCES ${p}creative_projects(tenant_id,space_id,project_id,owner_principal_id) ON DELETE RESTRICT)${strict};
    CREATE TABLE ${p}project_asset_schema_version(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,migration_digest TEXT NOT NULL,schema_digest TEXT NOT NULL)${strict};
  `;
  if (!pg) return { sql, p };
  const deferred =
    /      FOREIGN KEY\(tenant_id,space_id,project_id,asset_id,selected_(?:content|reference)_revision\)[^\n]+\n/gu;
  return {
    sql:
      sql.replace(deferred, "") +
      `ALTER TABLE ${p}project_assets ADD FOREIGN KEY(tenant_id,space_id,project_id,asset_id,selected_content_revision) REFERENCES ${p}project_asset_revisions(tenant_id,space_id,project_id,asset_id,content_revision) DEFERRABLE INITIALLY DEFERRED, ADD FOREIGN KEY(tenant_id,space_id,project_id,asset_id,selected_reference_revision) REFERENCES ${p}project_asset_reference_revisions(tenant_id,space_id,project_id,asset_id,reference_revision) DEFERRABLE INITIALLY DEFERRED;`,
    p,
  };
}
function triggers(pg: boolean, schema = "main") {
  const p = pg ? `${creativeProjectSchemaName(schema)}.` : "";
  if (!pg)
    return (
      immutable
        .map(
          (
            table,
          ) => `CREATE TRIGGER ${table}_immutable BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'project_asset_history_immutable'); END;
    CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'project_asset_history_immutable'); END;`,
        )
        .join("\n") +
      `
    CREATE TRIGGER project_assets_no_delete BEFORE DELETE ON project_assets BEGIN SELECT RAISE(ABORT,'project_asset_identity_immutable'); END;
    CREATE TRIGGER project_assets_identity_immutable BEFORE UPDATE ON project_assets WHEN NEW.tenant_id IS NOT OLD.tenant_id OR NEW.space_id IS NOT OLD.space_id OR NEW.project_id IS NOT OLD.project_id OR NEW.asset_id IS NOT OLD.asset_id OR NEW.owner_principal_id IS NOT OLD.owner_principal_id OR NEW.kind IS NOT OLD.kind OR NEW.revision<>OLD.revision+1 OR json_extract(NEW.record_json,'$.createdAt') IS NOT json_extract(OLD.record_json,'$.createdAt') OR json_extract(NEW.record_json,'$.createdByActorId') IS NOT json_extract(OLD.record_json,'$.createdByActorId') BEGIN SELECT RAISE(ABORT,'project_asset_identity_immutable'); END;`
    );
  return `CREATE FUNCTION ${p}project_asset_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'project_asset_history_immutable'; END; $$;
    ${immutable.map((table) => `CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON ${p}${table} FOR EACH ROW EXECUTE FUNCTION ${p}project_asset_history_immutable();`).join("\n")}
    CREATE FUNCTION ${p}project_asset_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP='DELETE' OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.space_id IS DISTINCT FROM OLD.space_id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.asset_id IS DISTINCT FROM OLD.asset_id OR NEW.owner_principal_id IS DISTINCT FROM OLD.owner_principal_id OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.revision<>OLD.revision+1 OR (NEW.record_json->>'createdAt') IS DISTINCT FROM (OLD.record_json->>'createdAt') OR (NEW.record_json->>'createdByActorId') IS DISTINCT FROM (OLD.record_json->>'createdByActorId') THEN RAISE EXCEPTION 'project_asset_identity_immutable'; END IF; RETURN NEW; END; $$;
    CREATE TRIGGER project_assets_identity_immutable BEFORE UPDATE OR DELETE ON ${p}project_assets FOR EACH ROW EXECUTE FUNCTION ${p}project_asset_identity_immutable();`;
}
const digest = (pg: boolean, schema?: string) =>
  hash([definitions(pg, schema).sql, triggers(pg, schema)]);
function invalid(): never {
  throw new Error("project_asset_schema_incomplete");
}
function check(
  row: Record<string, unknown> | undefined,
  expected: string,
  actual: unknown,
) {
  if (
    !row ||
    row.version !== 1 ||
    row.migration_digest !== expected ||
    row.schema_digest !== hash(actual)
  )
    invalid();
}
function sqliteSnapshot(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE tbl_name IN ('project_assets','project_asset_revisions','project_asset_reference_revisions','project_asset_mutation_receipts','project_asset_schema_version') ORDER BY type,name",
    )
    .all()
    .map((row) => ({ ...row }));
}
export function assertSqliteProjectAssetSchema(db: DatabaseSync): void {
  const snapshot = sqliteSnapshot(db);
  if (snapshot.filter((row) => row.type === "table").length !== tables.length)
    invalid();
  const row = db
    .prepare(
      "SELECT id,version,migration_digest,schema_digest FROM project_asset_schema_version LIMIT 2",
    )
    .all();
  if (row.length !== 1 || row[0]?.id !== 1) invalid();
  check(row[0], digest(false), snapshot);
}
/** Explicit migration never repairs a partially lost archive under an existing marker. */
export function migrateSqliteProjectAssets(db: DatabaseSync): void {
  const existing = sqliteSnapshot(db);
  if (existing.length) {
    assertSqliteProjectAssetSchema(db);
    return;
  }
  db.prepare(
    "SELECT tenant_id,space_id,project_id,owner_principal_id FROM creative_projects LIMIT 0",
  ).all();
  db.prepare(
    "SELECT artifact_id,content_revision,content_digest FROM project_text_revisions LIMIT 0",
  ).all();
  db.exec(definitions(false).sql + triggers(false));
  db.prepare("INSERT INTO project_asset_schema_version VALUES(1,1,?,?)").run(
    digest(false),
    hash(sqliteSnapshot(db)),
  );
  assertSqliteProjectAssetSchema(db);
}
async function pgSnapshot(client: PoolClient, schema: string) {
  const rows = (
    await client.query(
      `SELECT 'table' AS type,c.relname AS name,pg_catalog.jsonb_build_object('columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'constraints',(SELECT jsonb_agg(jsonb_build_array(x.conname,pg_get_constraintdef(x.oid),x.convalidated) ORDER BY x.conname) FROM pg_constraint x WHERE x.conrelid=c.oid),'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgname,pg_get_triggerdef(t.oid),t.tgenabled) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),'indexes',(SELECT jsonb_agg(pg_get_indexdef(i.indexrelid) ORDER BY i.indexrelid::regclass::text) FROM pg_index i WHERE i.indrelid=c.oid)) AS definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r' AND c.relname IN ('project_assets','project_asset_revisions','project_asset_reference_revisions','project_asset_mutation_receipts','project_asset_schema_version')
    UNION ALL SELECT 'function',p.proname,to_jsonb(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname IN('project_asset_history_immutable','project_asset_identity_immutable') ORDER BY type,name`,
      [schema],
    )
  ).rows;
  return rows;
}
export async function assertPostgresProjectAssetSchema(
  client: PoolClient,
  schema: string,
): Promise<void> {
  const snapshot = await pgSnapshot(client, schema),
    p = `${creativeProjectSchemaName(schema)}.`;
  if (snapshot.filter((row) => row.type === "table").length !== tables.length)
    invalid();
  const rows = (
    await client.query(
      `SELECT id,version,migration_digest,schema_digest FROM ${p}project_asset_schema_version LIMIT 2`,
    )
  ).rows;
  if (rows.length !== 1 || rows[0]?.id !== 1) invalid();
  check(rows[0], digest(true, schema), snapshot);
}
export async function migratePostgresProjectAssets(
  client: PoolClient,
  schema: string,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    JSON.stringify(["project-asset-schema", schema]),
  ]);
  const existing = await pgSnapshot(client, schema);
  if (existing.length) {
    await assertPostgresProjectAssetSchema(client, schema);
    return;
  }
  const { sql, p } = definitions(true, schema);
  await client.query(
    `SELECT tenant_id,space_id,project_id,owner_principal_id FROM ${p}creative_projects LIMIT 0`,
  );
  await client.query(
    `SELECT artifact_id,content_revision,content_digest FROM ${p}project_text_revisions LIMIT 0`,
  );
  await client.query(sql + triggers(true, schema));
  await client.query(
    `INSERT INTO ${p}project_asset_schema_version VALUES(1,1,$1,$2)`,
    [digest(true, schema), hash(await pgSnapshot(client, schema))],
  );
  await assertPostgresProjectAssetSchema(client, schema);
}
