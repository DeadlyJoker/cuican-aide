import type { DatabaseSync } from "node:sqlite";
import type { Pool, PoolClient } from "pg";
import type {
  CommitExtensionTurnInput,
  ExtensionMutationReceipt,
  ExtensionRunLocator,
  PluginTaskReceiptLocator,
} from "@crewon/application";
import {
  assertPluginTaskAdmission,
  parsePluginTaskAdmission,
  parsePluginTaskAdmissionPin,
  parseInstalledPluginPackage,
  pluginInstallationOpaqueId,
  pluginInstallationNamespaceId,
  type ExtensionRunBinding,
  type ExtensionCreditAdmission,
  type PluginTaskAdmission,
  type PluginTaskAdmissionPin,
} from "@crewon/domain";
import {
  extensionStoreDigester,
  parseExtensionTurnReceipt,
  validateExtensionReceipt,
} from "./extension-store-records.ts";
import { assertPluginTaskAdmissionSchemaVersion } from "./plugin-task-admission-schema.ts";
import { pluginInstallationSchemaName } from "./plugin-installation-schema.ts";
import {
  admitSqlitePluginInstallationPin,
  admitPostgresPluginInstallationPin,
} from "./plugin-installation-pin-store-support.ts";

type PostgresReader = Pool | PoolClient;
type Row = Record<string, unknown>;

export function capturePluginTaskTurnInput(
  input: CommitExtensionTurnInput,
  admission: PluginTaskAdmission,
): CommitExtensionTurnInput {
  const captured = structuredClone({ ...input, pluginAdmission: admission });
  // Keep provenance tied to the actual snapshot if other fields change when read.
  checkedPluginTaskAdmission(captured);
  return captured;
}

export function checkedPluginTaskAdmission(
  input: CommitExtensionTurnInput,
): PluginTaskAdmission | undefined {
  const field = Object.getOwnPropertyDescriptor(input, "pluginAdmission");
  if (field === undefined) {
    if ("pluginAdmission" in input)
      throw new Error("plugin_task_admission_record_invalid");
    return undefined;
  }
  if (!Object.hasOwn(field, "value") || !field.enumerable)
    throw new Error("plugin_task_admission_record_invalid");
  if (field.value === undefined) return undefined;
  const admission = parsePluginTaskAdmission(field.value);
  assertPluginTaskAdmission(
    { admission, binding: input.binding, receipt: input.receipt },
    extensionStoreDigester,
  );
  assertCreditPrincipal(admission, input.creditAdmission);
  if (input.binding.source !== null)
    throw new Error("plugin_task_query_admission_unsupported");
  return admission;
}

export function assertPluginTaskAdmissionReplay(input: {
  requested: PluginTaskAdmission | undefined;
  saved: PluginTaskAdmission | null;
  binding: ExtensionRunBinding;
  receipt: ExtensionMutationReceipt;
  creditAdmission: ExtensionCreditAdmission | undefined;
}): void {
  if (input.requested === undefined && input.saved === null) return;
  if (input.requested === undefined || input.saved === null)
    throw new Error("plugin_task_admission_conflict");
  assertPluginTaskAdmission(
    { admission: input.saved, binding: input.binding, receipt: input.receipt },
    extensionStoreDigester,
  );
  assertCreditPrincipal(input.saved, input.creditAdmission);
  const pin = (value: PluginTaskAdmission) =>
    parsePluginTaskAdmissionPin(
      Object.fromEntries(
        Object.entries(value).filter(
          ([key]) =>
            ![
              "schemaVersion",
              "runId",
              "threadId",
              "extensionBindingDigest",
              "requestDigest",
              "idempotencyKey",
            ].includes(key),
        ),
      ),
    );
  if (
    JSON.stringify(pin(input.saved)) !== JSON.stringify(pin(input.requested)) ||
    input.saved.threadId !== input.requested.threadId ||
    input.saved.requestDigest !== input.requested.requestDigest ||
    input.saved.idempotencyKey !== input.requested.idempotencyKey
  )
    throw new Error("plugin_task_admission_conflict");
}

function assertCreditPrincipal(
  admission: PluginTaskAdmission,
  credit: ExtensionCreditAdmission | undefined,
): void {
  if (
    credit === undefined ||
    credit.reservation.scope.tenantId !== admission.tenantId ||
    credit.reservation.scope.principalId !== admission.principalId
  )
    throw new Error("plugin_task_credit_admission_required");
}

export const admissionQuery = (
  prefix: string,
) => `SELECT a.*,b.binding_json,p.record_json AS package_json FROM ${prefix}plugin_task_admissions a
  JOIN ${prefix}extension_run_bindings b ON b.tenant_id=a.tenant_id AND b.run_id=a.run_id
  JOIN ${prefix}installed_plugin_packages p ON p.tenant_id=a.tenant_id AND p.space_id=a.space_id AND p.profile_id=a.profile_id AND p.package_digest=a.package_digest
  WHERE a.tenant_id=$1 AND a.space_id=$2 AND a.run_id=$3`;

export function admitSqlitePluginTask(
  database: DatabaseSync,
  admission: PluginTaskAdmission,
): void {
  admitSqlitePluginTaskPin(database, installationPin(admission));
}

/** Source UI-only selections do not create a second execution admission. */
export function admitSqlitePluginTaskPin(
  database: DatabaseSync,
  admission: PluginTaskAdmissionPin,
): void {
  sqliteVersion(database);
  try {
    admitSqlitePluginInstallationPin(database, admission);
  } catch (cause) {
    throw new Error("plugin_task_admission_conflict", { cause });
  }
}

/** Selection UPDATE takes the same row lock: keep this shared lock until the Run transaction commits. */
export async function admitPostgresPluginTask(
  client: PoolClient,
  schema: string,
  admission: PluginTaskAdmission,
): Promise<void> {
  await admitPostgresPluginTaskPin(client, schema, installationPin(admission));
}

export async function admitPostgresPluginTaskPin(
  client: PoolClient,
  schema: string,
  admission: PluginTaskAdmissionPin,
): Promise<void> {
  await postgresVersion(client, schema);
  try {
    await admitPostgresPluginInstallationPin(client, schema, admission);
  } catch (cause) {
    throw new Error("plugin_task_admission_conflict", { cause });
  }
}

export function saveSqlitePluginTask(
  database: DatabaseSync,
  admission: PluginTaskAdmission,
): void {
  database
    .prepare("INSERT INTO plugin_task_admissions VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(...admissionValues(admission), JSON.stringify(admission));
}
export async function savePostgresPluginTask(
  client: PoolClient,
  schema: string,
  admission: PluginTaskAdmission,
): Promise<void> {
  await client.query(
    `INSERT INTO ${prefix(schema)}plugin_task_admissions VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [...admissionValues(admission), admission],
  );
}

export function loadSqlitePluginTask(
  database: DatabaseSync,
  input: ExtensionRunLocator,
): PluginTaskAdmission | null {
  sqliteVersion(database);
  const values = locator(input);
  return decodePluginTaskAdmissionRecord(
    database
      .prepare(admissionQuery("").replaceAll(/\$[1-3]/gu, "?"))
      .get(...values),
  );
}
export async function loadPostgresPluginTask(
  client: PostgresReader,
  schema: string,
  input: ExtensionRunLocator,
): Promise<PluginTaskAdmission | null> {
  await postgresVersion(client, schema);
  const result = await client.query<Row>(
    admissionQuery(prefix(schema)),
    locator(input),
  );
  return decodePluginTaskAdmissionRecord(result.rows[0]);
}

/** One indexed receipt lookup; the saved v1 pin is evidence, never fresh admission authority. */
export function loadSqlitePluginTaskByReceipt(
  database: DatabaseSync,
  input: PluginTaskReceiptLocator,
): PluginTaskAdmission | null {
  const captured = captureReceiptLocator(input);
  const row = database
    .prepare(receiptAdmissionQuery("").replaceAll(/\$[1-5]/gu, "?"))
    .get(...receiptLocatorValues(captured)) as Row | undefined;
  if (row === undefined) return null;
  const saved = parseTaskAdmissionReceipt(row, captured);
  return checkedReceiptAdmission(
    captured,
    saved,
    loadSqlitePluginTask(database, saved.binding),
  );
}

export async function loadPostgresPluginTaskByReceipt(
  client: PostgresReader,
  schema: string,
  input: PluginTaskReceiptLocator,
): Promise<PluginTaskAdmission | null> {
  // Capture all caller-owned fields before the first asynchronous database read.
  const captured = captureReceiptLocator(input);
  const result = await client.query<Row>(
    receiptAdmissionQuery(prefix(schema)),
    receiptLocatorValues(captured),
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1)
    throw new Error("plugin_task_admission_record_invalid");
  const saved = parseTaskAdmissionReceipt(result.rows[0]!, captured);
  return checkedReceiptAdmission(
    captured,
    saved,
    await loadPostgresPluginTask(client, schema, saved.binding),
  );
}

function captureReceiptLocator(
  input: PluginTaskReceiptLocator,
): PluginTaskReceiptLocator {
  const names = [
    "tenantId",
    "spaceId",
    "profileId",
    "pluginId",
    "principalId",
    "actorId",
    "idempotencyKey",
  ] as const;
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new Error("plugin_installation_object_invalid");
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error("plugin_installation_object_invalid");
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== names.length ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        !names.includes(key as (typeof names)[number]),
    )
  )
    throw new Error("plugin_installation_fields_invalid");
  const fields = Object.fromEntries(
    names.map((name) => {
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
const receiptAdmissionQuery = (prefix: string) =>
  `SELECT request_digest,result_json FROM ${prefix}extension_mutation_receipts WHERE tenant_id=$1 AND space_id=$2 AND plugin_id=$3 AND kind='task' AND actor_id=$4 AND idempotency_key=$5`;
const receiptLocatorValues = (input: PluginTaskReceiptLocator) => [
  input.tenantId,
  input.spaceId,
  input.pluginId,
  input.actorId,
  input.idempotencyKey,
];
function parseTaskAdmissionReceipt(row: Row, input: PluginTaskReceiptLocator) {
  const receipt = Object.freeze({
    actorId: input.actorId,
    idempotencyKey: input.idempotencyKey,
    requestDigest: row.request_digest as string,
  });
  validateExtensionReceipt(receipt);
  const saved = parseExtensionTurnReceipt(
    json(row.result_json),
    input,
    receipt,
  );
  if (saved.binding.source !== null)
    throw new Error("plugin_task_query_admission_unsupported");
  return { ...saved, receipt };
}
function checkedReceiptAdmission(
  input: PluginTaskReceiptLocator,
  saved: ReturnType<typeof parseTaskAdmissionReceipt>,
  admission: PluginTaskAdmission | null,
): PluginTaskAdmission {
  if (admission === null) throw new Error("plugin_task_admission_missing");
  if (
    [
      "tenantId",
      "spaceId",
      "profileId",
      "pluginId",
      "principalId",
      "actorId",
      "idempotencyKey",
    ].some(
      (key) =>
        admission[key as keyof PluginTaskReceiptLocator] !==
        input[key as keyof PluginTaskReceiptLocator],
    )
  )
    throw new Error("plugin_task_admission_record_invalid");
  assertPluginTaskAdmission(
    { admission, binding: saved.binding, receipt: saved.receipt },
    extensionStoreDigester,
  );
  assertCreditPrincipal(admission, saved.creditAdmission);
  return admission;
}

export function decodePluginTaskAdmissionRecord(
  row: Row | undefined,
): PluginTaskAdmission | null {
  if (row === undefined) return null;
  const admission = parsePluginTaskAdmission(json(row.admission_json));
  // The v0 digest validator lives in the domain, so a corrupt historical binding cannot appear valid.
  const binding = json(row.binding_json) as ExtensionRunBinding;
  assertPluginTaskAdmission(
    {
      admission,
      binding,
      receipt: {
        actorId: admission.actorId,
        idempotencyKey: admission.idempotencyKey,
        requestDigest: admission.requestDigest,
      },
    },
    extensionStoreDigester,
  );
  const pkg = parseInstalledPluginPackage(json(row.package_json));
  const columns = {
    tenantId: "tenant_id",
    spaceId: "space_id",
    profileId: "profile_id",
    pluginId: "plugin_id",
    principalId: "principal_id",
    actorId: "actor_id",
    runId: "run_id",
    packageDigest: "package_digest",
    selectionRevision: "selection_revision",
    extensionBindingDigest: "extension_binding_digest",
  } as const;
  if (
    Object.entries(columns).some(
      ([key, column]) =>
        String(admission[key as keyof typeof columns]) !== String(row[column]),
    ) ||
    pkg.tenantId !== admission.tenantId ||
    pkg.spaceId !== admission.spaceId ||
    pkg.profileId !== admission.profileId ||
    pkg.pluginId !== admission.pluginId ||
    pkg.publisherId !== admission.publisherId ||
    pkg.version !== admission.version ||
    pkg.packageDigest !== admission.packageDigest
  )
    throw new Error("plugin_task_admission_record_invalid");
  return admission;
}

function sqliteVersion(database: DatabaseSync): void {
  assertPluginTaskAdmissionSchemaVersion(
    database
      .prepare(
        "SELECT id,version FROM plugin_task_admission_schema_version LIMIT 2",
      )
      .all() as { id: unknown; version: unknown }[],
  );
}
async function postgresVersion(
  client: PostgresReader,
  schema: string,
): Promise<void> {
  assertPluginTaskAdmissionSchemaVersion(
    (
      await client.query<{ id: unknown; version: unknown }>(
        `SELECT id,version FROM ${prefix(schema)}plugin_task_admission_schema_version LIMIT 2`,
      )
    ).rows,
  );
}
function json(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}
function prefix(schema: string): string {
  return `${pluginInstallationSchemaName(schema)}.`;
}
function scope(value: PluginTaskAdmissionPin): [string, string, string] {
  return [value.tenantId, value.spaceId, value.profileId];
}
function locator(value: ExtensionRunLocator): [string, string, string] {
  return [
    pluginInstallationOpaqueId(value.tenantId),
    pluginInstallationOpaqueId(value.spaceId),
    pluginInstallationOpaqueId(value.runId),
  ];
}
function admissionValues(
  value: PluginTaskAdmission,
): [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
] {
  return [
    ...scope(value),
    value.pluginId,
    value.principalId,
    value.actorId,
    value.runId,
    value.packageDigest,
    value.selectionRevision,
    value.extensionBindingDigest,
  ];
}

function installationPin(
  admission: PluginTaskAdmission,
): PluginTaskAdmissionPin {
  const {
    schemaVersion: _schema,
    runId: _run,
    threadId: _thread,
    extensionBindingDigest: _binding,
    requestDigest: _request,
    idempotencyKey: _key,
    ...pin
  } = parsePluginTaskAdmission(admission);
  return parsePluginTaskAdmissionPin(pin);
}
