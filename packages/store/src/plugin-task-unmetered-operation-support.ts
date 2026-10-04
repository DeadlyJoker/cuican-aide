import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import type { ExternalOperation } from "@crewon/application";
import {
  assertPluginTaskFunding,
  extensionCanonicalJson,
  parsePluginTaskAdmission,
} from "@crewon/domain";
import {
  extensionStoreDigester,
  parseExtensionTurnReceipt,
} from "./extension-store-records.ts";
import { pluginInstallationSchemaName } from "./plugin-installation-schema.ts";
import {
  verifySqliteUnmeteredReceipt,
  verifyPostgresUnmeteredReceipt,
} from "./plugin-task-unmetered-store-support.ts";

const json = (value: unknown): unknown =>
  typeof value === "string" ? JSON.parse(value) : value;
const taskSql = (prefix: string) =>
  `SELECT admission_json FROM ${prefix}plugin_task_admissions WHERE tenant_id=$1 AND run_id=$2`;
const receiptSql = (prefix: string) =>
  `SELECT request_digest,result_json FROM ${prefix}extension_mutation_receipts WHERE tenant_id=$1 AND space_id=$2 AND plugin_id=$3 AND kind='task' AND actor_id=$4 AND idempotency_key=$5`;
function task(
  row: Record<string, unknown> | undefined,
  operation: ExternalOperation,
) {
  if (row === undefined) return null;
  const admission = parsePluginTaskAdmission(json(row.admission_json));
  if (
    admission.tenantId !== operation.tenantId ||
    admission.runId !== operation.runId ||
    admission.extensionBindingDigest !== operation.bindingDigest
  )
    throw new Error("plugin_task_unmetered_dispatch_invalid");
  return admission;
}
function unmeteredReceipt(
  row: Record<string, unknown> | undefined,
  admission: NonNullable<ReturnType<typeof task>>,
) {
  if (row === undefined || row.request_digest !== admission.requestDigest)
    throw new Error("plugin_task_unmetered_dispatch_invalid");
  const value = json(row.result_json) as {
    creditAdmission?: unknown;
    unmeteredAdmission?: unknown;
  };
  // The original paid dispatch checker still owns all reservation and balance checks.
  if (
    value.creditAdmission !== undefined &&
    value.unmeteredAdmission === undefined
  )
    return null;
  const receipt = {
    actorId: admission.actorId,
    idempotencyKey: admission.idempotencyKey,
    requestDigest: admission.requestDigest,
  };
  const saved = parseExtensionTurnReceipt(value, admission, receipt);
  assertPluginTaskFunding(
    { ...saved, receipt, principalId: admission.principalId, task: admission },
    extensionStoreDigester,
  );
  if (
    extensionCanonicalJson(saved.unmeteredAdmission?.task) !==
    extensionCanonicalJson(admission)
  )
    throw new Error("plugin_task_unmetered_dispatch_invalid");
  return saved;
}
const receiptValues = (admission: NonNullable<ReturnType<typeof task>>) => [
  admission.tenantId,
  admission.spaceId,
  admission.pluginId,
  admission.actorId,
  admission.idempotencyKey,
];
/** The operation write transaction cannot turn lost unmetered provenance into a legacy dispatch. */
export function assertSqliteUnmeteredDispatch(
  database: DatabaseSync,
  operation: ExternalOperation,
): void {
  if (
    database
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE name='plugin_task_admissions'",
      )
      .get() === undefined
  )
    return;
  const admission = task(
    database
      .prepare(taskSql("").replaceAll(/\$[1-2]/gu, "?"))
      .get(operation.tenantId, operation.runId) as
      | Record<string, unknown>
      | undefined,
    operation,
  );
  if (admission === null) return;
  const saved = unmeteredReceipt(
    database
      .prepare(receiptSql("").replaceAll(/\$[1-5]/gu, "?"))
      .get(...receiptValues(admission)) as Record<string, unknown> | undefined,
    admission,
  );
  if (saved !== null) verifySqliteUnmeteredReceipt(database, saved);
}
export async function assertPostgresUnmeteredDispatch(
  client: PoolClient,
  schema: string,
  operation: ExternalOperation,
): Promise<void> {
  const exists = await client.query(
    "SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='plugin_task_admissions'",
    [schema],
  );
  if (exists.rows.length === 0) return;
  const prefix = `${pluginInstallationSchemaName(schema)}.`;
  const admission = task(
    (await client.query(taskSql(prefix), [operation.tenantId, operation.runId]))
      .rows[0],
    operation,
  );
  if (admission === null) return;
  const saved = unmeteredReceipt(
    (await client.query(receiptSql(prefix), receiptValues(admission))).rows[0],
    admission,
  );
  if (saved !== null)
    await verifyPostgresUnmeteredReceipt(client, schema, saved);
}
