import {
  validateClaimWorkspaceDeliveryInput,
  validateWorkspaceDeliveryAttempt,
  validateWorkspaceDeliveryLease,
} from "./workspace-delivery-store-port.ts";
import type {
  CommitWorkspaceOperationResolutionInput,
  PrepareWorkspaceOperationActionInput,
  PrepareWorkspaceOperationInput,
  WorkspaceDeliverySettlementResult,
  WorkspaceOperationMutationResult,
  WorkspaceOperationPreparationResult,
  WorkspaceOperationReceiptQuery,
} from "./workspace-operation-store-port.ts";
import { validateWorkspaceOperationRecord } from "./workspace-operation-record-validation.ts";
import { validateWorkspaceListResolution } from "./workspace-operation-command-validation.ts";
import {
  hasExactKeys,
  idempotency,
  opaqueId,
  positiveInteger,
  workspaceStoreError,
} from "./workspace-operation-validation-common.ts";
export function validateWorkspaceOperationMutationResult(
  input: unknown,
): WorkspaceOperationMutationResult {
  if (
    !hasExactKeys(input, ["disposition", "operation"]) ||
    (input.disposition !== "committed" && input.disposition !== "replayed")
  ) {
    throw workspaceStoreError("workspace_operation_result_invalid");
  }
  return {
    disposition: input.disposition,
    operation: validateWorkspaceOperationRecord(input.operation),
  };
}

export function validateWorkspaceOperationPreparationResult(
  input: unknown,
): WorkspaceOperationPreparationResult {
  if (!hasExactKeys(input, ["deliveryAttempt", "disposition", "operation"])) {
    throw workspaceStoreError("workspace_operation_result_invalid");
  }
  const result = validateWorkspaceOperationMutationResult({
    disposition: input.disposition,
    operation: input.operation,
  });
  const deliveryAttempt =
    input.deliveryAttempt === null
      ? null
      : validateWorkspaceDeliveryAttempt(input.deliveryAttempt);
  if (
    (result.disposition === "replayed" && deliveryAttempt !== null) ||
    (deliveryAttempt !== null &&
      (deliveryAttempt.tenantId !== result.operation.tenantId ||
        deliveryAttempt.spaceId !== result.operation.spaceId ||
        deliveryAttempt.threadId !== result.operation.threadId ||
        deliveryAttempt.executionId !== result.operation.executionId ||
        deliveryAttempt.operationRevision !== result.operation.revision ||
        deliveryAttempt.actionDigest !==
          result.operation.command.actionDigest ||
        deliveryAttempt.commandDigest !==
          result.operation.command.commandDigest))
  ) {
    throw workspaceStoreError("workspace_operation_result_invalid");
  }
  return { ...result, deliveryAttempt };
}

export function validateWorkspaceDeliverySettlementResult(
  input: unknown,
): WorkspaceDeliverySettlementResult {
  if (
    !hasExactKeys(input, ["deliveryAttempt", "operation", "outcome"]) ||
    (input.outcome !== "committed" &&
      input.outcome !== "replayed" &&
      input.outcome !== "lostRace")
  ) {
    throw workspaceStoreError("workspace_delivery_settlement_result_invalid");
  }
  const operation = validateWorkspaceOperationRecord(input.operation);
  const deliveryAttempt = validateWorkspaceDeliveryAttempt(
    input.deliveryAttempt,
  );
  if (
    deliveryAttempt.status !== "settled" ||
    deliveryAttempt.settlement === null ||
    deliveryAttempt.tenantId !== operation.tenantId ||
    deliveryAttempt.spaceId !== operation.spaceId ||
    deliveryAttempt.threadId !== operation.threadId ||
    deliveryAttempt.executionId !== operation.executionId ||
    deliveryAttempt.actionDigest !== operation.command.actionDigest ||
    deliveryAttempt.commandDigest !== operation.command.commandDigest ||
    deliveryAttempt.settlement.resultRevision !== operation.revision ||
    (deliveryAttempt.settlement.kind === "resolution" &&
      deliveryAttempt.settlement.resolutionStatus !== operation.status) ||
    (input.outcome === "lostRace") !==
      (deliveryAttempt.settlement.kind === "superseded") ||
    (input.outcome !== "lostRace" &&
      deliveryAttempt.settlement.kind !== "resolution")
  ) {
    throw workspaceStoreError("workspace_delivery_settlement_result_invalid");
  }
  return { outcome: input.outcome, operation, deliveryAttempt };
}

export function workspaceOperationReceiptKey(
  query: WorkspaceOperationReceiptQuery,
): string {
  validateWorkspaceOperationReceiptQuery(query);
  return [
    query.tenantId,
    query.spaceId,
    query.phase,
    query.idempotency.scope,
    query.idempotency.key,
  ].join("\u0000");
}

export function validateWorkspaceOperationReceiptQuery(
  input: WorkspaceOperationReceiptQuery,
): void {
  opaqueId(input.tenantId);
  opaqueId(input.spaceId);
  if (
    input.phase !== "execute" &&
    input.phase !== "reconcile" &&
    input.phase !== "cancel"
  ) {
    throw workspaceStoreError("workspace_operation_phase_invalid");
  }
  idempotency(input.idempotency);
}

export function validatePrepareWorkspaceOperationInput(
  input: PrepareWorkspaceOperationInput,
): void {
  validateWorkspaceOperationReceiptQuery({
    tenantId: input.tenantId,
    spaceId: input.spaceId,
    phase: "execute",
    idempotency: input.idempotency,
  });
  if (!hasExactKeys(input.threadFence, ["expectedRevision", "threadId"])) {
    throw workspaceStoreError("workspace_operation_thread_fence_invalid");
  }
  opaqueId(input.threadFence.threadId);
  positiveInteger(input.threadFence.expectedRevision);
  const operation = validateWorkspaceOperationRecord(input.operation);
  if (
    operation.tenantId !== input.tenantId ||
    operation.spaceId !== input.spaceId ||
    operation.threadId !== input.threadFence.threadId ||
    operation.expectedThreadRevision !== input.threadFence.expectedRevision ||
    operation.revision !== 1 ||
    operation.status !== "prepared"
  ) {
    throw workspaceStoreError("workspace_operation_prepare_invalid");
  }
}

export function validateCommitWorkspaceOperationResolutionInput(
  input: CommitWorkspaceOperationResolutionInput,
): void {
  opaqueId(input.tenantId);
  opaqueId(input.spaceId);
  opaqueId(input.threadId);
  opaqueId(input.executionId);
  positiveInteger(input.expectedOperationRevision);
  const lease = validateWorkspaceDeliveryLease(input.deliveryLease);
  if (lease.executionId !== input.executionId) {
    throw workspaceStoreError("workspace_delivery_lease_invalid");
  }
  validateWorkspaceListResolution(input.resolution);
}

export function validatePrepareWorkspaceOperationActionInput(
  input: PrepareWorkspaceOperationActionInput,
): void {
  opaqueId(input.tenantId);
  opaqueId(input.spaceId);
  opaqueId(input.threadId);
  opaqueId(input.executionId);
  positiveInteger(input.expectedOperationRevision);
  if (input.phase !== "reconcile" && input.phase !== "cancel") {
    throw workspaceStoreError("workspace_operation_phase_invalid");
  }
  idempotency(input.idempotency);
}

export { validateClaimWorkspaceDeliveryInput };
