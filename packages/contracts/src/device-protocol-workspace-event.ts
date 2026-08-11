import { ContractValidationError } from "./contract-validation-error.ts";
import { DEVICE_PROTOCOL_VERSION } from "./device-protocol.ts";
import {
  DEVICE_WORKSPACE_LIST_HARD_LIMITS,
  parseDeviceWorkspaceListCommand,
  type DeviceWorkspaceListCommand,
} from "./device-protocol-workspace.ts";
import {
  parseDeviceWorkspaceListResult,
  type DeviceWorkspaceListResult,
} from "./device-protocol-workspace-result.ts";

export const DEVICE_WORKSPACE_LIST_EVENT_TYPES = [
  "workspace_list.accepted",
  "workspace_list.completed",
  "workspace_list.failed",
  "workspace_list.canceled",
  "workspace_list.unknown_outcome",
] as const;

type DeviceWorkspaceListEventEnvelope = Readonly<{
  schemaVersion: "crewon.device-workspace-list-event.v0";
  protocolVersion: typeof DEVICE_PROTOCOL_VERSION;
  commandKind: "workspaceList";
  deviceId: string;
  executionId: string;
  receiptId: string;
  connectionEpoch: number;
  workspaceBindingId: string;
  incarnationId: string;
  deviceBindingId: string;
  runtimeBindingId: string;
  actionDigest: string;
  commandDigest: string;
  sequence: number;
  observedAt: string;
}>;

export type DeviceWorkspaceListEvent =
  | (DeviceWorkspaceListEventEnvelope &
      Readonly<{
        type: "workspace_list.accepted";
        data: Readonly<{
          leaseId: string;
          leaseEpoch: number;
          expiresAt: string;
          policySnapshotId: string;
        }>;
      }>)
  | (DeviceWorkspaceListEventEnvelope &
      Readonly<{
        type: "workspace_list.completed";
        data: Readonly<{ result: DeviceWorkspaceListResult }>;
      }>)
  | (DeviceWorkspaceListEventEnvelope &
      Readonly<{
        type: "workspace_list.failed";
        data: Readonly<{ code: string; retryable: boolean }>;
      }>)
  | (DeviceWorkspaceListEventEnvelope &
      Readonly<{
        type: "workspace_list.canceled";
        data: Readonly<{ reasonCode: string }>;
      }>)
  | (DeviceWorkspaceListEventEnvelope &
      Readonly<{
        type: "workspace_list.unknown_outcome";
        data: Readonly<{ providerReceiptId: string | null }>;
      }>);

export type DeviceWorkspaceListAck = Readonly<{
  schemaVersion: "crewon.device-workspace-list-ack.v0";
  protocolVersion: typeof DEVICE_PROTOCOL_VERSION;
  commandKind: "workspaceList";
  deviceId: string;
  executionId: string;
  receiptId: string;
  connectionEpoch: number;
  workspaceBindingId: string;
  incarnationId: string;
  deviceBindingId: string;
  runtimeBindingId: string;
  actionDigest: string;
  commandDigest: string;
  throughSequence: number;
  acknowledgedAt: string;
}>;

const MAX_EVENT_BYTES = 96 * 1024;
const MAX_ACK_BYTES = 16 * 1024;

export function parseDeviceWorkspaceListEvent(
  input: unknown,
): DeviceWorkspaceListEvent {
  const event = requireObject(input, "device_workspace_event_invalid");
  requireExactKeys(event, [
    "actionDigest",
    "commandDigest",
    "commandKind",
    "connectionEpoch",
    "data",
    "deviceBindingId",
    "deviceId",
    "executionId",
    "incarnationId",
    "observedAt",
    "protocolVersion",
    "receiptId",
    "runtimeBindingId",
    "schemaVersion",
    "sequence",
    "type",
    "workspaceBindingId",
  ]);
  if (
    event.schemaVersion !== "crewon.device-workspace-list-event.v0" ||
    event.protocolVersion !== DEVICE_PROTOCOL_VERSION ||
    event.commandKind !== "workspaceList"
  ) {
    throw new ContractValidationError(
      "device_workspace_event_protocol_unsupported",
    );
  }
  for (const [value, code] of [
    [event.deviceId, "device_id_invalid"],
    [event.executionId, "device_execution_id_invalid"],
    [event.receiptId, "device_receipt_id_invalid"],
    [event.workspaceBindingId, "device_workspace_binding_invalid"],
    [event.incarnationId, "device_workspace_incarnation_invalid"],
    [event.deviceBindingId, "device_binding_id_invalid"],
    [event.runtimeBindingId, "device_runtime_binding_id_invalid"],
  ] as const) {
    requireOpaqueId(value, code);
  }
  requirePositiveInteger(
    event.connectionEpoch,
    "device_connection_epoch_invalid",
  );
  requirePositiveInteger(event.sequence, "device_event_sequence_invalid");
  requireTimestamp(event.observedAt, "device_event_timestamp_invalid");
  requireDigest(event.actionDigest, "device_action_digest_invalid");
  requireDigest(event.commandDigest, "device_command_digest_invalid");
  const data = requireObject(event.data, "device_workspace_event_data_invalid");
  switch (event.type) {
    case "workspace_list.accepted":
      requireSequence(event.sequence, 1);
      requireExactKeys(data, [
        "expiresAt",
        "leaseEpoch",
        "leaseId",
        "policySnapshotId",
      ]);
      requireOpaqueId(data.leaseId, "device_lease_id_invalid");
      requirePositiveInteger(data.leaseEpoch, "device_lease_epoch_invalid");
      requireTimestamp(data.expiresAt, "device_lease_expiry_invalid");
      requireOpaqueId(
        data.policySnapshotId,
        "device_policy_snapshot_id_invalid",
      );
      break;
    case "workspace_list.completed":
      requireSequence(event.sequence, 2);
      requireExactKeys(data, ["result"]);
      parseDeviceWorkspaceListResult(data.result, {
        actionDigest: event.actionDigest,
        commandDigest: event.commandDigest,
        executionId: requireOpaqueId(
          event.executionId,
          "device_execution_id_invalid",
        ),
        maxEntries: DEVICE_WORKSPACE_LIST_HARD_LIMITS.maxEntries,
        maxNameBytes: DEVICE_WORKSPACE_LIST_HARD_LIMITS.maxNameBytes,
        maxOutputBytes: DEVICE_WORKSPACE_LIST_HARD_LIMITS.maxOutputBytes,
      });
      break;
    case "workspace_list.failed":
      requireSequence(event.sequence, 2);
      requireExactKeys(data, ["code", "retryable"]);
      requireSafeCode(data.code, "device_failure_code_invalid");
      if (typeof data.retryable !== "boolean") {
        throw new ContractValidationError("device_failure_retryable_invalid");
      }
      break;
    case "workspace_list.canceled":
      requireSequence(event.sequence, 2);
      requireExactKeys(data, ["reasonCode"]);
      requireSafeCode(data.reasonCode, "device_cancel_reason_invalid");
      break;
    case "workspace_list.unknown_outcome":
      requireSequence(event.sequence, 2);
      requireExactKeys(data, ["providerReceiptId"]);
      if (data.providerReceiptId !== null) {
        requireOpaqueId(
          data.providerReceiptId,
          "device_provider_receipt_id_invalid",
        );
      }
      break;
    default:
      throw new ContractValidationError(
        "device_workspace_event_type_unsupported",
      );
  }
  requireBoundedJson(
    event,
    MAX_EVENT_BYTES,
    "device_workspace_event_too_large",
  );
  return structuredClone(event) as DeviceWorkspaceListEvent;
}

export function parseDeviceWorkspaceListEventForCommand(
  input: unknown,
  expectedCommand: DeviceWorkspaceListCommand,
  expectedConnectionEpoch?: number,
): DeviceWorkspaceListEvent {
  const event = parseDeviceWorkspaceListEvent(input);
  const command = parseDeviceWorkspaceListCommand(expectedCommand);
  if (
    event.deviceId !== command.deviceId ||
    event.executionId !== command.executionId ||
    event.workspaceBindingId !== command.workspaceBindingId ||
    event.incarnationId !== command.incarnationId ||
    event.deviceBindingId !== command.deviceBindingId ||
    event.runtimeBindingId !== command.runtimeBindingId ||
    event.actionDigest !== command.actionDigest ||
    event.commandDigest !== command.commandDigest ||
    (expectedConnectionEpoch !== undefined &&
      event.connectionEpoch !== expectedConnectionEpoch)
  ) {
    throw new ContractValidationError(
      "device_workspace_event_identity_mismatch",
    );
  }
  if (
    event.type === "workspace_list.accepted" &&
    (event.data.leaseId !== command.leaseId ||
      event.data.leaseEpoch !== command.leaseEpoch ||
      event.data.expiresAt !== command.expiresAt ||
      event.data.policySnapshotId !== command.policySnapshotId)
  ) {
    throw new ContractValidationError(
      "device_workspace_event_identity_mismatch",
    );
  }
  if (event.type === "workspace_list.completed") {
    parseDeviceWorkspaceListResult(event.data.result, {
      actionDigest: command.actionDigest,
      commandDigest: command.commandDigest,
      executionId: command.executionId,
      maxEntries: command.limits.maxEntries,
      maxNameBytes: command.limits.maxNameBytes,
      maxOutputBytes: command.limits.maxOutputBytes,
    });
  }
  return event;
}

export function parseDeviceWorkspaceListAck(
  input: unknown,
): DeviceWorkspaceListAck {
  const ack = requireObject(input, "device_workspace_ack_invalid");
  requireExactKeys(ack, [
    "acknowledgedAt",
    "actionDigest",
    "commandDigest",
    "commandKind",
    "connectionEpoch",
    "deviceBindingId",
    "deviceId",
    "executionId",
    "incarnationId",
    "protocolVersion",
    "receiptId",
    "runtimeBindingId",
    "schemaVersion",
    "throughSequence",
    "workspaceBindingId",
  ]);
  if (
    ack.schemaVersion !== "crewon.device-workspace-list-ack.v0" ||
    ack.protocolVersion !== DEVICE_PROTOCOL_VERSION ||
    ack.commandKind !== "workspaceList"
  ) {
    throw new ContractValidationError(
      "device_workspace_ack_protocol_unsupported",
    );
  }
  for (const [value, code] of [
    [ack.deviceId, "device_id_invalid"],
    [ack.executionId, "device_execution_id_invalid"],
    [ack.receiptId, "device_receipt_id_invalid"],
    [ack.workspaceBindingId, "device_workspace_binding_invalid"],
    [ack.incarnationId, "device_workspace_incarnation_invalid"],
    [ack.deviceBindingId, "device_binding_id_invalid"],
    [ack.runtimeBindingId, "device_runtime_binding_id_invalid"],
  ] as const) {
    requireOpaqueId(value, code);
  }
  requirePositiveInteger(
    ack.connectionEpoch,
    "device_connection_epoch_invalid",
  );
  requirePositiveInteger(ack.throughSequence, "device_ack_sequence_invalid");
  if (Number(ack.throughSequence) > 2) {
    throw new ContractValidationError("device_ack_sequence_invalid");
  }
  requireTimestamp(ack.acknowledgedAt, "device_ack_timestamp_invalid");
  requireDigest(ack.actionDigest, "device_action_digest_invalid");
  requireDigest(ack.commandDigest, "device_command_digest_invalid");
  requireBoundedJson(ack, MAX_ACK_BYTES, "device_workspace_ack_too_large");
  return structuredClone(ack) as DeviceWorkspaceListAck;
}

export function parseDeviceWorkspaceListAckForEvent(
  input: unknown,
  expectedEvent: DeviceWorkspaceListEvent,
): DeviceWorkspaceListAck {
  const ack = parseDeviceWorkspaceListAck(input);
  const event = parseDeviceWorkspaceListEvent(expectedEvent);
  for (const key of [
    "deviceId",
    "executionId",
    "receiptId",
    "connectionEpoch",
    "workspaceBindingId",
    "incarnationId",
    "deviceBindingId",
    "runtimeBindingId",
    "actionDigest",
    "commandDigest",
  ] as const) {
    if (ack[key] !== event[key]) {
      throw new ContractValidationError(
        "device_workspace_ack_identity_mismatch",
      );
    }
  }
  if (ack.throughSequence < event.sequence) {
    throw new ContractValidationError("device_ack_sequence_invalid");
  }
  return ack;
}

function requireSequence(value: unknown, expected: number): void {
  if (value !== expected) {
    throw new ContractValidationError("device_event_sequence_invalid");
  }
}

function requireObject(value: unknown, code: string): Record<string, unknown> {
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
    throw new ContractValidationError("device_workspace_fields_invalid");
  }
}

function requireOpaqueId(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)
  ) {
    throw new ContractValidationError(code);
  }
  return value;
}

function requireDigest(value: unknown, code: string): asserts value is string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new ContractValidationError(code);
  }
}

function requireSafeCode(
  value: unknown,
  code: string,
): asserts value is string {
  if (typeof value !== "string" || !/^[a-z0-9_.:-]{1,128}$/u.test(value)) {
    throw new ContractValidationError(code);
  }
}

function requirePositiveInteger(value: unknown, code: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new ContractValidationError(code);
  }
}

function requireTimestamp(value: unknown, code: string): void {
  if (
    typeof value !== "string" ||
    !value.endsWith("Z") ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new ContractValidationError(code);
  }
}

function requireBoundedJson(
  value: unknown,
  maximumBytes: number,
  code: string,
): void {
  let encoded: Uint8Array;
  try {
    encoded = utf8(JSON.stringify(value));
  } catch {
    throw new ContractValidationError(code);
  }
  if (encoded.byteLength > maximumBytes) {
    throw new ContractValidationError(code);
  }
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
