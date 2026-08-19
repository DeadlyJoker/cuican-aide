import { randomUUID } from "node:crypto";

import {
  RunStoreError,
  validateAbandonWorkspaceDeliveryInput,
  validateClaimWorkspaceDeliveryInput,
  validateCommitWorkspaceOperationResolutionInput,
  validatePrepareWorkspaceOperationActionInput,
  validatePrepareWorkspaceOperationInput,
  validateWorkspaceDeliveryAttempt,
  validateWorkspaceDeliveryAttemptQuery,
  validateWorkspaceListResolution,
  validateWorkspaceOperationEventQuery,
  validateWorkspaceOperationListQuery,
  validateWorkspaceOperationLocator,
  validateWorkspaceOperationReceiptQuery,
  validateWorkspaceOperationRecord,
  type AbandonWorkspaceDeliveryInput,
  type ClaimWorkspaceDeliveryInput,
  type CommitWorkspaceOperationResolutionInput,
  type PrepareWorkspaceOperationActionInput,
  type PrepareWorkspaceOperationInput,
  type WorkspaceDeliveryAttempt,
  type WorkspaceDeliveryAttemptQuery,
  type WorkspaceDeliverySettlementResult,
  type WorkspaceOperationEvent,
  type WorkspaceOperationEventQuery,
  type WorkspaceOperationLocator,
  type WorkspaceOperationListPage,
  type WorkspaceOperationListQuery,
  type WorkspaceOperationPreparationResult,
  type WorkspaceOperationReceiptQuery,
  type WorkspaceOperationRecord,
  type WorkspaceOperationSnapshot,
} from "@crewon/application";
import type { Pool, PoolClient } from "pg";

import {
  normalizePostgresError,
  rollbackPostgres,
} from "./postgres-store-support.ts";
import { validateWorkspaceOperationDigestAuthority } from "./workspace-operation-digest-authority.ts";
import {
  workspaceOperationEventPageAuthority,
  workspaceOperationListPageAuthority,
  workspaceOperationSnapshotAuthority,
} from "./workspace-operation-read-authority.ts";
import {
  attemptSelect,
  decodeAttempt,
  decodeOperation,
  decodeWorkspaceOperationRevision,
  insertAttempt,
  insertOperation,
  insertRevision,
  loadOperationInClient,
  nullableSafeInteger,
  requireAttempt,
  requireOperation,
  requireRevision,
  requireRevisionChain,
  safeInteger,
  selectMaximumRevision,
  selectAttempt,
  selectAttempts,
  selectOperation,
  selectRevisionPage,
  updateAttempt,
  type PostgresWorkspaceAttemptRow,
  type PostgresWorkspaceOperationRow,
  type PostgresWorkspaceRevisionRow,
} from "./postgres-workspace-operation-codec.ts";
import {
  WORKSPACE_DELIVERY_COMMIT_MARGIN_MS,
  isFinalWorkspaceOperation,
  pendingWorkspaceDeliveryAttempt,
  requireWorkspaceExactLease,
  sameWorkspaceAuthority,
  settledWorkspaceDeliveryAttempt,
  validateWorkspaceAttemptScope,
  validateWorkspaceAttemptTransition,
  validWorkspaceOperationSuccessor,
  workspaceAttemptMatchesResult,
  workspaceDeliveryLease,
  workspaceDeliveryAttemptIdentity,
  workspaceMutationResult,
  workspaceOperationResultDigest,
  workspacePreparation,
  workspaceReceiptQuery,
  workspaceSettlementResult,
} from "./workspace-operation-store-support.ts";

type ReceiptRow = Readonly<{
  tenant_id: string;
  space_id: string;
  phase: string;
  scope: string;
  idempotency_key: string;
  thread_id: string;
  execution_id: string;
  action_digest: string;
  command_digest: string;
  fingerprint: string;
  attempt_number: string | number | null;
  attempt_identity: string | null;
  seed_result_revision: string | number;
  seed_result_digest: string;
}>;

type PostgresWorkspaceOperationListRow = PostgresWorkspaceOperationRow &
  Readonly<{
    revision_tenant_id: string | null;
    revision_execution_id: string | null;
    revision_revision: string | number | null;
    revision_result_digest: string | null;
    revision_operation_json: unknown;
    maximum_revision: string | number | null;
  }>;

export async function replay(
  client: PoolClient,
  schemaSql: string,
  query: WorkspaceOperationReceiptQuery,
): Promise<WorkspaceOperationPreparationResult | null> {
  const receipt = await client.query<ReceiptRow>(
    `SELECT tenant_id, space_id, phase, scope, idempotency_key, thread_id,
            execution_id, action_digest, command_digest, fingerprint,
            attempt_number, attempt_identity, seed_result_revision,
            seed_result_digest
     FROM ${schemaSql}.workspace_operation_receipts
     WHERE tenant_id = $1 AND space_id = $2 AND phase = $3 AND scope = $4
       AND idempotency_key = $5`,
    [
      query.tenantId,
      query.spaceId,
      query.phase,
      query.idempotency.scope,
      query.idempotency.key,
    ],
  );
  const row = receipt.rows[0];
  if (row === undefined) return null;
  if (row.fingerprint !== query.idempotency.requestFingerprint) {
    throw new RunStoreError("workspace_operation_idempotency_conflict");
  }
  if (
    row.tenant_id !== query.tenantId ||
    row.space_id !== query.spaceId ||
    row.phase !== query.phase ||
    row.scope !== query.idempotency.scope ||
    row.idempotency_key !== query.idempotency.key
  ) {
    throw new RunStoreError("workspace_operation_stored_state_invalid");
  }
  const attemptNumber = nullableSafeInteger(row.attempt_number);
  const attempt =
    attemptNumber === null
      ? null
      : await selectAttempt(
          client,
          schemaSql,
          row.tenant_id,
          row.execution_id,
          attemptNumber,
          "",
        );
  const headRow = await selectOperation(
    client,
    schemaSql,
    row.tenant_id,
    row.execution_id,
    "",
  );
  if (headRow === undefined || headRow.space_id !== row.space_id) {
    throw new RunStoreError("workspace_operation_stored_state_invalid");
  }
  const authority = decodeOperation(headRow).operation;
  const resultRevision =
    attempt?.settlement?.resultRevision ??
    safeInteger(row.seed_result_revision);
  const resultDigest =
    attempt?.settlement?.resultDigest ?? row.seed_result_digest;
  const frozen = await requireRevision(
    client,
    schemaSql,
    authority,
    resultRevision,
  );
  if (
    row.thread_id !== authority.threadId ||
    row.execution_id !== authority.executionId ||
    row.action_digest !== authority.command.actionDigest ||
    row.command_digest !== authority.command.commandDigest ||
    workspaceOperationResultDigest(frozen) !== resultDigest
  ) {
    throw new RunStoreError("workspace_operation_stored_state_invalid");
  }
  await requireRevisionChain(client, schemaSql, frozen, authority);
  if (attemptNumber !== null || row.attempt_identity !== null) {
    if (
      attemptNumber === null ||
      row.attempt_identity === null ||
      attempt === null ||
      attempt.actionDigest !== row.action_digest ||
      attempt.commandDigest !== row.command_digest ||
      workspaceDeliveryAttemptIdentity(attempt) !== row.attempt_identity ||
      attempt.operationRevision !== safeInteger(row.seed_result_revision) ||
      attempt.phase !== row.phase ||
      !workspaceAttemptMatchesResult(attempt, frozen, resultDigest)
    ) {
      throw new RunStoreError("workspace_operation_stored_state_invalid");
    }
  }
  return workspacePreparation("replayed", frozen, attempt);
}

export async function replaySettlement(
  client: PoolClient,
  schemaSql: string,
  authority: WorkspaceOperationRecord,
  attempt: WorkspaceDeliveryAttempt,
  resolution: ReturnType<typeof validateWorkspaceListResolution>,
): Promise<WorkspaceDeliverySettlementResult> {
  const settlement = attempt.settlement;
  if (settlement === null) {
    throw new RunStoreError("workspace_delivery_stored_state_invalid");
  }
  const frozen = await requireRevision(
    client,
    schemaSql,
    authority,
    settlement.resultRevision,
  );
  await requireRevisionChain(client, schemaSql, frozen, authority);
  if (workspaceOperationResultDigest(frozen) !== settlement.resultDigest) {
    throw new RunStoreError("workspace_delivery_stored_state_invalid");
  }
  if (settlement.kind === "resolution") {
    if (
      frozen.resolution === null ||
      !sameWorkspaceAuthority(frozen.resolution, resolution) ||
      settlement.resolutionStatus !== frozen.status
    ) {
      throw new RunStoreError("workspace_delivery_terminal_conflict");
    }
    return workspaceSettlementResult("replayed", frozen, attempt);
  }
  if (settlement.kind === "superseded") {
    return workspaceSettlementResult("lostRace", frozen, attempt);
  }
  throw new RunStoreError("workspace_delivery_terminal_conflict");
}

export async function insertReceipt(
  client: PoolClient,
  schemaSql: string,
  query: WorkspaceOperationReceiptQuery,
  operation: WorkspaceOperationRecord,
  attempt: WorkspaceDeliveryAttempt | null,
): Promise<void> {
  await client.query(
    `INSERT INTO ${schemaSql}.workspace_operation_receipts (
       tenant_id, space_id, phase, scope, idempotency_key, thread_id,
       execution_id, action_digest, command_digest, fingerprint,
       attempt_number, attempt_identity, seed_result_revision,
       seed_result_digest
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      query.tenantId,
      query.spaceId,
      query.phase,
      query.idempotency.scope,
      query.idempotency.key,
      operation.threadId,
      operation.executionId,
      operation.command.actionDigest,
      operation.command.commandDigest,
      query.idempotency.requestFingerprint,
      attempt?.attemptNumber ?? null,
      attempt === null ? null : workspaceDeliveryAttemptIdentity(attempt),
      operation.revision,
      workspaceOperationResultDigest(operation),
    ],
  );
}

export async function lockReceipt(
  client: PoolClient,
  schemaName: string,
  query: WorkspaceOperationReceiptQuery,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    [
      "workspace-operation-receipt",
      schemaName,
      query.tenantId,
      query.spaceId,
      query.phase,
      query.idempotency.scope,
      query.idempotency.key,
    ].join(":"),
  ]);
}

export async function databaseNow(client: PoolClient): Promise<number> {
  const result = await client.query<{ now: Date }>(
    "SELECT clock_timestamp() AS now",
  );
  const now = result.rows[0]?.now.getTime();
  if (now === undefined || !Number.isSafeInteger(now) || now < 0) {
    throw new RunStoreError("workspace_delivery_clock_invalid");
  }
  return now;
}

export async function readHead(
  client: PoolClient,
  schemaSql: string,
  locator: WorkspaceOperationLocator,
): Promise<WorkspaceOperationRecord | null> {
  return loadOperationInClient(client, schemaSql, locator);
}

export async function read<T>(
  pool: Pool,
  action: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const value = await action(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await rollbackPostgres(client);
    throw normalizeWorkspaceError(error);
  } finally {
    client.release();
  }
}

export async function write<T>(
  pool: Pool,
  action: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await action(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await rollbackPostgres(client);
    throw normalizeWorkspaceError(error);
  } finally {
    client.release();
  }
}

export function requireLocator(input: Record<string, string>): void {
  for (const value of Object.values(input)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)) {
      throw new RunStoreError("workspace_operation_locator_invalid");
    }
  }
}

export function normalizeWorkspaceError(error: unknown): Error {
  return error instanceof RunStoreError ? error : normalizePostgresError(error);
}
