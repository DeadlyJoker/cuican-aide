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

type ReceiptAuthority = Readonly<{
  threadId: string;
  executionId: string;
  actionDigest: string;
  commandDigest: string;
  fingerprint: string;
  attemptNumber: number | null;
  attemptIdentity: string | null;
  phase: WorkspaceOperationReceiptQuery["phase"];
  seedResultRevision: number;
  seedResultDigest: string;
}>;

/** In-memory conformance authority with the same receipt-first semantics as SQL stores. */
export class InMemoryWorkspaceOperationState {
  protected readonly threads: (
    tenantId: string,
    threadId: string,
  ) => ThreadState | null;
  protected readonly operations = new Map<string, WorkspaceOperationRecord>();
  protected readonly operationRevisions = new Map<
    string,
    WorkspaceOperationRecord[]
  >();
  protected readonly receipts = new Map<string, ReceiptAuthority>();
  protected readonly attempts = new Map<string, WorkspaceDeliveryAttempt[]>();
  protected readonly now: () => number;
  protected leaseSequence = 0;
  constructor(
    threads: (tenantId: string, threadId: string) => ThreadState | null,
    now: () => number = Date.now,
  ) {
    this.threads = threads;
    this.now = now;
  }
  protected retiredAttemptsForAction(
    operationKey: string,
    operation: WorkspaceOperationRecord,
    phase: "reconcile" | "cancel",
    now: number,
  ): WorkspaceDeliveryAttempt[] {
    const attempts = clone(this.attempts.get(operationKey) ?? []);
    const relevant = attempts
      .map((attempt, index) => ({ attempt, index }))
      .filter(
        ({ attempt }) =>
          attempt.status !== "settled" &&
          (phase === "reconcile" || attempt.phase === "cancel"),
      );
    for (const { attempt, index } of relevant) {
      if (attempt.status === "leased" && attempt.lease !== null) {
        if (Date.parse(attempt.lease.expiresAt) > now) {
          throw new RunStoreError("workspace_delivery_lease_active");
        }
        attempts[index] = validateWorkspaceDeliveryAttempt({
          ...attempt,
          status: "settled",
          settlement: {
            kind: "leaseExpired",
            resolutionStatus: null,
            resultRevision: operation.revision,
            resultDigest: operationDigest(operation),
            settledAt: workspaceTimestamp(now),
          },
        });
      } else {
        attempts[index] = validateWorkspaceDeliveryAttempt({
          ...attempt,
          status: "settled",
          settlement: {
            kind: "superseded",
            resolutionStatus: null,
            resultRevision: operation.revision,
            resultDigest: operationDigest(operation),
            settledAt: workspaceTimestamp(now),
          },
        });
      }
    }
    return attempts;
  }

  protected nowMs(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new RunStoreError("workspace_delivery_clock_invalid");
    }
    return now;
  }

  protected nextLeaseId(): string {
    this.leaseSequence += 1;
    if (!Number.isSafeInteger(this.leaseSequence)) {
      throw new RunStoreError("workspace_delivery_lease_id_invalid");
    }
    return `workspace-lease-${this.leaseSequence}`;
  }

  protected replay(
    query: WorkspaceOperationReceiptQuery,
  ): WorkspaceOperationPreparationResult | null {
    const receipt = this.receipts.get(workspaceOperationReceiptKey(query));
    if (receipt === undefined) return null;
    if (receipt.fingerprint !== query.idempotency.requestFingerprint) {
      throw new RunStoreError("workspace_operation_idempotency_conflict");
    }
    const operationKey = key(query.tenantId, receipt.executionId);
    const operation = this.operations.get(operationKey);
    if (operation === undefined || operation.spaceId !== query.spaceId) {
      throw new RunStoreError("workspace_operation_stored_state_invalid");
    }
    const authority = validateWorkspaceOperationDigestAuthority(operation);
    const attempts = this.attempts.get(operationKey) ?? [];
    const attempt =
      receipt.attemptNumber === null
        ? null
        : (attempts.find(
            (candidate) => candidate.attemptNumber === receipt.attemptNumber,
          ) ?? null);
    const resultRevision =
      attempt?.settlement?.resultRevision ?? receipt.seedResultRevision;
    const resultDigest =
      attempt?.settlement?.resultDigest ?? receipt.seedResultDigest;
    const revisions = this.operationRevisions.get(operationKey) ?? [];
    const frozen = validateWorkspaceOperationDigestAuthority(
      revisions[resultRevision - 1],
    );
    if (
      receipt.threadId !== authority.threadId ||
      receipt.executionId !== authority.executionId ||
      receipt.actionDigest !== authority.command.actionDigest ||
      receipt.commandDigest !== authority.command.commandDigest ||
      receipt.phase !== query.phase ||
      operationDigest(frozen) !== resultDigest ||
      frozen.revision !== resultRevision ||
      !this.validOperationRevisionChain(operationKey, frozen, authority)
    ) {
      throw new RunStoreError("workspace_operation_stored_state_invalid");
    }
    if (receipt.attemptNumber !== null || receipt.attemptIdentity !== null) {
      if (receipt.attemptNumber === null || receipt.attemptIdentity === null) {
        throw new RunStoreError("workspace_operation_stored_state_invalid");
      }
      if (
        attempt === null ||
        attempt.actionDigest !== receipt.actionDigest ||
        attempt.commandDigest !== receipt.commandDigest ||
        workspaceDeliveryAttemptIdentity(attempt) !== receipt.attemptIdentity ||
        attempt.operationRevision !== receipt.seedResultRevision ||
        attempt.phase !== receipt.phase ||
        !workspaceAttemptMatchesResult(attempt, frozen, resultDigest)
      ) {
        throw new RunStoreError("workspace_operation_stored_state_invalid");
      }
    }
    return workspacePreparation("replayed", frozen, attempt);
  }

  protected validOperationRevisionChain(
    operationKey: string,
    frozen: WorkspaceOperationRecord,
    authority: WorkspaceOperationRecord,
  ): boolean {
    const revisions = this.operationRevisions.get(operationKey) ?? [];
    if (revisions.length < 1) return false;
    for (let index = 0; index < revisions.length; index += 1) {
      const current = validateWorkspaceOperationDigestAuthority(
        revisions[index],
      );
      if (current.revision !== index + 1) return false;
      if (
        index > 0 &&
        !validWorkspaceOperationSuccessor(revisions[index - 1]!, current)
      ) {
        return false;
      }
    }
    return (
      sameWorkspaceAuthority(revisions.at(-1), authority) &&
      sameWorkspaceAuthority(revisions[frozen.revision - 1], frozen)
    );
  }
}

export function compareRawUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function receiptAuthority(
  operation: WorkspaceOperationRecord,
  fingerprint: string,
  attempt: WorkspaceDeliveryAttempt | null,
  phase: WorkspaceOperationReceiptQuery["phase"],
): ReceiptAuthority {
  return {
    threadId: operation.threadId,
    executionId: operation.executionId,
    actionDigest: operation.command.actionDigest,
    commandDigest: operation.command.commandDigest,
    fingerprint,
    attemptNumber: attempt?.attemptNumber ?? null,
    attemptIdentity:
      attempt === null ? null : workspaceDeliveryAttemptIdentity(attempt),
    phase,
    seedResultRevision: operation.revision,
    seedResultDigest: operationDigest(operation),
  };
}

export function supersededAttempt(
  attempt: WorkspaceDeliveryAttempt,
  now: number,
  result: WorkspaceOperationRecord,
): WorkspaceDeliveryAttempt {
  return settledWorkspaceDeliveryAttempt(attempt, "superseded", result, now);
}

export function operationDigest(operation: WorkspaceOperationRecord): string {
  return workspaceOperationResultDigest(operation);
}

export function requireLocator(input: {
  tenantId: string;
  spaceId: string;
  threadId: string;
  executionId: string;
}): void {
  for (const value of Object.values(input)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)) {
      throw new RunStoreError("workspace_operation_locator_invalid");
    }
  }
}

export function key(tenantId: string, executionId: string): string {
  return `${tenantId}\u0000${executionId}`;
}

export function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function clone<T>(input: T): T {
  return structuredClone(input);
}
