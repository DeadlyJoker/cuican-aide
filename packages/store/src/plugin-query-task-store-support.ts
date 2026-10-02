import type { DatabaseSync } from "node:sqlite";
import type { Pool, PoolClient } from "pg";
import type {
  CommitExtensionTurnInput,
  ExtensionRunLocator,
  ExtensionMutationReceipt,
} from "@crewon/application";
import {
  assertPluginQueryTaskAdmission,
  extensionCanonicalJson,
  parseExtensionRunBinding,
  parsePluginQueryTaskAdmission,
  type PluginQueryTaskAdmission,
  type ExtensionRunBinding,
} from "@crewon/domain";
import { extensionStoreDigester } from "./extension-store-records.ts";
import {
  admitSqlitePluginTask,
  admitPostgresPluginTask,
  loadSqlitePluginTask,
  loadPostgresPluginTask,
} from "./plugin-task-admission-store-support.ts";
import { pluginInstallationSchemaName } from "./plugin-installation-schema.ts";
import {
  assertPluginQuerySchema,
  postgresPluginQueryVersion,
} from "./plugin-query-task-schema.ts";
const json = (value: unknown): unknown =>
  typeof value === "string" ? JSON.parse(value) : value;
const receipt = (query: PluginQueryTaskAdmission) => ({
  actorId: query.actorId,
  idempotencyKey: query.idempotencyKey,
  requestDigest: query.requestDigest,
});
export function checkedPluginQueryTurn(
  input: CommitExtensionTurnInput,
): PluginQueryTaskAdmission | undefined {
  const field = Object.getOwnPropertyDescriptor(input, "pluginQueryAdmission");
  if (field === undefined) {
    if ("pluginQueryAdmission" in input)
      throw new Error("plugin_query_admission_invalid");
    return undefined;
  }
  if (!field.enumerable || !("value" in field))
    throw new Error("plugin_query_admission_invalid");
  if (field.value === undefined) return undefined;
  if (
    input.pluginAdmission !== undefined ||
    input.creditAdmission !== undefined
  )
    throw new Error("plugin_query_credit_or_generation_conflict");
  const query = parsePluginQueryTaskAdmission(field.value),
    binding = parseExtensionRunBinding(input.binding, extensionStoreDigester);
  if (
    binding.source === null ||
    query.extensionBindingDigest !== binding.bindingDigest ||
    query.runId !== binding.runId ||
    query.actorId !== input.receipt.actorId ||
    query.requestDigest !== input.receipt.requestDigest ||
    query.idempotencyKey !== input.receipt.idempotencyKey
  )
    throw new Error("plugin_query_admission_binding_mismatch");
  return query;
}
function validate(
  query: PluginQueryTaskAdmission,
  binding: ExtensionRunBinding,
  sourceBinding: unknown,
  sourceAdmission: unknown,
  sourcePrincipal: unknown,
  operation: unknown,
): void {
  if (
    sourceAdmission === null ||
    extensionCanonicalJson(sourceAdmission) !==
      extensionCanonicalJson(query.source) ||
    sourcePrincipal !== query.source.principalId ||
    operation === undefined ||
    operation === null
  )
    throw new Error("plugin_query_source_invalid");
  assertPluginQueryTaskAdmission(
    {
      admission: query,
      binding,
      sourceBinding: sourceBinding as ExtensionRunBinding,
      receipt: receipt(query),
    },
    extensionStoreDigester,
  );
}
const currentGenerationPin = (query: PluginQueryTaskAdmission) => ({
  ...query.source,
  ...Object.fromEntries(
    Object.entries(query).filter(
      ([key]) => !["schemaVersion", "source", "operationId"].includes(key),
    ),
  ),
  schemaVersion: "crewon.plugin-task-admission.v1" as const,
});
export function admitSqlitePluginQuery(
  db: DatabaseSync,
  query: PluginQueryTaskAdmission,
  binding: ExtensionRunBinding,
): void {
  assertPluginQuerySchema(
    db
      .prepare(
        "SELECT id,version FROM plugin_query_task_admission_schema_version LIMIT 2",
      )
      .all() as { id: unknown; version: unknown }[],
  );
  admitSqlitePluginTask(db, currentGenerationPin(query));
  validateSqliteSource(db, query, binding);
}
function validateSqliteSource(
  db: DatabaseSync,
  query: PluginQueryTaskAdmission,
  binding: ExtensionRunBinding,
): void {
  const original = loadSqlitePluginTask(db, {
    tenantId: query.tenantId,
    spaceId: query.spaceId,
    runId: query.source.runId,
  });
  const raw = db
    .prepare(
      "SELECT binding_json FROM extension_run_bindings WHERE tenant_id=? AND run_id=?",
    )
    .get(query.tenantId, query.source.runId) as
    | { binding_json: unknown }
    | undefined;
  const credit = db
    .prepare(
      "SELECT principal_id FROM extension_credit_admissions WHERE tenant_id=? AND run_id=?",
    )
    .get(query.tenantId, query.source.runId) as
    | { principal_id: unknown }
    | undefined;
  const operation = db
    .prepare(
      "SELECT 1 FROM extension_external_operations WHERE tenant_id=? AND run_id=? AND binding_digest=? AND operation_id=?",
    )
    .get(
      query.tenantId,
      query.source.runId,
      query.source.extensionBindingDigest,
      query.operationId,
    );
  validate(
    query,
    binding,
    json(raw?.binding_json),
    original,
    credit?.principal_id,
    operation,
  );
}
export async function admitPostgresPluginQuery(
  client: PoolClient,
  schema: string,
  query: PluginQueryTaskAdmission,
  binding: ExtensionRunBinding,
): Promise<void> {
  await postgresPluginQueryVersion(client, schema);
  await admitPostgresPluginTask(client, schema, currentGenerationPin(query));
  await validatePostgresSource(client, schema, query, binding);
}
async function validatePostgresSource(
  client: Pool | PoolClient,
  schema: string,
  query: PluginQueryTaskAdmission,
  binding: ExtensionRunBinding,
): Promise<void> {
  const prefix = `${pluginInstallationSchemaName(schema)}.`;
  const original = await loadPostgresPluginTask(client, schema, {
    tenantId: query.tenantId,
    spaceId: query.spaceId,
    runId: query.source.runId,
  });
  const raw = await client.query(
    `SELECT b.binding_json,c.principal_id FROM ${prefix}extension_run_bindings b JOIN ${prefix}extension_credit_admissions c ON c.tenant_id=b.tenant_id AND c.run_id=b.run_id WHERE b.tenant_id=$1 AND b.run_id=$2`,
    [query.tenantId, query.source.runId],
  );
  const operation = await client.query(
    `SELECT 1 FROM ${prefix}extension_external_operations WHERE tenant_id=$1 AND run_id=$2 AND binding_digest=$3 AND operation_id=$4`,
    [
      query.tenantId,
      query.source.runId,
      query.source.extensionBindingDigest,
      query.operationId,
    ],
  );
  validate(
    query,
    binding,
    json(raw.rows[0]?.binding_json),
    original,
    raw.rows[0]?.principal_id,
    operation.rows[0],
  );
}
export function saveSqlitePluginQuery(
  db: DatabaseSync,
  query: PluginQueryTaskAdmission,
): void {
  db.prepare("INSERT INTO plugin_query_task_admissions VALUES(?,?,?,?,?)").run(
    query.tenantId,
    query.spaceId,
    query.runId,
    query.source.runId,
    JSON.stringify(query),
  );
}
export async function savePostgresPluginQuery(
  client: PoolClient,
  schema: string,
  query: PluginQueryTaskAdmission,
): Promise<void> {
  await client.query(
    `INSERT INTO ${pluginInstallationSchemaName(schema)}.plugin_query_task_admissions VALUES($1,$2,$3,$4,$5)`,
    [query.tenantId, query.spaceId, query.runId, query.source.runId, query],
  );
}
function decode(
  row: Record<string, unknown> | undefined,
  locator: ExtensionRunLocator,
): PluginQueryTaskAdmission | null {
  if (row === undefined) return null;
  const query = parsePluginQueryTaskAdmission(json(row.admission_json));
  if (
    query.tenantId !== locator.tenantId ||
    query.spaceId !== locator.spaceId ||
    query.runId !== locator.runId ||
    query.tenantId !== row.tenant_id ||
    query.spaceId !== row.space_id ||
    query.runId !== row.run_id ||
    query.source.runId !== row.source_run_id
  )
    throw new Error("plugin_query_admission_record_invalid");
  return query;
}
export function loadSqlitePluginQuery(
  db: DatabaseSync,
  locator: ExtensionRunLocator,
): PluginQueryTaskAdmission | null {
  assertPluginQuerySchema(
    db
      .prepare(
        "SELECT id,version FROM plugin_query_task_admission_schema_version LIMIT 2",
      )
      .all() as { id: unknown; version: unknown }[],
  );
  const query = decode(
    db
      .prepare(
        "SELECT * FROM plugin_query_task_admissions WHERE tenant_id=? AND run_id=?",
      )
      .get(locator.tenantId, locator.runId),
    locator,
  );
  if (query !== null) {
    const row = db
      .prepare(
        "SELECT binding_json FROM extension_run_bindings WHERE tenant_id=? AND run_id=?",
      )
      .get(locator.tenantId, locator.runId) as
      | { binding_json: unknown }
      | undefined;
    validateSqliteSource(
      db,
      query,
      parseExtensionRunBinding(json(row?.binding_json), extensionStoreDigester),
    );
  }
  return query;
}
export async function loadPostgresPluginQuery(
  client: Pool | PoolClient,
  schema: string,
  locator: ExtensionRunLocator,
): Promise<PluginQueryTaskAdmission | null> {
  await postgresPluginQueryVersion(client, schema);
  const prefix = `${pluginInstallationSchemaName(schema)}.`;
  const row = await client.query(
    `SELECT * FROM ${prefix}plugin_query_task_admissions WHERE tenant_id=$1 AND run_id=$2`,
    [locator.tenantId, locator.runId],
  );
  const query = decode(row.rows[0], locator);
  if (query !== null) {
    const raw = await client.query(
      `SELECT binding_json FROM ${prefix}extension_run_bindings WHERE tenant_id=$1 AND run_id=$2`,
      [locator.tenantId, locator.runId],
    );
    await validatePostgresSource(
      client,
      schema,
      query,
      parseExtensionRunBinding(
        json(raw.rows[0]?.binding_json),
        extensionStoreDigester,
      ),
    );
  }
  return query;
}
export function assertPluginQueryReplay(
  requested: PluginQueryTaskAdmission,
  saved: PluginQueryTaskAdmission | null,
  binding: ExtensionRunBinding,
  request: ExtensionMutationReceipt,
): void {
  if (
    saved === null ||
    saved.threadId !== requested.threadId ||
    saved.extensionBindingDigest !== binding.bindingDigest ||
    saved.requestDigest !== request.requestDigest ||
    saved.idempotencyKey !== request.idempotencyKey ||
    extensionCanonicalJson({
      ...saved,
      runId: requested.runId,
      extensionBindingDigest: requested.extensionBindingDigest,
    }) !== extensionCanonicalJson(requested)
  )
    throw new Error("plugin_query_admission_conflict");
}
