import {
  RUNTIME_WORKER_WORKSPACE_WIRE_LIMITS,
  type RuntimeWorkerWorkspaceOperation,
} from "./runtime-worker-workspace-types.ts";
import { parseRuntimeWorkerFrozenWorkspaceCommand } from "./runtime-worker-workspace-freeze.ts";

import {
  bounded,
  digest,
  exact,
  identity,
  integer,
  object,
  opaqueId,
  parseDeliveryLease,
  parseLimits,
  parsePhase,
  parseResolution,
  positiveInteger,
  safeCode,
  timestamp,
} from "./runtime-worker-workspace-support.ts";

export function parseRuntimeWorkerWorkspaceOperation(
  input: unknown,
): RuntimeWorkerWorkspaceOperation {
  bounded(
    input,
    RUNTIME_WORKER_WORKSPACE_WIRE_LIMITS.dispatchRequestBytes,
    "runtime_workspace_operation_too_large",
  );
  const operation = object(input, "runtime_workspace_operation_invalid");
  exact(operation, [
    "actorId",
    "command",
    "executionId",
    "expectedThreadRevision",
    "idempotencyKey",
    "principalId",
    "resolution",
    "revision",
    "schemaVersion",
    "spaceId",
    "status",
    "tenantId",
    "threadId",
  ]);
  if (operation.schemaVersion !== "crewon.workspace-operation.v0") {
    throw new ContractValidationError("runtime_workspace_operation_invalid");
  }
  const command = parseRuntimeWorkerFrozenWorkspaceCommand(operation.command);
  const resolution =
    operation.resolution === null
      ? null
      : parseResolution(operation.resolution, command);
  if (
    (operation.status !== "prepared" &&
      operation.status !== "completed" &&
      operation.status !== "failed" &&
      operation.status !== "canceled" &&
      operation.status !== "unknownOutcome") ||
    (operation.status === "prepared") !== (resolution === null) ||
    (resolution !== null && resolution.status !== operation.status)
  ) {
    throw new ContractValidationError("runtime_workspace_operation_invalid");
  }
  const executionId = opaqueId(operation.executionId);
  if (command.executionId !== executionId) {
    throw new ContractValidationError("runtime_workspace_operation_mismatch");
  }
  return {
    schemaVersion: "crewon.workspace-operation.v0",
    tenantId: opaqueId(operation.tenantId),
    spaceId: opaqueId(operation.spaceId),
    threadId: opaqueId(operation.threadId),
    expectedThreadRevision: positiveInteger(operation.expectedThreadRevision),
    principalId: identity(operation.principalId),
    actorId: identity(operation.actorId),
    idempotencyKey: identity(operation.idempotencyKey, 256),
    executionId,
    revision: positiveInteger(operation.revision),
    status: operation.status,
    command,
    resolution,
  };
}
import { ContractValidationError } from "./contract-validation-error.ts";
