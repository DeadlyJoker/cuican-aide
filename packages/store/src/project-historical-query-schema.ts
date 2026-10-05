import {
  assertSqliteHistoricalQueryEvidenceCatalog,
  assertPostgresHistoricalQueryEvidenceCatalog,
  assertSqliteHistoricalQueryMarkerColumn,
  assertPostgresHistoricalQueryMarkerColumn,
} from "./project-historical-query-catalog.ts";
import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import {
  assertSqliteProjectGenerationSchema,
  assertPostgresProjectGenerationSchema,
} from "./project-generation-schema.ts";
import {
  assertPluginQuerySchema,
  postgresPluginQueryVersion,
} from "./plugin-query-task-schema.ts";

const versionTable = "project_historical_query_schema_version",
  table = "creative_project_historical_query_links",
  message = "project_historical_query_link_immutable";
const triggers = [
  "project_historical_query_no_update",
  "project_historical_query_no_delete",
] as const;
export const projectHistoricalQueryColumns = [
  "tenant_id",
  "space_id",
  "project_id",
  "owner_principal_id",
  "asset_id",
  "asset_revision",
  "generation_link_digest",
  "source_run_id",
  "source_binding_digest",
  "operation_id",
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
const fields = {
  "tenantId": "tenant_id",
  "spaceId": "space_id",
  "projectId": "project_id",
  "ownerPrincipalId": "owner_principal_id",
  "reference.assetId": "asset_id",
  "reference.assetRevision": "asset_revision",
  "generationLinkDigest": "generation_link_digest",
  "sourceRunId": "source_run_id",
  "sourceBindingDigest": "source_binding_digest",
  "operationId": "operation_id",
  "binding.pluginId": "plugin_id",
  "binding.runId": "run_id",
  "binding.threadId": "thread_id",
  "receipt.actorId": "actor_id",
  "binding.bindingDigest": "binding_digest",
  "receipt.idempotencyKey": "idempotency_key",
  "receipt.requestDigest": "request_digest",
  "contentDigest": "content_digest",
};
export function projectHistoricalQuerySchemaSql(
  input: { dialect: "sqlite" } | { dialect: "postgres"; schema: string },
): string {
  const pg = input.dialect === "postgres",
    prefix = pg ? `${creativeProjectSchemaName(input.schema)}.` : "";
  const json = (path: string) =>
    pg
      ? `(record_json#>>'{${path.split(".").join(",")}}')`
      : `json_extract(record_json,'$.${path}')`;
  const matches = Object.entries(fields)
    .map(
      ([field, column]) =>
        `${json(field)} IS NOT NULL AND CAST(${json(field)} AS TEXT)=CAST(${column} AS TEXT)`,
    )
    .join(" AND ");
  return `CREATE TABLE ${prefix}${table} (
    tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,project_id TEXT NOT NULL,owner_principal_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,asset_revision ${pg ? "BIGINT" : "INTEGER"} NOT NULL CHECK(asset_revision>=1 AND asset_revision<=9007199254740991),
    generation_link_digest TEXT NOT NULL,source_run_id TEXT NOT NULL,source_binding_digest TEXT NOT NULL,operation_id TEXT NOT NULL,
    plugin_id TEXT NOT NULL,run_id TEXT NOT NULL,thread_id TEXT NOT NULL,actor_id TEXT NOT NULL,binding_digest TEXT NOT NULL,
    receipt_kind TEXT NOT NULL CHECK(receipt_kind='task'),idempotency_key TEXT NOT NULL,request_digest TEXT NOT NULL,content_digest TEXT NOT NULL,
    record_json ${pg ? "JSONB" : "TEXT"} NOT NULL CHECK(${pg ? "jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=32768" : "json_valid(record_json) AND json_type(record_json)='object' AND length(CAST(record_json AS BLOB))<=32768"} AND ${json("schemaVersion")}='crewon.project-historical-query-link.v1' AND ${matches}),
    PRIMARY KEY(tenant_id,run_id),
    FOREIGN KEY(tenant_id,source_run_id) REFERENCES ${prefix}creative_project_generation_links(tenant_id,run_id) ON DELETE RESTRICT,
    FOREIGN KEY(tenant_id,run_id) REFERENCES ${prefix}extension_run_bindings(tenant_id,run_id) ON DELETE RESTRICT,
    FOREIGN KEY(tenant_id,space_id,plugin_id,receipt_kind,actor_id,idempotency_key) REFERENCES ${prefix}extension_mutation_receipts(tenant_id,space_id,plugin_id,kind,actor_id,idempotency_key) ON DELETE RESTRICT
  )${pg ? "" : " STRICT"};`;
}
const canonical = (sql: string) =>
  sql
    .trim()
    .replace(/;$/u, "")
    .replace(/\s+/gu, " ")
    .replace(/\s*([(),=])\s*/gu, "$1")
    .toLowerCase();
const versionSql = (prefix = "", sqlite = false) =>
  `CREATE TABLE ${prefix}${versionTable}(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL)${sqlite ? " STRICT" : ""};`;
const triggerSql = (operation: "UPDATE" | "DELETE") =>
  `CREATE TRIGGER project_historical_query_no_${operation.toLowerCase()} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'${message}'); END;`;
function version(rows: readonly { id: unknown; version: unknown }[]) {
  if (rows.length !== 1 || rows[0]?.id !== 1 || rows[0].version !== 1)
    throw new Error("project_historical_query_schema_version_unsupported");
}
function sqliteBase(db: DatabaseSync) {
  assertSqliteHistoricalQueryEvidenceCatalog(db);
  assertSqliteHistoricalQueryMarkerColumn(db);
  assertSqliteProjectGenerationSchema(db);
  assertPluginQuerySchema(
    db
      .prepare(
        "SELECT id,version FROM plugin_query_task_admission_schema_version LIMIT 2",
      )
      .all() as { id: unknown; version: unknown }[],
  );
  for (const sql of baseReads()) db.prepare(sql).all();
}
function baseReads(prefix = "") {
  return [
    `SELECT tenant_id,space_id,run_id,source_run_id,admission_json FROM ${prefix}plugin_query_task_admissions LIMIT 0`,
    `SELECT tenant_id,run_id,binding_digest,operation_id FROM ${prefix}extension_external_operations LIMIT 0`,
    `SELECT tenant_id,space_id,profile_id,plugin_id,package_digest,admission_json FROM ${prefix}plugin_task_admissions LIMIT 0`,
  ];
}
export function assertSqliteProjectHistoricalQuerySchema(
  db: DatabaseSync,
): void {
  sqliteBase(db);
  const expected = new Map([
    [versionTable, versionSql("", true)],
    [table, projectHistoricalQuerySchemaSql({ dialect: "sqlite" })],
    [triggers[0], triggerSql("UPDATE")],
    [triggers[1], triggerSql("DELETE")],
  ]);
  const objects = db
    .prepare("SELECT name,sql FROM sqlite_master WHERE name IN (?,?,?,?)")
    .all(versionTable, table, ...triggers) as { name: string; sql: string }[];
  if (
    objects.length !== expected.size ||
    objects.some(
      (row) =>
        canonical(row.sql ?? "") !== canonical(expected.get(row.name) ?? ""),
    )
  )
    throw new Error("project_historical_query_schema_incomplete");
  version(
    db.prepare(`SELECT id,version FROM ${versionTable} LIMIT 2`).all() as {
      id: unknown;
      version: unknown;
    }[],
  );
}
/** Only explicit migration creates this independent query sidecar. Unknown/partial schemas are never repaired. */
export function migrateSqliteProjectHistoricalQueries(db: DatabaseSync): void {
  sqliteBase(db);
  const objects = db
    .prepare("SELECT name FROM sqlite_master WHERE name IN (?,?,?,?)")
    .all(versionTable, table, ...triggers);
  if (objects.length === 0) {
    db.exec(versionSql("", true));
    db.exec(`INSERT INTO ${versionTable} VALUES(1,1);`);
    db.exec(projectHistoricalQuerySchemaSql({ dialect: "sqlite" }));
    db.exec(triggerSql("UPDATE"));
    db.exec(triggerSql("DELETE"));
  }
  assertSqliteProjectHistoricalQuerySchema(db);
}
async function pgObjects(client: PoolClient, schema: string) {
  const tables = await client.query<{ name: string }>(
    "SELECT tablename AS name FROM pg_tables WHERE schemaname=$1 AND tablename=ANY($2::text[])",
    [schema, [versionTable, table]],
  );
  const trigger = await client.query<{
    name: string;
    enabled: string;
    bits: number;
    body: string;
    function_schema: string;
    language: string;
    guard: string | null;
  }>(
    `SELECT t.tgname AS name,t.tgenabled AS enabled,t.tgtype AS bits,p.prosrc AS body,pn.nspname AS function_schema,l.lanname AS language,pg_get_expr(t.tgqual,t.tgrelid) AS guard FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang WHERE n.nspname=$1 AND c.relname=$2 AND NOT t.tgisinternal AND t.tgname=ANY($3::text[])`,
    [schema, table, triggers],
  );
  return { tables: tables.rows, triggers: trigger.rows };
}
async function pgBase(client: PoolClient, schema: string) {
  await assertPostgresHistoricalQueryEvidenceCatalog(client, schema);
  await assertPostgresHistoricalQueryMarkerColumn(client, schema);
  await assertPostgresProjectGenerationSchema(client, schema);
  await postgresPluginQueryVersion(client, schema);
  for (const sql of baseReads(`${creativeProjectSchemaName(schema)}.`))
    await client.query(sql);
}
export async function assertPostgresProjectHistoricalQuerySchema(
  client: PoolClient,
  schema: string,
): Promise<void> {
  const prefix = `${creativeProjectSchemaName(schema)}.`,
    objects = await pgObjects(client, schema);
  if (
    objects.tables.length !== 2 ||
    objects.triggers.length !== 2 ||
    triggers.some(
      (name, index) =>
        !objects.triggers.some(
          (t) =>
            t.name === name &&
            t.enabled === "O" &&
            t.bits === (index === 0 ? 19 : 11) &&
            t.function_schema === schema &&
            t.language === "plpgsql" &&
            t.guard === null &&
            canonical(t.body) ===
              canonical(`BEGIN RAISE EXCEPTION '${message}'; END`),
        ),
    )
  )
    throw new Error("project_historical_query_schema_incomplete");
  version(
    (
      await client.query<{ id: unknown; version: unknown }>(
        `SELECT id,version FROM ${prefix}${versionTable} LIMIT 2`,
      )
    ).rows,
  );
  for (const [name, columns] of [
    [table, projectHistoricalQueryColumns],
    [versionTable, ["id", "version"]],
  ] as const) {
    const actual = (
      await client.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
      }>(
        "SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position",
        [schema, name],
      )
    ).rows;
    if (
      actual.length !== columns.length ||
      actual.some(
        (field, i) =>
          field.column_name !== columns[i] ||
          field.is_nullable !== "NO" ||
          field.data_type !==
            (name === versionTable
              ? "integer"
              : field.column_name === "asset_revision"
                ? "bigint"
                : field.column_name === "record_json"
                  ? "jsonb"
                  : "text"),
      )
    )
      throw new Error("project_historical_query_schema_incomplete");
    const constraints = (
      await client.query<{
        definition: string;
        validated: boolean;
        deferred: boolean;
      }>(
        `SELECT pg_get_constraintdef(x.oid) AS definition,x.convalidated AS validated,x.condeferrable AS deferred FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND x.contype<>'n'`,
        [schema, name],
      )
    ).rows;
    const expected =
      name === versionTable
        ? ["PRIMARY KEY (id)", "CHECK ((id = 1))"]
        : pgConstraints(schema);
    if (
      constraints.length !== expected.length ||
      constraints.some((c) => !c.validated || c.deferred) ||
      expected.some(
        (definition) =>
          !constraints.some(
            (c) => canonical(c.definition) === canonical(definition),
          ),
      )
    )
      throw new Error("project_historical_query_schema_incomplete");
  }
  await pgBase(client, schema);
}
export async function migratePostgresProjectHistoricalQueries(
  client: PoolClient,
  schema: string,
): Promise<void> {
  await pgBase(client, schema);
  const prefix = `${creativeProjectSchemaName(schema)}.`,
    objects = await pgObjects(client, schema);
  if (objects.tables.length === 0 && objects.triggers.length === 0) {
    await client.query(versionSql(prefix));
    await client.query(`INSERT INTO ${prefix}${versionTable} VALUES(1,1);`);
    await client.query(
      projectHistoricalQuerySchemaSql({ dialect: "postgres", schema }),
    );
    await client.query(
      `CREATE FUNCTION ${prefix}project_historical_query_link_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '${message}'; END $$;`,
    );
    for (const operation of ["UPDATE", "DELETE"] as const)
      await client.query(
        `CREATE TRIGGER project_historical_query_no_${operation.toLowerCase()} BEFORE ${operation} ON ${prefix}${table} FOR EACH ROW EXECUTE FUNCTION ${prefix}project_historical_query_link_immutable();`,
      );
  }
  await assertPostgresProjectHistoricalQuerySchema(client, schema);
}
function pgConstraints(schema: string): readonly string[] {
  const matches = Object.entries(fields).flatMap(([field, column]) => {
    const expression = `(record_json #>> '{${field.split(".").join(",")}}'::text[])`,
      value = column === "asset_revision" ? `(${column})::text` : column;
    return [`(${expression} IS NOT NULL)`, `(${expression} = ${value})`];
  });
  return [
    "PRIMARY KEY (tenant_id, run_id)",
    "CHECK (((asset_revision >= 1) AND (asset_revision <= '9007199254740991'::bigint)))",
    "CHECK ((receipt_kind = 'task'::text))",
    `CHECK (((jsonb_typeof(record_json) = 'object'::text) AND (octet_length((record_json)::text) <= 32768) AND ((record_json #>> '{schemaVersion}'::text[]) = 'crewon.project-historical-query-link.v1'::text) AND ${matches.join(" AND ")}))`,
    `FOREIGN KEY (tenant_id, source_run_id) REFERENCES ${schema}.creative_project_generation_links(tenant_id, run_id) ON DELETE RESTRICT`,
    `FOREIGN KEY (tenant_id, run_id) REFERENCES ${schema}.extension_run_bindings(tenant_id, run_id) ON DELETE RESTRICT`,
    `FOREIGN KEY (tenant_id, space_id, plugin_id, receipt_kind, actor_id, idempotency_key) REFERENCES ${schema}.extension_mutation_receipts(tenant_id, space_id, plugin_id, kind, actor_id, idempotency_key) ON DELETE RESTRICT`,
  ];
}
