import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";

const tables = [
  "project_conversation_schema_version",
  "project_conversation_bindings",
  "project_conversation_receipts",
  "project_stage_run_admissions",
] as const;
const reads = [
  "SELECT id,version FROM project_conversation_schema_version LIMIT 0",
  "SELECT tenant_id,space_id,principal_id,actor_id,profile_id,binding_id,project_id,thread_id,revision,state,record_json FROM project_conversation_bindings LIMIT 0",
  "SELECT tenant_id,space_id,principal_id,actor_id,profile_id,idempotency_key,request_digest,kind,binding_id,result_json FROM project_conversation_receipts LIMIT 0",
  "SELECT tenant_id,space_id,run_id,thread_id,binding_id,binding_revision,record_json FROM project_stage_run_admissions LIMIT 0",
];
export function conversationSchemaSql(
  dialect: "sqlite" | "postgres",
  schema = "public",
): string {
  const pg = dialect === "postgres",
    p = pg ? `${creativeProjectSchemaName(schema)}.` : "",
    j = pg ? "JSONB" : "TEXT",
    integer = pg ? "BIGINT" : "INTEGER",
    strict = pg ? "" : " STRICT",
    collate = pg ? ' COLLATE "C"' : " COLLATE BINARY";
  const json = (c: string, max: number) =>
    pg
      ? `jsonb_typeof(${c})='object' AND octet_length(${c}::text)<=${max}`
      : `json_valid(${c}) AND json_type(${c})='object' AND length(CAST(${c} AS BLOB))<=${max}`;
  return `
  CREATE TABLE IF NOT EXISTS ${p}project_conversation_schema_version (id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL CHECK(version=1))${strict};
  INSERT INTO ${p}project_conversation_schema_version VALUES(1,1) ON CONFLICT(id) DO NOTHING;
  CREATE TABLE IF NOT EXISTS ${p}project_conversation_bindings (
    tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,principal_id TEXT NOT NULL,actor_id TEXT NOT NULL,profile_id TEXT NOT NULL,
    binding_id TEXT NOT NULL,project_id TEXT NOT NULL,thread_id TEXT NOT NULL,
    revision ${integer} NOT NULL CHECK(revision>=1 AND revision<=9007199254740991),state TEXT NOT NULL CHECK(state IN ('active','revoked')),
    record_json ${j} NOT NULL CHECK(${json("record_json", 16384)}),
    PRIMARY KEY(tenant_id,space_id,binding_id),UNIQUE(tenant_id,space_id,thread_id),
    FOREIGN KEY(tenant_id,space_id,project_id,principal_id) REFERENCES ${p}creative_projects(tenant_id,space_id,project_id,owner_principal_id),
    FOREIGN KEY(tenant_id,thread_id) REFERENCES ${p}threads(tenant_id,thread_id)
  )${strict};
  CREATE INDEX IF NOT EXISTS project_conversation_owner_page ON ${p}project_conversation_bindings(tenant_id,space_id,principal_id,actor_id,profile_id,project_id,thread_id${collate});
  CREATE TABLE IF NOT EXISTS ${p}project_conversation_receipts (
    tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,principal_id TEXT NOT NULL,actor_id TEXT NOT NULL,profile_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,request_digest TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('create','refresh-source','set-state')),binding_id TEXT NOT NULL,
    result_json ${j} NOT NULL CHECK(${json("result_json", 32768)}),
    PRIMARY KEY(tenant_id,space_id,principal_id,actor_id,profile_id,idempotency_key),
    FOREIGN KEY(tenant_id,space_id,binding_id) REFERENCES ${p}project_conversation_bindings(tenant_id,space_id,binding_id)
  )${strict};
  CREATE TABLE IF NOT EXISTS ${p}project_stage_run_admissions (
    tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,run_id TEXT NOT NULL,thread_id TEXT NOT NULL,binding_id TEXT NOT NULL,
    binding_revision ${integer} NOT NULL CHECK(binding_revision>=1 AND binding_revision<=9007199254740991),
    record_json ${j} NOT NULL CHECK(${json("record_json", 32768)}),PRIMARY KEY(tenant_id,run_id),
    FOREIGN KEY(tenant_id,run_id) REFERENCES ${p}run_snapshots(tenant_id,run_id),
    FOREIGN KEY(tenant_id,space_id,binding_id) REFERENCES ${p}project_conversation_bindings(tenant_id,space_id,binding_id)
  )${strict};`;
}
function fail(): never {
  throw new Error("project_conversation_schema_incomplete");
}
function version(rows: readonly { id: unknown; version: unknown }[]): void {
  if (rows.length !== 1 || rows[0]?.id !== 1 || rows[0]?.version !== 1)
    throw new Error("project_conversation_schema_version_unsupported");
}
function sqliteTables(db: DatabaseSync, names: readonly string[]): void {
  for (const name of names) {
    const rows = db
      .prepare(
        "SELECT type FROM main.sqlite_schema WHERE name=? UNION ALL SELECT type FROM temp.sqlite_schema WHERE name=?",
      )
      .all(name, name);
    if (rows.length !== 1 || rows[0]?.type !== "table") fail();
  }
}
async function pgTables(
  c: PoolClient,
  schema: string,
  names: readonly string[],
): Promise<void> {
  const rows = (
    await c.query<{ relname: string; relkind: string }>(
      "SELECT c.relname,c.relkind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[])",
      [schema, names],
    )
  ).rows;
  if (
    rows.length !== names.length ||
    names.some((n) => !rows.some((r) => r.relname === n && r.relkind === "r"))
  )
    fail();
}
const originals = [
  "creative_project_schema_version",
  "creative_projects",
  "creative_project_briefs",
  "threads",
  "run_snapshots",
  "plugin_installation_schema_version",
  "plugin_profile_selections",
  "installed_plugin_packages",
  "plugin_task_admission_schema_version",
  "plugin_task_admissions",
];
export function assertSqliteConversationSchema(db: DatabaseSync): void {
  sqliteTables(db, [...tables, ...originals]);
  version(
    db
      .prepare(
        "SELECT id,version FROM project_conversation_schema_version LIMIT 2",
      )
      .all() as { id: unknown; version: unknown }[],
  );
  db.prepare(
    "SELECT project_conversation_binding_id FROM threads LIMIT 0",
  ).all();
  db.prepare(
    "SELECT project_stage_digest FROM plugin_task_admissions LIMIT 0",
  ).all();
  for (const [table, column] of [
    ["threads", "project_conversation_binding_id"],
    ["plugin_task_admissions", "project_stage_digest"],
  ] as const) {
    const c = db
      .prepare(`PRAGMA main.table_xinfo(${table})`)
      .all()
      .find((c) => c.name === column);
    if (c?.type !== "TEXT" || c.notnull !== 0 || c.hidden !== 0) fail();
  }
  for (const query of reads) db.prepare(query).all();
  for (const table of tables.slice(1)) {
    const name =
      table === "project_conversation_bindings"
        ? `${table}_immutable_identity`
        : `${table}_immutable`;
    if (
      db
        .prepare(
          "SELECT name FROM main.sqlite_schema WHERE type='trigger' AND tbl_name=? AND name=?",
        )
        .all(table, name).length !== 1
    )
      fail();
    if (
      db
        .prepare(
          "SELECT name FROM main.sqlite_schema WHERE type='trigger' AND tbl_name=? AND name=?",
        )
        .all(table, `${table}_no_delete`).length !== 1
    )
      fail();
  }
  if (
    db
      .prepare(
        "SELECT name FROM main.sqlite_schema WHERE type='trigger' AND tbl_name='threads' AND name='project_conversation_thread_marker_immutable'",
      )
      .all().length !== 1
  )
    fail();
}
export async function assertPostgresConversationSchema(
  c: PoolClient,
  schema: string,
): Promise<void> {
  const p = `${creativeProjectSchemaName(schema)}.`;
  await pgTables(c, schema, [...tables, ...originals]);
  version(
    (
      await c.query<{ id: unknown; version: unknown }>(
        `SELECT id,version FROM ${p}project_conversation_schema_version LIMIT 2`,
      )
    ).rows,
  );
  await c.query(
    `SELECT project_conversation_binding_id FROM ${p}threads LIMIT 0`,
  );
  await c.query(
    `SELECT project_stage_digest FROM ${p}plugin_task_admissions LIMIT 0`,
  );
  for (const [table, column] of [
    ["threads", "project_conversation_binding_id"],
    ["plugin_task_admissions", "project_stage_digest"],
  ] as const) {
    const r = (
      await c.query(
        "SELECT a.atttypid,a.attnotnull,a.attgenerated FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND a.attname=$3 AND a.attnum>0 AND NOT a.attisdropped",
        [schema, table, column],
      )
    ).rows;
    if (
      r.length !== 1 ||
      r[0]?.atttypid !== 25 ||
      r[0]?.attnotnull !== false ||
      r[0]?.attgenerated !== ""
    )
      fail();
  }
  for (const query of reads)
    await c.query(query.replace(/FROM (project_[a-z_]+)/u, `FROM ${p}$1`));
  for (const table of tables.slice(1)) {
    const name =
      table === "project_conversation_bindings"
        ? `${table}_immutable_identity`
        : `${table}_immutable`;
    const rows = (
      await c.query(
        "SELECT t.tgname FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND t.tgname=$3 AND NOT t.tgisinternal AND t.tgenabled='O' AND t.tgtype=27",
        [schema, table, name],
      )
    ).rows;
    if (rows.length !== 1) fail();
  }
  if (
    (
      await c.query(
        "SELECT t.tgname FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='threads' AND t.tgname='project_conversation_thread_marker_immutable' AND NOT t.tgisinternal AND t.tgenabled='O' AND t.tgtype=19",
        [schema],
      )
    ).rows.length !== 1
  )
    fail();
}
export function migrateSqliteConversations(db: DatabaseSync): void {
  sqliteTables(db, originals);
  const existing = db
    .prepare(
      "SELECT type FROM main.sqlite_schema WHERE name='project_conversation_schema_version'",
    )
    .get();
  if (existing) {
    if (existing.type !== "table") fail();
    version(
      db
        .prepare(
          "SELECT id,version FROM project_conversation_schema_version LIMIT 2",
        )
        .all() as { id: unknown; version: unknown }[],
    );
  }
  for (const [table, column] of [
    ["threads", "project_conversation_binding_id"],
    ["plugin_task_admissions", "project_stage_digest"],
  ] as const)
    if (
      !db
        .prepare(`PRAGMA main.table_xinfo(${table})`)
        .all()
        .some((c) => c.name === column)
    )
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
  db.exec(
    `CREATE TRIGGER IF NOT EXISTS project_conversation_thread_marker_immutable BEFORE UPDATE ON threads WHEN OLD.project_conversation_binding_id IS NOT NULL AND NEW.project_conversation_binding_id IS NOT OLD.project_conversation_binding_id BEGIN SELECT RAISE(ABORT,'project_conversation_marker_immutable'); END;`,
  );
  db.exec(conversationSchemaSql("sqlite"));
  for (const table of [
    "project_conversation_receipts",
    "project_stage_run_admissions",
  ])
    db.exec(
      `CREATE TRIGGER IF NOT EXISTS ${table}_immutable BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'project_conversation_history_immutable'); END; CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'project_conversation_history_immutable'); END;`,
    );
  const columns = [
    "tenant_id",
    "space_id",
    "principal_id",
    "actor_id",
    "profile_id",
    "binding_id",
    "project_id",
    "thread_id",
  ];
  db.exec(
    `CREATE TRIGGER IF NOT EXISTS project_conversation_bindings_immutable_identity BEFORE UPDATE ON project_conversation_bindings WHEN ${columns.map((k) => `NEW.${k} IS NOT OLD.${k}`).join(" OR ")} OR NEW.revision!=OLD.revision+1 BEGIN SELECT RAISE(ABORT,'project_conversation_identity_immutable'); END; CREATE TRIGGER IF NOT EXISTS project_conversation_bindings_no_delete BEFORE DELETE ON project_conversation_bindings BEGIN SELECT RAISE(ABORT,'project_conversation_identity_immutable'); END;`,
  );
  assertSqliteConversationSchema(db);
}
export async function migratePostgresConversations(
  c: PoolClient,
  schema: string,
): Promise<void> {
  const p = `${creativeProjectSchemaName(schema)}.`;
  await pgTables(c, schema, originals);
  const marker = (
    await c.query<{ relkind: string }>(
      "SELECT c.relkind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='project_conversation_schema_version'",
      [schema],
    )
  ).rows;
  if (marker.length) {
    if (marker[0]?.relkind !== "r") fail();
    version(
      (
        await c.query<{ id: unknown; version: unknown }>(
          `SELECT id,version FROM ${p}project_conversation_schema_version LIMIT 2`,
        )
      ).rows,
    );
  }
  await c.query(
    `ALTER TABLE ${p}threads ADD COLUMN IF NOT EXISTS project_conversation_binding_id TEXT; ALTER TABLE ${p}plugin_task_admissions ADD COLUMN IF NOT EXISTS project_stage_digest TEXT; CREATE OR REPLACE FUNCTION ${p}project_conversation_thread_marker_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.project_conversation_binding_id IS NOT NULL AND NEW.project_conversation_binding_id IS DISTINCT FROM OLD.project_conversation_binding_id THEN RAISE EXCEPTION 'project_conversation_marker_immutable'; END IF; RETURN NEW; END; $$; CREATE OR REPLACE TRIGGER project_conversation_thread_marker_immutable BEFORE UPDATE ON ${p}threads FOR EACH ROW EXECUTE FUNCTION ${p}project_conversation_thread_marker_immutable();`,
  );
  await c.query(conversationSchemaSql("postgres", schema));
  await c.query(
    `CREATE OR REPLACE FUNCTION ${p}project_conversation_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'project_conversation_history_immutable'; END; $$;`,
  );
  for (const table of [
    "project_conversation_receipts",
    "project_stage_run_admissions",
  ])
    await c.query(
      `CREATE OR REPLACE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON ${p}${table} FOR EACH ROW EXECUTE FUNCTION ${p}project_conversation_history_immutable();`,
    );
  const columns = [
    "tenant_id",
    "space_id",
    "principal_id",
    "actor_id",
    "profile_id",
    "binding_id",
    "project_id",
    "thread_id",
  ];
  await c.query(
    `CREATE OR REPLACE FUNCTION ${p}project_conversation_binding_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP='DELETE' OR ${columns.map((k) => `NEW.${k} IS DISTINCT FROM OLD.${k}`).join(" OR ")} OR NEW.revision!=OLD.revision+1 THEN RAISE EXCEPTION 'project_conversation_identity_immutable'; END IF; RETURN NEW; END; $$; CREATE OR REPLACE TRIGGER project_conversation_bindings_immutable_identity BEFORE UPDATE OR DELETE ON ${p}project_conversation_bindings FOR EACH ROW EXECUTE FUNCTION ${p}project_conversation_binding_immutable();`,
  );
  await assertPostgresConversationSchema(c, schema);
}
