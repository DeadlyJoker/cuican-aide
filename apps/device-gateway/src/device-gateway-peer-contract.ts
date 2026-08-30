import {
  parseDeviceExecutionCommand,
  type DeviceDispatchOperation,
  type DeviceExecutionCommand,
} from "@crewon/contracts";

import {
  parseDeviceConnectionRoute,
  validateGatewayId,
  type DeviceConnectionRoute,
} from "./device-connection-route-store.ts";
import { DeviceGatewayError } from "./device-gateway-error.ts";

export const DEVICE_GATEWAY_PEER_DISPATCH_PATH =
  "/gateway/v1/device-dispatch" as const;

export type DeviceGatewayPeerDispatchRequest = Readonly<{
  schemaVersion: "crewon.device-peer-dispatch-request.v0";
  sourceGatewayId: string;
  route: DeviceConnectionRoute;
  operation: DeviceDispatchOperation;
  command: DeviceExecutionCommand;
}>;

export function parseDeviceGatewayPeerDispatchRequest(
  input: unknown,
): DeviceGatewayPeerDispatchRequest {
  const value = requireObject(input);
  requireExactKeys(value, [
    "command",
    "operation",
    "route",
    "schemaVersion",
    "sourceGatewayId",
  ]);
  if (value.schemaVersion !== "crewon.device-peer-dispatch-request.v0") {
    throw new DeviceGatewayError("device_gateway_peer_request_invalid");
  }
  const operation = requireOperation(value.operation);
  const command = parseDeviceExecutionCommand(value.command);
  const route = parseDeviceConnectionRoute(value.route);
  if (route.deviceId !== command.deviceId) {
    throw new DeviceGatewayError("device_gateway_peer_route_mismatch");
  }
  return {
    schemaVersion: "crewon.device-peer-dispatch-request.v0",
    sourceGatewayId: validateGatewayId(value.sourceGatewayId),
    route,
    operation,
    command,
  };
}

function requireOperation(value: unknown): DeviceDispatchOperation {
  if (value !== "execute" && value !== "reconcile" && value !== "cancel") {
    throw new DeviceGatewayError("device_gateway_peer_operation_invalid");
  }
  return value;
}

function requireObject(value: unknown): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new DeviceGatewayError("device_gateway_peer_request_invalid");
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new DeviceGatewayError("device_gateway_peer_request_invalid");
  }
}
