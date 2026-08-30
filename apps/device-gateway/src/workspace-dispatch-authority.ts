import { createHash } from "node:crypto";

import {
  DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION,
  parseDeviceWorkspaceListCommand,
  parseDeviceWorkspaceListEventForCommand,
  parseDeviceWorkspaceListWorkerDispatchRequest,
  parseDeviceWorkspaceListWorkerDispatchResponse,
  type DeviceWorkspaceListCommand,
  type DeviceWorkspaceListDispatchResolution,
  type DeviceWorkspaceListEvent,
  type DeviceWorkspaceListPeerRoute,
} from "@crewon/contracts";

import { DeviceGatewayError } from "./device-gateway-error.ts";

export type WorkspaceDispatchAcceptedEvent = Extract<
  DeviceWorkspaceListEvent,
  { type: "workspace_list.accepted" }
>;
export type WorkspaceDispatchTerminalEvent = Exclude<
  DeviceWorkspaceListEvent,
  WorkspaceDispatchAcceptedEvent
>;

export type WorkspaceDispatchAuthorityRecord = Readonly<{
  commandKind: "workspaceList";
  executionId: string;
  fingerprint: string;
  command: DeviceWorkspaceListCommand;
  route: DeviceWorkspaceListPeerRoute | null;
  acceptedEvent: WorkspaceDispatchAcceptedEvent | null;
  terminalEvent: WorkspaceDispatchTerminalEvent | null;
  resolution: DeviceWorkspaceListDispatchResolution | null;
  createdAt: string;
  updatedAt: string;
}>;

export type AcceptWorkspaceDispatchEventInput = Readonly<{
  command: DeviceWorkspaceListCommand;
  route: DeviceWorkspaceListPeerRoute;
  event: DeviceWorkspaceListEvent;
}>;

export type SettleWorkspaceDispatchEventInput = Readonly<{
  command: DeviceWorkspaceListCommand;
  route: DeviceWorkspaceListPeerRoute;
  event: DeviceWorkspaceListEvent;
  resolution: DeviceWorkspaceListDispatchResolution;
}>;

export function parseWorkspaceDispatchAuthorityRecord(
  input: unknown,
): WorkspaceDispatchAuthorityRecord {
  const value = requireObject(input, "workspace_dispatch_authority_invalid");
  requireExactKeys(value, [
    "acceptedEvent",
    "command",
    "commandKind",
    "createdAt",
    "executionId",
    "fingerprint",
    "resolution",
    "route",
    "terminalEvent",
    "updatedAt",
  ]);
  if (value.commandKind !== "workspaceList") {
    throw new DeviceGatewayError("workspace_dispatch_authority_invalid");
  }
  const command = parseDeviceWorkspaceListCommand(value.command);
  const executionId = requireOpaqueId(
    value.executionId,
    "device_execution_id_invalid",
  );
  if (
    executionId !== command.executionId ||
    value.fingerprint !== workspaceDispatchFingerprint(command)
  ) {
    throw new DeviceGatewayError("workspace_dispatch_authority_corrupt");
  }
  const route =
    value.route === null ? null : parseWorkspaceDispatchRoute(value.route);
  const acceptedEvent =
    value.acceptedEvent === null
      ? null
      : requireAcceptedEvent(value.acceptedEvent, command, route);
  const terminalEvent =
    value.terminalEvent === null
      ? null
      : requireTerminalEvent(value.terminalEvent, command, route);
  const resolution =
    value.resolution === null
      ? null
      : parseWorkspaceResolution(value.resolution, command);
  if (
    (route === null) !== (acceptedEvent === null) ||
    (terminalEvent === null) !== (resolution === null) ||
    (terminalEvent !== null &&
      (acceptedEvent === null ||
        terminalEvent.receiptId !== acceptedEvent.receiptId ||
        Date.parse(terminalEvent.observedAt) <
          Date.parse(acceptedEvent.observedAt) ||
        !sameWorkspaceDispatchJson(resolution?.terminal, terminalEvent)))
  ) {
    throw new DeviceGatewayError("workspace_dispatch_authority_corrupt");
  }
  const createdAt = requireWorkspaceDispatchTimestamp(value.createdAt);
  const updatedAt = requireWorkspaceDispatchTimestamp(value.updatedAt);
  requireWorkspaceDispatchNotBefore(updatedAt, createdAt);
  return {
    commandKind: "workspaceList",
    executionId,
    fingerprint: value.fingerprint as string,
    command,
    route,
    acceptedEvent,
    terminalEvent,
    resolution,
    createdAt,
    updatedAt,
  };
}

export function workspaceDispatchFingerprint(
  input: DeviceWorkspaceListCommand,
): string {
  const command = parseDeviceWorkspaceListCommand(input);
  return `sha256:${createHash("sha256")
    .update(canonicalJson(command), "utf8")
    .digest("hex")}`;
}

export function validateAcceptWorkspaceDispatchEventInput(
  input: AcceptWorkspaceDispatchEventInput,
): AcceptWorkspaceDispatchEventInput &
  Readonly<{ event: WorkspaceDispatchAcceptedEvent }> {
  const value = requireObject(input, "workspace_dispatch_event_input_invalid");
  requireExactKeys(value, ["command", "event", "route"]);
  const command = parseDeviceWorkspaceListCommand(value.command);
  const route = parseWorkspaceDispatchRoute(value.route);
  const event = requireAcceptedEvent(value.event, command, route);
  return { command, route, event };
}

export function validateSettleWorkspaceDispatchEventInput(
  input: SettleWorkspaceDispatchEventInput,
): SettleWorkspaceDispatchEventInput &
  Readonly<{ event: WorkspaceDispatchTerminalEvent }> {
  const value = requireObject(input, "workspace_dispatch_event_input_invalid");
  requireExactKeys(value, ["command", "event", "resolution", "route"]);
  const command = parseDeviceWorkspaceListCommand(value.command);
  const route = parseWorkspaceDispatchRoute(value.route);
  const event = requireTerminalEvent(value.event, command, route);
  const resolution = parseWorkspaceResolution(value.resolution, command);
  if (!sameWorkspaceDispatchJson(resolution.terminal, event)) {
    throw new DeviceGatewayError("workspace_dispatch_terminal_conflict");
  }
  return { command, route, event, resolution };
}

export function requireWorkspaceDispatchTimestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new DeviceGatewayError("workspace_dispatch_timestamp_invalid");
  }
  return value;
}

export function requireWorkspaceDispatchNotBefore(
  value: string,
  minimum: string,
): void {
  if (Date.parse(value) < Date.parse(minimum)) {
    throw new DeviceGatewayError("workspace_dispatch_timestamp_invalid");
  }
}

export function requireWorkspaceDispatchRouteCurrent(
  committedAt: string,
  route: DeviceWorkspaceListPeerRoute,
): void {
  if (Date.parse(committedAt) >= Date.parse(route.leaseExpiresAt)) {
    throw new DeviceGatewayError("workspace_dispatch_route_expired");
  }
}

export function sameWorkspaceDispatchJson(
  left: unknown,
  right: unknown,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function sameWorkspaceDispatchRouteFence(
  left: DeviceWorkspaceListPeerRoute,
  right: DeviceWorkspaceListPeerRoute,
): boolean {
  return (
    left.deviceId === right.deviceId &&
    left.gatewayId === right.gatewayId &&
    left.connectionId === right.connectionId &&
    left.connectionEpoch === right.connectionEpoch
  );
}

function requireAcceptedEvent(
  input: unknown,
  command: DeviceWorkspaceListCommand,
  route: DeviceWorkspaceListPeerRoute | null,
): WorkspaceDispatchAcceptedEvent {
  if (route === null) {
    throw new DeviceGatewayError("workspace_dispatch_authority_corrupt");
  }
  const event = parseDeviceWorkspaceListEventForCommand(
    input,
    command,
    route.connectionEpoch,
  );
  if (
    event.type !== "workspace_list.accepted" ||
    event.deviceId !== route.deviceId
  ) {
    throw new DeviceGatewayError("workspace_dispatch_event_identity_mismatch");
  }
  return event;
}

function requireTerminalEvent(
  input: unknown,
  command: DeviceWorkspaceListCommand,
  route: DeviceWorkspaceListPeerRoute | null,
): WorkspaceDispatchTerminalEvent {
  if (route === null) {
    throw new DeviceGatewayError("workspace_dispatch_authority_corrupt");
  }
  const event = parseDeviceWorkspaceListEventForCommand(
    input,
    command,
    route.connectionEpoch,
  );
  if (
    event.type === "workspace_list.accepted" ||
    event.deviceId !== route.deviceId
  ) {
    throw new DeviceGatewayError("workspace_dispatch_event_identity_mismatch");
  }
  return event;
}

function parseWorkspaceResolution(
  input: unknown,
  command: DeviceWorkspaceListCommand,
): DeviceWorkspaceListDispatchResolution {
  const request = parseDeviceWorkspaceListWorkerDispatchRequest({
    schemaVersion: "crewon.device-workspace-list-dispatch-request.v0",
    apiVersion: DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION,
    operation: "execute",
    command,
  });
  return parseDeviceWorkspaceListWorkerDispatchResponse(
    {
      schemaVersion: "crewon.device-workspace-list-dispatch-response.v0",
      apiVersion: DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION,
      operation: "execute",
      resolution: input,
    },
    request,
  ).resolution;
}

export function parseWorkspaceDispatchRoute(
  input: unknown,
): DeviceWorkspaceListPeerRoute {
  const route = requireObject(input, "workspace_dispatch_route_invalid");
  requireExactKeys(route, [
    "connectionEpoch",
    "connectionId",
    "deviceId",
    "gatewayId",
    "leaseExpiresAt",
  ]);
  return {
    deviceId: requireOpaqueId(route.deviceId, "device_id_invalid"),
    gatewayId: requireOpaqueId(route.gatewayId, "device_gateway_id_invalid"),
    connectionId: requireOpaqueId(
      route.connectionId,
      "device_connection_id_invalid",
    ),
    connectionEpoch: requirePositiveInteger(
      route.connectionEpoch,
      "device_connection_epoch_invalid",
    ),
    leaseExpiresAt: requireWorkspaceDispatchTimestamp(route.leaseExpiresAt),
  };
}

function requireObject(value: unknown, code: string): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new DeviceGatewayError(code);
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
    throw new DeviceGatewayError("workspace_dispatch_fields_invalid");
  }
}

function requireOpaqueId(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)
  ) {
    throw new DeviceGatewayError(code);
  }
  return value;
}

function requirePositiveInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new DeviceGatewayError(code);
  }
  return Number(value);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])]),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
