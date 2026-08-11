import { ContractValidationError } from "./contract-validation-error.ts";
import type { DeviceWorkspaceListCommand } from "./device-protocol-workspace.ts";
import {
  parseDeviceWorkspaceListEvent,
  parseDeviceWorkspaceListEventForCommand,
  type DeviceWorkspaceListEvent,
} from "./device-protocol-workspace-event.ts";
import {
  DEVICE_WORKSPACE_LIST_DISPATCH_OPERATIONS,
  type DeviceWorkspaceListDispatchOperation,
  type DeviceWorkspaceListDispatchReference,
  type DeviceWorkspaceListDispatchResolution,
  type DeviceWorkspaceListPeerRoute,
  type DeviceWorkspaceListPeerSourceWorker,
} from "./device-workspace-list-dispatch-types.ts";

export function parseResolution(
  input: unknown,
  expected: DeviceWorkspaceListCommand | DeviceWorkspaceListDispatchReference,
  expectedConnectionEpoch?: number,
): DeviceWorkspaceListDispatchResolution {
  const resolution = requireObject(
    input,
    "device_workspace_dispatch_resolution_invalid",
  );
  requireOpaqueId(resolution.executionId, "device_execution_id_invalid");
  if (resolution.executionId !== expected.executionId) {
    throw new ContractValidationError(
      "device_workspace_dispatch_resolution_identity_mismatch",
    );
  }
  switch (resolution.status) {
    case "completed":
      return parseTerminalResolution(
        resolution,
        "workspace_list.completed",
        expected,
        expectedConnectionEpoch,
      );
    case "failed":
      return parseTerminalResolution(
        resolution,
        "workspace_list.failed",
        expected,
        expectedConnectionEpoch,
      );
    case "canceled":
      return parseTerminalResolution(
        resolution,
        "workspace_list.canceled",
        expected,
        expectedConnectionEpoch,
      );
    case "unknownOutcome": {
      requireExactKeys(resolution, [
        "executionId",
        "receiptId",
        "status",
        "terminal",
      ]);
      const receiptId =
        resolution.receiptId === null
          ? null
          : requireOpaqueId(resolution.receiptId, "device_receipt_id_invalid");
      const terminal =
        resolution.terminal === null
          ? null
          : parseTerminalEvent(
              resolution.terminal,
              expected,
              expectedConnectionEpoch,
            );
      if (
        terminal !== null &&
        (terminal.type !== "workspace_list.unknown_outcome" ||
          receiptId !== terminal.receiptId)
      ) {
        throw new ContractValidationError(
          "device_workspace_dispatch_resolution_identity_mismatch",
        );
      }
      requireReferenceReceipt(expected, receiptId);
      return {
        status: "unknownOutcome",
        executionId: resolution.executionId,
        receiptId,
        terminal: terminal as Extract<
          DeviceWorkspaceListEvent,
          { type: "workspace_list.unknown_outcome" }
        > | null,
      };
    }
    default:
      throw new ContractValidationError(
        "device_workspace_dispatch_status_invalid",
      );
  }
}

export function parseTerminalResolution<
  T extends
    | "workspace_list.completed"
    | "workspace_list.failed"
    | "workspace_list.canceled",
>(
  resolution: Readonly<Record<string, unknown>>,
  expectedType: T,
  expected: DeviceWorkspaceListCommand | DeviceWorkspaceListDispatchReference,
  expectedConnectionEpoch?: number,
): Extract<DeviceWorkspaceListDispatchResolution, { terminal: { type: T } }> {
  requireExactKeys(resolution, [
    "executionId",
    "receiptId",
    "status",
    "terminal",
  ]);
  const receiptId = requireOpaqueId(
    resolution.receiptId,
    "device_receipt_id_invalid",
  );
  const terminal = parseTerminalEvent(
    resolution.terminal,
    expected,
    expectedConnectionEpoch,
  );
  if (terminal.type !== expectedType || terminal.receiptId !== receiptId) {
    throw new ContractValidationError(
      "device_workspace_dispatch_resolution_identity_mismatch",
    );
  }
  requireReferenceReceipt(expected, receiptId);
  return {
    status: resolution.status as "completed" | "failed" | "canceled",
    executionId: resolution.executionId as string,
    receiptId,
    terminal,
  } as Extract<
    DeviceWorkspaceListDispatchResolution,
    { terminal: { type: T } }
  >;
}

export function parseTerminalEvent(
  input: unknown,
  expected: DeviceWorkspaceListCommand | DeviceWorkspaceListDispatchReference,
  expectedConnectionEpoch?: number,
): DeviceWorkspaceListEvent {
  if ("authorization" in expected) {
    return parseDeviceWorkspaceListEventForCommand(
      input,
      expected,
      expectedConnectionEpoch,
    );
  }
  const event = parseDeviceWorkspaceListEvent(input);
  if (
    event.deviceId !== expected.deviceId ||
    event.executionId !== expected.executionId ||
    event.workspaceBindingId !== expected.workspaceBindingId ||
    event.incarnationId !== expected.incarnationId ||
    event.deviceBindingId !== expected.deviceBindingId ||
    event.runtimeBindingId !== expected.runtimeBindingId ||
    event.actionDigest !== expected.actionDigest ||
    event.commandDigest !== expected.commandDigest ||
    (expectedConnectionEpoch !== undefined &&
      event.connectionEpoch !== expectedConnectionEpoch)
  ) {
    throw new ContractValidationError(
      "device_workspace_dispatch_resolution_identity_mismatch",
    );
  }
  return event;
}

export function requireReferenceReceipt(
  expected: DeviceWorkspaceListCommand | DeviceWorkspaceListDispatchReference,
  actualReceiptId: string | null,
): void {
  if (
    !("authorization" in expected) &&
    expected.receiptId !== null &&
    expected.receiptId !== actualReceiptId
  ) {
    throw new ContractValidationError(
      "device_workspace_dispatch_resolution_identity_mismatch",
    );
  }
}

export function parsePeerRoute(input: unknown): DeviceWorkspaceListPeerRoute {
  const route = requireObject(input, "device_workspace_peer_route_invalid");
  requireExactKeys(route, [
    "connectionEpoch",
    "connectionId",
    "deviceId",
    "gatewayId",
    "leaseExpiresAt",
  ]);
  requireOpaqueId(route.deviceId, "device_id_invalid");
  requireOpaqueId(route.gatewayId, "device_gateway_id_invalid");
  requireOpaqueId(route.connectionId, "device_connection_id_invalid");
  requirePositiveInteger(
    route.connectionEpoch,
    "device_connection_epoch_invalid",
  );
  requireTimestamp(route.leaseExpiresAt, "device_connection_lease_invalid");
  return structuredClone(route) as DeviceWorkspaceListPeerRoute;
}

export function parsePeerSourceWorker(
  input: unknown,
): DeviceWorkspaceListPeerSourceWorker {
  const sourceWorker = requireObject(
    input,
    "device_workspace_peer_source_worker_invalid",
  );
  requireExactKeys(sourceWorker, ["credentialId", "workerId"]);
  return {
    workerId: requireOpaqueId(
      sourceWorker.workerId,
      "device_workspace_peer_worker_id_invalid",
    ),
    credentialId: requireOpaqueId(
      sourceWorker.credentialId,
      "device_workspace_peer_worker_credential_id_invalid",
    ),
  };
}

export function samePeerRoute(
  left: DeviceWorkspaceListPeerRoute,
  right: DeviceWorkspaceListPeerRoute,
): boolean {
  return (
    left.deviceId === right.deviceId &&
    left.gatewayId === right.gatewayId &&
    left.connectionId === right.connectionId &&
    left.connectionEpoch === right.connectionEpoch &&
    left.leaseExpiresAt === right.leaseExpiresAt
  );
}

export function parseOperation(
  value: unknown,
): DeviceWorkspaceListDispatchOperation {
  if (
    !DEVICE_WORKSPACE_LIST_DISPATCH_OPERATIONS.includes(
      value as DeviceWorkspaceListDispatchOperation,
    )
  ) {
    throw new ContractValidationError(
      "device_workspace_dispatch_operation_invalid",
    );
  }
  return value as DeviceWorkspaceListDispatchOperation;
}

export function requireObject(
  value: unknown,
  code: string,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new ContractValidationError(code);
  }
  return value as Record<string, unknown>;
}

export function requireExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new ContractValidationError(
      "device_workspace_dispatch_fields_invalid",
    );
  }
}

export function requireOpaqueId(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)
  ) {
    throw new ContractValidationError(code);
  }
  return value;
}

export function requireDigest(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new ContractValidationError(code);
  }
  return value;
}

export function requireSafeCode(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^[a-z0-9_.:-]{1,128}$/u.test(value)) {
    throw new ContractValidationError(code);
  }
  return value;
}

export function requirePositiveInteger(value: unknown, code: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new ContractValidationError(code);
  }
}

export function requireTimestamp(value: unknown, code: string): void {
  if (
    typeof value !== "string" ||
    !value.endsWith("Z") ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new ContractValidationError(code);
  }
}

export function requireBoundedJson(
  value: unknown,
  maximumBytes: number,
  code: string,
): void {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new ContractValidationError(code);
  }
  if (new TextEncoder().encode(encoded).byteLength > maximumBytes) {
    throw new ContractValidationError(code);
  }
}
