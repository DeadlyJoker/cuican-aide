import { ContractValidationError } from "./contract-validation-error.ts";
import {
  canonicalDeviceFilesystemReadCommandDigest,
  parseDeviceFilesystemReadCommand,
  parseDeviceFilesystemReadEvent,
  type DeviceFilesystemReadCommand,
  type DeviceFilesystemReadEvent,
} from "./device-filesystem-read.ts";

export const DEVICE_FILESYSTEM_READ_DISPATCH_API_VERSION = 1 as const;
export const DEVICE_GATEWAY_WORKER_FILESYSTEM_READ_DISPATCH_PATH =
  "/worker/v1/device-filesystem-read-dispatch" as const;
export const DEVICE_GATEWAY_PEER_FILESYSTEM_READ_DISPATCH_PATH =
  "/gateway/v1/device-filesystem-read-dispatch" as const;
export const DEVICE_FILESYSTEM_READ_DISPATCH_MAX_REQUEST_BYTES = 128 * 1024;
export const DEVICE_FILESYSTEM_READ_DISPATCH_MAX_RESPONSE_BYTES = 96 * 1024;
export const DEVICE_FILESYSTEM_READ_DISPATCH_MAX_ERROR_BYTES = 16 * 1024;

export type DeviceFilesystemReadDispatchOperation =
  | "execute"
  | "reconcile"
  | "cancel";

export type DeviceFilesystemReadDispatchReference = Readonly<{
  deviceId: string;
  executionId: string;
  workspaceBindingId: string;
  incarnationId: string;
  deviceBindingId: string;
  runtimeBindingId: string;
  actionDigest: string;
  commandDigest: string;
  leaseId: string;
  leaseEpoch: number;
  receiptId: string | null;
}>;

export type DeviceFilesystemReadDispatchResolution =
  | terminalResolution<"completed", "workspace_read.completed">
  | terminalResolution<"failed", "workspace_read.failed">
  | terminalResolution<"canceled", "workspace_read.canceled">
  | Readonly<{
      status: "unknownOutcome";
      executionId: string;
      receiptId: string | null;
      terminal: Extract<
        DeviceFilesystemReadEvent,
        { type: "workspace_read.unknown_outcome" }
      > | null;
    }>;
type terminalResolution<
  S extends string,
  E extends DeviceFilesystemReadEvent["type"],
> = Readonly<{
  status: S;
  executionId: string;
  receiptId: string;
  terminal: Extract<DeviceFilesystemReadEvent, { type: E }>;
}>;

type WorkerEnvelope = Readonly<{
  schemaVersion: "crewon.device-filesystem-read-dispatch-request.v0";
  apiVersion: 1;
  routeIntent: DeviceFilesystemReadRouteIntent;
}>;
export type DeviceFilesystemReadRouteIntent = Readonly<{
  deviceBindingId: string;
  runtimeBindingId: string;
}>;
export type DeviceFilesystemReadWorkerDispatchRequest =
  | (WorkerEnvelope & {
      operation: "execute";
      command: DeviceFilesystemReadCommand;
    })
  | (WorkerEnvelope & {
      operation: "reconcile" | "cancel";
      reference: DeviceFilesystemReadDispatchReference;
    });

export type DeviceFilesystemReadPeerRoute = Readonly<{
  deviceId: string;
  gatewayId: string;
  connectionId: string;
  connectionEpoch: number;
  deviceBindingId: string;
  runtimeBindingId: string;
  capability: "workspace.read_file.v0";
  leaseExpiresAt: string;
}>;
export type DeviceFilesystemReadPeerSourceWorker = Readonly<{
  workerId: string;
  credentialId: string;
}>;
type PeerEnvelope = Readonly<{
  schemaVersion: "crewon.device-filesystem-read-peer-dispatch-request.v0";
  apiVersion: 1;
  sourceGatewayId: string;
  sourceWorker: DeviceFilesystemReadPeerSourceWorker;
  route: DeviceFilesystemReadPeerRoute;
}>;
export type DeviceFilesystemReadPeerDispatchRequest =
  | (PeerEnvelope & {
      operation: "execute";
      command: DeviceFilesystemReadCommand;
    })
  | (PeerEnvelope & {
      operation: "reconcile" | "cancel";
      reference: DeviceFilesystemReadDispatchReference;
    });

export type DeviceFilesystemReadWorkerDispatchResponse = Readonly<{
  schemaVersion: "crewon.device-filesystem-read-dispatch-response.v0";
  apiVersion: 1;
  operation: DeviceFilesystemReadDispatchOperation;
  resolution: DeviceFilesystemReadDispatchResolution;
}>;
export type DeviceFilesystemReadPeerDispatchResponse = Readonly<{
  schemaVersion: "crewon.device-filesystem-read-peer-dispatch-response.v0";
  apiVersion: 1;
  operation: DeviceFilesystemReadDispatchOperation;
  route: DeviceFilesystemReadPeerRoute;
  resolution: DeviceFilesystemReadDispatchResolution;
}>;
export type DeviceFilesystemReadDispatchError = Readonly<{
  schemaVersion: "crewon.device-filesystem-read-dispatch-error.v0";
  apiVersion: 1;
  code: string;
  retryable: boolean;
  certainty: "notSent" | "possiblySent";
}>;

export function parseDeviceFilesystemReadDispatchReference(
  input: unknown,
): DeviceFilesystemReadDispatchReference {
  const value = object(input, "device_filesystem_read_reference_invalid");
  exact(value, [
    "actionDigest",
    "commandDigest",
    "deviceBindingId",
    "deviceId",
    "executionId",
    "incarnationId",
    "leaseEpoch",
    "leaseId",
    "receiptId",
    "runtimeBindingId",
    "workspaceBindingId",
  ]);
  return {
    deviceId: id(value.deviceId),
    executionId: id(value.executionId),
    workspaceBindingId: id(value.workspaceBindingId),
    incarnationId: id(value.incarnationId),
    deviceBindingId: id(value.deviceBindingId),
    runtimeBindingId: id(value.runtimeBindingId),
    actionDigest: digest(value.actionDigest),
    commandDigest: digest(value.commandDigest),
    leaseId: id(value.leaseId),
    leaseEpoch: positive(value.leaseEpoch),
    receiptId: value.receiptId === null ? null : id(value.receiptId),
  };
}

export function parseDeviceFilesystemReadWorkerDispatchRequest(
  input: unknown,
): DeviceFilesystemReadWorkerDispatchRequest {
  const value = envelope(
    input,
    "crewon.device-filesystem-read-dispatch-request.v0",
  );
  const operation = operationOf(value.operation);
  exact(
    value,
    operation === "execute"
      ? ["apiVersion", "command", "operation", "routeIntent", "schemaVersion"]
      : [
          "apiVersion",
          "operation",
          "reference",
          "routeIntent",
          "schemaVersion",
        ],
  );
  const routeIntent = intentOf(value.routeIntent);
  const parsed =
    operation === "execute"
      ? {
          schemaVersion: value.schemaVersion,
          apiVersion: 1 as const,
          routeIntent,
          operation,
          command: parseDeviceFilesystemReadCommand(value.command),
        }
      : {
          schemaVersion: value.schemaVersion,
          apiVersion: 1 as const,
          routeIntent,
          operation,
          reference: parseDeviceFilesystemReadDispatchReference(
            value.reference,
          ),
        };
  if (
    parsed.operation !== "execute" &&
    (parsed.reference.deviceBindingId !== routeIntent.deviceBindingId ||
      parsed.reference.runtimeBindingId !== routeIntent.runtimeBindingId)
  )
    invalid("device_filesystem_read_route_intent_mismatch");
  bounded(parsed, DEVICE_FILESYSTEM_READ_DISPATCH_MAX_REQUEST_BYTES);
  return parsed;
}

export function parseDeviceFilesystemReadPeerDispatchRequest(
  input: unknown,
): DeviceFilesystemReadPeerDispatchRequest {
  const value = envelope(
    input,
    "crewon.device-filesystem-read-peer-dispatch-request.v0",
  );
  const operation = operationOf(value.operation);
  exact(
    value,
    operation === "execute"
      ? [
          "apiVersion",
          "command",
          "operation",
          "route",
          "schemaVersion",
          "sourceGatewayId",
          "sourceWorker",
        ]
      : [
          "apiVersion",
          "operation",
          "reference",
          "route",
          "schemaVersion",
          "sourceGatewayId",
          "sourceWorker",
        ],
  );
  const route = routeOf(value.route);
  const source = object(
    value.sourceWorker,
    "device_filesystem_read_peer_source_invalid",
  );
  exact(source, ["credentialId", "workerId"]);
  const common = {
    schemaVersion: value.schemaVersion,
    apiVersion: 1 as const,
    sourceGatewayId: id(value.sourceGatewayId),
    sourceWorker: {
      workerId: id(source.workerId),
      credentialId: id(source.credentialId),
    },
    route,
  };
  const target =
    operation === "execute"
      ? parseDeviceFilesystemReadCommand(value.command)
      : parseDeviceFilesystemReadDispatchReference(value.reference);
  const parsed: DeviceFilesystemReadPeerDispatchRequest =
    operation === "execute"
      ? { ...common, operation, command: target as DeviceFilesystemReadCommand }
      : {
          ...common,
          operation,
          reference: target as DeviceFilesystemReadDispatchReference,
        };
  const runtimeBindingId =
    operation === "execute"
      ? route.runtimeBindingId
      : (target as DeviceFilesystemReadDispatchReference).runtimeBindingId;
  if (
    target.deviceId !== route.deviceId ||
    runtimeBindingId !== route.runtimeBindingId
  )
    invalid("device_filesystem_read_peer_route_mismatch");
  bounded(parsed, DEVICE_FILESYSTEM_READ_DISPATCH_MAX_REQUEST_BYTES);
  return parsed;
}

export function parseDeviceFilesystemReadWorkerDispatchResponse(
  input: unknown,
  expected: DeviceFilesystemReadWorkerDispatchRequest,
  digestUtf8: (value: string) => string,
): DeviceFilesystemReadWorkerDispatchResponse {
  const value = envelope(
    input,
    "crewon.device-filesystem-read-dispatch-response.v0",
  );
  exact(value, ["apiVersion", "operation", "resolution", "schemaVersion"]);
  if (value.operation !== expected.operation)
    invalid("device_filesystem_read_response_mismatch");
  const result = {
    schemaVersion: value.schemaVersion,
    apiVersion: 1 as const,
    operation: expected.operation,
    resolution: resolutionOf(value.resolution, targetOf(expected), digestUtf8),
  };
  bounded(result, DEVICE_FILESYSTEM_READ_DISPATCH_MAX_RESPONSE_BYTES);
  return result;
}

export function parseDeviceFilesystemReadPeerDispatchResponse(
  input: unknown,
  expected: DeviceFilesystemReadPeerDispatchRequest,
  digestUtf8: (value: string) => string,
): DeviceFilesystemReadPeerDispatchResponse {
  const value = envelope(
    input,
    "crewon.device-filesystem-read-peer-dispatch-response.v0",
  );
  exact(value, [
    "apiVersion",
    "operation",
    "resolution",
    "route",
    "schemaVersion",
  ]);
  const route = routeOf(value.route);
  if (
    value.operation !== expected.operation ||
    JSON.stringify(route) !== JSON.stringify(expected.route)
  )
    invalid("device_filesystem_read_peer_response_mismatch");
  const result = {
    schemaVersion: value.schemaVersion,
    apiVersion: 1 as const,
    operation: expected.operation,
    route,
    resolution: resolutionOf(
      value.resolution,
      targetOf(expected),
      digestUtf8,
      expected.operation === "execute"
        ? expected.route.connectionEpoch
        : undefined,
    ),
  };
  bounded(result, DEVICE_FILESYSTEM_READ_DISPATCH_MAX_RESPONSE_BYTES);
  return result;
}

export function parseDeviceFilesystemReadDispatchError(
  input: unknown,
): DeviceFilesystemReadDispatchError {
  const value = envelope(
    input,
    "crewon.device-filesystem-read-dispatch-error.v0",
  );
  exact(value, [
    "apiVersion",
    "certainty",
    "code",
    "retryable",
    "schemaVersion",
  ]);
  if (
    typeof value.code !== "string" ||
    !/^[a-z][a-z0-9_]{0,127}$/u.test(value.code) ||
    typeof value.retryable !== "boolean" ||
    (value.certainty !== "notSent" && value.certainty !== "possiblySent")
  )
    invalid("device_filesystem_read_error_invalid");
  return structuredClone(value) as DeviceFilesystemReadDispatchError;
}

function targetOf(
  value:
    | DeviceFilesystemReadWorkerDispatchRequest
    | DeviceFilesystemReadPeerDispatchRequest,
) {
  return value.operation === "execute" ? value.command : value.reference;
}
function resolutionOf(
  input: unknown,
  target: DeviceFilesystemReadCommand | DeviceFilesystemReadDispatchReference,
  digestUtf8: (value: string) => string,
  expectedConnectionEpoch?: number,
): DeviceFilesystemReadDispatchResolution {
  const value = object(input, "device_filesystem_read_resolution_invalid");
  exact(value, ["executionId", "receiptId", "status", "terminal"]);
  if (
    !["completed", "failed", "canceled", "unknownOutcome"].includes(
      String(value.status),
    ) ||
    value.executionId !== target.executionId
  )
    invalid("device_filesystem_read_resolution_invalid");
  const terminal =
    value.terminal === null
      ? null
      : parseDeviceFilesystemReadEvent(value.terminal, digestUtf8);
  if (
    terminal !== null &&
    (terminal.deviceId !== target.deviceId ||
      terminal.executionId !== target.executionId ||
      terminal.receiptId !== value.receiptId)
  )
    invalid("device_filesystem_read_resolution_invalid");
  if (terminal !== null) {
    const expectedWorkspaceBindingId = target.workspaceBindingId;
    const expectedIncarnationId =
      "arguments" in target
        ? target.arguments.workspaceIncarnationId
        : target.incarnationId;
    const expectedCommandDigest =
      "arguments" in target
        ? canonicalDeviceFilesystemReadCommandDigest(target, digestUtf8)
        : target.commandDigest;
    if (
      terminal.workspaceBindingId !== expectedWorkspaceBindingId ||
      terminal.incarnationId !== expectedIncarnationId ||
      terminal.commandDigest !== expectedCommandDigest ||
      (expectedConnectionEpoch !== undefined &&
        terminal.connectionEpoch !== expectedConnectionEpoch)
    )
      invalid("device_filesystem_read_resolution_invalid");
  }
  if (
    !("arguments" in target) &&
    target.receiptId !== null &&
    value.receiptId !== target.receiptId
  )
    invalid("device_filesystem_read_resolution_invalid");
  const expectedType =
    value.status === "completed"
      ? "workspace_read.completed"
      : value.status === "failed"
        ? "workspace_read.failed"
        : value.status === "canceled"
          ? "workspace_read.canceled"
          : "workspace_read.unknown_outcome";
  if (
    (value.status === "unknownOutcome" &&
      terminal !== null &&
      terminal.type !== expectedType) ||
    (value.status !== "unknownOutcome" && terminal?.type !== expectedType) ||
    (value.status !== "unknownOutcome" && value.receiptId === null)
  )
    invalid("device_filesystem_read_resolution_invalid");
  return {
    status: value.status as DeviceFilesystemReadDispatchResolution["status"],
    executionId: id(value.executionId),
    receiptId: value.receiptId === null ? null : id(value.receiptId),
    terminal,
  } as DeviceFilesystemReadDispatchResolution;
}
function routeOf(input: unknown): DeviceFilesystemReadPeerRoute {
  const value = object(input, "device_filesystem_read_peer_route_invalid");
  exact(value, [
    "capability",
    "connectionEpoch",
    "connectionId",
    "deviceBindingId",
    "deviceId",
    "gatewayId",
    "leaseExpiresAt",
    "runtimeBindingId",
  ]);
  if (value.capability !== "workspace.read_file.v0")
    invalid("device_filesystem_read_peer_route_invalid");
  timestamp(value.leaseExpiresAt);
  return {
    deviceId: id(value.deviceId),
    gatewayId: id(value.gatewayId),
    connectionId: id(value.connectionId),
    connectionEpoch: positive(value.connectionEpoch),
    deviceBindingId: id(value.deviceBindingId),
    runtimeBindingId: id(value.runtimeBindingId),
    capability: value.capability,
    leaseExpiresAt: value.leaseExpiresAt as string,
  };
}
function intentOf(input: unknown): DeviceFilesystemReadRouteIntent {
  const value = object(input, "device_filesystem_read_route_intent_invalid");
  exact(value, ["deviceBindingId", "runtimeBindingId"]);
  return {
    deviceBindingId: id(value.deviceBindingId),
    runtimeBindingId: id(value.runtimeBindingId),
  };
}
function envelope(input: unknown, schema: string) {
  const value = object(input, "device_filesystem_read_dispatch_invalid");
  if (value.schemaVersion !== schema || value.apiVersion !== 1)
    invalid("device_filesystem_read_dispatch_api_unsupported");
  return value as Record<string, unknown> & { schemaVersion: any };
}
function object(input: unknown, code: string): Record<string, unknown> {
  if (input === null || Array.isArray(input) || typeof input !== "object")
    invalid(code);
  return input as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(value).sort().join() !== [...keys].sort().join())
    invalid("device_filesystem_read_dispatch_invalid");
}
function id(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)
  )
    invalid("device_filesystem_read_dispatch_invalid");
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value))
    invalid("device_filesystem_read_dispatch_invalid");
  return value;
}
function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    invalid("device_filesystem_read_dispatch_invalid");
  return Number(value);
}
function operationOf(value: unknown): DeviceFilesystemReadDispatchOperation {
  if (value !== "execute" && value !== "reconcile" && value !== "cancel")
    invalid("device_filesystem_read_operation_invalid");
  return value;
}
function timestamp(value: unknown) {
  if (
    typeof value !== "string" ||
    !value.endsWith("Z") ||
    Number.isNaN(Date.parse(value))
  )
    invalid("device_filesystem_read_dispatch_invalid");
}
function bounded(value: unknown, maximum: number) {
  if (new TextEncoder().encode(JSON.stringify(value)).length > maximum)
    invalid("device_filesystem_read_dispatch_too_large");
}
function invalid(code: string): never {
  throw new ContractValidationError(code);
}
