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
  workspaceMutationResult,
  workspaceOperationResultDigest,
  workspacePreparation,
  workspaceReceiptQuery,
  workspaceSettlementResult,
  workspaceTimestamp,
} from "./workspace-operation-store-support.ts";

import {
  InMemoryWorkspaceOperationState,
  clone,
  compareRawUtf8,
  key,
  receiptAuthority,
  requireLocator,
} from "./in-memory-workspace-operation-state.ts";
export class InMemoryWorkspaceOperationReadAuthority extends InMemoryWorkspaceOperationState {
  async loadWorkspaceOperationReceipt(
    query: WorkspaceOperationReceiptQuery,
  ): Promise<WorkspaceOperationMutationResult | null> {
    validateWorkspaceOperationReceiptQuery(query);
    return this.replay(query);
  }

  async loadWorkspaceOperation(input: {
    tenantId: string;
    spaceId: string;
    threadId: string;
    executionId: string;
  }): Promise<WorkspaceOperationRecord | null> {
    requireLocator(input);
    const operation = this.operations.get(
      key(input.tenantId, input.executionId),
    );
    if (
      operation === undefined ||
      operation.spaceId !== input.spaceId ||
      operation.threadId !== input.threadId
    ) {
      return null;
    }
    return clone(validateWorkspaceOperationRecord(operation));
  }

  async loadWorkspaceOperationSnapshot(
    locatorInput: WorkspaceOperationLocator,
  ): Promise<WorkspaceOperationSnapshot | null> {
    const locator = validateWorkspaceOperationLocator(locatorInput);
    const operationKey = key(locator.tenantId, locator.executionId);
    const operation = this.operations.get(operationKey);
    if (
      operation === undefined ||
      operation.spaceId !== locator.spaceId ||
      operation.threadId !== locator.threadId
    ) {
      return null;
    }
    const revisions = this.operationRevisions.get(operationKey) ?? [];
    const headRevision = revisions[operation.revision - 1];
    if (headRevision === undefined) {
      throw new RunStoreError("workspace_operation_stored_state_invalid");
    }
    return clone(
      workspaceOperationSnapshotAuthority(
        operation,
        headRevision,
        revisions.at(-1)?.revision ?? null,
      ),
    );
  }

  async listWorkspaceOperationEvents(
    queryInput: WorkspaceOperationEventQuery,
  ): Promise<readonly WorkspaceOperationEvent[]> {
    const query = validateWorkspaceOperationEventQuery(queryInput);
    const operationKey = key(query.tenantId, query.executionId);
    const operation = this.operations.get(operationKey);
    if (
      operation === undefined ||
      operation.spaceId !== query.spaceId ||
      operation.threadId !== query.threadId
    ) {
      return [];
    }
    const revisions = this.operationRevisions.get(operationKey) ?? [];
    const headRevision = revisions[operation.revision - 1];
    if (headRevision === undefined) {
      throw new RunStoreError("workspace_operation_stored_state_invalid");
    }
    return clone(
      workspaceOperationEventPageAuthority(
        operation,
        headRevision,
        revisions.at(-1)?.revision ?? null,
        query.afterSequence === 0
          ? null
          : (revisions[query.afterSequence - 1] ?? null),
        revisions.slice(query.afterSequence, query.afterSequence + query.limit),
        query,
      ),
    );
  }

  async listWorkspaceOperations(
    queryInput: WorkspaceOperationListQuery,
  ): Promise<WorkspaceOperationListPage> {
    const query = validateWorkspaceOperationListQuery(queryInput);
    const candidates = [...this.operations.values()]
      .filter(
        (operation) =>
          operation.tenantId === query.tenantId &&
          operation.spaceId === query.spaceId &&
          operation.threadId === query.threadId &&
          (query.afterExecutionId === null ||
            compareRawUtf8(operation.executionId, query.afterExecutionId) > 0),
      )
      .sort((left, right) =>
        compareRawUtf8(left.executionId, right.executionId),
      )
      .slice(0, query.limit + 1)
      .map((operation) => {
        const revisions =
          this.operationRevisions.get(
            key(operation.tenantId, operation.executionId),
          ) ?? [];
        const headRevision = revisions[operation.revision - 1];
        if (headRevision === undefined) {
          throw new RunStoreError("workspace_operation_stored_state_invalid");
        }
        return workspaceOperationSnapshotAuthority(
          operation,
          headRevision,
          revisions.at(-1)?.revision ?? null,
        ).operation;
      });
    return clone(workspaceOperationListPageAuthority(candidates, query));
  }
}
