import {
  RUNTIME_WORKER_WORKSPACE_API_VERSION,
  RUNTIME_WORKER_WORKSPACE_WIRE_LIMITS,
  type RuntimeWorkerWorkspaceDispatchError,
  type RuntimeWorkerWorkspaceDispatchRequest,
  type RuntimeWorkerWorkspaceDispatchResponse,
  type RuntimeWorkerWorkspacePhase,
} from "./runtime-worker-workspace-types.ts";
import { parseRuntimeWorkerWorkspaceOperation } from "./runtime-worker-workspace-operation.ts";

import {
  bounded,
  digest,
  exact,
  envelope,
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

export function parseRuntimeWorkerWorkspaceDispatchRequest(
  input: unknown,
): RuntimeWorkerWorkspaceDispatchRequest {
  bounded(
    input,
    RUNTIME_WORKER_WORKSPACE_WIRE_LIMITS.dispatchRequestBytes,
    "runtime_workspace_dispatch_request_too_large",
  );
  const request = object(input, "runtime_workspace_dispatch_request_invalid");
  exact(request, [
    "apiVersion",
    "deliveryLease",
    "operation",
    "phase",
    "schemaVersion",
  ]);
  envelope(
    request,
    "crewon.runtime-worker-workspace-dispatch-request.v0",
    "runtime_workspace_dispatch_api_unsupported",
  );
  const phase = parsePhase(request.phase);
  const operation = parseRuntimeWorkerWorkspaceOperation(request.operation);
  const deliveryLease = parseDeliveryLease(request.deliveryLease);
  if (
    deliveryLease.phase !== phase ||
    deliveryLease.executionId !== operation.executionId ||
    (phase === "execute" &&
      (operation.revision !== 1 || operation.status !== "prepared")) ||
    (phase !== "execute" &&
      operation.status !== "prepared" &&
      operation.status !== "unknownOutcome") ||
    (operation.status === "prepared" && operation.revision !== 1) ||
    (operation.status === "unknownOutcome" && operation.revision < 2)
  ) {
    throw new ContractValidationError(
      "runtime_workspace_dispatch_request_mismatch",
    );
  }
  const parsed: RuntimeWorkerWorkspaceDispatchRequest = {
    schemaVersion: "crewon.runtime-worker-workspace-dispatch-request.v0",
    apiVersion: RUNTIME_WORKER_WORKSPACE_API_VERSION,
    phase,
    operation,
    deliveryLease,
  };
  bounded(
    parsed,
    RUNTIME_WORKER_WORKSPACE_WIRE_LIMITS.dispatchRequestBytes,
    "runtime_workspace_dispatch_request_too_large",
  );
  return parsed;
}

export function parseRuntimeWorkerWorkspaceDispatchResponse(
  input: unknown,
  expectedRequest: RuntimeWorkerWorkspaceDispatchRequest,
): RuntimeWorkerWorkspaceDispatchResponse {
  bounded(
    input,
    RUNTIME_WORKER_WORKSPACE_WIRE_LIMITS.dispatchResponseBytes,
    "runtime_workspace_dispatch_response_too_large",
  );
  const expected = parseRuntimeWorkerWorkspaceDispatchRequest(expectedRequest);
  const response = object(input, "runtime_workspace_dispatch_response_invalid");
  exact(response, ["apiVersion", "phase", "resolution", "schemaVersion"]);
  envelope(
    response,
    "crewon.runtime-worker-workspace-dispatch-response.v0",
    "runtime_workspace_dispatch_api_unsupported",
  );
  if (response.phase !== expected.phase) {
    throw new ContractValidationError(
      "runtime_workspace_dispatch_response_mismatch",
    );
  }
  const resolution = parseResolution(
    response.resolution,
    expected.operation.command,
  );
  const parsed: RuntimeWorkerWorkspaceDispatchResponse = {
    schemaVersion: "crewon.runtime-worker-workspace-dispatch-response.v0",
    apiVersion: RUNTIME_WORKER_WORKSPACE_API_VERSION,
    phase: expected.phase,
    resolution,
  };
  bounded(
    parsed,
    RUNTIME_WORKER_WORKSPACE_WIRE_LIMITS.dispatchResponseBytes,
    "runtime_workspace_dispatch_response_too_large",
  );
  return parsed;
}

export function parseRuntimeWorkerWorkspaceDispatchError(
  input: unknown,
  expectedPhase: RuntimeWorkerWorkspacePhase,
): RuntimeWorkerWorkspaceDispatchError {
  bounded(
    input,
    RUNTIME_WORKER_WORKSPACE_WIRE_LIMITS.dispatchErrorBytes,
    "runtime_workspace_dispatch_error_too_large",
  );
  const error = object(input, "runtime_workspace_dispatch_error_invalid");
  exact(error, [
    "apiVersion",
    "certainty",
    "code",
    "phase",
    "retryable",
    "schemaVersion",
  ]);
  envelope(
    error,
    "crewon.runtime-worker-workspace-dispatch-error.v0",
    "runtime_workspace_dispatch_api_unsupported",
  );
  const phase = parsePhase(error.phase);
  if (
    phase !== expectedPhase ||
    typeof error.retryable !== "boolean" ||
    (error.certainty !== "notSent" && error.certainty !== "possiblySent")
  ) {
    throw new ContractValidationError(
      "runtime_workspace_dispatch_error_invalid",
    );
  }
  const parsed: RuntimeWorkerWorkspaceDispatchError = {
    schemaVersion: "crewon.runtime-worker-workspace-dispatch-error.v0",
    apiVersion: RUNTIME_WORKER_WORKSPACE_API_VERSION,
    phase,
    code: safeCode(error.code),
    retryable: error.retryable,
    certainty: error.certainty,
  };
  bounded(
    parsed,
    RUNTIME_WORKER_WORKSPACE_WIRE_LIMITS.dispatchErrorBytes,
    "runtime_workspace_dispatch_error_too_large",
  );
  return parsed;
}
import { ContractValidationError } from "./contract-validation-error.ts";
