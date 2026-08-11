import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

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
  type WorkspaceOperationMutationResult,
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
import {
  workspaceOperationEventPageAuthority,
  workspaceOperationListPageAuthority,
  workspaceOperationSnapshotAuthority,
} from "./workspace-operation-read-authority.ts";
import { validateWorkspaceOperationDigestAuthority } from "./workspace-operation-digest-authority.ts";
import {
  attemptSelect,
  decodeAttempt,
  decodeOperation,
  decodeWorkspaceOperationRevision,
  insertAttempt,
  insertOperation,
  insertRevision,
  nextAttemptNumber,
  requireAttempt,
  requireOperation,
  requireRevision,
  requireRevisionChain,
  selectMaximumRevision,
  selectAttempt,
  selectAttempts,
  selectOperation,
  selectRevisionPage,
  updateAttempt,
  type SqliteWorkspaceAttemptRow,
  type SqliteWorkspaceOperationRow,
  type SqliteWorkspaceRevisionRow,
} from "./sqlite-workspace-operation-codec.ts";
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
  attempt_number: number | null;
  attempt_identity: string | null;
  seed_result_revision: number;
  seed_result_digest: string;
}>;

type SqliteWorkspaceOperationListRow = SqliteWorkspaceOperationRow &
  Readonly<{
    revision_tenant_id: string | null;
    revision_execution_id: string | null;
    revision_revision: number | null;
    revision_result_digest: string | null;
    revision_operation_json: string | null;
    maximum_revision: number | null;
  }>;

export function replay(
  database: DatabaseSync,
  query: WorkspaceOperationReceiptQuery,
): WorkspaceOperationMutationResult | null {
  const row = database
    .prepare(
      `SELECT tenant_id, space_id, phase, scope, idempotency_key, thread_id,
              execution_id, action_digest, command_digest, fingerprint,
              attempt_number, attempt_identity, seed_result_revision,
              seed_result_digest
       FROM workspace_operation_receipts
       WHERE tenant_id = ? AND space_id = ? AND phase = ? AND scope = ?
         AND idempotency_key = ?`,
    )
    .get(
      query.tenantId,
      query.spaceId,
      query.phase,
      query.idempotency.scope,
      query.idempotency.key,
    ) as ReceiptRow | undefined;
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
  const headRow = selectOperation(database, row.tenant_id, row.execution_id);
  if (headRow === undefined || headRow.space_id !== row.space_id) {
    throw new RunStoreError("workspace_operation_stored_state_invalid");
  }
  const authority = decodeOperation(headRow).operation;
  const attempt =
    row.attempt_number === null
      ? null
      : selectAttempt(
          database,
          row.tenant_id,
          row.execution_id,
          row.attempt_number,
        );
  const resultRevision =
    attempt?.settlement?.resultRevision ?? row.seed_result_revision;
  const resultDigest =
    attempt?.settlement?.resultDigest ?? row.seed_result_digest;
  const frozen = requireRevision(database, authority, resultRevision);
  if (
    row.thread_id !== authority.threadId ||
    row.execution_id !== authority.executionId ||
    row.action_digest !== authority.command.actionDigest ||
    row.command_digest !== authority.command.commandDigest ||
    workspaceOperationResultDigest(frozen) !== resultDigest
  ) {
    throw new RunStoreError("workspace_operation_stored_state_invalid");
  }
  requireRevisionChain(database, frozen, authority);
  if (row.attempt_number !== null || row.attempt_identity !== null) {
    if (
      row.attempt_number === null ||
      row.attempt_identity === null ||
      attempt === null ||
      attempt.actionDigest !== row.action_digest ||
      attempt.commandDigest !== row.command_digest ||
      workspaceDeliveryAttemptIdentity(attempt) !== row.attempt_identity ||
      attempt.operationRevision !== row.seed_result_revision ||
      attempt.phase !== row.phase ||
      !workspaceAttemptMatchesResult(attempt, frozen, resultDigest)
    ) {
      throw new RunStoreError("workspace_operation_stored_state_invalid");
    }
  }
  return workspaceMutationResult("replayed", frozen);
}

export function replaySettlement(
  database: DatabaseSync,
  authority: WorkspaceOperationRecord,
  attempt: WorkspaceDeliveryAttempt,
  resolution: ReturnType<typeof validateWorkspaceListResolution>,
): WorkspaceDeliverySettlementResult {
  const settlement = attempt.settlement;
  if (settlement === null) {
    throw new RunStoreError("workspace_delivery_stored_state_invalid");
  }
  const frozen = requireRevision(
    database,
    authority,
    settlement.resultRevision,
  );
  requireRevisionChain(database, frozen, authority);
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

export function insertReceipt(
  database: DatabaseSync,
  query: WorkspaceOperationReceiptQuery,
  operation: WorkspaceOperationRecord,
  attempt: WorkspaceDeliveryAttempt | null,
): void {
  database
    .prepare(
      `INSERT INTO workspace_operation_receipts (
         tenant_id, space_id, phase, scope, idempotency_key, thread_id,
         execution_id, action_digest, command_digest, fingerprint,
         attempt_number, attempt_identity, seed_result_revision,
         seed_result_digest
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
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
    );
}

export function readHead(
  database: DatabaseSync,
  locator: WorkspaceOperationLocator,
): WorkspaceOperationRecord | null {
  const row = selectOperation(database, locator.tenantId, locator.executionId);
  if (
    row === undefined ||
    row.space_id !== locator.spaceId ||
    row.thread_id !== locator.threadId
  ) {
    return null;
  }
  return decodeOperation(row).operation;
}

export function transaction<T>(
  database: DatabaseSync,
  mode: "deferred" | "immediate",
  action: () => T,
): T {
  database.exec(mode === "immediate" ? "BEGIN IMMEDIATE" : "BEGIN");
  try {
    const value = action();
    database.exec("COMMIT");
    return value;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {}
    if (error instanceof RunStoreError) throw error;
    throw new RunStoreError("workspace_operation_store_failed", {
      cause: error,
    });
  }
}

export function requireLocator(input: Record<string, string>): void {
  for (const value of Object.values(input)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)) {
      throw new RunStoreError("workspace_operation_locator_invalid");
    }
  }
}

function parseJson(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch (error) {
    throw new RunStoreError("workspace_operation_stored_state_invalid", {
      cause: error,
    });
  }
}
