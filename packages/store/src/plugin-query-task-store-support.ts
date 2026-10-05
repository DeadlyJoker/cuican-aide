import { assertPluginTaskFunding } from "@crewon/domain";
import {
  sqlitePluginTaskFundingPrincipal,
  postgresPluginTaskFundingPrincipal,
} from "./plugin-task-unmetered-store-support.ts";
import type { DatabaseSync } from "node:sqlite";
import type { Pool, PoolClient } from "pg";
import type {
  CommitExtensionTurnInput,
  ExtensionRunLocator,
  ExtensionMutationReceipt,
  ExtensionStore,
  PluginTaskReceiptLocator,
} from "@crewon/application";
import {
  assertPluginQueryTaskAdmission,
  assertPluginTaskAdmission,
  extensionCanonicalJson,
  parseExtensionRunBinding,
  parsePluginQueryTaskAdmission,
  type PluginQueryTaskAdmission,
  type ExtensionRunBinding,
  pluginInstallationOpaqueId,
  pluginInstallationNamespaceId,
} from "@crewon/domain";
import {
  extensionStoreDigester,
  parseExtensionTurnReceipt,
  validateExtensionReceipt,
} from "./extension-store-records.ts";
import { parseExternalOperationQueryRecord } from "./external-operation-record.ts";
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
    input.creditAdmission !== undefined ||
    input.unmeteredAdmission !== undefined
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
  const sourcePrincipal = sqlitePluginTaskFundingPrincipal(db, {
    tenantId: query.tenantId,
    spaceId: query.spaceId,
    runId: query.source.runId,
  });
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
    sourcePrincipal,
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
    `SELECT b.binding_json FROM ${prefix}extension_run_bindings b WHERE b.tenant_id=$1 AND b.run_id=$2`,
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
    await postgresPluginTaskFundingPrincipal(client, schema, {
      tenantId: query.tenantId,
      spaceId: query.spaceId,
      runId: query.source.runId,
    }),
    operation.rows[0],
  );
}
export function saveSqlitePluginQuery(
  db: DatabaseSync,
  query: PluginQueryTaskAdmission,
  historicalDigest?: string,
): void {
  db.prepare(
    `INSERT INTO plugin_query_task_admissions(tenant_id,space_id,run_id,source_run_id,admission_json${historicalDigest === undefined ? "" : ",project_historical_query_digest"}) VALUES(?,?,?,?,?${historicalDigest === undefined ? "" : ",?"})`,
  ).run(
    query.tenantId,
    query.spaceId,
    query.runId,
    query.source.runId,
    JSON.stringify(query),
    ...(historicalDigest === undefined ? [] : [historicalDigest]),
  );
}
export async function savePostgresPluginQuery(
  client: PoolClient,
  schema: string,
  query: PluginQueryTaskAdmission,
  historicalDigest?: string,
): Promise<void> {
  await client.query(
    `INSERT INTO ${pluginInstallationSchemaName(schema)}.plugin_query_task_admissions(tenant_id,space_id,run_id,source_run_id,admission_json${historicalDigest === undefined ? "" : ",project_historical_query_digest"}) VALUES($1,$2,$3,$4,$5${historicalDigest === undefined ? "" : ",$6"})`,
    [
      query.tenantId,
      query.spaceId,
      query.runId,
      query.source.runId,
      query,
      ...(historicalDigest === undefined ? [] : [historicalDigest]),
    ],
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

type QuerySourceReceiptStore = Pick<ExtensionStore, "loadExtensionTurnReceipt">;
const queryReceiptScopeFields = [
  "tenantId",
  "spaceId",
  "profileId",
  "pluginId",
  "principalId",
  "actorId",
  "idempotencyKey",
] as const;

/** Historical query evidence is separate from ordinary paid generation admission. */
export async function loadSqlitePluginQueryByReceipt(
  db: DatabaseSync,
  input: PluginTaskReceiptLocator,
  sourceReceipts: QuerySourceReceiptStore,
): Promise<PluginQueryTaskAdmission | null> {
  const locator = captureQueryReceiptLocator(input);
  const row = db
    .prepare(queryReceiptSql("").replaceAll(/\$[1-5]/gu, "?"))
    .get(...queryReceiptValues(locator));
  if (row === undefined) return null;
  const saved = parseQueryAdmissionReceipt(row, locator);
  const query = checkedQueryReceiptAdmission(
    locator,
    saved,
    loadSqlitePluginQuery(db, saved.binding),
  );
  await assertQuerySourceReceipt(query, sourceReceipts);
  const operation = db
    .prepare(
      "SELECT record_json FROM extension_external_operations WHERE tenant_id=? AND run_id=? AND binding_digest=? AND operation_id=?",
    )
    .get(
      query.source.tenantId,
      query.source.runId,
      query.source.extensionBindingDigest,
      query.operationId,
    );
  assertQueryOperationRecord(query, operation);
  return query;
}

export async function loadPostgresPluginQueryByReceipt(
  client: Pool | PoolClient,
  schema: string,
  input: PluginTaskReceiptLocator,
  sourceReceipts: QuerySourceReceiptStore,
): Promise<PluginQueryTaskAdmission | null> {
  // Caller-owned identity is captured before the first asynchronous SQL read.
  const locator = captureQueryReceiptLocator(input);
  const prefix = `${pluginInstallationSchemaName(schema)}.`;
  const result = await client.query(
    queryReceiptSql(prefix),
    queryReceiptValues(locator),
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1)
    throw new Error("plugin_query_admission_record_invalid");
  const saved = parseQueryAdmissionReceipt(result.rows[0], locator);
  const query = checkedQueryReceiptAdmission(
    locator,
    saved,
    await loadPostgresPluginQuery(client, schema, saved.binding),
  );
  await assertQuerySourceReceipt(query, sourceReceipts);
  const operation = await client.query(
    `SELECT record_json FROM ${prefix}extension_external_operations WHERE tenant_id=$1 AND run_id=$2 AND binding_digest=$3 AND operation_id=$4`,
    [
      query.source.tenantId,
      query.source.runId,
      query.source.extensionBindingDigest,
      query.operationId,
    ],
  );
  if (operation.rows.length !== 1)
    throw new Error("plugin_query_source_invalid");
  assertQueryOperationRecord(query, operation.rows[0]);
  return query;
}

function captureQueryReceiptLocator(
  input: PluginTaskReceiptLocator,
): PluginTaskReceiptLocator {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw new Error("plugin_installation_object_invalid");
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== queryReceiptScopeFields.length ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        !queryReceiptScopeFields.includes(
          key as (typeof queryReceiptScopeFields)[number],
        ),
    )
  )
    throw new Error("plugin_installation_fields_invalid");
  const fields = Object.fromEntries(
    queryReceiptScopeFields.map((name) => {
      const descriptor = Object.getOwnPropertyDescriptor(input, name);
      if (
        !descriptor ||
        !Object.hasOwn(descriptor, "value") ||
        !descriptor.enumerable
      )
        throw new Error("plugin_installation_fields_invalid");
      return [name, descriptor.value];
    }),
  );
  return Object.freeze({
    tenantId: pluginInstallationOpaqueId(fields.tenantId),
    spaceId: pluginInstallationOpaqueId(fields.spaceId),
    profileId: pluginInstallationOpaqueId(fields.profileId),
    pluginId: pluginInstallationNamespaceId(fields.pluginId),
    principalId: pluginInstallationOpaqueId(fields.principalId),
    actorId: pluginInstallationOpaqueId(fields.actorId),
    idempotencyKey: pluginInstallationOpaqueId(fields.idempotencyKey),
  });
}

const queryReceiptSql = (prefix: string) =>
  `SELECT request_digest,result_json FROM ${prefix}extension_mutation_receipts WHERE tenant_id=$1 AND space_id=$2 AND plugin_id=$3 AND kind='task' AND actor_id=$4 AND idempotency_key=$5`;
const queryReceiptValues = (locator: PluginTaskReceiptLocator) => [
  locator.tenantId,
  locator.spaceId,
  locator.pluginId,
  locator.actorId,
  locator.idempotencyKey,
];

function parseQueryAdmissionReceipt(
  row: Record<string, unknown>,
  locator: PluginTaskReceiptLocator,
) {
  const receipt = Object.freeze({
    actorId: locator.actorId,
    idempotencyKey: locator.idempotencyKey,
    requestDigest: row.request_digest as string,
  });
  validateExtensionReceipt(receipt);
  const saved = parseExtensionTurnReceipt(
    json(row.result_json),
    locator,
    receipt,
  );
  if (saved.binding.source === null || saved.creditAdmission !== undefined)
    throw new Error("plugin_query_admission_binding_mismatch");
  return { ...saved, receipt };
}

function checkedQueryReceiptAdmission(
  locator: PluginTaskReceiptLocator,
  saved: ReturnType<typeof parseQueryAdmissionReceipt>,
  query: PluginQueryTaskAdmission | null,
): PluginQueryTaskAdmission {
  if (query === null) throw new Error("plugin_query_admission_missing");
  if (
    queryReceiptScopeFields.some((name) => query[name] !== locator[name]) ||
    query.runId !== saved.binding.runId ||
    query.threadId !== saved.binding.threadId ||
    query.extensionBindingDigest !== saved.binding.bindingDigest ||
    query.requestDigest !== saved.receipt.requestDigest ||
    query.source.runId !== saved.binding.source?.runId ||
    query.source.extensionBindingDigest !==
      saved.binding.source?.bindingDigest ||
    query.operationId !== saved.binding.source?.operationId
  )
    throw new Error("plugin_query_admission_record_invalid");
  return query;
}

async function assertQuerySourceReceipt(
  query: PluginQueryTaskAdmission,
  sourceReceipts: QuerySourceReceiptStore,
): Promise<void> {
  const source = query.source;
  const receipt = {
    actorId: source.actorId,
    idempotencyKey: source.idempotencyKey,
    requestDigest: source.requestDigest,
  };
  // The actual adapter's receipt read also verifies immutable credit admission
  // and reservation records; the query itself never receives a second quote.
  const saved = await sourceReceipts.loadExtensionTurnReceipt({
    tenantId: source.tenantId,
    spaceId: source.spaceId,
    pluginId: source.pluginId,
    receipt,
  });
  if (saved === null || saved.binding.source !== null)
    throw new Error("plugin_query_source_invalid");
  assertPluginTaskFunding(
    {
      creditAdmission: saved.creditAdmission,
      unmeteredAdmission: saved.unmeteredAdmission,
      binding: saved.binding,
      receipt,
      principalId: source.principalId,
      task: source,
    },
    extensionStoreDigester,
  );
  assertPluginTaskAdmission(
    { admission: source, binding: saved.binding, receipt },
    extensionStoreDigester,
  );
}

function assertQueryOperationRecord(
  query: PluginQueryTaskAdmission,
  row: Record<string, unknown> | undefined,
): void {
  if (row === undefined) throw new Error("plugin_query_source_invalid");
  parseExternalOperationQueryRecord({
    record: json(row.record_json),
    query: {
      tenantId: query.source.tenantId,
      runId: query.source.runId,
      bindingDigest: query.source.extensionBindingDigest,
      limit: 1,
    },
    operationId: query.operationId,
  });
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
