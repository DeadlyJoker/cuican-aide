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

import { InMemoryWorkspaceOperationReadAuthority } from "./in-memory-workspace-operation-read.ts";
import {
  clone,
  key,
  operationDigest,
  same,
  supersededAttempt,
} from "./in-memory-workspace-operation-state.ts";
export class InMemoryWorkspaceOperationDeliveryAuthority extends InMemoryWorkspaceOperationReadAuthority {
  async claimWorkspaceOperationDelivery(
    input: ClaimWorkspaceDeliveryInput,
  ): Promise<WorkspaceDeliveryAttempt> {
    validateClaimWorkspaceDeliveryInput(input);
    const operationKey = key(input.tenantId, input.executionId);
    const operation = this.operations.get(operationKey);
    if (
      operation === undefined ||
      operation.spaceId !== input.spaceId ||
      operation.threadId !== input.threadId ||
      operation.revision !== input.operationRevision
    ) {
      throw new RunStoreError("workspace_delivery_attempt_stale");
    }
    if (
      input.leaseDurationMs <
      operation.command.limits.timeoutMs + WORKSPACE_DELIVERY_COMMIT_MARGIN_MS
    ) {
      throw new RunStoreError("workspace_delivery_lease_duration_invalid");
    }
    const attempts = clone(this.attempts.get(operationKey) ?? []);
    const index = attempts.findIndex(
      (candidate) => candidate.attemptNumber === input.attemptNumber,
    );
    const attempt = attempts[index];
    if (
      attempt === undefined ||
      attempt.operationRevision !== input.operationRevision ||
      attempt.phase !== input.phase ||
      attempt.status === "settled"
    ) {
      throw new RunStoreError("workspace_delivery_attempt_stale");
    }
    const now = this.nowMs();
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
        this.nextLeaseId(),
        now,
        input.leaseDurationMs,
      ),
    });
    attempts[index] = clone(leased);
    const response = clone(leased);
    this.attempts.set(operationKey, attempts);
    return response;
  }

  async listWorkspaceOperationDeliveryAttempts(
    query: WorkspaceDeliveryAttemptQuery,
  ): Promise<readonly WorkspaceDeliveryAttempt[]> {
    validateWorkspaceDeliveryAttemptQuery(query);
    const operation = this.operations.get(
      key(query.tenantId, query.executionId),
    );
    if (
      operation === undefined ||
      operation.spaceId !== query.spaceId ||
      operation.threadId !== query.threadId
    ) {
      return [];
    }
    const attempts = (
      this.attempts.get(key(query.tenantId, query.executionId)) ?? []
    ).map(validateWorkspaceDeliveryAttempt);
    for (let index = 0; index < attempts.length; index += 1) {
      const attempt = attempts[index]!;
      if (
        attempt.attemptNumber !== index + 1 ||
        attempt.tenantId !== operation.tenantId ||
        attempt.spaceId !== operation.spaceId ||
        attempt.threadId !== operation.threadId ||
        attempt.executionId !== operation.executionId ||
        attempt.actionDigest !== operation.command.actionDigest ||
        attempt.commandDigest !== operation.command.commandDigest
      ) {
        throw new RunStoreError("workspace_delivery_stored_state_invalid");
      }
    }
    return clone(
      attempts
        .filter(
          (attempt) =>
            attempt.attemptNumber > query.afterAttemptNumber &&
            (query.view === "audit" || attempt.status === "pending"),
        )
        .slice(0, query.limit),
    );
  }

  async abandonWorkspaceOperationDelivery(
    input: AbandonWorkspaceDeliveryInput,
  ): Promise<WorkspaceDeliveryAttempt> {
    validateAbandonWorkspaceDeliveryInput(input);
    const operationKey = key(input.tenantId, input.executionId);
    const operation = this.operations.get(operationKey);
    if (
      operation === undefined ||
      operation.spaceId !== input.spaceId ||
      operation.threadId !== input.threadId ||
      operation.revision !== input.operationRevision
    ) {
      throw new RunStoreError("workspace_delivery_attempt_stale");
    }
    const attempts = clone(this.attempts.get(operationKey) ?? []);
    const index = attempts.findIndex(
      (candidate) =>
        candidate.attemptNumber === input.deliveryLease.attemptNumber,
    );
    const attempt = attempts[index];
    if (
      attempt === undefined ||
      attempt.status !== "leased" ||
      attempt.lease === null ||
      !same(attempt.lease, input.deliveryLease) ||
      attempt.operationRevision !== operation.revision
    ) {
      throw new RunStoreError("workspace_delivery_lease_mismatch");
    }
    const now = this.nowMs();
    if (Date.parse(attempt.lease.expiresAt) <= now) {
      throw new RunStoreError("workspace_delivery_lease_expired");
    }
    const abandoned = validateWorkspaceDeliveryAttempt({
      ...attempt,
      status: "settled",
      settlement: {
        kind: "abandoned",
        resolutionStatus: null,
        resultRevision: operation.revision,
        resultDigest: operationDigest(operation),
        settledAt: workspaceTimestamp(now),
      },
    });
    attempts[index] = clone(abandoned);
    const response = clone(abandoned);
    this.attempts.set(operationKey, attempts);
    return response;
  }

  async settleWorkspaceOperationDelivery(
    input: CommitWorkspaceOperationResolutionInput,
  ): Promise<WorkspaceDeliverySettlementResult> {
    validateCommitWorkspaceOperationResolutionInput(input);
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
    const resolution = validateWorkspaceListResolution(
      input.resolution,
      authority.command,
    );
    const attempts = clone(this.attempts.get(operationKey) ?? []);
    const index = attempts.findIndex(
      (candidate) =>
        candidate.attemptNumber === input.deliveryLease.attemptNumber,
    );
    const attempt = attempts[index];
    if (
      attempt === undefined ||
      attempt.lease === null ||
      !same(attempt.lease, input.deliveryLease) ||
      attempt.operationRevision !== input.expectedOperationRevision
    ) {
      throw new RunStoreError("workspace_delivery_lease_mismatch");
    }
    if (attempt.status === "settled") {
      const settlement = attempt.settlement;
      if (settlement === null) {
        throw new RunStoreError("workspace_delivery_stored_state_invalid");
      }
      const revisions = this.operationRevisions.get(operationKey) ?? [];
      const frozen = validateWorkspaceOperationDigestAuthority(
        revisions[settlement.resultRevision - 1],
      );
      if (
        operationDigest(frozen) !== settlement.resultDigest ||
        !this.validOperationRevisionChain(operationKey, frozen, authority)
      ) {
        throw new RunStoreError("workspace_delivery_stored_state_invalid");
      }
      if (settlement.kind === "resolution") {
        if (
          frozen.resolution === null ||
          !same(frozen.resolution, resolution) ||
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
    if (authority.revision !== input.expectedOperationRevision) {
      const revisions = this.operationRevisions.get(operationKey) ?? [];
      const winner = validateWorkspaceOperationDigestAuthority(
        revisions[attempt.operationRevision],
      );
      if (
        winner.revision === attempt.operationRevision + 1 &&
        this.validOperationRevisionChain(operationKey, winner, authority)
      ) {
        const lost = supersededAttempt(attempt, this.nowMs(), winner);
        attempts[index] = lost;
        const outcome = workspaceSettlementResult("lostRace", winner, lost);
        const storedAttempts = clone(attempts);
        this.attempts.set(operationKey, storedAttempts);
        return outcome;
      }
      throw new RunStoreError("workspace_operation_revision_conflict");
    }
    if (
      attempt.status !== "leased" ||
      attempt.operationRevision !== authority.revision
    ) {
      throw new RunStoreError("workspace_delivery_lease_mismatch");
    }
    const now = this.nowMs();
    if (Date.parse(attempt.lease.expiresAt) <= now) {
      throw new RunStoreError("workspace_delivery_lease_expired");
    }
    const next = validateWorkspaceOperationRecord({
      ...authority,
      revision: authority.revision + 1,
      status: resolution.status,
      resolution,
    });
    attempts[index] = validateWorkspaceDeliveryAttempt({
      ...attempt,
      status: "settled",
      settlement: {
        kind: "resolution",
        resolutionStatus: resolution.status,
        resultRevision: next.revision,
        resultDigest: operationDigest(next),
        settledAt: workspaceTimestamp(now),
      },
    });
    for (let otherIndex = 0; otherIndex < attempts.length; otherIndex += 1) {
      const other = attempts[otherIndex]!;
      if (
        otherIndex !== index &&
        other.status !== "settled" &&
        other.operationRevision === authority.revision
      ) {
        attempts[otherIndex] = supersededAttempt(other, now, next);
      }
    }
    const nextRevisions = [
      ...(this.operationRevisions.get(operationKey) ?? []),
      clone(next),
    ];
    const outcome = workspaceSettlementResult(
      "committed",
      next,
      attempts[index]!,
    );
    const storedOperation = clone(next);
    const storedAttempts = clone(attempts);
    this.operations.set(operationKey, storedOperation);
    this.operationRevisions.set(operationKey, nextRevisions);
    this.attempts.set(operationKey, storedAttempts);
    return outcome;
  }
}
