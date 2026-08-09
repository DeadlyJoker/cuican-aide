import {
  RunStoreError,
  type AbortModelProviderSettingsInput,
  type AbortModelProviderSettingsResult,
  type FinalizeModelProviderSettingsInput,
  type FinalizeModelProviderSettingsResult,
  type ExpireModelProviderSettingsInput,
  type ExpireModelProviderSettingsResult,
  type ModelProviderSettingsCatalog,
  type ModelProviderSettingsState,
  type PendingModelProviderSettings,
  type PrepareModelProviderSettingsInput,
  type PrepareModelProviderSettingsResult,
} from "@crewon/application";
import type { Pool, PoolClient, QueryResult } from "pg";

import {
  parseAbortModelProviderSettingsReceipt,
  parseFinalizeModelProviderSettingsReceipt,
  parseExpireModelProviderSettingsReceipt,
  parsePrepareModelProviderSettingsReceipt,
  parseStoredModelProviderSettings,
  parseStoredModelProviderSettingsOperation,
  parseStoredPendingModelProviderSettings,
  modelProviderSettingsOperation,
  providerSettingsReceiptEnvelope,
  validateAbortedModelProviderSettingsOperation,
  validateAbortModelProviderSettingsInput,
  validateFinalizedModelProviderSettingsOperation,
  validateFinalizeModelProviderSettingsInput,
  validateExpireModelProviderSettingsInput,
  validatePrepareModelProviderSettingsInput,
  validateStoredTerminalModelProviderSettingsOperation,
} from "./model-provider-settings-store-support.ts";
import { stableJson } from "./store-invariants.ts";

type Queryable = Pick<Pool | PoolClient, "query">;

type OperationRow = Readonly<{
  operation_id: string;
  coordinator_binding: string;
  base_revision: string | number;
  operation_json: unknown;
  status: "pending" | "finalized" | "aborted" | "expired";
  prepared_at: string | Date;
  expires_at: string | Date;
  terminal_binding: string | null;
  completed_at: string | Date | null;
  result_json: unknown | null;
}>;

type CatalogRow = Readonly<{
  revision: string | number | null;
  active_provider_id: string | null;
  catalog_json: unknown | null;
  updated_at: string | Date | null;
}>;

type LatestFinalizedRow = Readonly<{
  latest_operation_id: string | null;
  latest_coordinator_binding: string | null;
  latest_base_revision: string | number | null;
  latest_operation_json: unknown | null;
  latest_prepared_at: string | Date | null;
  latest_expires_at: string | Date | null;
  latest_terminal_binding: string | null;
  latest_completed_at: string | Date | null;
  latest_result_json: unknown | null;
}>;

export async function loadPostgresModelProviderSettingsState(
  queryable: Queryable,
  schema: string,
  tenantId: string,
): Promise<ModelProviderSettingsState> {
  const result = await queryable.query<
    OperationRow & CatalogRow & LatestFinalizedRow
  >(
    `SELECT settings.revision, settings.active_provider_id,
            settings.catalog_json, settings.updated_at,
            operations.operation_id, operations.coordinator_binding,
            operations.base_revision, operations.operation_json,
            operations.status, operations.prepared_at, operations.expires_at,
            operations.terminal_binding, operations.completed_at,
            operations.result_json,
            latest.operation_id AS latest_operation_id,
            latest.coordinator_binding AS latest_coordinator_binding,
            latest.base_revision AS latest_base_revision,
            latest.operation_json AS latest_operation_json,
            latest.prepared_at AS latest_prepared_at,
            latest.expires_at AS latest_expires_at,
            latest.terminal_binding AS latest_terminal_binding,
            latest.completed_at AS latest_completed_at,
            latest.result_json AS latest_result_json
     FROM (SELECT $1::text AS tenant_id) AS requested
     LEFT JOIN ${schema}.model_provider_settings AS settings
       ON settings.tenant_id = requested.tenant_id
     LEFT JOIN ${schema}.model_provider_settings_operations AS operations
       ON operations.tenant_id = requested.tenant_id
      AND operations.status = 'pending'
     LEFT JOIN LATERAL (
       SELECT * FROM ${schema}.model_provider_settings_operations
       WHERE tenant_id = requested.tenant_id AND status = 'finalized'
       ORDER BY base_revision DESC
       LIMIT 1
     ) AS latest ON TRUE`,
    [tenantId],
  );
  const row = result.rows[0];
  const catalog = decodeCatalogRow(row, tenantId);
  const operation =
    row?.operation_id == null ? null : decodeOperationRow(row, tenantId);
  if (
    operation !== null &&
    stableJson(operation.baseCatalog) !== stableJson(catalog)
  ) {
    throw new RunStoreError("model_provider_settings_stored_state_invalid");
  }
  const latest = decodeLatestFinalizedRow(row, tenantId);
  if (
    (catalog === null) !== (latest === null) ||
    (latest !== null && stableJson(latest) !== stableJson(catalog))
  ) {
    throw new RunStoreError("model_provider_settings_stored_state_invalid");
  }
  return { catalog, pending: operation?.pending ?? null };
}

function decodeLatestFinalizedRow(
  row: LatestFinalizedRow | undefined,
  tenantId: string,
): ModelProviderSettingsCatalog | null {
  if (row?.latest_operation_id == null) return null;
  if (
    row.latest_coordinator_binding === null ||
    row.latest_base_revision === null ||
    row.latest_operation_json === null ||
    row.latest_prepared_at === null ||
    row.latest_expires_at === null ||
    row.latest_completed_at === null ||
    row.latest_result_json === null
  ) {
    throw new RunStoreError("model_provider_settings_stored_state_invalid");
  }
  const operationRow: OperationRow = {
    operation_id: row.latest_operation_id,
    coordinator_binding: row.latest_coordinator_binding,
    base_revision: row.latest_base_revision,
    operation_json: row.latest_operation_json,
    status: "finalized",
    prepared_at: row.latest_prepared_at,
    expires_at: row.latest_expires_at,
    terminal_binding: row.latest_terminal_binding,
    completed_at: row.latest_completed_at,
    result_json: row.latest_result_json,
  };
  const operation = decodeOperationRow(operationRow, tenantId);
  return validateStoredTerminalModelProviderSettingsOperation({
    operation,
    status: "finalized",
    terminalBinding: operationRow.terminal_binding,
    completedAt: timestamp(row.latest_completed_at),
    resultEnvelope: operationRow.result_json,
  });
}

export async function preparePostgresModelProviderSettings(
  client: PoolClient,
  schema: string,
  input: PrepareModelProviderSettingsInput,
): Promise<PrepareModelProviderSettingsResult> {
  const normalized = validatePrepareModelProviderSettingsInput(input);
  await lockProviderSettingsReceipt(client, schema, normalized, "prepare");
  const replay = await loadReceipt(client, schema, normalized, "prepare");
  if (replay !== undefined) {
    const pending = parsePrepareModelProviderSettingsReceipt(
      replay,
      normalized,
    );
    const operation = await requireOperationAny(client, schema, normalized);
    if (stableJson(operation.pending) !== stableJson(pending)) {
      throw new RunStoreError("model_provider_settings_stored_state_invalid");
    }
    return {
      disposition: "replayed",
      pending,
    };
  }
  await lockProviderSettingsTenant(client, schema, normalized.tenantId);
  const pendingResult = await loadPendingOperationRow(
    client,
    schema,
    normalized.tenantId,
    true,
  );
  if (pendingResult !== undefined) {
    throw new RunStoreError("model_provider_settings_pending");
  }
  const activeRun = await client.query(
    `SELECT 1 FROM ${schema}.run_snapshots
     WHERE tenant_id = $1
       AND COALESCE(state_json->>'status', '')
         NOT IN ('completed', 'failed', 'canceled')
     LIMIT 1`,
    [normalized.tenantId],
  );
  if (activeRun.rowCount !== 0) {
    throw new RunStoreError("model_provider_settings_active_run");
  }
  const baseCatalog = await loadProviderHeadAuthority(
    client,
    schema,
    normalized.tenantId,
  );
  const currentRevision = baseCatalog?.revision ?? 0;
  if (currentRevision !== normalized.expectedRevision) {
    throw new RunStoreError("model_provider_settings_revision_conflict");
  }
  if (
    normalized.activeProviderId !== null &&
    baseCatalog?.runtimeBindingId === normalized.coordinatorBinding
  ) {
    throw new RunStoreError("model_provider_settings_operation_mismatch");
  }
  const preparedAt = await databaseNow(client);
  const expiresAt = new Date(
    Date.parse(preparedAt) + normalized.ttlMs,
  ).toISOString();
  const pending: PendingModelProviderSettings = {
    tenantId: normalized.tenantId,
    operationId: normalized.operationId,
    coordinatorBinding: normalized.coordinatorBinding,
    baseRevision: normalized.expectedRevision,
    activeProviderId: normalized.activeProviderId,
    runtimeBindingId:
      normalized.activeProviderId === null
        ? null
        : normalized.coordinatorBinding,
    bindings: structuredClone(normalized.bindings),
    preparedAt,
    expiresAt,
  };
  await client.query(
    `INSERT INTO ${schema}.model_provider_settings_operations (
       tenant_id, operation_id, coordinator_binding, base_revision,
       operation_json, status, prepared_at, expires_at, terminal_binding,
       completed_at, result_json
     ) VALUES ($1, $2, $3, $4, $5::jsonb, 'pending',
               $6::timestamptz, $7::timestamptz, NULL, NULL, NULL)`,
    [
      normalized.tenantId,
      normalized.operationId,
      normalized.coordinatorBinding,
      normalized.expectedRevision,
      stableJson(
        modelProviderSettingsOperation(pending, baseCatalog, normalized.actor),
      ),
      preparedAt,
      expiresAt,
    ],
  );
  await insertReceipt(
    client,
    schema,
    normalized,
    "prepare",
    providerSettingsReceiptEnvelope(
      "prepare",
      normalized.operationId,
      normalized.coordinatorBinding,
      pending,
      null,
      normalized.actor,
    ),
  );
  return { disposition: "prepared", pending };
}

export async function finalizePostgresModelProviderSettings(
  client: PoolClient,
  schema: string,
  input: FinalizeModelProviderSettingsInput,
): Promise<FinalizeModelProviderSettingsResult> {
  const normalized = validateFinalizeModelProviderSettingsInput(input);
  await lockProviderSettingsReceipt(client, schema, normalized, "finalize");
  const replay = await loadReceipt(client, schema, normalized, "finalize");
  if (replay !== undefined) {
    const catalog = parseFinalizeModelProviderSettingsReceipt(
      replay,
      normalized,
    );
    const operation = await requireOperation(
      client,
      schema,
      normalized,
      "finalized",
      replay,
    );
    validateFinalizedModelProviderSettingsOperation(operation, catalog);
    return {
      disposition: "replayed",
      catalog,
    };
  }
  await lockProviderSettingsTenant(client, schema, normalized.tenantId);
  const operation = await requireOperation(
    client,
    schema,
    normalized,
    "pending",
  );
  const { pending } = operation;
  const finalizedAt = await databaseNow(client);
  if (Date.parse(finalizedAt) < Date.parse(pending.preparedAt)) {
    throw new RunStoreError("model_provider_settings_operation_time_invalid");
  }
  if (Date.parse(finalizedAt) > Date.parse(pending.expiresAt)) {
    throw new RunStoreError("model_provider_settings_operation_expired");
  }
  const currentCatalog = await loadProviderHeadAuthority(
    client,
    schema,
    normalized.tenantId,
  );
  if (
    (currentCatalog?.revision ?? 0) !== pending.baseRevision ||
    stableJson(currentCatalog) !== stableJson(operation.baseCatalog)
  ) {
    throw new RunStoreError("model_provider_settings_revision_conflict");
  }
  const catalog: ModelProviderSettingsCatalog = {
    tenantId: normalized.tenantId,
    revision: pending.baseRevision + 1,
    activeProviderId: pending.activeProviderId,
    runtimeBindingId: pending.runtimeBindingId,
    bindings: structuredClone(pending.bindings),
    updatedAt: finalizedAt,
  };
  await client.query(
    `INSERT INTO ${schema}.model_provider_settings (
       tenant_id, revision, active_provider_id, catalog_json, updated_at
     ) VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz)
     ON CONFLICT(tenant_id) DO UPDATE SET
       revision = excluded.revision,
       active_provider_id = excluded.active_provider_id,
       catalog_json = excluded.catalog_json,
       updated_at = excluded.updated_at`,
    [
      normalized.tenantId,
      catalog.revision,
      catalog.activeProviderId,
      stableJson(catalog),
      catalog.updatedAt,
    ],
  );
  const envelope = providerSettingsReceiptEnvelope(
    "finalize",
    normalized.operationId,
    normalized.coordinatorBinding,
    catalog,
    finalizedAt,
    normalized.actor,
  );
  await completeOperation(
    client,
    schema,
    normalized,
    "finalized",
    finalizedAt,
    envelope,
  );
  await insertReceipt(client, schema, normalized, "finalize", envelope);
  return { disposition: "finalized", catalog };
}

export async function abortPostgresModelProviderSettings(
  client: PoolClient,
  schema: string,
  input: AbortModelProviderSettingsInput,
): Promise<AbortModelProviderSettingsResult> {
  const normalized = validateAbortModelProviderSettingsInput(input);
  await lockProviderSettingsReceipt(client, schema, normalized, "abort");
  const replay = await loadReceipt(client, schema, normalized, "abort");
  if (replay !== undefined) {
    const catalog = parseAbortModelProviderSettingsReceipt(replay, normalized);
    const operation = await requireOperation(
      client,
      schema,
      normalized,
      "aborted",
      replay,
    );
    validateAbortedModelProviderSettingsOperation(operation, catalog);
    return {
      disposition: "replayed",
      catalog,
    };
  }
  await lockProviderSettingsTenant(client, schema, normalized.tenantId);
  const operation = await requireOperation(
    client,
    schema,
    normalized,
    "pending",
  );
  const abortedAt = await databaseNow(client);
  if (Date.parse(abortedAt) < Date.parse(operation.pending.preparedAt)) {
    throw new RunStoreError("model_provider_settings_operation_time_invalid");
  }
  const catalog = await loadProviderHeadAuthority(
    client,
    schema,
    normalized.tenantId,
  );
  validateAbortedModelProviderSettingsOperation(operation, catalog);
  const envelope = providerSettingsReceiptEnvelope(
    "abort",
    normalized.operationId,
    normalized.coordinatorBinding,
    catalog,
    abortedAt,
    normalized.actor,
  );
  await completeOperation(
    client,
    schema,
    normalized,
    "aborted",
    abortedAt,
    envelope,
  );
  await insertReceipt(client, schema, normalized, "abort", envelope);
  return { disposition: "aborted", catalog };
}

export async function expirePostgresModelProviderSettings(
  client: PoolClient,
  schema: string,
  input: ExpireModelProviderSettingsInput,
): Promise<ExpireModelProviderSettingsResult> {
  const normalized = validateExpireModelProviderSettingsInput(input);
  await lockProviderSettingsReceipt(client, schema, normalized, "expire");
  const replay = await loadReceipt(client, schema, normalized, "expire");
  if (replay !== undefined) {
    const catalog = parseExpireModelProviderSettingsReceipt(replay, normalized);
    const operation = await requireRecoveryOperation(
      client,
      schema,
      normalized,
      "expired",
      replay,
    );
    validateAbortedModelProviderSettingsOperation(operation, catalog);
    return { disposition: "replayed", catalog };
  }
  await lockProviderSettingsTenant(client, schema, normalized.tenantId);
  const operation = await requireRecoveryOperation(
    client,
    schema,
    normalized,
    "pending",
  );
  const expiredAt = await databaseNow(client);
  if (Date.parse(expiredAt) <= Date.parse(operation.pending.expiresAt)) {
    throw new RunStoreError("model_provider_settings_operation_not_expired");
  }
  const catalog = await loadProviderHeadAuthority(
    client,
    schema,
    normalized.tenantId,
  );
  validateAbortedModelProviderSettingsOperation(operation, catalog);
  const envelope = providerSettingsReceiptEnvelope(
    "expire",
    normalized.operationId,
    normalized.recoveryBinding,
    catalog,
    expiredAt,
    normalized.actor,
  );
  await completeRecoveryOperation(
    client,
    schema,
    normalized,
    expiredAt,
    envelope,
  );
  await insertReceipt(client, schema, normalized, "expire", envelope);
  return { disposition: "expired", catalog };
}

/** Serializes a new Run admission with Provider prepare for one tenant. */
export async function assertPostgresProviderSettingsAdmissionOpen(
  client: PoolClient,
  schema: string,
  tenantId: string,
): Promise<void> {
  await lockProviderSettingsTenant(client, schema, tenantId);
  const relation = await client.query<{ relation: string | null }>(
    "SELECT to_regclass($1) AS relation",
    [`${schema}.model_provider_settings_operations`],
  );
  if (relation.rows[0]?.relation == null) return;
  const pending = await client.query(
    `SELECT 1 FROM ${schema}.model_provider_settings_operations
     WHERE tenant_id = $1 AND status = 'pending' LIMIT 1`,
    [tenantId],
  );
  if (pending.rowCount !== 0) {
    throw new RunStoreError("model_provider_settings_switch_pending");
  }
}

async function lockProviderSettingsTenant(
  client: PoolClient,
  schema: string,
  tenantId: string,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `provider-settings:${schema}:${tenantId}`,
  ]);
}

async function lockProviderSettingsReceipt(
  client: PoolClient,
  schema: string,
  input: { tenantId: string; idempotencyKey: string },
  phase: "prepare" | "finalize" | "abort" | "expire",
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `provider-settings-receipt:${schema}:${input.tenantId}:${phase}:${input.idempotencyKey}`,
  ]);
}

async function loadCatalogAuthority(
  queryable: Queryable,
  schema: string,
  tenantId: string,
): Promise<ModelProviderSettingsCatalog | null> {
  const result = await queryable.query<CatalogRow>(
    `SELECT revision, active_provider_id, catalog_json, updated_at
     FROM ${schema}.model_provider_settings WHERE tenant_id=$1`,
    [tenantId],
  );
  return decodeCatalogRow(result.rows[0], tenantId);
}

async function loadProviderHeadAuthority(
  queryable: Queryable,
  schema: string,
  tenantId: string,
): Promise<ModelProviderSettingsCatalog | null> {
  const catalog = await loadCatalogAuthority(queryable, schema, tenantId);
  const latestResult = await queryable.query<OperationRow>(
    `SELECT operation_id, coordinator_binding, base_revision, operation_json,
            status, prepared_at, expires_at, terminal_binding,
            completed_at, result_json
     FROM ${schema}.model_provider_settings_operations
     WHERE tenant_id=$1 AND status='finalized'
     ORDER BY base_revision DESC LIMIT 1`,
    [tenantId],
  );
  const row = latestResult.rows[0];
  const latest =
    row === undefined
      ? null
      : validateStoredTerminalModelProviderSettingsOperation({
          operation: decodeOperationRow(row, tenantId),
          status: "finalized",
          terminalBinding: row.terminal_binding,
          completedAt:
            row.completed_at === null ? null : timestamp(row.completed_at),
          resultEnvelope: row.result_json,
        });
  if (
    (catalog === null) !== (latest === null) ||
    stableJson(catalog) !== stableJson(latest)
  ) {
    throw new RunStoreError("model_provider_settings_stored_state_invalid");
  }
  return catalog;
}

function decodeCatalogRow(
  row: CatalogRow | undefined,
  tenantId: string,
): ModelProviderSettingsCatalog | null {
  if (row?.catalog_json == null) return null;
  const catalog = parseStoredModelProviderSettings(row.catalog_json, tenantId);
  if (
    Number(row.revision) !== catalog.revision ||
    row.active_provider_id !== catalog.activeProviderId ||
    row.updated_at === null ||
    timestamp(row.updated_at) !== catalog.updatedAt
  ) {
    throw new RunStoreError("model_provider_settings_stored_state_invalid");
  }
  return catalog;
}

async function loadPendingOperationRow(
  queryable: Queryable,
  schema: string,
  tenantId: string,
  forUpdate: boolean,
): Promise<OperationRow | undefined> {
  const result = await queryable.query<OperationRow>(
    `SELECT operation_id, coordinator_binding, base_revision, operation_json,
            status, prepared_at, expires_at, terminal_binding,
            completed_at, result_json
     FROM ${schema}.model_provider_settings_operations
     WHERE tenant_id = $1 AND status = 'pending'${forUpdate ? " FOR UPDATE" : ""}`,
    [tenantId],
  );
  return result.rows[0];
}

async function loadOperationRow(
  queryable: Queryable,
  schema: string,
  tenantId: string,
  operationId: string,
  forUpdate: boolean,
): Promise<OperationRow | undefined> {
  const result = await queryable.query<OperationRow>(
    `SELECT operation_id, coordinator_binding, base_revision, operation_json,
            status, prepared_at, expires_at, terminal_binding,
            completed_at, result_json
     FROM ${schema}.model_provider_settings_operations
     WHERE tenant_id = $1 AND operation_id = $2${forUpdate ? " FOR UPDATE" : ""}`,
    [tenantId, operationId],
  );
  return result.rows[0];
}

function decodeOperationRow(
  row: OperationRow,
  tenantId: string,
): ReturnType<typeof parseStoredModelProviderSettingsOperation> {
  const operation = parseStoredModelProviderSettingsOperation(
    row.operation_json,
    tenantId,
  );
  const { pending } = operation;
  const completedAt =
    row.completed_at === null ? null : timestamp(row.completed_at);
  const terminalResult = row.result_json as Record<string, unknown> | null;
  if (
    pending.operationId !== row.operation_id ||
    pending.coordinatorBinding !== row.coordinator_binding ||
    pending.baseRevision !== Number(row.base_revision) ||
    pending.preparedAt !== timestamp(row.prepared_at) ||
    pending.expiresAt !== timestamp(row.expires_at) ||
    (row.status === "pending") !==
      (row.terminal_binding === null &&
        row.completed_at === null &&
        row.result_json === null) ||
    (row.status !== "pending") !==
      (row.terminal_binding !== null &&
        row.completed_at !== null &&
        row.result_json !== null) ||
    (completedAt !== null &&
      (!completedAt.endsWith("Z") ||
        !Number.isFinite(Date.parse(completedAt)))) ||
    (row.status === "finalized" &&
      (typeof terminalResult?.value !== "object" ||
        terminalResult.value === null ||
        !("updatedAt" in terminalResult.value) ||
        terminalResult.value.updatedAt !== completedAt)) ||
    (completedAt !== null &&
      Date.parse(completedAt) < Date.parse(pending.preparedAt))
  ) {
    throw new RunStoreError("model_provider_settings_stored_state_invalid");
  }
  if (row.status !== "pending") {
    validateStoredTerminalModelProviderSettingsOperation({
      operation,
      status: row.status,
      terminalBinding: row.terminal_binding,
      completedAt,
      resultEnvelope: terminalResult,
    });
  }
  return operation;
}

async function requireOperation(
  client: PoolClient,
  schema: string,
  input: { tenantId: string; operationId: string; coordinatorBinding: string },
  status: OperationRow["status"],
  expectedResult?: unknown,
): Promise<ReturnType<typeof parseStoredModelProviderSettingsOperation>> {
  const row = await loadOperationRow(
    client,
    schema,
    input.tenantId,
    input.operationId,
    true,
  );
  if (
    row === undefined ||
    row.operation_id !== input.operationId ||
    row.coordinator_binding !== input.coordinatorBinding ||
    row.status !== status
  ) {
    throw new RunStoreError("model_provider_settings_operation_mismatch");
  }
  if (
    expectedResult !== undefined &&
    stableJson(row.result_json) !== stableJson(expectedResult)
  ) {
    throw new RunStoreError("model_provider_settings_stored_state_invalid");
  }
  return decodeOperationRow(row, input.tenantId);
}

async function requireOperationAny(
  client: PoolClient,
  schema: string,
  input: { tenantId: string; operationId: string; coordinatorBinding: string },
): Promise<ReturnType<typeof parseStoredModelProviderSettingsOperation>> {
  const row = await loadOperationRow(
    client,
    schema,
    input.tenantId,
    input.operationId,
    true,
  );
  if (
    row === undefined ||
    row.coordinator_binding !== input.coordinatorBinding
  ) {
    throw new RunStoreError("model_provider_settings_stored_state_invalid");
  }
  return decodeOperationRow(row, input.tenantId);
}

async function requireRecoveryOperation(
  client: PoolClient,
  schema: string,
  input: { tenantId: string; operationId: string; recoveryBinding: string },
  status: "pending" | "expired",
  expectedResult?: unknown,
): Promise<ReturnType<typeof parseStoredModelProviderSettingsOperation>> {
  const row = await loadOperationRow(
    client,
    schema,
    input.tenantId,
    input.operationId,
    true,
  );
  if (
    row === undefined ||
    row.status !== status ||
    (status === "expired" && row.terminal_binding !== input.recoveryBinding)
  ) {
    throw new RunStoreError("model_provider_settings_operation_mismatch");
  }
  if (
    expectedResult !== undefined &&
    stableJson(row.result_json) !== stableJson(expectedResult)
  ) {
    throw new RunStoreError("model_provider_settings_stored_state_invalid");
  }
  return decodeOperationRow(row, input.tenantId);
}

async function completeOperation(
  client: PoolClient,
  schema: string,
  input: { tenantId: string; operationId: string; coordinatorBinding: string },
  status: "finalized" | "aborted",
  completedAt: string,
  result: unknown,
): Promise<void> {
  const updated = await client.query(
    `UPDATE ${schema}.model_provider_settings_operations
     SET status=$1, terminal_binding=$2, completed_at=$3::timestamptz,
         result_json=$4::jsonb
     WHERE tenant_id=$5 AND operation_id=$6
       AND coordinator_binding=$7 AND status='pending'`,
    [
      status,
      input.coordinatorBinding,
      completedAt,
      stableJson(result),
      input.tenantId,
      input.operationId,
      input.coordinatorBinding,
    ],
  );
  if (updated.rowCount !== 1) {
    throw new RunStoreError("model_provider_settings_operation_mismatch");
  }
}

async function completeRecoveryOperation(
  client: PoolClient,
  schema: string,
  input: { tenantId: string; operationId: string; recoveryBinding: string },
  completedAt: string,
  result: unknown,
): Promise<void> {
  const updated = await client.query(
    `UPDATE ${schema}.model_provider_settings_operations
     SET status='expired', terminal_binding=$1, completed_at=$2::timestamptz,
         result_json=$3::jsonb
     WHERE tenant_id=$4 AND operation_id=$5 AND status='pending'`,
    [
      input.recoveryBinding,
      completedAt,
      stableJson(result),
      input.tenantId,
      input.operationId,
    ],
  );
  if (updated.rowCount !== 1) {
    throw new RunStoreError("model_provider_settings_operation_mismatch");
  }
}

async function loadReceipt(
  client: PoolClient,
  schema: string,
  input: { tenantId: string; idempotencyKey: string; fingerprint: string },
  phase: "prepare" | "finalize" | "abort" | "expire",
): Promise<unknown | undefined> {
  const result = await client.query<{
    fingerprint: string;
    result_json: unknown;
  }>(
    `SELECT fingerprint, result_json
     FROM ${schema}.model_provider_settings_receipts
     WHERE tenant_id=$1 AND phase=$2 AND idempotency_key=$3`,
    [input.tenantId, phase, input.idempotencyKey],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  if (row.fingerprint !== input.fingerprint) {
    throw new RunStoreError("model_provider_settings_idempotency_conflict");
  }
  return row.result_json;
}

async function insertReceipt(
  client: PoolClient,
  schema: string,
  input: { tenantId: string; idempotencyKey: string; fingerprint: string },
  phase: "prepare" | "finalize" | "abort" | "expire",
  envelope: unknown,
): Promise<QueryResult> {
  return client.query(
    `INSERT INTO ${schema}.model_provider_settings_receipts (
       tenant_id, phase, idempotency_key, fingerprint, result_json
     ) VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      input.tenantId,
      phase,
      input.idempotencyKey,
      input.fingerprint,
      stableJson(envelope),
    ],
  );
}

function timestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

async function databaseNow(client: PoolClient): Promise<string> {
  const result = await client.query<{ now: string | Date }>(
    "SELECT clock_timestamp() AS now",
  );
  const value = result.rows[0]?.now;
  if (value === undefined) {
    throw new RunStoreError("model_provider_settings_stored_state_invalid");
  }
  return timestamp(value);
}
