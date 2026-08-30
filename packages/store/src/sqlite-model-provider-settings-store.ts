import { DatabaseSync } from "node:sqlite";

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
import { rollback } from "./sqlite-schema.ts";
import { stableJson } from "./store-invariants.ts";
import { leaseExpiry } from "./lease-clock.ts";

type OperationRow = Readonly<{
  operation_id: string;
  coordinator_binding: string;
  base_revision: number;
  operation_json: string;
  status: "pending" | "finalized" | "aborted" | "expired";
  prepared_at: string;
  expires_at: string;
  terminal_binding: string | null;
  completed_at: string | null;
  result_json: string | null;
}>;

type CatalogRow = Readonly<{
  revision: number | null;
  active_provider_id: string | null;
  catalog_json: string | null;
  updated_at: string | null;
}>;

type LatestFinalizedRow = Readonly<{
  latest_operation_id: string | null;
  latest_coordinator_binding: string | null;
  latest_base_revision: number | null;
  latest_operation_json: string | null;
  latest_prepared_at: string | null;
  latest_expires_at: string | null;
  latest_terminal_binding: string | null;
  latest_completed_at: string | null;
  latest_result_json: string | null;
}>;

export function loadSqliteModelProviderSettingsState(
  database: DatabaseSync,
  tenantId: string,
): ModelProviderSettingsState {
  const row = database
    .prepare(
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
       FROM (SELECT ? AS tenant_id) AS requested
       LEFT JOIN model_provider_settings AS settings
         ON settings.tenant_id = requested.tenant_id
       LEFT JOIN model_provider_settings_operations AS operations
         ON operations.tenant_id = requested.tenant_id
        AND operations.status = 'pending'
       LEFT JOIN model_provider_settings_operations AS latest
         ON latest.tenant_id = requested.tenant_id
        AND latest.status = 'finalized'
        AND NOT EXISTS (
          SELECT 1 FROM model_provider_settings_operations AS newer
          WHERE newer.tenant_id = latest.tenant_id
            AND newer.status = 'finalized'
            AND newer.base_revision > latest.base_revision
        )`,
    )
    .get(tenantId) as
    | (CatalogRow & OperationRow & LatestFinalizedRow)
    | undefined;
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
    completedAt: row.latest_completed_at,
    resultEnvelope: JSON.parse(row.latest_result_json),
  });
}

export function prepareSqliteModelProviderSettings(
  database: DatabaseSync,
  input: PrepareModelProviderSettingsInput,
  nowEpochMilliseconds: () => number,
): PrepareModelProviderSettingsResult {
  const normalized = validatePrepareModelProviderSettingsInput(input);
  try {
    database.exec("BEGIN IMMEDIATE");
    const replay = loadReceipt(database, normalized, "prepare");
    if (replay !== undefined) {
      const pending = parsePrepareModelProviderSettingsReceipt(
        replay,
        normalized,
      );
      const operation = requireOperationAny(database, normalized);
      if (stableJson(operation.pending) !== stableJson(pending)) {
        throw new RunStoreError("model_provider_settings_stored_state_invalid");
      }
      database.exec("COMMIT");
      return {
        disposition: "replayed",
        pending,
      };
    }
    if (loadPendingOperationRow(database, normalized.tenantId) !== undefined) {
      throw new RunStoreError("model_provider_settings_pending");
    }
    const activeRun = database
      .prepare(
        `SELECT 1 FROM run_snapshots
         WHERE tenant_id = ?
           AND COALESCE(json_extract(state_json, '$.status'), '')
             NOT IN ('completed', 'failed', 'canceled')
         LIMIT 1`,
      )
      .get(normalized.tenantId);
    if (activeRun !== undefined) {
      throw new RunStoreError("model_provider_settings_active_run");
    }
    const baseCatalog = loadProviderHeadAuthority(
      database,
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
    const preparedAtMs = nowEpochMilliseconds();
    const preparedAt = new Date(preparedAtMs).toISOString();
    const { expiresAt } = leaseExpiry(preparedAtMs, normalized.ttlMs);
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
    database
      .prepare(
        `INSERT INTO model_provider_settings_operations (
           tenant_id, operation_id, coordinator_binding, base_revision,
           operation_json, status, prepared_at, expires_at,
           terminal_binding, completed_at, result_json
         ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, NULL)`,
      )
      .run(
        normalized.tenantId,
        normalized.operationId,
        normalized.coordinatorBinding,
        normalized.expectedRevision,
        stableJson(
          modelProviderSettingsOperation(
            pending,
            baseCatalog,
            normalized.actor,
          ),
        ),
        preparedAt,
        expiresAt,
      );
    insertReceipt(
      database,
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
    database.exec("COMMIT");
    return { disposition: "prepared", pending };
  } catch (error) {
    rollback(database);
    throw error;
  }
}

export function finalizeSqliteModelProviderSettings(
  database: DatabaseSync,
  input: FinalizeModelProviderSettingsInput,
  nowEpochMilliseconds: () => number,
): FinalizeModelProviderSettingsResult {
  const normalized = validateFinalizeModelProviderSettingsInput(input);
  try {
    database.exec("BEGIN IMMEDIATE");
    const replay = loadReceipt(database, normalized, "finalize");
    if (replay !== undefined) {
      const catalog = parseFinalizeModelProviderSettingsReceipt(
        replay,
        normalized,
      );
      const operation = requireOperation(
        database,
        normalized,
        "finalized",
        replay,
      );
      validateFinalizedModelProviderSettingsOperation(operation, catalog);
      database.exec("COMMIT");
      return {
        disposition: "replayed",
        catalog,
      };
    }
    const operation = requireOperation(database, normalized, "pending");
    const { pending } = operation;
    const finalizedAt = new Date(nowEpochMilliseconds()).toISOString();
    if (Date.parse(finalizedAt) < Date.parse(pending.preparedAt)) {
      throw new RunStoreError("model_provider_settings_operation_time_invalid");
    }
    if (Date.parse(finalizedAt) > Date.parse(pending.expiresAt)) {
      throw new RunStoreError("model_provider_settings_operation_expired");
    }
    const currentCatalog = loadProviderHeadAuthority(
      database,
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
    database
      .prepare(
        `INSERT INTO model_provider_settings (
           tenant_id, revision, active_provider_id, catalog_json, updated_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id) DO UPDATE SET
           revision = excluded.revision,
           active_provider_id = excluded.active_provider_id,
           catalog_json = excluded.catalog_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        normalized.tenantId,
        catalog.revision,
        catalog.activeProviderId,
        stableJson(catalog),
        catalog.updatedAt,
      );
    const envelope = providerSettingsReceiptEnvelope(
      "finalize",
      normalized.operationId,
      normalized.coordinatorBinding,
      catalog,
      finalizedAt,
      normalized.actor,
    );
    completeOperation(database, normalized, "finalized", finalizedAt, envelope);
    insertReceipt(database, normalized, "finalize", envelope);
    database.exec("COMMIT");
    return { disposition: "finalized", catalog };
  } catch (error) {
    rollback(database);
    throw error;
  }
}

export function abortSqliteModelProviderSettings(
  database: DatabaseSync,
  input: AbortModelProviderSettingsInput,
  nowEpochMilliseconds: () => number,
): AbortModelProviderSettingsResult {
  const normalized = validateAbortModelProviderSettingsInput(input);
  try {
    database.exec("BEGIN IMMEDIATE");
    const replay = loadReceipt(database, normalized, "abort");
    if (replay !== undefined) {
      const catalog = parseAbortModelProviderSettingsReceipt(
        replay,
        normalized,
      );
      const operation = requireOperation(
        database,
        normalized,
        "aborted",
        replay,
      );
      validateAbortedModelProviderSettingsOperation(operation, catalog);
      database.exec("COMMIT");
      return {
        disposition: "replayed",
        catalog,
      };
    }
    const operation = requireOperation(database, normalized, "pending");
    const abortedAt = new Date(nowEpochMilliseconds()).toISOString();
    if (Date.parse(abortedAt) < Date.parse(operation.pending.preparedAt)) {
      throw new RunStoreError("model_provider_settings_operation_time_invalid");
    }
    const catalog = loadProviderHeadAuthority(database, normalized.tenantId);
    validateAbortedModelProviderSettingsOperation(operation, catalog);
    const envelope = providerSettingsReceiptEnvelope(
      "abort",
      normalized.operationId,
      normalized.coordinatorBinding,
      catalog,
      abortedAt,
      normalized.actor,
    );
    completeOperation(database, normalized, "aborted", abortedAt, envelope);
    insertReceipt(database, normalized, "abort", envelope);
    database.exec("COMMIT");
    return { disposition: "aborted", catalog };
  } catch (error) {
    rollback(database);
    throw error;
  }
}

export function expireSqliteModelProviderSettings(
  database: DatabaseSync,
  input: ExpireModelProviderSettingsInput,
  nowEpochMilliseconds: () => number,
): ExpireModelProviderSettingsResult {
  const normalized = validateExpireModelProviderSettingsInput(input);
  try {
    database.exec("BEGIN IMMEDIATE");
    const replay = loadReceipt(database, normalized, "expire");
    if (replay !== undefined) {
      const catalog = parseExpireModelProviderSettingsReceipt(
        replay,
        normalized,
      );
      const operation = requireRecoveryOperation(
        database,
        normalized,
        "expired",
        replay,
      );
      validateAbortedModelProviderSettingsOperation(operation, catalog);
      database.exec("COMMIT");
      return { disposition: "replayed", catalog };
    }
    const operation = requireRecoveryOperation(database, normalized, "pending");
    const expiredAt = new Date(nowEpochMilliseconds()).toISOString();
    if (Date.parse(expiredAt) <= Date.parse(operation.pending.expiresAt)) {
      throw new RunStoreError("model_provider_settings_operation_not_expired");
    }
    const catalog = loadProviderHeadAuthority(database, normalized.tenantId);
    validateAbortedModelProviderSettingsOperation(operation, catalog);
    const envelope = providerSettingsReceiptEnvelope(
      "expire",
      normalized.operationId,
      normalized.recoveryBinding,
      catalog,
      expiredAt,
      normalized.actor,
    );
    completeRecoveryOperation(database, normalized, expiredAt, envelope);
    insertReceipt(database, normalized, "expire", envelope);
    database.exec("COMMIT");
    return { disposition: "expired", catalog };
  } catch (error) {
    rollback(database);
    throw error;
  }
}

function loadCatalogAuthority(
  database: DatabaseSync,
  tenantId: string,
): ModelProviderSettingsCatalog | null {
  const row = database
    .prepare(
      `SELECT revision, active_provider_id, catalog_json, updated_at
       FROM model_provider_settings WHERE tenant_id = ?`,
    )
    .get(tenantId) as CatalogRow | undefined;
  return decodeCatalogRow(row, tenantId);
}

function loadProviderHeadAuthority(
  database: DatabaseSync,
  tenantId: string,
): ModelProviderSettingsCatalog | null {
  const catalog = loadCatalogAuthority(database, tenantId);
  const row = database
    .prepare(
      `SELECT operation_id, coordinator_binding, base_revision, operation_json,
              status, prepared_at, expires_at, terminal_binding,
              completed_at, result_json
       FROM model_provider_settings_operations
       WHERE tenant_id = ? AND status = 'finalized'
       ORDER BY base_revision DESC LIMIT 1`,
    )
    .get(tenantId) as OperationRow | undefined;
  const latest =
    row === undefined
      ? null
      : validateStoredTerminalModelProviderSettingsOperation({
          operation: decodeOperationRow(row, tenantId),
          status: "finalized",
          terminalBinding: row.terminal_binding,
          completedAt: row.completed_at,
          resultEnvelope:
            row.result_json === null ? null : JSON.parse(row.result_json),
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
  const catalog = parseStoredModelProviderSettings(
    JSON.parse(row.catalog_json),
    tenantId,
  );
  if (
    row.revision !== catalog.revision ||
    row.active_provider_id !== catalog.activeProviderId ||
    row.updated_at !== catalog.updatedAt
  ) {
    throw new RunStoreError("model_provider_settings_stored_state_invalid");
  }
  return catalog;
}

function loadPendingOperationRow(
  database: DatabaseSync,
  tenantId: string,
): OperationRow | undefined {
  return database
    .prepare(
      `SELECT operation_id, coordinator_binding, base_revision, operation_json,
              status, prepared_at, expires_at, terminal_binding,
              completed_at, result_json
       FROM model_provider_settings_operations
       WHERE tenant_id = ? AND status = 'pending'`,
    )
    .get(tenantId) as OperationRow | undefined;
}

function loadOperationRow(
  database: DatabaseSync,
  tenantId: string,
  operationId: string,
): OperationRow | undefined {
  return database
    .prepare(
      `SELECT operation_id, coordinator_binding, base_revision, operation_json,
              status, prepared_at, expires_at, terminal_binding,
              completed_at, result_json
       FROM model_provider_settings_operations
       WHERE tenant_id = ? AND operation_id = ?`,
    )
    .get(tenantId, operationId) as OperationRow | undefined;
}

function decodeOperationRow(
  row: OperationRow,
  tenantId: string,
): ReturnType<typeof parseStoredModelProviderSettingsOperation> {
  const operation = parseStoredModelProviderSettingsOperation(
    JSON.parse(row.operation_json),
    tenantId,
  );
  const { pending } = operation;
  const validCompletedAt =
    row.completed_at === null ||
    (row.completed_at.endsWith("Z") &&
      Number.isFinite(Date.parse(row.completed_at)));
  const terminalResult =
    row.result_json === null
      ? null
      : (JSON.parse(row.result_json) as Record<string, unknown>);
  if (
    pending.operationId !== row.operation_id ||
    pending.coordinatorBinding !== row.coordinator_binding ||
    pending.baseRevision !== row.base_revision ||
    pending.preparedAt !== row.prepared_at ||
    pending.expiresAt !== row.expires_at ||
    (row.status === "pending") !==
      (row.terminal_binding === null &&
        row.completed_at === null &&
        row.result_json === null) ||
    (row.status !== "pending") !==
      (row.terminal_binding !== null &&
        row.completed_at !== null &&
        row.result_json !== null) ||
    !validCompletedAt ||
    (row.status !== "pending" &&
      terminalResult?.completedAt !== row.completed_at) ||
    (row.status === "finalized" &&
      (typeof terminalResult?.value !== "object" ||
        terminalResult.value === null ||
        !("updatedAt" in terminalResult.value) ||
        terminalResult.value.updatedAt !== row.completed_at)) ||
    (row.completed_at !== null &&
      Date.parse(row.completed_at) < Date.parse(pending.preparedAt))
  ) {
    throw new RunStoreError("model_provider_settings_stored_state_invalid");
  }
  if (row.status !== "pending") {
    validateStoredTerminalModelProviderSettingsOperation({
      operation,
      status: row.status,
      terminalBinding: row.terminal_binding,
      completedAt: row.completed_at,
      resultEnvelope: terminalResult,
    });
  }
  return operation;
}

function requireOperation(
  database: DatabaseSync,
  input: { tenantId: string; operationId: string; coordinatorBinding: string },
  status: OperationRow["status"],
  expectedResult?: unknown,
): ReturnType<typeof parseStoredModelProviderSettingsOperation> {
  const row = loadOperationRow(database, input.tenantId, input.operationId);
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
    (row.result_json === null ||
      stableJson(JSON.parse(row.result_json)) !== stableJson(expectedResult))
  ) {
    throw new RunStoreError("model_provider_settings_stored_state_invalid");
  }
  return decodeOperationRow(row, input.tenantId);
}

function requireOperationAny(
  database: DatabaseSync,
  input: { tenantId: string; operationId: string; coordinatorBinding: string },
): ReturnType<typeof parseStoredModelProviderSettingsOperation> {
  const row = loadOperationRow(database, input.tenantId, input.operationId);
  if (
    row === undefined ||
    row.coordinator_binding !== input.coordinatorBinding
  ) {
    throw new RunStoreError("model_provider_settings_stored_state_invalid");
  }
  return decodeOperationRow(row, input.tenantId);
}

function requireRecoveryOperation(
  database: DatabaseSync,
  input: { tenantId: string; operationId: string; recoveryBinding: string },
  status: "pending" | "expired",
  expectedResult?: unknown,
): ReturnType<typeof parseStoredModelProviderSettingsOperation> {
  const row = loadOperationRow(database, input.tenantId, input.operationId);
  if (row === undefined || row.status !== status) {
    throw new RunStoreError("model_provider_settings_operation_mismatch");
  }
  if (
    expectedResult !== undefined &&
    (row.result_json === null ||
      stableJson(JSON.parse(row.result_json)) !== stableJson(expectedResult))
  ) {
    throw new RunStoreError("model_provider_settings_stored_state_invalid");
  }
  return decodeOperationRow(row, input.tenantId);
}

function completeOperation(
  database: DatabaseSync,
  input: { tenantId: string; operationId: string; coordinatorBinding: string },
  status: "finalized" | "aborted",
  completedAt: string,
  result: unknown,
): void {
  const updated = database
    .prepare(
      `UPDATE model_provider_settings_operations
       SET status = ?, terminal_binding = ?, completed_at = ?, result_json = ?
       WHERE tenant_id = ? AND operation_id = ?
         AND coordinator_binding = ? AND status = 'pending'`,
    )
    .run(
      status,
      input.coordinatorBinding,
      completedAt,
      stableJson(result),
      input.tenantId,
      input.operationId,
      input.coordinatorBinding,
    );
  if (updated.changes !== 1) {
    throw new RunStoreError("model_provider_settings_operation_mismatch");
  }
}

function completeRecoveryOperation(
  database: DatabaseSync,
  input: { tenantId: string; operationId: string; recoveryBinding: string },
  completedAt: string,
  result: unknown,
): void {
  const updated = database
    .prepare(
      `UPDATE model_provider_settings_operations
       SET status = 'expired', terminal_binding = ?, completed_at = ?, result_json = ?
       WHERE tenant_id = ? AND operation_id = ? AND status = 'pending'`,
    )
    .run(
      input.recoveryBinding,
      completedAt,
      stableJson(result),
      input.tenantId,
      input.operationId,
    );
  if (updated.changes !== 1) {
    throw new RunStoreError("model_provider_settings_operation_mismatch");
  }
}

function loadReceipt(
  database: DatabaseSync,
  input: { tenantId: string; idempotencyKey: string; fingerprint: string },
  phase: "prepare" | "finalize" | "abort" | "expire",
): unknown | undefined {
  const row = database
    .prepare(
      `SELECT fingerprint, result_json
       FROM model_provider_settings_receipts
       WHERE tenant_id = ? AND phase = ? AND idempotency_key = ?`,
    )
    .get(input.tenantId, phase, input.idempotencyKey) as
    | { fingerprint: string; result_json: string }
    | undefined;
  if (row === undefined) return undefined;
  if (row.fingerprint !== input.fingerprint) {
    throw new RunStoreError("model_provider_settings_idempotency_conflict");
  }
  return JSON.parse(row.result_json);
}

function insertReceipt(
  database: DatabaseSync,
  input: { tenantId: string; idempotencyKey: string; fingerprint: string },
  phase: "prepare" | "finalize" | "abort" | "expire",
  envelope: unknown,
): void {
  database
    .prepare(
      `INSERT INTO model_provider_settings_receipts (
         tenant_id, phase, idempotency_key, fingerprint, result_json
       ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      input.tenantId,
      phase,
      input.idempotencyKey,
      input.fingerprint,
      stableJson(envelope),
    );
}
