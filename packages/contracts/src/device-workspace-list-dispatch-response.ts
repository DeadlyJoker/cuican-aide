import { ContractValidationError } from "./contract-validation-error.ts";
import { parseDeviceWorkspaceListCommand } from "./device-protocol-workspace.ts";
import {
  DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION,
  DEVICE_WORKSPACE_LIST_DISPATCH_MAX_ERROR_BYTES,
  DEVICE_WORKSPACE_LIST_DISPATCH_MAX_REQUEST_BYTES,
  DEVICE_WORKSPACE_LIST_DISPATCH_MAX_RESPONSE_BYTES,
  type DeviceWorkspaceListDispatchError,
  type DeviceWorkspaceListDispatchReference,
  type DeviceWorkspaceListPeerDispatchRequest,
  type DeviceWorkspaceListPeerDispatchResponse,
  type DeviceWorkspaceListWorkerDispatchRequest,
  type DeviceWorkspaceListWorkerDispatchResponse,
} from "./device-workspace-list-dispatch-types.ts";
import {
  parseOperation,
  parsePeerRoute,
  parsePeerSourceWorker,
  parseResolution,
  requireBoundedJson,
  requireExactKeys,
  requireObject,
  requireSafeCode,
  samePeerRoute,
} from "./device-workspace-list-dispatch-support.ts";
import { parseDeviceWorkspaceListWorkerDispatchRequest } from "./device-workspace-list-dispatch-command.ts";

export function parseDeviceWorkspaceListWorkerDispatchResponse(
  input: unknown,
  expectedRequest: DeviceWorkspaceListWorkerDispatchRequest,
): DeviceWorkspaceListWorkerDispatchResponse {
  const expected =
    parseDeviceWorkspaceListWorkerDispatchRequest(expectedRequest);
  const response = requireObject(
    input,
    "device_workspace_dispatch_response_invalid",
  );
  requireExactKeys(response, [
    "apiVersion",
    "operation",
    "resolution",
    "schemaVersion",
  ]);
  if (
    response.schemaVersion !==
      "crewon.device-workspace-list-dispatch-response.v0" ||
    response.apiVersion !== DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION ||
    response.operation !== expected.operation
  ) {
    throw new ContractValidationError(
      "device_workspace_dispatch_response_mismatch",
    );
  }
  const parsed: DeviceWorkspaceListWorkerDispatchResponse = {
    schemaVersion: "crewon.device-workspace-list-dispatch-response.v0",
    apiVersion: DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION,
    operation: expected.operation,
    resolution: parseResolution(
      response.resolution,
      expected.operation === "execute" ? expected.command : expected.reference,
    ),
  };
  requireBoundedJson(
    parsed,
    DEVICE_WORKSPACE_LIST_DISPATCH_MAX_RESPONSE_BYTES,
    "device_workspace_dispatch_response_too_large",
  );
  return parsed;
}

export function parseDeviceWorkspaceListDispatchError(
  input: unknown,
): DeviceWorkspaceListDispatchError {
  const error = requireObject(input, "device_workspace_dispatch_error_invalid");
  requireExactKeys(error, [
    "apiVersion",
    "certainty",
    "code",
    "retryable",
    "schemaVersion",
  ]);
  if (
    error.schemaVersion !== "crewon.device-workspace-list-dispatch-error.v0" ||
    error.apiVersion !== DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION ||
    typeof error.retryable !== "boolean" ||
    (error.certainty !== "notSent" && error.certainty !== "possiblySent")
  ) {
    throw new ContractValidationError(
      "device_workspace_dispatch_error_invalid",
    );
  }
  const parsed: DeviceWorkspaceListDispatchError = {
    schemaVersion: "crewon.device-workspace-list-dispatch-error.v0",
    apiVersion: DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION,
    code: requireSafeCode(
      error.code,
      "device_workspace_dispatch_error_invalid",
    ),
    retryable: error.retryable,
    certainty: error.certainty,
  };
  requireBoundedJson(
    parsed,
    DEVICE_WORKSPACE_LIST_DISPATCH_MAX_ERROR_BYTES,
    "device_workspace_dispatch_error_too_large",
  );
  return parsed;
}
