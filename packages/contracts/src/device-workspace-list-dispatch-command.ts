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
import { parseDeviceWorkspaceListDispatchReference } from "./device-workspace-list-dispatch-reference.ts";

export function parseDeviceWorkspaceListWorkerDispatchRequest(
  input: unknown,
): DeviceWorkspaceListWorkerDispatchRequest {
  const request = requireObject(
    input,
    "device_workspace_dispatch_request_invalid",
  );
  if (
    request.schemaVersion !==
      "crewon.device-workspace-list-dispatch-request.v0" ||
    request.apiVersion !== DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION
  ) {
    throw new ContractValidationError(
      "device_workspace_dispatch_api_unsupported",
    );
  }
  const operation = parseOperation(request.operation);
  const parsed: DeviceWorkspaceListWorkerDispatchRequest =
    operation === "execute"
      ? parseWorkerExecuteRequest(request)
      : parseWorkerReferenceRequest(request, operation);
  requireBoundedJson(
    parsed,
    DEVICE_WORKSPACE_LIST_DISPATCH_MAX_REQUEST_BYTES,
    "device_workspace_dispatch_request_too_large",
  );
  return parsed;
}

function parseWorkerExecuteRequest(
  request: Readonly<Record<string, unknown>>,
): Extract<DeviceWorkspaceListWorkerDispatchRequest, { operation: "execute" }> {
  requireExactKeys(request, [
    "apiVersion",
    "command",
    "operation",
    "schemaVersion",
  ]);
  return {
    schemaVersion: "crewon.device-workspace-list-dispatch-request.v0",
    apiVersion: DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION,
    operation: "execute",
    command: parseDeviceWorkspaceListCommand(request.command),
  };
}

function parseWorkerReferenceRequest<T extends "reconcile" | "cancel">(
  request: Readonly<Record<string, unknown>>,
  operation: T,
): Extract<DeviceWorkspaceListWorkerDispatchRequest, { operation: T }> {
  requireExactKeys(request, [
    "apiVersion",
    "operation",
    "reference",
    "schemaVersion",
  ]);
  return {
    schemaVersion: "crewon.device-workspace-list-dispatch-request.v0",
    apiVersion: DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION,
    operation,
    reference: parseDeviceWorkspaceListDispatchReference(request.reference),
  } as Extract<DeviceWorkspaceListWorkerDispatchRequest, { operation: T }>;
}
