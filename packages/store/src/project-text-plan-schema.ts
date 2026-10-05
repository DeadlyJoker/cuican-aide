import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import {
  assertSqliteConversationSchema,
  assertPostgresConversationSchema,
} from "./project-conversation-schema.ts";

export const planTables = [
  "project_text_plan_schema_version",
  "project_text_plans",
  "project_text_plan_revisions",
  "project_text_plan_steps",
  "project_text_plan_run_admissions",
  "project_text_plan_receipts",
] as const;
const immutable = [
  "project_text_plan_revisions",
  "project_text_plan_run_admissions",
  "project_text_plan_receipts",
] as const;
const identities = {
  project_text_plans: [
    "tenant_id",
    "space_id",
    "principal_id",
    "actor_id",
    "profile_id",
    "plan_id",
    "project_id",
    "thread_id",
    "binding_id",
  ],
  project_text_plan_steps: [
    "tenant_id",
    "space_id",
    "plan_id",
    "plan_revision",
    "step_id",
    "ordinal",
    "kind",
    "episode_id",
    "attempt",
  ],
} as const;
export function planSchemaFailure(): never {
  throw new Error("project_text_plan_schema_incomplete");
}
export function projectTextPlanSchemaSql(
  dialect: "sqlite" | "postgres",
  schema = "public",
): string {
  const pg = dialect === "postgres",
    p = pg ? `${creativeProjectSchemaName(schema)}.` : "",
    j = pg ? "JSONB" : "TEXT",
    n = pg ? "BIGINT" : "INTEGER",
    strict = pg ? "" : " STRICT",
    collate = pg ? ' COLLATE "C"' : " COLLATE BINARY";
  const safe = (c: string, min = 1) =>
    `${c}>=${min} AND ${c}<=9007199254740991`;
  const json = (c: string, max: number) =>
    pg
      ? `jsonb_typeof(${c})='object' AND octet_length(${c}::text)<=${max}`
      : `json_valid(${c}) AND json_type(${c})='object' AND length(CAST(${c} AS BLOB))<=${max}`;
  const owner =
    "tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,principal_id TEXT NOT NULL,actor_id TEXT NOT NULL,profile_id TEXT NOT NULL";
  return `
  CREATE TABLE IF NOT EXISTS ${p}project_text_plan_schema_version(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL CHECK(version=1))${strict};
  INSERT INTO ${p}project_text_plan_schema_version VALUES(1,1) ON CONFLICT(id) DO NOTHING;
  CREATE TABLE IF NOT EXISTS ${p}project_text_plans(
    ${owner},plan_id TEXT NOT NULL,project_id TEXT NOT NULL,thread_id TEXT NOT NULL,binding_id TEXT NOT NULL,
    revision ${n} NOT NULL CHECK(${safe("revision")}),current_plan_revision ${n} NOT NULL CHECK(${safe("current_plan_revision")}),
    state TEXT NOT NULL CHECK(state IN ('ready','running','waitingSelection','paused','completed','revoked')),
    active_step_id TEXT,wake_revision ${n} NOT NULL CHECK(${safe("wake_revision", 0)}),record_json ${j} NOT NULL CHECK(${json("record_json", 16384)}),
    PRIMARY KEY(tenant_id,space_id,plan_id),
    FOREIGN KEY(tenant_id,space_id,project_id,principal_id) REFERENCES ${p}creative_projects(tenant_id,space_id,project_id,owner_principal_id),
    FOREIGN KEY(tenant_id,space_id,binding_id) REFERENCES ${p}project_conversation_bindings(tenant_id,space_id,binding_id),
    FOREIGN KEY(tenant_id,thread_id) REFERENCES ${p}threads(tenant_id,thread_id))${strict};
  CREATE INDEX IF NOT EXISTS project_text_plan_owner_page ON ${p}project_text_plans(tenant_id,space_id,principal_id,actor_id,profile_id,project_id,plan_id${collate});
  CREATE INDEX IF NOT EXISTS project_text_plan_recovery_page ON ${p}project_text_plans(tenant_id,space_id,profile_id,plan_id${collate});
  CREATE TABLE IF NOT EXISTS ${p}project_text_plan_revisions(
    tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,plan_id TEXT NOT NULL,plan_revision ${n} NOT NULL CHECK(${safe("plan_revision")}),
    record_json ${j} NOT NULL CHECK(${json("record_json", 65536)}),PRIMARY KEY(tenant_id,space_id,plan_id,plan_revision),
    FOREIGN KEY(tenant_id,space_id,plan_id) REFERENCES ${p}project_text_plans(tenant_id,space_id,plan_id))${strict};
  CREATE TABLE IF NOT EXISTS ${p}project_text_plan_steps(
    tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,plan_id TEXT NOT NULL,plan_revision ${n} NOT NULL CHECK(${safe("plan_revision")}),step_id TEXT NOT NULL,
    ordinal ${n} NOT NULL CHECK(ordinal>=1 AND ordinal<=18),kind TEXT NOT NULL CHECK(kind IN ('brief','outline','script')),episode_id TEXT,
    attempt ${n} NOT NULL CHECK(${safe("attempt")}),revision ${n} NOT NULL CHECK(${safe("revision")}),
    state TEXT NOT NULL CHECK(state IN ('ready','admitted','waitingSelection','succeeded','paused','failed','revoked')),
    record_json ${j} NOT NULL CHECK(${json("record_json", 65536)}),PRIMARY KEY(tenant_id,space_id,plan_id,step_id),UNIQUE(tenant_id,space_id,plan_id,plan_revision,ordinal),
    FOREIGN KEY(tenant_id,space_id,plan_id,plan_revision) REFERENCES ${p}project_text_plan_revisions(tenant_id,space_id,plan_id,plan_revision))${strict};
  CREATE TABLE IF NOT EXISTS ${p}project_text_plan_run_admissions(
    tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,run_id TEXT NOT NULL,plan_id TEXT NOT NULL,plan_revision ${n} NOT NULL CHECK(${safe("plan_revision")}),step_id TEXT NOT NULL,
    record_json ${j} NOT NULL CHECK(${json("record_json", 65536)}),PRIMARY KEY(tenant_id,run_id),UNIQUE(tenant_id,space_id,plan_id,step_id),
    FOREIGN KEY(tenant_id,run_id) REFERENCES ${p}plugin_task_admissions(tenant_id,run_id),
    FOREIGN KEY(tenant_id,space_id,plan_id,step_id) REFERENCES ${p}project_text_plan_steps(tenant_id,space_id,plan_id,step_id))${strict};
  CREATE TABLE IF NOT EXISTS ${p}project_text_plan_receipts(
    ${owner},idempotency_key TEXT NOT NULL,request_digest TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('start','pause','revoke','resume','reviseRemaining','continue')),
    plan_id TEXT NOT NULL,result_json ${j} NOT NULL CHECK(${json("result_json", 524288)}),
    PRIMARY KEY(tenant_id,space_id,principal_id,actor_id,profile_id,idempotency_key),
    FOREIGN KEY(tenant_id,space_id,plan_id) REFERENCES ${p}project_text_plans(tenant_id,space_id,plan_id))${strict};`;
}
function checkVersion(
  rows: readonly { id: unknown; version: unknown }[],
): void {
  if (rows.length !== 1 || rows[0]?.id !== 1 || rows[0]?.version !== 1)
    throw new Error("project_text_plan_schema_version_unsupported");
}
function sqliteObjects(db: DatabaseSync, required: boolean): boolean {
  const rows = db
    .prepare(
      `SELECT name,type FROM main.sqlite_schema WHERE name IN (${planTables.map(() => "?").join(",")}) UNION ALL SELECT name,type FROM temp.sqlite_schema WHERE name IN (${planTables.map(() => "?").join(",")})`,
    )
    .all(...planTables, ...planTables);
  if (rows.length === 0 && !required) return false;
  if (
    rows.length !== planTables.length ||
    planTables.some(
      (n) =>
        rows.filter((r) => r.name === n && r.type === "table").length !== 1,
    )
  )
    planSchemaFailure();
  return true;
}
async function pgObjects(
  c: PoolClient,
  schema: string,
  required: boolean,
): Promise<boolean> {
  const rows = (
    await c.query<{ relname: string; relkind: string }>(
      "SELECT c.relname,c.relkind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[])",
      [schema, planTables],
    )
  ).rows;
  if (rows.length === 0 && !required) return false;
  if (
    rows.length !== planTables.length ||
    planTables.some(
      (n) =>
        rows.filter((r) => r.relname === n && r.relkind === "r").length !== 1,
    )
  )
    planSchemaFailure();
  return true;
}
const reads = [
  "SELECT tenant_id,space_id,principal_id,actor_id,profile_id,plan_id,project_id,thread_id,binding_id,revision,current_plan_revision,state,active_step_id,wake_revision,record_json FROM project_text_plans LIMIT 0",
  "SELECT tenant_id,space_id,plan_id,plan_revision,record_json FROM project_text_plan_revisions LIMIT 0",
  "SELECT tenant_id,space_id,plan_id,plan_revision,step_id,ordinal,kind,episode_id,attempt,revision,state,record_json FROM project_text_plan_steps LIMIT 0",
  "SELECT tenant_id,space_id,run_id,plan_id,plan_revision,step_id,record_json FROM project_text_plan_run_admissions LIMIT 0",
  "SELECT tenant_id,space_id,principal_id,actor_id,profile_id,idempotency_key,request_digest,kind,plan_id,result_json FROM project_text_plan_receipts LIMIT 0",
];
export function assertSqlitePlanSchema(
  db: DatabaseSync,
  required = true,
): boolean {
  if (!sqliteObjects(db, required)) return false;
  assertSqliteConversationSchema(db);
  assertSqliteTextTables(db);
  checkVersion(
    db
      .prepare(
        "SELECT id,version FROM project_text_plan_schema_version LIMIT 2",
      )
      .all() as { id: unknown; version: unknown }[],
  );
  const col = db
    .prepare("PRAGMA main.table_xinfo(plugin_task_admissions)")
    .all()
    .find((c) => c.name === "project_text_plan_digest");
  if (col?.type !== "TEXT" || col.notnull !== 0 || col.hidden !== 0)
    planSchemaFailure();
  for (const sql of reads) db.prepare(sql).all();
  for (const table of planTables.slice(1))
    for (const suffix of [
      immutable.includes(table as (typeof immutable)[number])
        ? "immutable"
        : "immutable_identity",
      "no_delete",
    ]) {
      if (
        db
          .prepare(
            "SELECT name FROM main.sqlite_schema WHERE type='trigger' AND tbl_name=? AND name=?",
          )
          .all(table, `${table}_${suffix}`).length !== 1
      )
        planSchemaFailure();
    }
  for (const [name, columns] of [
    [
      "project_text_plan_owner_page",
      [
        "tenant_id",
        "space_id",
        "principal_id",
        "actor_id",
        "profile_id",
        "project_id",
        "plan_id",
      ],
    ],
    [
      "project_text_plan_recovery_page",
      ["tenant_id", "space_id", "profile_id", "plan_id"],
    ],
  ] as const) {
    const index = db
      .prepare("PRAGMA main.index_list(project_text_plans)")
      .all()
      .find((r) => r.name === name);
    if (index?.partial !== 0) planSchemaFailure();
    const items = db
      .prepare(`PRAGMA main.index_xinfo(${name})`)
      .all()
      .filter((r) => r.key === 1);
    if (
      items.length !== columns.length ||
      items.some(
        (r, i) => r.name !== columns[i] || r.desc !== 0 || r.coll !== "BINARY",
      )
    )
      planSchemaFailure();
  }
  return true;
}
export async function assertPostgresPlanSchema(
  c: PoolClient,
  schema: string,
  required = true,
): Promise<boolean> {
  if (!(await pgObjects(c, schema, required))) return false;
  await assertPostgresConversationSchema(c, schema);
  await assertPostgresTextTables(c, schema);
  const p = `${creativeProjectSchemaName(schema)}.`;
  checkVersion(
    (
      await c.query<{ id: unknown; version: unknown }>(
        `SELECT id,version FROM ${p}project_text_plan_schema_version LIMIT 2`,
      )
    ).rows,
  );
  const col = (
    await c.query(
      "SELECT a.atttypid,a.attnotnull,a.attgenerated FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='plugin_task_admissions' AND a.attname='project_text_plan_digest' AND a.attnum>0 AND NOT a.attisdropped",
      [schema],
    )
  ).rows;
  if (
    col.length !== 1 ||
    col[0]?.atttypid !== 25 ||
    col[0]?.attnotnull !== false ||
    col[0]?.attgenerated !== ""
  )
    planSchemaFailure();
  for (const sql of reads)
    await c.query(sql.replace(/FROM (project_[a-z_]+)/u, `FROM ${p}$1`));
  for (const table of planTables.slice(1)) {
    const name = `${table}_${immutable.includes(table as (typeof immutable)[number]) ? "immutable" : "immutable_identity"}`;
    if (
      (
        await c.query(
          "SELECT t.tgname FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND t.tgname=$3 AND NOT t.tgisinternal AND t.tgenabled='O' AND t.tgtype=27",
          [schema, table, name],
        )
      ).rows.length !== 1
    )
      planSchemaFailure();
  }
  for (const [name, columns] of [
    [
      "project_text_plan_owner_page",
      [
        "tenant_id",
        "space_id",
        "principal_id",
        "actor_id",
        "profile_id",
        "project_id",
        "plan_id",
      ],
    ],
    [
      "project_text_plan_recovery_page",
      ["tenant_id", "space_id", "profile_id", "plan_id"],
    ],
  ] as const) {
    const rows = (
      await c.query(
        "SELECT i.indisvalid,i.indisready,i.indnkeyatts,i.indnatts,i.indpred IS NULL AS plain,i.indexprs IS NULL AS noexpr,a.attname,a.atttypid,k.ordinality,o.opcname,onsp.nspname AS opnamespace,co.collname,cn.nspname AS collnamespace,i.indoption[(k.ordinality-1)::int] AS ordering FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class x ON x.oid=i.indexrelid JOIN pg_catalog.pg_namespace n ON n.oid=x.relnamespace JOIN pg_catalog.pg_class t ON t.oid=i.indrelid CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality) JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum JOIN pg_catalog.pg_opclass o ON o.oid=i.indclass[(k.ordinality-1)::int] JOIN pg_catalog.pg_namespace onsp ON onsp.oid=o.opcnamespace LEFT JOIN pg_catalog.pg_collation co ON co.oid=i.indcollation[(k.ordinality-1)::int] LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid=co.collnamespace WHERE n.nspname=$1 AND x.relname=$2 AND t.relname='project_text_plans' ORDER BY k.ordinality",
        [schema, name],
      )
    ).rows;
    if (
      rows.length !== columns.length ||
      rows.some(
        (r, i) =>
          !r.indisvalid ||
          !r.indisready ||
          !r.plain ||
          !r.noexpr ||
          r.indnkeyatts !== columns.length ||
          r.indnatts !== columns.length ||
          r.attname !== columns[i] ||
          r.atttypid !== 25 ||
          r.opcname !== "text_ops" ||
          r.opnamespace !== "pg_catalog" ||
          r.ordering !== 0 ||
          (i === columns.length - 1 &&
            (r.collname !== "C" || r.collnamespace !== "pg_catalog")),
      )
    )
      planSchemaFailure();
  }
  return true;
}
export function migrateSqlitePlans(db: DatabaseSync): void {
  assertSqliteConversationSchema(db);
  assertSqliteTextTables(db);
  const existing = db
    .prepare(
      "SELECT name FROM main.sqlite_schema WHERE name IN ('project_text_plan_schema_version','project_text_plans','project_text_plan_revisions','project_text_plan_steps','project_text_plan_run_admissions','project_text_plan_receipts') UNION ALL SELECT name FROM temp.sqlite_schema WHERE name IN ('project_text_plan_schema_version','project_text_plans','project_text_plan_revisions','project_text_plan_steps','project_text_plan_run_admissions','project_text_plan_receipts')",
    )
    .all();
  if (existing.length) {
    assertSqlitePlanSchema(db);
    return;
  }
  if (
    !db
      .prepare("PRAGMA main.table_xinfo(plugin_task_admissions)")
      .all()
      .some((c) => c.name === "project_text_plan_digest")
  )
    db.exec(
      "ALTER TABLE plugin_task_admissions ADD COLUMN project_text_plan_digest TEXT",
    );
  db.exec(projectTextPlanSchemaSql("sqlite"));
  for (const table of immutable)
    db.exec(
      `CREATE TRIGGER ${table}_immutable BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'project_text_plan_history_immutable'); END; CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'project_text_plan_history_immutable'); END;`,
    );
  for (const [table, cols] of Object.entries(identities))
    db.exec(
      `CREATE TRIGGER ${table}_immutable_identity BEFORE UPDATE ON ${table} WHEN ${cols.map((c) => `NEW.${c} IS NOT OLD.${c}`).join(" OR ")} OR NEW.revision!=OLD.revision+1 BEGIN SELECT RAISE(ABORT,'project_text_plan_identity_immutable'); END; CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'project_text_plan_identity_immutable'); END;`,
    );
  assertSqlitePlanSchema(db);
}
export async function migratePostgresPlans(
  c: PoolClient,
  schema: string,
): Promise<void> {
  await assertPostgresConversationSchema(c, schema);
  await assertPostgresTextTables(c, schema);
  const existing = (
    await c.query(
      "SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[])",
      [schema, planTables],
    )
  ).rows;
  if (existing.length) {
    await assertPostgresPlanSchema(c, schema);
    return;
  }
  const p = `${creativeProjectSchemaName(schema)}.`;
  await c.query(
    `ALTER TABLE ${p}plugin_task_admissions ADD COLUMN IF NOT EXISTS project_text_plan_digest TEXT`,
  );
  await c.query(projectTextPlanSchemaSql("postgres", schema));
  await c.query(
    `CREATE OR REPLACE FUNCTION ${p}project_text_plan_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'project_text_plan_history_immutable'; END; $$;`,
  );
  for (const table of immutable)
    await c.query(
      `CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON ${p}${table} FOR EACH ROW EXECUTE FUNCTION ${p}project_text_plan_history_immutable();`,
    );
  for (const [table, cols] of Object.entries(identities))
    await c.query(
      `CREATE FUNCTION ${p}${table}_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP='DELETE' OR ${cols.map((k) => `NEW.${k} IS DISTINCT FROM OLD.${k}`).join(" OR ")} OR NEW.revision!=OLD.revision+1 THEN RAISE EXCEPTION 'project_text_plan_identity_immutable'; END IF; RETURN NEW; END; $$; CREATE TRIGGER ${table}_immutable_identity BEFORE UPDATE OR DELETE ON ${p}${table} FOR EACH ROW EXECUTE FUNCTION ${p}${table}_identity_guard();`,
    );
  await assertPostgresPlanSchema(c, schema);
}

const textTables = [
  "project_text_schema_version",
  "project_text_artifacts",
  "project_text_revisions",
  "project_text_mutation_receipts",
] as const;
function assertSqliteTextTables(db: DatabaseSync): void {
  for (const n of textTables) {
    const r = db
      .prepare(
        "SELECT type FROM main.sqlite_schema WHERE name=? UNION ALL SELECT type FROM temp.sqlite_schema WHERE name=?",
      )
      .all(n, n);
    if (r.length !== 1 || r[0]?.type !== "table") planSchemaFailure();
  }
  checkVersion(
    db
      .prepare("SELECT id,version FROM project_text_schema_version LIMIT 2")
      .all() as { id: unknown; version: unknown }[],
  );
}
async function assertPostgresTextTables(
  c: PoolClient,
  schema: string,
): Promise<void> {
  const r = (
    await c.query<{ relname: string; relkind: string }>(
      "SELECT c.relname,c.relkind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[])",
      [schema, textTables],
    )
  ).rows;
  if (
    r.length !== textTables.length ||
    textTables.some((n) => !r.some((v) => v.relname === n && v.relkind === "r"))
  )
    planSchemaFailure();
  checkVersion(
    (
      await c.query<{ id: unknown; version: unknown }>(
        `SELECT id,version FROM ${creativeProjectSchemaName(schema)}.project_text_schema_version LIMIT 2`,
      )
    ).rows,
  );
}
