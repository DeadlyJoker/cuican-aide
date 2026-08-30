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
  requireOpaqueId,
  requireSafeCode,
  samePeerRoute,
} from "./device-workspace-list-dispatch-support.ts";
import { parseDeviceWorkspaceListDispatchReference } from "./device-workspace-list-dispatch-reference.ts";

export function parseDeviceWorkspaceListPeerDispatchRequest(
  input: unknown,
): DeviceWorkspaceListPeerDispatchRequest {
  const request = requireObject(
    input,
    "device_workspace_peer_dispatch_request_invalid",
  );
  if (
    request.schemaVersion !==
      "crewon.device-workspace-list-peer-dispatch-request.v0" ||
    request.apiVersion !== DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION
  ) {
    throw new ContractValidationError(
      "device_workspace_peer_dispatch_api_unsupported",
    );
  }
  const operation = parseOperation(request.operation);
  const route = parsePeerRoute(request.route);
  const sourceGatewayId = requireOpaqueId(
    request.sourceGatewayId,
    "device_workspace_peer_gateway_id_invalid",
  );
  const sourceWorker = parsePeerSourceWorker(request.sourceWorker);
  const common = {
    schemaVersion:
      "crewon.device-workspace-list-peer-dispatch-request.v0" as const,
    apiVersion: DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION,
    sourceGatewayId,
    sourceWorker,
    route,
  };
  let parsed: DeviceWorkspaceListPeerDispatchRequest;
  if (operation === "execute") {
    requireExactKeys(request, [
      "apiVersion",
      "command",
      "operation",
      "route",
      "schemaVersion",
      "sourceGatewayId",
      "sourceWorker",
    ]);
    const command = parseDeviceWorkspaceListCommand(request.command);
    if (route.deviceId !== command.deviceId) {
      throw new ContractValidationError(
        "device_workspace_peer_dispatch_route_mismatch",
      );
    }
    parsed = { ...common, operation, command };
  } else {
    requireExactKeys(request, [
      "apiVersion",
      "operation",
      "reference",
      "route",
      "schemaVersion",
      "sourceGatewayId",
      "sourceWorker",
    ]);
    const reference = parseDeviceWorkspaceListDispatchReference(
      request.reference,
    );
    if (route.deviceId !== reference.deviceId) {
      throw new ContractValidationError(
        "device_workspace_peer_dispatch_route_mismatch",
      );
    }
    parsed = { ...common, operation, reference };
  }
  requireBoundedJson(
    parsed,
    DEVICE_WORKSPACE_LIST_DISPATCH_MAX_REQUEST_BYTES,
    "device_workspace_peer_dispatch_request_too_large",
  );
  return parsed;
}

export function parseDeviceWorkspaceListPeerDispatchResponse(
  input: unknown,
  expectedRequest: DeviceWorkspaceListPeerDispatchRequest,
): DeviceWorkspaceListPeerDispatchResponse {
  const expected = parseDeviceWorkspaceListPeerDispatchRequest(expectedRequest);
  const response = requireObject(
    input,
    "device_workspace_peer_dispatch_response_invalid",
  );
  requireExactKeys(response, [
    "apiVersion",
    "operation",
    "resolution",
    "route",
    "schemaVersion",
  ]);
  if (
    response.schemaVersion !==
      "crewon.device-workspace-list-peer-dispatch-response.v0" ||
    response.apiVersion !== DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION ||
    response.operation !== expected.operation
  ) {
    throw new ContractValidationError(
      "device_workspace_peer_dispatch_response_mismatch",
    );
  }
  const route = parsePeerRoute(response.route);
  if (!samePeerRoute(route, expected.route)) {
    throw new ContractValidationError(
      "device_workspace_peer_dispatch_route_mismatch",
    );
  }
  const parsed: DeviceWorkspaceListPeerDispatchResponse = {
    schemaVersion: "crewon.device-workspace-list-peer-dispatch-response.v0",
    apiVersion: DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION,
    route,
    operation: expected.operation,
    resolution: parseResolution(
      response.resolution,
      expected.operation === "execute" ? expected.command : expected.reference,
      expected.operation === "execute"
        ? expected.route.connectionEpoch
        : undefined,
    ),
  };
  requireBoundedJson(
    parsed,
    DEVICE_WORKSPACE_LIST_DISPATCH_MAX_RESPONSE_BYTES,
    "device_workspace_peer_dispatch_response_too_large",
  );
  return parsed;
}
