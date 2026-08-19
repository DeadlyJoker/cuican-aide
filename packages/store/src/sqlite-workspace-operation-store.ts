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
  insertReceipt,
  readHead,
  replay,
  transaction,
} from "./sqlite-workspace-operation-store-delivery.ts";

export function loadSqliteWorkspaceOperationReceipt(
  database: DatabaseSync,
  query: WorkspaceOperationReceiptQuery,
): WorkspaceOperationPreparationResult | null {
  validateWorkspaceOperationReceiptQuery(query);
  return transaction(database, "deferred", () => replay(database, query));
}

export function prepareSqliteWorkspaceOperation(
  database: DatabaseSync,
  input: PrepareWorkspaceOperationInput,
  now: number,
): WorkspaceOperationPreparationResult {
  validatePrepareWorkspaceOperationInput(input);
  return transaction(database, "immediate", () => {
    const query = workspaceReceiptQuery(input, "execute");
    const prior = replay(database, query);
    if (prior !== null) return prior;
    const thread = database
      .prepare(
        `SELECT tenant_id, space_id, revision, status
         FROM threads WHERE tenant_id = ? AND thread_id = ?`,
      )
      .get(input.tenantId, input.threadFence.threadId) as
      | {
          tenant_id: string;
          space_id: string;
          revision: number;
          status: string;
        }
      | undefined;
    if (
      thread === undefined ||
      thread.space_id !== input.spaceId ||
      thread.status === "deleted"
    ) {
      throw new RunStoreError("workspace_operation_thread_not_found");
    }
    if (thread.revision !== input.threadFence.expectedRevision) {
      throw new RunStoreError("workspace_operation_thread_revision_conflict");
    }
    const operation = validateWorkspaceOperationDigestAuthority(
      input.operation,
    );
    if (operation.revision !== 1) {
      throw new RunStoreError("workspace_operation_initial_revision_invalid");
    }
    const attempt = pendingWorkspaceDeliveryAttempt(
      operation,
      "execute",
      1,
      now,
    );
    try {
      insertOperation(database, operation);
      insertRevision(database, operation);
      insertAttempt(database, attempt);
      insertReceipt(database, query, operation, attempt);
    } catch (error) {
      if (error instanceof RunStoreError) throw error;
      throw new RunStoreError("workspace_operation_identity_conflict", {
        cause: error,
      });
    }
    return workspacePreparation("committed", operation, attempt);
  });
}

export function prepareSqliteWorkspaceOperationAction(
  database: DatabaseSync,
  input: PrepareWorkspaceOperationActionInput,
  now: number,
): WorkspaceOperationPreparationResult {
  validatePrepareWorkspaceOperationActionInput(input);
  return transaction(database, "immediate", () => {
    const query = workspaceReceiptQuery(input, input.phase);
    const prior = replay(database, query);
    if (prior !== null) return prior;
    const authority = requireOperation(database, input);
    if (authority.revision !== input.expectedOperationRevision) {
      throw new RunStoreError("workspace_operation_revision_conflict");
    }
    if (isFinalWorkspaceOperation(authority.status)) {
      insertReceipt(database, query, authority, null);
      return workspacePreparation("committed", authority, null);
    }
    const attempts = selectAttempts(database, authority);
    for (const attempt of attempts) {
      if (
        attempt.status === "settled" ||
        (input.phase === "cancel" && attempt.phase !== "cancel")
      ) {
        continue;
      }
      if (
        attempt.status === "leased" &&
        attempt.lease !== null &&
        Date.parse(attempt.lease.expiresAt) > now
      ) {
        throw new RunStoreError("workspace_delivery_lease_active");
      }
    }
    for (const attempt of attempts) {
      if (
        attempt.status === "settled" ||
        (input.phase === "cancel" && attempt.phase !== "cancel")
      ) {
        continue;
      }
      const retired =
        attempt.status === "leased"
          ? settledWorkspaceDeliveryAttempt(
              attempt,
              "leaseExpired",
              authority,
              now,
            )
          : settledWorkspaceDeliveryAttempt(
              attempt,
              "superseded",
              authority,
              now,
            );
      updateAttempt(database, attempt, retired);
    }
    const nextNumber = nextAttemptNumber(database, authority);
    const attempt = pendingWorkspaceDeliveryAttempt(
      authority,
      input.phase,
      nextNumber,
      now,
    );
    insertAttempt(database, attempt);
    insertReceipt(database, query, authority, attempt);
    return workspacePreparation("committed", authority, attempt);
  });
}

export * from "./sqlite-workspace-operation-store-read.ts";
export {
  claimSqliteWorkspaceOperationDelivery,
  listSqliteWorkspaceOperationDeliveryAttempts,
  abandonSqliteWorkspaceOperationDelivery,
  settleSqliteWorkspaceOperationDelivery,
} from "./sqlite-workspace-operation-store-delivery.ts";
