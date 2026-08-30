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

import {
  readHead,
  replaySettlement,
  transaction,
  insertReceipt,
} from "./sqlite-workspace-operation-store-transaction.ts";
import { loadSqliteWorkspaceOperation } from "./sqlite-workspace-operation-store-read.ts";
export function claimSqliteWorkspaceOperationDelivery(
  database: DatabaseSync,
  input: ClaimWorkspaceDeliveryInput,
  now: number,
): WorkspaceDeliveryAttempt {
  validateClaimWorkspaceDeliveryInput(input);
  return transaction(database, "immediate", () => {
    const authority = requireOperation(database, input);
    if (authority.revision !== input.operationRevision) {
      throw new RunStoreError("workspace_delivery_attempt_stale");
    }
    if (
      input.leaseDurationMs <
      authority.command.limits.timeoutMs + WORKSPACE_DELIVERY_COMMIT_MARGIN_MS
    ) {
      throw new RunStoreError("workspace_delivery_lease_duration_invalid");
    }
    const attempt = requireAttempt(database, input);
    if (
      attempt.operationRevision !== input.operationRevision ||
      attempt.phase !== input.phase ||
      attempt.status === "settled"
    ) {
      throw new RunStoreError("workspace_delivery_attempt_stale");
    }
    if (attempt.status === "leased" && attempt.lease !== null) {
      throw new RunStoreError(
        Date.parse(attempt.lease.expiresAt) > now
          ? "workspace_delivery_lease_active"
          : "workspace_delivery_reconcile_required",
      );
    }
    const leased = validateWorkspaceDeliveryAttempt({
      ...attempt,
      status: "leased",
      lease: workspaceDeliveryLease(
        attempt,
        input.ownerId,
        `workspace-lease-${randomUUID()}`,
        now,
        input.leaseDurationMs,
      ),
    });
    updateAttempt(database, attempt, leased);
    return leased;
  });
}

export function listSqliteWorkspaceOperationDeliveryAttempts(
  database: DatabaseSync,
  query: WorkspaceDeliveryAttemptQuery,
): readonly WorkspaceDeliveryAttempt[] {
  validateWorkspaceDeliveryAttemptQuery(query);
  const operation = loadSqliteWorkspaceOperation(database, query);
  if (operation === null) return [];
  const statusFilter =
    query.view === "claimable" ? "AND status = 'pending'" : "";
  const rows = database
    .prepare(
      `${attemptSelect()}
       WHERE tenant_id = ? AND execution_id = ? AND attempt_number > ?
         ${statusFilter}
       ORDER BY attempt_number
       LIMIT ?`,
    )
    .all(
      query.tenantId,
      query.executionId,
      query.afterAttemptNumber,
      query.limit,
    ) as SqliteWorkspaceAttemptRow[];
  const attempts = rows.map(decodeAttempt);
  for (const attempt of attempts)
    validateWorkspaceAttemptScope(attempt, operation);
  if (query.view === "audit" && attempts.length > 0) {
    if (attempts[0]!.attemptNumber !== query.afterAttemptNumber + 1) {
      throw new RunStoreError("workspace_delivery_stored_state_invalid");
    }
    for (let index = 1; index < attempts.length; index += 1) {
      if (
        attempts[index]!.attemptNumber !==
        attempts[index - 1]!.attemptNumber + 1
      ) {
        throw new RunStoreError("workspace_delivery_stored_state_invalid");
      }
    }
  }
  return attempts;
}

export function abandonSqliteWorkspaceOperationDelivery(
  database: DatabaseSync,
  input: AbandonWorkspaceDeliveryInput,
  now: number,
): WorkspaceDeliveryAttempt {
  validateAbandonWorkspaceDeliveryInput(input);
  return transaction(database, "immediate", () => {
    const authority = requireOperation(database, input);
    if (authority.revision !== input.operationRevision) {
      throw new RunStoreError("workspace_delivery_attempt_stale");
    }
    const attempt = requireAttempt(database, {
      ...input,
      attemptNumber: input.deliveryLease.attemptNumber,
    });
    requireWorkspaceExactLease(attempt, input.deliveryLease);
    if (Date.parse(input.deliveryLease.expiresAt) <= now) {
      throw new RunStoreError("workspace_delivery_lease_expired");
    }
    const abandoned = settledWorkspaceDeliveryAttempt(
      attempt,
      "abandoned",
      authority,
      now,
    );
    updateAttempt(database, attempt, abandoned);
    return abandoned;
  });
}

export function settleSqliteWorkspaceOperationDelivery(
  database: DatabaseSync,
  input: CommitWorkspaceOperationResolutionInput,
  now: number,
): WorkspaceDeliverySettlementResult {
  validateCommitWorkspaceOperationResolutionInput(input);
  return transaction(database, "immediate", () => {
    const authority = requireOperation(database, input);
    const resolution = validateWorkspaceListResolution(
      input.resolution,
      authority.command,
    );
    const attempt = requireAttempt(database, {
      ...input,
      attemptNumber: input.deliveryLease.attemptNumber,
    });
    requireWorkspaceExactLease(attempt, input.deliveryLease);
    if (attempt.operationRevision !== input.expectedOperationRevision) {
      throw new RunStoreError("workspace_delivery_lease_mismatch");
    }
    if (attempt.status === "settled") {
      return replaySettlement(database, authority, attempt, resolution);
    }
    if (authority.revision !== input.expectedOperationRevision) {
      const winner = requireRevision(
        database,
        authority,
        attempt.operationRevision + 1,
      );
      requireRevisionChain(database, winner, authority);
      const lost = settledWorkspaceDeliveryAttempt(
        attempt,
        "superseded",
        winner,
        now,
      );
      updateAttempt(database, attempt, lost);
      return workspaceSettlementResult("lostRace", winner, lost);
    }
    if (attempt.status !== "leased" || attempt.lease === null) {
      throw new RunStoreError("workspace_delivery_lease_mismatch");
    }
    if (Date.parse(attempt.lease.expiresAt) <= now) {
      throw new RunStoreError("workspace_delivery_lease_expired");
    }
    const next = validateWorkspaceOperationRecord({
      ...authority,
      revision: authority.revision + 1,
      status: resolution.status,
      resolution,
    });
    insertRevision(database, next);
    const updated = database
      .prepare(
        `UPDATE workspace_operations
         SET revision = ?, status = ?, operation_json = ?
         WHERE tenant_id = ? AND execution_id = ? AND revision = ?`,
      )
      .run(
        next.revision,
        next.status,
        JSON.stringify(next),
        next.tenantId,
        next.executionId,
        authority.revision,
      );
    if (updated.changes !== 1) {
      throw new RunStoreError("workspace_operation_revision_conflict");
    }
    const resolved = settledWorkspaceDeliveryAttempt(
      attempt,
      "resolution",
      next,
      now,
    );
    updateAttempt(database, attempt, resolved);
    const others = selectAttempts(database, authority);
    for (const other of others) {
      if (
        other.attemptNumber !== attempt.attemptNumber &&
        other.status !== "settled" &&
        other.operationRevision === authority.revision
      ) {
        updateAttempt(
          database,
          other,
          settledWorkspaceDeliveryAttempt(other, "superseded", next, now),
        );
      }
    }
    return workspaceSettlementResult("committed", next, resolved);
  });
}

export * from "./sqlite-workspace-operation-store-transaction.ts";
