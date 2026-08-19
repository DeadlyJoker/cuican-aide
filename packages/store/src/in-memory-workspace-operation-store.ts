import {
  RunStoreError,
  validateCommitWorkspaceOperationResolutionInput,
  validateAbandonWorkspaceDeliveryInput,
  validateClaimWorkspaceDeliveryInput,
  validatePrepareWorkspaceOperationInput,
  validatePrepareWorkspaceOperationActionInput,
  validateWorkspaceDeliveryAttempt,
  validateWorkspaceDeliveryAttemptQuery,
  validateWorkspaceListResolution,
  validateWorkspaceOperationEventQuery,
  validateWorkspaceOperationListQuery,
  validateWorkspaceOperationLocator,
  validateWorkspaceOperationReceiptQuery,
  validateWorkspaceOperationRecord,
  workspaceOperationReceiptKey,
  type AbandonWorkspaceDeliveryInput,
  type ClaimWorkspaceDeliveryInput,
  type CommitWorkspaceOperationResolutionInput,
  type PrepareWorkspaceOperationInput,
  type PrepareWorkspaceOperationActionInput,
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
  type WorkspaceOperationStore,
} from "@crewon/application";
import type { ThreadState } from "@crewon/domain";
import {
  workspaceOperationEventPageAuthority,
  workspaceOperationListPageAuthority,
  workspaceOperationSnapshotAuthority,
} from "./workspace-operation-read-authority.ts";
import { validateWorkspaceOperationDigestAuthority } from "./workspace-operation-digest-authority.ts";
import {
  WORKSPACE_DELIVERY_COMMIT_MARGIN_MS,
  isFinalWorkspaceOperation,
  pendingWorkspaceDeliveryAttempt,
  sameWorkspaceAuthority,
  settledWorkspaceDeliveryAttempt,
  validWorkspaceOperationSuccessor,
  workspaceAttemptMatchesResult,
  workspaceDeliveryLease,
  workspaceDeliveryAttemptIdentity,
  workspaceOperationResultDigest,
  workspacePreparation,
  workspaceReceiptQuery,
  workspaceSettlementResult,
  workspaceTimestamp,
} from "./workspace-operation-store-support.ts";

import { InMemoryWorkspaceOperationDeliveryAuthority } from "./in-memory-workspace-operation-delivery.ts";
import {
  clone,
  key,
  receiptAuthority,
} from "./in-memory-workspace-operation-state.ts";

/** In-memory conformance authority with the same receipt-first semantics as SQL stores. */
export class InMemoryWorkspaceOperationStore
  extends InMemoryWorkspaceOperationDeliveryAuthority
  implements WorkspaceOperationStore
{
  async prepareWorkspaceOperation(
    input: PrepareWorkspaceOperationInput,
  ): Promise<WorkspaceOperationPreparationResult> {
    validatePrepareWorkspaceOperationInput(input);
    const query = workspaceReceiptQuery(input, "execute");
    const replay = this.replay(query);
    if (replay !== null) return replay;
    const thread = this.threads(input.tenantId, input.threadFence.threadId);
    if (
      thread === null ||
      thread.tenantId !== input.tenantId ||
      thread.spaceId !== input.spaceId ||
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
    const operationKey = key(operation.tenantId, operation.executionId);
    if (this.operations.has(operationKey)) {
      throw new RunStoreError("workspace_operation_identity_conflict");
    }
    const attempt = pendingWorkspaceDeliveryAttempt(
      operation,
      "execute",
      1,
      this.nowMs(),
    );
    const receipt = receiptAuthority(
      operation,
      input.idempotency.requestFingerprint,
      attempt,
      query.phase,
    );
    const prepared = workspacePreparation("committed", operation, attempt);
    const storedOperation = clone(operation);
    const storedRevisions = [clone(operation)];
    const storedAttempts = [clone(attempt)];
    const storedReceipt = clone(receipt);
    this.operations.set(operationKey, storedOperation);
    this.operationRevisions.set(operationKey, storedRevisions);
    this.attempts.set(operationKey, storedAttempts);
    this.receipts.set(workspaceOperationReceiptKey(query), storedReceipt);
    return prepared;
  }

  async prepareWorkspaceOperationAction(
    input: PrepareWorkspaceOperationActionInput,
  ): Promise<WorkspaceOperationPreparationResult> {
    validatePrepareWorkspaceOperationActionInput(input);
    const query = workspaceReceiptQuery(input, input.phase);
    const replay = this.replay(query);
    if (replay !== null) return replay;
    const operationKey = key(input.tenantId, input.executionId);
    const current = this.operations.get(operationKey);
    if (
      current === undefined ||
      current.spaceId !== input.spaceId ||
      current.threadId !== input.threadId
    ) {
      throw new RunStoreError("workspace_operation_not_found");
    }
    const authority = validateWorkspaceOperationDigestAuthority(current);
    if (authority.revision !== input.expectedOperationRevision) {
      throw new RunStoreError("workspace_operation_revision_conflict");
    }
    if (isFinalWorkspaceOperation(authority.status)) {
      const receipt = receiptAuthority(
        authority,
        input.idempotency.requestFingerprint,
        null,
        query.phase,
      );
      const prepared = workspacePreparation("committed", authority, null);
      this.receipts.set(workspaceOperationReceiptKey(query), receipt);
      return prepared;
    }
    const now = this.nowMs();
    const attempts = this.retiredAttemptsForAction(
      operationKey,
      authority,
      input.phase,
      now,
    );
    const attempt = pendingWorkspaceDeliveryAttempt(
      authority,
      input.phase,
      (attempts.at(-1)?.attemptNumber ?? 0) + 1,
      now,
    );
    const nextAttempts = [...attempts, clone(attempt)];
    const receipt = receiptAuthority(
      authority,
      input.idempotency.requestFingerprint,
      attempt,
      query.phase,
    );
    const prepared = workspacePreparation("committed", authority, attempt);
    this.attempts.set(operationKey, nextAttempts);
    this.receipts.set(workspaceOperationReceiptKey(query), receipt);
    return prepared;
  }
}
