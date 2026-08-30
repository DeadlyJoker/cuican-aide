import { createHash } from "node:crypto";

import {
  RunStoreError,
  canonicalWorkspaceOperationResult,
  validateWorkspaceDeliveryAttempt,
  validateWorkspaceDeliverySettlementResult,
  validateWorkspaceOperationMutationResult,
  validateWorkspaceOperationPreparationResult,
  validateWorkspaceOperationRecord,
  type WorkspaceDeliveryAttempt,
  type WorkspaceDeliverySettlementResult,
  type WorkspaceOperationMutationResult,
  type WorkspaceOperationPreparationResult,
  type WorkspaceOperationReceiptQuery,
  type WorkspaceOperationRecord,
} from "@crewon/application";

export const WORKSPACE_DELIVERY_COMMIT_MARGIN_MS = 5_000;

export function workspaceOperationResultDigest(
  operation: WorkspaceOperationRecord,
): string {
  return `sha256:${createHash("sha256")
    .update(canonicalWorkspaceOperationResult(operation), "utf8")
    .digest("hex")}`;
}

export function workspaceDeliveryAttemptIdentity(
  input: WorkspaceDeliveryAttempt,
): string {
  const attempt = validateWorkspaceDeliveryAttempt(input);
  return JSON.stringify({
    tenantId: attempt.tenantId,
    spaceId: attempt.spaceId,
    threadId: attempt.threadId,
    executionId: attempt.executionId,
    attemptNumber: attempt.attemptNumber,
    operationRevision: attempt.operationRevision,
    phase: attempt.phase,
    actionDigest: attempt.actionDigest,
    commandDigest: attempt.commandDigest,
    createdAt: attempt.createdAt,
  });
}

export function validWorkspaceOperationSuccessor(
  previousInput: WorkspaceOperationRecord,
  nextInput: WorkspaceOperationRecord,
): boolean {
  const previous = validateWorkspaceOperationRecord(previousInput);
  const next = validateWorkspaceOperationRecord(nextInput);
  if (
    previous.revision + 1 !== next.revision ||
    previous.status === "completed" ||
    previous.status === "failed" ||
    previous.status === "canceled" ||
    next.status === "prepared" ||
    next.resolution === null
  ) {
    return false;
  }
  return sameWorkspaceAuthority(
    validateWorkspaceOperationRecord({
      ...previous,
      revision: next.revision,
      status: next.status,
      resolution: next.resolution,
    }),
    next,
  );
}

export function sameWorkspaceAuthority(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function pendingWorkspaceDeliveryAttempt(
  operation: WorkspaceOperationRecord,
  phase: WorkspaceDeliveryAttempt["phase"],
  attemptNumber: number,
  now: number,
): WorkspaceDeliveryAttempt {
  return validateWorkspaceDeliveryAttempt({
    schemaVersion: "crewon.workspace-delivery-attempt.v0",
    tenantId: operation.tenantId,
    spaceId: operation.spaceId,
    threadId: operation.threadId,
    executionId: operation.executionId,
    attemptNumber,
    operationRevision: operation.revision,
    phase,
    status: "pending",
    actionDigest: operation.command.actionDigest,
    commandDigest: operation.command.commandDigest,
    createdAt: workspaceTimestamp(now),
    lease: null,
    settlement: null,
  });
}

export function workspaceDeliveryLease(
  attempt: WorkspaceDeliveryAttempt,
  ownerId: string,
  leaseId: string,
  now: number,
  durationMs: number,
): NonNullable<WorkspaceDeliveryAttempt["lease"]> {
  const expiresAt = now + durationMs;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new RunStoreError("workspace_delivery_lease_expiry_invalid");
  }
  return {
    schemaVersion: "crewon.workspace-delivery-lease.v0",
    executionId: attempt.executionId,
    attemptNumber: attempt.attemptNumber,
    phase: attempt.phase,
    ownerId,
    leaseId,
    epoch: 1,
    leasedAt: workspaceTimestamp(now),
    expiresAt: workspaceTimestamp(expiresAt),
  };
}

export function settledWorkspaceDeliveryAttempt(
  attempt: WorkspaceDeliveryAttempt,
  kind: "resolution" | "superseded" | "leaseExpired" | "abandoned",
  operation: WorkspaceOperationRecord,
  now: number,
): WorkspaceDeliveryAttempt {
  return validateWorkspaceDeliveryAttempt({
    ...attempt,
    status: "settled",
    settlement: {
      kind,
      resolutionStatus: kind === "resolution" ? operation.status : null,
      settledAt: workspaceTimestamp(now),
      resultRevision: operation.revision,
      resultDigest: workspaceOperationResultDigest(operation),
    },
  });
}

export function validateWorkspaceAttemptScope(
  attempt: WorkspaceDeliveryAttempt,
  operation: WorkspaceOperationRecord,
): void {
  if (
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

export function validateWorkspaceAttemptTransition(
  previous: WorkspaceDeliveryAttempt,
  next: WorkspaceDeliveryAttempt,
): void {
  if (
    workspaceDeliveryAttemptIdentity(previous) !==
      workspaceDeliveryAttemptIdentity(next) ||
    previous.status === "settled" ||
    (previous.status === "leased" && next.status !== "settled")
  ) {
    throw new RunStoreError("workspace_delivery_attempt_transition_invalid");
  }
}

export function requireWorkspaceExactLease(
  attempt: WorkspaceDeliveryAttempt,
  lease: NonNullable<WorkspaceDeliveryAttempt["lease"]>,
): void {
  if (
    attempt.lease === null ||
    !sameWorkspaceAuthority(attempt.lease, lease) ||
    (attempt.status !== "leased" && attempt.status !== "settled")
  ) {
    throw new RunStoreError("workspace_delivery_lease_mismatch");
  }
}

export function workspaceAttemptMatchesResult(
  attempt: WorkspaceDeliveryAttempt,
  operation: WorkspaceOperationRecord,
  digest: string,
): boolean {
  if (attempt.status !== "settled") {
    return (
      operation.revision === attempt.operationRevision &&
      (operation.status === "prepared" ||
        operation.status === "unknownOutcome") &&
      workspaceOperationResultDigest(operation) === digest
    );
  }
  return (
    attempt.settlement !== null &&
    attempt.settlement.resultRevision === operation.revision &&
    attempt.settlement.resultDigest === digest &&
    (attempt.settlement.kind !== "resolution" ||
      attempt.settlement.resolutionStatus === operation.status)
  );
}

export function workspacePreparation(
  disposition: WorkspaceOperationPreparationResult["disposition"],
  operation: WorkspaceOperationRecord,
  deliveryAttempt: WorkspaceDeliveryAttempt | null,
): WorkspaceOperationPreparationResult {
  return validateWorkspaceOperationPreparationResult({
    disposition,
    operation,
    deliveryAttempt,
  });
}

export function workspaceSettlementResult(
  outcome: WorkspaceDeliverySettlementResult["outcome"],
  operation: WorkspaceOperationRecord,
  deliveryAttempt: WorkspaceDeliveryAttempt,
): WorkspaceDeliverySettlementResult {
  return validateWorkspaceDeliverySettlementResult({
    outcome,
    operation,
    deliveryAttempt,
  });
}

export function workspaceMutationResult(
  disposition: WorkspaceOperationMutationResult["disposition"],
  operation: WorkspaceOperationRecord,
): WorkspaceOperationMutationResult {
  return validateWorkspaceOperationMutationResult({ disposition, operation });
}

export function workspaceReceiptQuery(
  input: {
    tenantId: string;
    spaceId: string;
    idempotency: WorkspaceOperationReceiptQuery["idempotency"];
  },
  phase: WorkspaceOperationReceiptQuery["phase"],
): WorkspaceOperationReceiptQuery {
  return {
    tenantId: input.tenantId,
    spaceId: input.spaceId,
    phase,
    idempotency: input.idempotency,
  };
}

export function workspaceTimestamp(now: number): string {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new RunStoreError("workspace_delivery_timestamp_invalid");
  }
  try {
    return new Date(now).toISOString();
  } catch (error) {
    throw new RunStoreError("workspace_delivery_timestamp_invalid", {
      cause: error,
    });
  }
}

export function isFinalWorkspaceOperation(
  status: WorkspaceOperationRecord["status"],
): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}
