import type { DatabaseSync } from "node:sqlite";
import type { Pool, PoolClient } from "pg";
import {
  assertPluginTaskUnmeteredAdmission,
  extensionCanonicalJson,
  parsePluginTaskUnmeteredAdmission,
  pluginInstallationOpaqueId,
  type PluginTaskUnmeteredAdmission,
} from "@crewon/domain";
import type {
  CommitExtensionRunResult,
  CommitExtensionTurnInput,
  CommitExtensionTurnOptions,
  ExtensionRunLocator,
  PluginTaskUnmeteredPreparedAuthority,
} from "@crewon/application";
import { capturePluginTaskUnmeteredAuthority } from "@crewon/application";
import { extensionStoreDigester } from "./extension-store-records.ts";
import { pluginInstallationSchemaName } from "./plugin-installation-schema.ts";
import { assertPluginTaskAdmissionSchemaVersion } from "./plugin-task-admission-schema.ts";

type Reader = Pool | PoolClient;
const names = [
  "plugin_task_unmetered_schema_version",
  "plugin_task_unmetered_admissions",
];
const json = (value: unknown): unknown =>
  typeof value === "string" ? JSON.parse(value) : value;
const prefix = (schema: string) => `${pluginInstallationSchemaName(schema)}.`;
function version(rows: readonly Record<string, unknown>[]): void {
  if (rows.length !== 1 || rows[0]!.id !== 1 || rows[0]!.version !== 1)
    throw new Error("plugin_task_unmetered_schema_unsupported");
}
function catalog(rows: readonly { name: unknown; table: boolean }[]): boolean {
  if (rows.length === 0) return false;
  if (
    rows.length !== 2 ||
    names.some((name) => !rows.some((row) => row.name === name && row.table))
  )
    throw new Error("plugin_task_unmetered_schema_invalid");
  return true;
}
export function sqliteUnmeteredSchema(database: DatabaseSync): boolean {
  const rows = database
    .prepare(
      "SELECT name,type FROM main.sqlite_schema WHERE name IN (?,?) UNION ALL SELECT name,type FROM temp.sqlite_schema WHERE name IN (?,?) LIMIT 5",
    )
    .all(...names, ...names) as { name: unknown; type: unknown }[];
  if (
    !catalog(
      rows.map((row) => ({ name: row.name, table: row.type === "table" })),
    )
  )
    return false;
  version(
    database
      .prepare(
        "SELECT id,version FROM plugin_task_unmetered_schema_version LIMIT 2",
      )
      .all() as Record<string, unknown>[],
  );
  database
    .prepare(
      "SELECT tenant_id,space_id,run_id,principal_id,admission_json FROM main.plugin_task_unmetered_admissions LIMIT 0",
    )
    .all();
  return true;
}
export async function postgresUnmeteredSchema(
  client: Reader,
  schema: string,
): Promise<boolean> {
  const rows = await client.query(
    "SELECT c.relname AS name,c.relkind AS kind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) LIMIT 3",
    [schema, names],
  );
  if (
    !catalog(
      rows.rows.map((row) => ({ name: row.name, table: row.kind === "r" })),
    )
  )
    return false;
  version(
    (
      await client.query(
        `SELECT id,version FROM ${prefix(schema)}plugin_task_unmetered_schema_version LIMIT 2`,
      )
    ).rows,
  );
  await client.query(
    `SELECT tenant_id,space_id,run_id,principal_id,admission_json FROM ${prefix(schema)}plugin_task_unmetered_admissions LIMIT 0`,
  );
  return true;
}
function schemaSql(pg: boolean, p: string): string {
  const fields = pg
    ? "admission_json->'task'"
    : "json_extract(admission_json,'$.task')";
  const field = (key: string) =>
    pg
      ? `(${fields}->>'${key}')`
      : `json_extract(admission_json,'$.task.${key}')`;
  const matches = Object.entries({
    tenantId: "tenant_id",
    spaceId: "space_id",
    runId: "run_id",
    principalId: "principal_id",
  })
    .map(
      ([key, column]) =>
        `${field(key)} IS NOT NULL AND ${field(key)}=${column}`,
    )
    .join(" AND ");
  return `CREATE TABLE IF NOT EXISTS ${p}plugin_task_unmetered_schema_version(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL)${pg ? "" : " STRICT"};
    INSERT INTO ${p}plugin_task_unmetered_schema_version VALUES(1,1) ON CONFLICT(id) DO NOTHING;
    CREATE TABLE IF NOT EXISTS ${p}plugin_task_unmetered_admissions(
    tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,run_id TEXT NOT NULL,principal_id TEXT NOT NULL,
    admission_json ${pg ? "JSONB" : "TEXT"} NOT NULL CHECK(${pg ? "jsonb_typeof(admission_json)='object' AND octet_length(admission_json::text)<=16384" : "json_valid(admission_json) AND json_type(admission_json)='object' AND length(CAST(admission_json AS BLOB))<=16384"} AND ${matches}),
    PRIMARY KEY(tenant_id,run_id),
    FOREIGN KEY(tenant_id,run_id) REFERENCES ${p}plugin_task_admissions(tenant_id,run_id) ON DELETE RESTRICT
    )${pg ? "" : " STRICT"};`;
}
export function migrateSqliteUnmeteredPluginAdmissions(
  database: DatabaseSync,
): void {
  assertPluginTaskAdmissionSchemaVersion(
    database
      .prepare(
        "SELECT id,version FROM plugin_task_admission_schema_version LIMIT 2",
      )
      .all() as { id: unknown; version: unknown }[],
  );
  sqliteUnmeteredSchema(database);
  database.exec(schemaSql(false, ""));
  if (!sqliteUnmeteredSchema(database))
    throw new Error("plugin_task_unmetered_schema_invalid");
  for (const operation of ["UPDATE", "DELETE"])
    database.exec(
      `CREATE TRIGGER IF NOT EXISTS plugin_task_unmetered_no_${operation.toLowerCase()} BEFORE ${operation} ON plugin_task_unmetered_admissions BEGIN SELECT RAISE(ABORT,'plugin_task_unmetered_immutable'); END;`,
    );
}
export async function migratePostgresUnmeteredPluginAdmissions(
  client: PoolClient,
  schema: string,
): Promise<void> {
  const p = prefix(schema);
  assertPluginTaskAdmissionSchemaVersion(
    (
      await client.query(
        `SELECT id,version FROM ${p}plugin_task_admission_schema_version LIMIT 2`,
      )
    ).rows,
  );
  await postgresUnmeteredSchema(client, schema);
  await client.query(schemaSql(true, p));
  if (!(await postgresUnmeteredSchema(client, schema)))
    throw new Error("plugin_task_unmetered_schema_invalid");
  await client.query(`CREATE OR REPLACE FUNCTION ${p}plugin_task_unmetered_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'plugin_task_unmetered_immutable'; END $$;
    DROP TRIGGER IF EXISTS plugin_task_unmetered_no_update ON ${p}plugin_task_unmetered_admissions;
    CREATE TRIGGER plugin_task_unmetered_no_update BEFORE UPDATE OR DELETE ON ${p}plugin_task_unmetered_admissions FOR EACH ROW EXECUTE FUNCTION ${p}plugin_task_unmetered_immutable();`);
}
const readSql = (p: string) =>
  `SELECT u.*,a.admission_json AS task_json,b.binding_json FROM ${p}plugin_task_unmetered_admissions u JOIN ${p}plugin_task_admissions a ON a.tenant_id=u.tenant_id AND a.run_id=u.run_id JOIN ${p}extension_run_bindings b ON b.tenant_id=u.tenant_id AND b.run_id=u.run_id WHERE u.tenant_id=$1 AND u.space_id=$2 AND u.run_id=$3`;
function locator(input: ExtensionRunLocator): readonly string[] {
  return [
    pluginInstallationOpaqueId(input.tenantId),
    pluginInstallationOpaqueId(input.spaceId),
    pluginInstallationOpaqueId(input.runId),
  ];
}
export function decodePluginTaskUnmeteredRecord(
  row: Record<string, unknown> | undefined,
): PluginTaskUnmeteredAdmission | null {
  if (row === undefined) return null;
  const admission = parsePluginTaskUnmeteredAdmission(
    json(row.admission_json),
    extensionStoreDigester,
  );
  if (
    admission.task.tenantId !== row.tenant_id ||
    admission.task.spaceId !== row.space_id ||
    admission.task.runId !== row.run_id ||
    admission.task.principalId !== row.principal_id ||
    extensionCanonicalJson(admission.task) !==
      extensionCanonicalJson(json(row.task_json))
  )
    throw new Error("plugin_task_unmetered_record_invalid");
  return assertPluginTaskUnmeteredAdmission(
    {
      admission,
      binding: json(row.binding_json) as CommitExtensionRunResult["binding"],
      receipt: {
        actorId: admission.task.actorId,
        idempotencyKey: admission.task.idempotencyKey,
        requestDigest: admission.task.requestDigest,
      },
    },
    extensionStoreDigester,
  );
}
export function loadSqlitePluginTaskUnmeteredAdmission(
  database: DatabaseSync,
  input: ExtensionRunLocator,
): PluginTaskUnmeteredAdmission | null {
  const values = locator(input);
  if (!sqliteUnmeteredSchema(database)) return null;
  return decodePluginTaskUnmeteredRecord(
    database
      .prepare(readSql("main.").replaceAll(/\$[1-3]/gu, "?"))
      .get(...values) as Record<string, unknown> | undefined,
  );
}
export async function loadPostgresPluginTaskUnmeteredAdmission(
  client: Reader,
  schema: string,
  input: ExtensionRunLocator,
): Promise<PluginTaskUnmeteredAdmission | null> {
  const values = locator(input);
  if (!(await postgresUnmeteredSchema(client, schema))) return null;
  return decodePluginTaskUnmeteredRecord(
    (await client.query(readSql(prefix(schema)), [...values])).rows[0],
  );
}
export function saveSqlitePluginTaskUnmeteredAdmission(
  database: DatabaseSync,
  admission: PluginTaskUnmeteredAdmission,
): void {
  if (!sqliteUnmeteredSchema(database))
    throw new Error("plugin_task_unmetered_unavailable");
  database
    .prepare("INSERT INTO plugin_task_unmetered_admissions VALUES(?,?,?,?,?)")
    .run(
      admission.task.tenantId,
      admission.task.spaceId,
      admission.task.runId,
      admission.task.principalId,
      JSON.stringify(admission),
    );
}
export async function savePostgresPluginTaskUnmeteredAdmission(
  client: PoolClient,
  schema: string,
  admission: PluginTaskUnmeteredAdmission,
): Promise<void> {
  if (!(await postgresUnmeteredSchema(client, schema)))
    throw new Error("plugin_task_unmetered_unavailable");
  await client.query(
    `INSERT INTO ${prefix(schema)}plugin_task_unmetered_admissions VALUES($1,$2,$3,$4,$5)`,
    [
      admission.task.tenantId,
      admission.task.spaceId,
      admission.task.runId,
      admission.task.principalId,
      admission,
    ],
  );
}
export function captureUnmeteredTurn(
  input: CommitExtensionTurnInput,
  enabled: boolean,
  options?: CommitExtensionTurnOptions,
): Readonly<{
  admission?: PluginTaskUnmeteredAdmission;
  authority?: PluginTaskUnmeteredPreparedAuthority;
  projectOptions?: CommitExtensionTurnOptions;
}> {
  const field = Object.getOwnPropertyDescriptor(input, "unmeteredAdmission");
  if (
    (field === undefined && "unmeteredAdmission" in input) ||
    (field !== undefined && (!field.enumerable || !("value" in field)))
  )
    throw new Error("plugin_task_unmetered_record_invalid");
  const authorityField =
    options === undefined
      ? undefined
      : Object.getOwnPropertyDescriptor(options, "unmeteredAuthority");
  if (
    options !== undefined &&
    ((authorityField === undefined && "unmeteredAuthority" in options) ||
      (authorityField !== undefined &&
        (!authorityField.enumerable || !("value" in authorityField))))
  )
    throw new Error("plugin_task_unmetered_authority_invalid");
  if (field?.value === undefined) {
    if (authorityField !== undefined)
      throw new Error("plugin_task_unmetered_admission_required");
    return { projectOptions: options };
  }
  const taskField = Object.getOwnPropertyDescriptor(input, "pluginAdmission");
  if (
    taskField !== undefined &&
    (!taskField.enumerable || !("value" in taskField))
  )
    throw new Error("plugin_task_unmetered_task_invalid");
  if (
    !enabled ||
    taskField?.value === undefined ||
    input.pluginQueryAdmission !== undefined ||
    input.creditAdmission !== undefined ||
    authorityField?.value === undefined
  )
    throw new Error("plugin_task_unmetered_admission_required");
  const admission = assertPluginTaskUnmeteredAdmission(
    {
      admission: field.value,
      binding: input.binding,
      receipt: input.receipt,
      task: taskField.value,
    },
    extensionStoreDigester,
  );
  const authority = capturePluginTaskUnmeteredAuthority(authorityField.value);
  if (
    extensionCanonicalJson(authority.authorization) !==
    extensionCanonicalJson(admission.authorization)
  )
    throw new Error("plugin_task_unmetered_authority_mismatch");
  authority.assertActive();
  if (![Object.prototype, null].includes(Object.getPrototypeOf(options!)))
    throw new Error("plugin_task_unmetered_authority_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(options!);
  const projectOptions = Object.create(
    Object.getPrototypeOf(options!),
    Object.fromEntries(
      Reflect.ownKeys(descriptors)
        .filter((key) => key !== "unmeteredAuthority")
        .map((key) => [key, descriptors[key as keyof typeof descriptors]]),
    ),
  ) as CommitExtensionTurnOptions;
  return {
    admission,
    authority,
    ...(Reflect.ownKeys(projectOptions).length === 0 ? {} : { projectOptions }),
  };
}
export function assertUnmeteredReceipt(
  result: CommitExtensionRunResult,
  linked: PluginTaskUnmeteredAdmission | null,
): void {
  if (
    result.creditAdmission !== undefined &&
    result.unmeteredAdmission !== undefined
  )
    throw new Error("plugin_task_unmetered_mode_conflict");
  if (
    extensionCanonicalJson(result.unmeteredAdmission ?? null) !==
    extensionCanonicalJson(linked)
  )
    throw new Error("plugin_task_unmetered_link_mismatch");
}
/** Reads use existing immutable evidence, with no enablement or migrations. */
export function verifySqliteUnmeteredReceipt(
  database: DatabaseSync,
  result: CommitExtensionRunResult,
): void {
  assertUnmeteredReceipt(
    result,
    loadSqlitePluginTaskUnmeteredAdmission(database, result.binding),
  );
}
export async function verifyPostgresUnmeteredReceipt(
  client: Reader,
  schema: string,
  result: CommitExtensionRunResult,
): Promise<void> {
  assertUnmeteredReceipt(
    result,
    await loadPostgresPluginTaskUnmeteredAdmission(
      client,
      schema,
      result.binding,
    ),
  );
}
export function sqlitePluginTaskFundingPrincipal(
  database: DatabaseSync,
  input: ExtensionRunLocator,
): unknown {
  const unmetered = loadSqlitePluginTaskUnmeteredAdmission(database, input);
  const present = database
    .prepare(
      "SELECT type FROM sqlite_schema WHERE name='extension_credit_admissions'",
    )
    .get();
  const credit =
    present === undefined
      ? undefined
      : (database
          .prepare(
            "SELECT principal_id FROM extension_credit_admissions WHERE tenant_id=? AND run_id=?",
          )
          .get(input.tenantId, input.runId) as
          | { principal_id: unknown }
          | undefined);
  if (credit !== undefined && unmetered !== null)
    throw new Error("plugin_task_unmetered_mode_conflict");
  return credit?.principal_id ?? unmetered?.task.principalId;
}
export async function postgresPluginTaskFundingPrincipal(
  client: Reader,
  schema: string,
  input: ExtensionRunLocator,
): Promise<unknown> {
  const unmetered = await loadPostgresPluginTaskUnmeteredAdmission(
    client,
    schema,
    input,
  );
  const present = await client.query(
    "SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='extension_credit_admissions'",
    [schema],
  );
  const credit =
    present.rows.length === 0
      ? undefined
      : (
          await client.query(
            `SELECT principal_id FROM ${prefix(schema)}extension_credit_admissions WHERE tenant_id=$1 AND run_id=$2`,
            [input.tenantId, input.runId],
          )
        ).rows[0];
  if (credit !== undefined && unmetered !== null)
    throw new Error("plugin_task_unmetered_mode_conflict");
  return credit?.principal_id ?? unmetered?.task.principalId;
}

export function assertUnmeteredReplay(
  saved: PluginTaskUnmeteredAdmission | undefined,
  requested: PluginTaskUnmeteredAdmission | undefined,
): void {
  if (
    (saved === undefined) !== (requested === undefined) ||
    (saved !== undefined &&
      extensionCanonicalJson(saved.authorization) !==
        extensionCanonicalJson(requested!.authorization))
  )
    throw new Error("plugin_task_unmetered_mode_conflict");
}
export async function migratePostgresUnmeteredWithPool(input: {
  pool: Pool;
  schema: string;
  assertOpen(): void;
}): Promise<void> {
  input.assertOpen();
  const client = await input.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      JSON.stringify(["plugin-task-unmetered-migration", input.schema]),
    ]);
    await migratePostgresUnmeteredPluginAdmissions(client, input.schema);
    input.assertOpen();
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
