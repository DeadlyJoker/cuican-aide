import { ContractValidationError } from "./contract-validation-error.ts";
import {
  RUNTIME_WORKER_WORKSPACE_API_VERSION,
  RUNTIME_WORKER_WORKSPACE_WIRE_LIMITS,
  type RuntimeWorkerWorkspaceFreezeCommandError,
  type RuntimeWorkerWorkspaceFreezeCommandRequest,
  type RuntimeWorkerWorkspaceFreezeCommandResponse,
  type RuntimeWorkerFrozenWorkspaceCommand,
} from "./runtime-worker-workspace-types.ts";

import {
  bounded,
  digest,
  exact,
  envelope,
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

export function parseRuntimeWorkerWorkspaceFreezeCommandRequest(
  input: unknown,
): RuntimeWorkerWorkspaceFreezeCommandRequest {
  bounded(
    input,
    RUNTIME_WORKER_WORKSPACE_WIRE_LIMITS.freezeRequestBytes,
    "runtime_workspace_freeze_request_too_large",
  );
  const request = object(input, "runtime_workspace_freeze_request_invalid");
  exact(request, [
    "actor",
    "apiVersion",
    "idempotencyKey",
    "maxEntries",
    "schemaVersion",
    "spaceId",
    "tenantId",
    "threadFence",
  ]);
  envelope(
    request,
    "crewon.runtime-worker-workspace-freeze-request.v0",
    "runtime_workspace_freeze_api_unsupported",
  );
  const actor = object(request.actor, "runtime_workspace_actor_invalid");
  exact(actor, ["actorId", "principalId"]);
  const threadFence = object(
    request.threadFence,
    "runtime_workspace_thread_fence_invalid",
  );
  exact(threadFence, ["expectedRevision", "threadId"]);
  const parsed: RuntimeWorkerWorkspaceFreezeCommandRequest = {
    schemaVersion: "crewon.runtime-worker-workspace-freeze-request.v0",
    apiVersion: RUNTIME_WORKER_WORKSPACE_API_VERSION,
    tenantId: opaqueId(request.tenantId),
    spaceId: opaqueId(request.spaceId),
    actor: {
      principalId: identity(actor.principalId),
      actorId: identity(actor.actorId),
    },
    threadFence: {
      threadId: opaqueId(threadFence.threadId),
      expectedRevision: positiveInteger(threadFence.expectedRevision),
    },
    idempotencyKey: identity(request.idempotencyKey, 256),
    maxEntries: integer(
      request.maxEntries,
      1,
      RUNTIME_WORKER_WORKSPACE_WIRE_LIMITS.maxEntries,
    ),
  };
  bounded(
    parsed,
    RUNTIME_WORKER_WORKSPACE_WIRE_LIMITS.freezeRequestBytes,
    "runtime_workspace_freeze_request_too_large",
  );
  return parsed;
}

export function parseRuntimeWorkerWorkspaceFreezeCommandResponse(
  input: unknown,
  expectedRequest: RuntimeWorkerWorkspaceFreezeCommandRequest,
): RuntimeWorkerWorkspaceFreezeCommandResponse {
  bounded(
    input,
    RUNTIME_WORKER_WORKSPACE_WIRE_LIMITS.freezeResponseBytes,
    "runtime_workspace_freeze_response_too_large",
  );
  const expected =
    parseRuntimeWorkerWorkspaceFreezeCommandRequest(expectedRequest);
  const response = object(input, "runtime_workspace_freeze_response_invalid");
  exact(response, ["apiVersion", "command", "schemaVersion"]);
  envelope(
    response,
    "crewon.runtime-worker-workspace-freeze-response.v0",
    "runtime_workspace_freeze_api_unsupported",
  );
  const command = parseRuntimeWorkerFrozenWorkspaceCommand(response.command);
  if (command.limits.maxEntries !== expected.maxEntries) {
    throw new ContractValidationError(
      "runtime_workspace_freeze_response_mismatch",
    );
  }
  const parsed: RuntimeWorkerWorkspaceFreezeCommandResponse = {
    schemaVersion: "crewon.runtime-worker-workspace-freeze-response.v0",
    apiVersion: RUNTIME_WORKER_WORKSPACE_API_VERSION,
    command,
  };
  bounded(
    parsed,
    RUNTIME_WORKER_WORKSPACE_WIRE_LIMITS.freezeResponseBytes,
    "runtime_workspace_freeze_response_too_large",
  );
  return parsed;
}

export function parseRuntimeWorkerWorkspaceFreezeCommandError(
  input: unknown,
): RuntimeWorkerWorkspaceFreezeCommandError {
  bounded(
    input,
    RUNTIME_WORKER_WORKSPACE_WIRE_LIMITS.freezeErrorBytes,
    "runtime_workspace_freeze_error_too_large",
  );
  const error = object(input, "runtime_workspace_freeze_error_invalid");
  exact(error, [
    "apiVersion",
    "certainty",
    "code",
    "retryable",
    "schemaVersion",
  ]);
  envelope(
    error,
    "crewon.runtime-worker-workspace-freeze-error.v0",
    "runtime_workspace_freeze_api_unsupported",
  );
  if (typeof error.retryable !== "boolean" || error.certainty !== "notSent") {
    throw new ContractValidationError("runtime_workspace_freeze_error_invalid");
  }
  return {
    schemaVersion: "crewon.runtime-worker-workspace-freeze-error.v0",
    apiVersion: RUNTIME_WORKER_WORKSPACE_API_VERSION,
    code: safeCode(error.code),
    retryable: error.retryable,
    certainty: "notSent",
  };
}

export function parseRuntimeWorkerFrozenWorkspaceCommand(
  input: unknown,
): RuntimeWorkerFrozenWorkspaceCommand {
  bounded(
    input,
    RUNTIME_WORKER_WORKSPACE_WIRE_LIMITS.freezeResponseBytes,
    "runtime_workspace_command_too_large",
  );
  const command = object(input, "runtime_workspace_command_invalid");
  exact(command, [
    "actionDigest",
    "commandDigest",
    "executionId",
    "incarnationId",
    "limits",
    "policySnapshotId",
    "runtimeBindingId",
    "workspaceBindingId",
  ]);
  return {
    executionId: opaqueId(command.executionId),
    workspaceBindingId: opaqueId(command.workspaceBindingId),
    incarnationId: opaqueId(command.incarnationId),
    runtimeBindingId: opaqueId(command.runtimeBindingId),
    policySnapshotId: opaqueId(command.policySnapshotId),
    actionDigest: digest(command.actionDigest),
    commandDigest: digest(command.commandDigest),
    limits: parseLimits(command.limits),
  };
}
