import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";

const versionTable = "project_generation_schema_version";
const linkTable = "creative_project_generation_links";
const immutableMessage = "project_generation_link_immutable";
const triggerNames = [
  "project_generation_no_update",
  "project_generation_no_delete",
] as const;

export function projectGenerationSchemaSql(
  input: { dialect: "sqlite" } | { dialect: "postgres"; schema: string },
): string {
  const pg = input.dialect === "postgres";
  const prefix = pg ? `${creativeProjectSchemaName(input.schema)}.` : "";
  const integer = pg ? "BIGINT" : "INTEGER";
  const json = pg ? "JSONB" : "TEXT";
  const jsonField = (path: string) =>
    pg
      ? `(record_json#>>'{${path.split(".").join(",")}}')`
      : `json_extract(record_json,'$.${path}')`;
  const matches = Object.entries({
    "tenantId": "tenant_id",
    "spaceId": "space_id",
    "projectId": "project_id",
    "ownerPrincipalId": "owner_principal_id",
    "reference.assetId": "asset_id",
    "reference.assetRevision": "asset_revision",
    "assetContentDigest": "asset_content_digest",
    "briefRevision": "brief_revision",
    "briefContentDigest": "brief_content_digest",
    "binding.pluginId": "plugin_id",
    "binding.runId": "run_id",
    "binding.threadId": "thread_id",
    "binding.bindingDigest": "binding_digest",
    "receipt.actorId": "actor_id",
    "receipt.idempotencyKey": "idempotency_key",
    "receipt.requestDigest": "request_digest",
    "contentDigest": "content_digest",
  })
    .map(
      ([field, column]) =>
        `${jsonField(field)} IS NOT NULL AND CAST(${jsonField(field)} AS TEXT)=CAST(${column} AS TEXT)`,
    )
    .join(" AND ");
  return `CREATE TABLE ${prefix}${linkTable} (
    tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,project_id TEXT NOT NULL,owner_principal_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,asset_revision ${integer} NOT NULL CHECK(asset_revision>=1 AND asset_revision<=9007199254740991),asset_content_digest TEXT NOT NULL,
    brief_revision ${integer} NOT NULL CHECK(brief_revision>=1 AND brief_revision<=9007199254740991),brief_content_digest TEXT NOT NULL,
    plugin_id TEXT NOT NULL,run_id TEXT NOT NULL,thread_id TEXT NOT NULL,actor_id TEXT NOT NULL,binding_digest TEXT NOT NULL,
    receipt_kind TEXT NOT NULL CHECK(receipt_kind='task'),idempotency_key TEXT NOT NULL,request_digest TEXT NOT NULL,content_digest TEXT NOT NULL,
    record_json ${json} NOT NULL CHECK(${pg ? "jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=32768" : "json_valid(record_json) AND json_type(record_json)='object' AND length(CAST(record_json AS BLOB))<=32768"} AND ${matches}),
    PRIMARY KEY(tenant_id,run_id),
    UNIQUE(tenant_id,space_id,project_id,asset_id,asset_revision),
    FOREIGN KEY(tenant_id,space_id,project_id,owner_principal_id) REFERENCES ${prefix}creative_projects(tenant_id,space_id,project_id,owner_principal_id) ON DELETE RESTRICT,
    FOREIGN KEY(tenant_id,space_id,project_id,asset_id,asset_revision) REFERENCES ${prefix}creative_concept_revisions(tenant_id,space_id,project_id,asset_id,asset_revision) ON DELETE RESTRICT,
    FOREIGN KEY(tenant_id,space_id,project_id,brief_revision,brief_content_digest) REFERENCES ${prefix}creative_project_briefs(tenant_id,space_id,project_id,brief_revision,content_digest) ON DELETE RESTRICT,
    FOREIGN KEY(tenant_id,run_id) REFERENCES ${prefix}extension_run_bindings(tenant_id,run_id) ON DELETE RESTRICT,
    FOREIGN KEY(tenant_id,space_id,plugin_id,receipt_kind,actor_id,idempotency_key) REFERENCES ${prefix}extension_mutation_receipts(tenant_id,space_id,plugin_id,kind,actor_id,idempotency_key) ON DELETE RESTRICT
  )${pg ? "" : " STRICT"};`;
}

function assertVersion(rows: readonly { id: unknown; version: unknown }[]) {
  if (rows.length !== 1 || rows[0]?.id !== 1 || rows[0].version !== 1)
    throw new Error("project_generation_schema_version_unsupported");
}

function versionSql(prefix = "", sqlite = false) {
  return `CREATE TABLE ${prefix}${versionTable}(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL)${sqlite ? " STRICT" : ""};`;
}
function sqliteTriggerSql(operation: "UPDATE" | "DELETE") {
  return `CREATE TRIGGER project_generation_no_${operation.toLowerCase()} BEFORE ${operation} ON ${linkTable} BEGIN SELECT RAISE(ABORT,'${immutableMessage}'); END;`;
}
function canonicalSql(sql: string) {
  return sql
    .trim()
    .replace(/;$/u, "")
    .replace(/\s+/gu, " ")
    .replace(/\s*([(),=])\s*/gu, "$1")
    .toLowerCase();
}

/** No repair of partial/unknown persisted schemas. Ordinary task migration never calls this. */
export function assertSqliteProjectGenerationSchema(db: DatabaseSync): void {
  const objects = db
    .prepare("SELECT type,name,sql FROM sqlite_master WHERE name IN (?,?,?,?)")
    .all(versionTable, linkTable, ...triggerNames) as {
    type: string;
    name: string;
    sql: string;
  }[];
  const expected = new Map([
    [versionTable, versionSql("", true)],
    [linkTable, projectGenerationSchemaSql({ dialect: "sqlite" })],
    [triggerNames[0], sqliteTriggerSql("UPDATE")],
    [triggerNames[1], sqliteTriggerSql("DELETE")],
  ]);
  if (
    objects.length !== expected.size ||
    objects.some(
      (row) =>
        canonicalSql(row.sql) !== canonicalSql(expected.get(row.name) ?? ""),
    )
  )
    throw new Error("project_generation_schema_incomplete");
  assertVersion(
    db.prepare(`SELECT id,version FROM ${versionTable} LIMIT 2`).all() as {
      id: unknown;
      version: unknown;
    }[],
  );
  assertSqliteProjectGenerationBase(db);
}
function baseReads(prefix = "") {
  return [
    `SELECT tenant_id,space_id,project_id,owner_principal_id,revision,state,record_json FROM ${prefix}creative_projects LIMIT 0`,
    `SELECT tenant_id,space_id,project_id,brief_revision,content_digest,record_json FROM ${prefix}creative_project_briefs LIMIT 0`,
    `SELECT tenant_id,space_id,project_id,asset_id,revision,latest_asset_revision,record_json FROM ${prefix}creative_concept_assets LIMIT 0`,
    `SELECT tenant_id,space_id,project_id,asset_id,asset_revision,brief_revision,brief_content_digest,content_digest,record_json FROM ${prefix}creative_concept_revisions LIMIT 0`,
    `SELECT tenant_id,space_id,plugin_id,run_id,binding_json FROM ${prefix}extension_run_bindings LIMIT 0`,
    `SELECT tenant_id,space_id,plugin_id,kind,actor_id,idempotency_key,request_digest,result_json FROM ${prefix}extension_mutation_receipts LIMIT 0`,
  ];
}
function assertSqliteProjectGenerationBase(db: DatabaseSync) {
  assertVersion(
    db
      .prepare("SELECT id,version FROM creative_project_schema_version LIMIT 2")
      .all() as { id: unknown; version: unknown }[],
  );
  for (const sql of baseReads()) db.prepare(sql).all();
  const version = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='creative_project_schema_version'",
    )
    .get() as { sql: string } | undefined;
  if (
    !version ||
    canonicalSql(version.sql) !==
      canonicalSql(
        versionSql("", true).replace(
          versionTable,
          "creative_project_schema_version",
        ),
      )
  )
    throw new Error("project_generation_schema_incomplete");
  for (const table of historyTables)
    for (const operation of ["UPDATE", "DELETE"] as const) {
      const name = `${table}_no_${operation.toLowerCase()}`;
      const row = db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='trigger' AND name=? AND tbl_name=?",
        )
        .get(name, table) as { sql: string } | undefined;
      const expected = `CREATE TRIGGER ${name} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'creative_project_history_immutable'); END;`;
      if (!row || canonicalSql(row.sql) !== canonicalSql(expected))
        throw new Error("project_generation_schema_incomplete");
    }
}
export function migrateSqliteProjectGenerations(db: DatabaseSync): void {
  assertSqliteProjectGenerationBase(db);
  const existing = db
    .prepare("SELECT name FROM sqlite_master WHERE name IN (?,?,?,?)")
    .all(versionTable, linkTable, ...triggerNames);
  if (existing.length === 0) {
    db.exec(versionSql("", true));
    db.exec(`INSERT INTO ${versionTable} VALUES(1,1);`);
    db.exec(projectGenerationSchemaSql({ dialect: "sqlite" }));
    db.exec(sqliteTriggerSql("UPDATE"));
    db.exec(sqliteTriggerSql("DELETE"));
  }
  assertSqliteProjectGenerationSchema(db);
}

const columns = [
  "tenant_id",
  "space_id",
  "project_id",
  "owner_principal_id",
  "asset_id",
  "asset_revision",
  "asset_content_digest",
  "brief_revision",
  "brief_content_digest",
  "plugin_id",
  "run_id",
  "thread_id",
  "actor_id",
  "binding_digest",
  "receipt_kind",
  "idempotency_key",
  "request_digest",
  "content_digest",
  "record_json",
] as const;
async function postgresObjects(client: PoolClient, schema: string) {
  const tables = await client.query<{ name: string }>(
    "SELECT tablename AS name FROM pg_tables WHERE schemaname=$1 AND tablename=ANY($2::text[])",
    [schema, [versionTable, linkTable]],
  );
  const triggers = await client.query<{
    name: string;
    enabled: string;
    bits: number;
    body: string;
    function_schema: string;
    language: string;
    guard: string | null;
  }>(
    `SELECT t.tgname AS name,t.tgenabled AS enabled,t.tgtype AS bits,p.prosrc AS body,pn.nspname AS function_schema,l.lanname AS language,pg_get_expr(t.tgqual,t.tgrelid) AS guard FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang WHERE n.nspname=$1 AND c.relname=$2 AND NOT t.tgisinternal AND t.tgname=ANY($3::text[])`,
    [schema, linkTable, triggerNames],
  );
  return { tables: tables.rows, triggers: triggers.rows };
}
export async function assertPostgresProjectGenerationSchema(
  client: PoolClient,
  schema: string,
): Promise<void> {
  const prefix = `${creativeProjectSchemaName(schema)}.`;
  const { tables, triggers } = await postgresObjects(client, schema);
  if (
    tables.length !== 2 ||
    triggers.length !== 2 ||
    triggerNames.some(
      (name, i) =>
        !triggers.some(
          (t) =>
            t.name === name &&
            t.enabled === "O" &&
            t.bits === (i === 0 ? 19 : 11) &&
            t.function_schema === schema &&
            t.language === "plpgsql" &&
            t.guard === null &&
            canonicalSql(t.body) ===
              canonicalSql(`BEGIN RAISE EXCEPTION '${immutableMessage}'; END`),
        ),
    )
  )
    throw new Error("project_generation_schema_incomplete");
  assertVersion(
    (
      await client.query<{ id: unknown; version: unknown }>(
        `SELECT id,version FROM ${prefix}${versionTable} LIMIT 2`,
      )
    ).rows,
  );
  const fields = (
    await client.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      "SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position",
      [schema, linkTable],
    )
  ).rows;
  if (
    fields.length !== columns.length ||
    fields.some(
      (f, i) =>
        f.column_name !== columns[i] ||
        f.is_nullable !== "NO" ||
        f.data_type !==
          (["asset_revision", "brief_revision"].includes(f.column_name)
            ? "bigint"
            : f.column_name === "record_json"
              ? "jsonb"
              : "text"),
    )
  )
    throw new Error("project_generation_schema_incomplete");
  const constraints = (
    await client.query<{
      kind: string;
      definition: string;
      validated: boolean;
      deferred: boolean;
    }>(
      `SELECT x.contype AS kind,pg_get_constraintdef(x.oid) AS definition,x.convalidated AS validated,x.condeferrable AS deferred FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND x.contype<>'n'`,
      [schema, linkTable],
    )
  ).rows;
  const expected = postgresLinkConstraints(schema);
  if (
    constraints.length !== expected.length ||
    constraints.some((c) => !c.validated || c.deferred) ||
    expected.some(
      (definition) =>
        !constraints.some(
          (constraint) =>
            canonicalSql(constraint.definition) === canonicalSql(definition),
        ),
    )
  )
    throw new Error("project_generation_schema_incomplete");
  await assertPostgresVersionTable(client, schema, versionTable);
  await assertPostgresProjectGenerationBase(client, prefix);
}
async function assertPostgresProjectGenerationBase(
  client: PoolClient,
  prefix: string,
) {
  assertVersion(
    (
      await client.query<{ id: unknown; version: unknown }>(
        `SELECT id,version FROM ${prefix}creative_project_schema_version LIMIT 2`,
      )
    ).rows,
  );
  for (const sql of baseReads(prefix)) await client.query(sql);
  const schema = prefix.slice(1, -2);
  await assertPostgresVersionTable(
    client,
    schema,
    "creative_project_schema_version",
  );
  const triggers = (
    await client.query<{
      table_name: string;
      name: string;
      enabled: string;
      bits: number;
      body: string;
      function_schema: string;
      language: string;
      guard: string | null;
    }>(
      `SELECT c.relname AS table_name,t.tgname AS name,t.tgenabled AS enabled,t.tgtype AS bits,p.prosrc AS body,pn.nspname AS function_schema,l.lanname AS language,pg_get_expr(t.tgqual,t.tgrelid) AS guard FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND NOT t.tgisinternal`,
      [schema, historyTables],
    )
  ).rows;
  for (const table of historyTables)
    if (
      !triggers.some(
        (trigger) =>
          trigger.table_name === table &&
          trigger.name === `${table}_no_update_or_delete` &&
          trigger.enabled === "O" &&
          trigger.bits === 27 &&
          trigger.function_schema === schema &&
          trigger.language === "plpgsql" &&
          trigger.guard === null &&
          canonicalSql(trigger.body) ===
            canonicalSql(
              "BEGIN RAISE EXCEPTION 'creative_project_history_immutable'; END;",
            ),
      )
    )
      throw new Error("project_generation_schema_incomplete");
}
export async function migratePostgresProjectGenerations(
  client: PoolClient,
  schema: string,
): Promise<void> {
  const prefix = `${creativeProjectSchemaName(schema)}.`;
  await assertPostgresProjectGenerationBase(client, prefix);
  const objects = await postgresObjects(client, schema);
  if (objects.tables.length === 0 && objects.triggers.length === 0) {
    await client.query(versionSql(prefix));
    await client.query(`INSERT INTO ${prefix}${versionTable} VALUES(1,1);`);
    await client.query(
      projectGenerationSchemaSql({ dialect: "postgres", schema }),
    );
    await client.query(
      `CREATE FUNCTION ${prefix}project_generation_link_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '${immutableMessage}'; END $$;`,
    );
    for (const operation of ["UPDATE", "DELETE"] as const)
      await client.query(
        `CREATE TRIGGER project_generation_no_${operation.toLowerCase()} BEFORE ${operation} ON ${prefix}${linkTable} FOR EACH ROW EXECUTE FUNCTION ${prefix}project_generation_link_immutable();`,
      );
  }
  await assertPostgresProjectGenerationSchema(client, schema);
}

const historyTables = [
  "creative_project_briefs",
  "creative_concept_revisions",
  "creative_project_mutation_receipts",
];
const recordFields: Readonly<Record<string, string>> = {
  "tenantId": "tenant_id",
  "spaceId": "space_id",
  "projectId": "project_id",
  "ownerPrincipalId": "owner_principal_id",
  "reference.assetId": "asset_id",
  "reference.assetRevision": "asset_revision",
  "assetContentDigest": "asset_content_digest",
  "briefRevision": "brief_revision",
  "briefContentDigest": "brief_content_digest",
  "binding.pluginId": "plugin_id",
  "binding.runId": "run_id",
  "binding.threadId": "thread_id",
  "binding.bindingDigest": "binding_digest",
  "receipt.actorId": "actor_id",
  "receipt.idempotencyKey": "idempotency_key",
  "receipt.requestDigest": "request_digest",
  "contentDigest": "content_digest",
};
function postgresLinkConstraints(schema: string): readonly string[] {
  const matches = Object.entries(recordFields).flatMap(([field, column]) => {
    const expression = `(record_json #>> '{${field.split(".").join(",")}}'::text[])`;
    const value = ["asset_revision", "brief_revision"].includes(column)
      ? `(${column})::text`
      : column;
    return [`(${expression} IS NOT NULL)`, `(${expression} = ${value})`];
  });
  return [
    "PRIMARY KEY (tenant_id, run_id)",
    "UNIQUE (tenant_id, space_id, project_id, asset_id, asset_revision)",
    "CHECK (((asset_revision >= 1) AND (asset_revision <= '9007199254740991'::bigint)))",
    "CHECK (((brief_revision >= 1) AND (brief_revision <= '9007199254740991'::bigint)))",
    "CHECK ((receipt_kind = 'task'::text))",
    `CHECK (((jsonb_typeof(record_json) = 'object'::text) AND (octet_length((record_json)::text) <= 32768) AND ${matches.join(" AND ")}))`,
    `FOREIGN KEY (tenant_id, space_id, project_id, owner_principal_id) REFERENCES ${schema}.creative_projects(tenant_id, space_id, project_id, owner_principal_id) ON DELETE RESTRICT`,
    `FOREIGN KEY (tenant_id, space_id, project_id, asset_id, asset_revision) REFERENCES ${schema}.creative_concept_revisions(tenant_id, space_id, project_id, asset_id, asset_revision) ON DELETE RESTRICT`,
    `FOREIGN KEY (tenant_id, space_id, project_id, brief_revision, brief_content_digest) REFERENCES ${schema}.creative_project_briefs(tenant_id, space_id, project_id, brief_revision, content_digest) ON DELETE RESTRICT`,
    `FOREIGN KEY (tenant_id, run_id) REFERENCES ${schema}.extension_run_bindings(tenant_id, run_id) ON DELETE RESTRICT`,
    `FOREIGN KEY (tenant_id, space_id, plugin_id, receipt_kind, actor_id, idempotency_key) REFERENCES ${schema}.extension_mutation_receipts(tenant_id, space_id, plugin_id, kind, actor_id, idempotency_key) ON DELETE RESTRICT`,
  ];
}
async function assertPostgresVersionTable(
  client: PoolClient,
  schema: string,
  table: string,
): Promise<void> {
  const fields = (
    await client.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      "SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position",
      [schema, table],
    )
  ).rows;
  const constraints = (
    await client.query<{
      definition: string;
      validated: boolean;
      deferred: boolean;
    }>(
      `SELECT pg_get_constraintdef(x.oid) AS definition,x.convalidated AS validated,x.condeferrable AS deferred FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND x.contype<>'n'`,
      [schema, table],
    )
  ).rows;
  if (
    fields.length !== 2 ||
    fields.some(
      (f, i) =>
        f.column_name !== ["id", "version"][i] ||
        f.data_type !== "integer" ||
        f.is_nullable !== "NO",
    ) ||
    constraints.length !== 2 ||
    constraints.some((c) => !c.validated || c.deferred) ||
    !constraints.some(
      (c) => canonicalSql(c.definition) === canonicalSql("PRIMARY KEY (id)"),
    ) ||
    !constraints.some(
      (c) => canonicalSql(c.definition) === canonicalSql("CHECK ((id = 1))"),
    )
  )
    throw new Error("project_generation_schema_incomplete");
}
