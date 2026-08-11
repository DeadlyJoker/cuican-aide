import { ContractValidationError } from "./contract-validation-error.ts";
import {
  parseDeviceExecutionCommand,
  type DeviceExecutionCommand,
} from "./device-protocol.ts";

export const DEVICE_FILESYSTEM_READ_CAPABILITY =
  "workspace.read_file.v0" as const;
export const DEVICE_FILESYSTEM_READ_MAX_BYTES = 64 * 1024;
export const DEVICE_FILESYSTEM_READ_MAX_TIMEOUT_MS = 30_000;

export type DeviceFilesystemReadArguments = Readonly<{
  schemaVersion: "crewon.device-filesystem-read-arguments.v0";
  workspaceIncarnationId: string;
  relativePathSegments: readonly string[];
  encoding: "utf8";
}>;

export type DeviceFilesystemReadCommand = DeviceExecutionCommand &
  Readonly<{
    capability: typeof DEVICE_FILESYSTEM_READ_CAPABILITY;
    arguments: DeviceFilesystemReadArguments;
    payloadRef: null;
  }>;

export type DeviceFilesystemReadResult = Readonly<{
  schemaVersion: "crewon.workspace-file-read-result.v0";
  encoding: "utf8";
  content: string;
  byteLength: number;
}>;

export type DeviceFilesystemReadEvent = Readonly<Record<string, unknown>>;
export type DeviceFilesystemReadAck = Readonly<Record<string, unknown>>;

const eventKeys = [
  "commandDigest",
  "commandKind",
  "connectionEpoch",
  "data",
  "deviceId",
  "executionId",
  "incarnationId",
  "observedAt",
  "protocolVersion",
  "receiptId",
  "schemaVersion",
  "sequence",
  "type",
  "workspaceBindingId",
];
const ackKeys = [
  "acknowledgedAt",
  "commandDigest",
  "commandKind",
  "connectionEpoch",
  "deviceId",
  "executionId",
  "incarnationId",
  "protocolVersion",
  "receiptId",
  "schemaVersion",
  "throughSequence",
  "workspaceBindingId",
];

export function parseDeviceFilesystemReadEvent(
  input: unknown,
): DeviceFilesystemReadEvent {
  const event = record(input);
  keys(event, eventKeys);
  envelope(event, "crewon.device-filesystem-read-event.v0");
  const data = record(event.data);
  switch (event.type) {
    case "workspace_read.accepted":
      sequence(event, 1);
      keys(data, ["expiresAt", "leaseEpoch", "leaseId"]);
      opaque(data.leaseId);
      positive(data.leaseEpoch);
      timestamp(data.expiresAt);
      break;
    case "workspace_read.completed":
      sequence(event, 2);
      keys(data, ["result"]);
      completed(data.result);
      break;
    case "workspace_read.failed":
      sequence(event, 2);
      keys(data, ["code", "retryable"]);
      code(data.code);
      if (typeof data.retryable !== "boolean") invalid();
      break;
    case "workspace_read.canceled":
      sequence(event, 2);
      keys(data, ["reasonCode"]);
      code(data.reasonCode);
      break;
    case "workspace_read.unknown_outcome":
      sequence(event, 2);
      keys(data, ["providerReceiptId"]);
      if (data.providerReceiptId !== null) opaque(data.providerReceiptId);
      break;
    default:
      throw new ContractValidationError(
        "device_filesystem_read_event_type_unsupported",
      );
  }
  if (new TextEncoder().encode(JSON.stringify(input)).length > 96 * 1024)
    invalid();
  return structuredClone(input) as DeviceFilesystemReadEvent;
}

export function parseDeviceFilesystemReadAck(
  input: unknown,
): DeviceFilesystemReadAck {
  const ack = record(input);
  keys(ack, ackKeys);
  envelope(ack, "crewon.device-filesystem-read-ack.v0");
  if (ack.throughSequence !== 1 && ack.throughSequence !== 2) invalid();
  timestamp(ack.acknowledgedAt);
  return structuredClone(input) as DeviceFilesystemReadAck;
}

function envelope(value: Record<string, unknown>, schema: string): void {
  if (
    value.schemaVersion !== schema ||
    value.protocolVersion !== 1 ||
    value.commandKind !== "workspaceRead"
  )
    invalid();
  for (const field of [
    "deviceId",
    "executionId",
    "receiptId",
    "workspaceBindingId",
    "incarnationId",
  ])
    opaque(value[field]);
  positive(value.connectionEpoch);
  if (!/^sha256:[0-9a-f]{64}$/.test(String(value.commandDigest))) invalid();
}

function completed(input: unknown): void {
  const result = record(input);
  keys(result, [
    "byteLength",
    "content",
    "encoding",
    "outputDigest",
    "schemaVersion",
  ]);
  if (
    result.schemaVersion !== "crewon.workspace-file-read-result.v0" ||
    result.encoding !== "utf8" ||
    typeof result.content !== "string" ||
    result.byteLength !== new TextEncoder().encode(result.content).length ||
    !/^sha256:[0-9a-f]{64}$/.test(String(result.outputDigest)) ||
    new TextEncoder().encode(JSON.stringify(result)).length >
      DEVICE_FILESYSTEM_READ_MAX_BYTES
  )
    invalid();
}

function record(input: unknown): Record<string, unknown> {
  if (input === null || Array.isArray(input) || typeof input !== "object")
    invalid();
  return input as Record<string, unknown>;
}
function keys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  if (Object.keys(value).sort().join(",") !== [...expected].sort().join(","))
    invalid();
}
function sequence(value: Record<string, unknown>, expected: 1 | 2): void {
  if (value.sequence !== expected) invalid();
}
function opaque(value: unknown): void {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(value)
  )
    invalid();
}
function positive(value: unknown): void {
  if (!Number.isSafeInteger(value) || Number(value) < 1) invalid();
}
function timestamp(value: unknown): void {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) invalid();
}
function code(value: unknown): void {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,127}$/.test(value))
    invalid();
}
function invalid(): never {
  throw new ContractValidationError("device_filesystem_read_event_invalid");
}

export function parseDeviceFilesystemReadResult(
  input: unknown,
  maximumOutputBytes: number,
): DeviceFilesystemReadResult {
  if (
    !Number.isSafeInteger(maximumOutputBytes) ||
    maximumOutputBytes < 1 ||
    maximumOutputBytes > DEVICE_FILESYSTEM_READ_MAX_BYTES ||
    input === null ||
    Array.isArray(input) ||
    typeof input !== "object" ||
    Object.keys(input).sort().join(",") !==
      "byteLength,content,encoding,schemaVersion" ||
    (input as any).schemaVersion !== "crewon.workspace-file-read-result.v0" ||
    (input as any).encoding !== "utf8" ||
    typeof (input as any).content !== "string" ||
    !Number.isSafeInteger((input as any).byteLength) ||
    (input as any).byteLength !==
      new TextEncoder().encode((input as any).content).length ||
    new TextEncoder().encode(JSON.stringify(input)).length > maximumOutputBytes
  ) {
    throw new ContractValidationError("device_filesystem_read_result_invalid");
  }
  return structuredClone(input) as DeviceFilesystemReadResult;
}

export function parseDeviceFilesystemReadCommand(
  input: unknown,
): DeviceFilesystemReadCommand {
  const command = parseDeviceExecutionCommand(input);
  if (
    command.capability !== DEVICE_FILESYSTEM_READ_CAPABILITY ||
    command.payloadRef !== null ||
    command.authorization.approvalProof !== null ||
    command.limits.maxOutputBytes > DEVICE_FILESYSTEM_READ_MAX_BYTES ||
    command.limits.timeoutMs > DEVICE_FILESYSTEM_READ_MAX_TIMEOUT_MS
  ) {
    throw new ContractValidationError("device_filesystem_read_command_invalid");
  }
  const argumentsValue = command.arguments;
  if (
    argumentsValue === null ||
    Array.isArray(argumentsValue) ||
    typeof argumentsValue !== "object" ||
    Object.keys(argumentsValue).sort().join(",") !==
      "encoding,relativePathSegments,schemaVersion,workspaceIncarnationId" ||
    argumentsValue.schemaVersion !==
      "crewon.device-filesystem-read-arguments.v0" ||
    argumentsValue.encoding !== "utf8" ||
    typeof argumentsValue.workspaceIncarnationId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(
      argumentsValue.workspaceIncarnationId,
    ) ||
    !Array.isArray(argumentsValue.relativePathSegments) ||
    argumentsValue.relativePathSegments.length === 0 ||
    argumentsValue.relativePathSegments.length > 32
  ) {
    throw new ContractValidationError(
      "device_filesystem_read_arguments_invalid",
    );
  }
  for (const component of argumentsValue.relativePathSegments) {
    if (
      typeof component !== "string" ||
      component.length === 0 ||
      new TextEncoder().encode(component).length > 255 ||
      component === "." ||
      component === ".." ||
      component.includes("/") ||
      component.includes("\\") ||
      component.includes(":") ||
      component.includes("\0")
    ) {
      throw new ContractValidationError("device_filesystem_read_path_invalid");
    }
  }
  return structuredClone(command) as DeviceFilesystemReadCommand;
}
