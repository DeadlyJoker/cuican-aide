import { ContractValidationError } from "./contract-validation-error.ts";
import {
  parseDeviceExecutionCommand,
  parseDeviceExecutionEvent,
  type DeviceExecutionCommand,
  type DeviceExecutionEvent,
} from "./device-protocol.ts";

export const DEVICE_DISPATCH_API_VERSION = 1 as const;
export const DEVICE_GATEWAY_WORKER_DISPATCH_PATH =
  "/worker/v1/device-dispatch" as const;

export const DEVICE_DISPATCH_OPERATIONS = [
  "execute",
  "reconcile",
  "cancel",
] as const;

export type DeviceDispatchOperation =
  (typeof DEVICE_DISPATCH_OPERATIONS)[number];

export type DeviceGatewayDispatchResolution =
  | Readonly<{
      status: "completed";
      executionId: string;
      providerReceiptId: string;
      terminal: Extract<DeviceExecutionEvent, { type: "execution.completed" }>;
      output: readonly Extract<
        DeviceExecutionEvent,
        { type: "execution.output" }
      >[];
    }>
  | Readonly<{
      status: "failed";
      executionId: string;
      providerReceiptId: string;
      terminal: Extract<DeviceExecutionEvent, { type: "execution.failed" }>;
    }>
  | Readonly<{
      status: "canceled";
      executionId: string;
      providerReceiptId: string;
      terminal: Extract<DeviceExecutionEvent, { type: "execution.canceled" }>;
    }>
  | Readonly<{
      status: "unknownOutcome";
      executionId: string;
      providerReceiptId: string | null;
      terminal: Extract<
        DeviceExecutionEvent,
        { type: "execution.unknown_outcome" }
      > | null;
    }>;

export type DeviceDispatchApiRequest = Readonly<{
  schemaVersion: "crewon.device-dispatch-request.v0";
  apiVersion: typeof DEVICE_DISPATCH_API_VERSION;
  operation: DeviceDispatchOperation;
  command: DeviceExecutionCommand;
}>;

export type DeviceDispatchApiResponse = Readonly<{
  schemaVersion: "crewon.device-dispatch-response.v0";
  apiVersion: typeof DEVICE_DISPATCH_API_VERSION;
  operation: DeviceDispatchOperation;
  resolution: DeviceGatewayDispatchResolution;
}>;

export type DeviceDispatchApiError = Readonly<{
  schemaVersion: "crewon.device-dispatch-error.v0";
  apiVersion: typeof DEVICE_DISPATCH_API_VERSION;
  code: string;
  retryable: boolean;
}>;

const MAX_REQUEST_BYTES = 160 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_EVENTS = 4_096;

export function parseDeviceDispatchApiRequest(
  input: unknown,
): DeviceDispatchApiRequest {
  const request = requireObject(input, "device_dispatch_request_invalid");
  requireExactKeys(request, [
    "apiVersion",
    "command",
    "operation",
    "schemaVersion",
  ]);
  if (
    request.schemaVersion !== "crewon.device-dispatch-request.v0" ||
    request.apiVersion !== DEVICE_DISPATCH_API_VERSION
  ) {
    throw new ContractValidationError("device_dispatch_api_unsupported");
  }
  const operation = parseOperation(request.operation);
  const command = parseDeviceExecutionCommand(request.command);
  requireBoundedJson(
    request,
    MAX_REQUEST_BYTES,
    "device_dispatch_request_too_large",
  );
  return {
    schemaVersion: "crewon.device-dispatch-request.v0",
    apiVersion: DEVICE_DISPATCH_API_VERSION,
    operation,
    command,
  };
}

export function parseDeviceDispatchApiResponse(
  input: unknown,
): DeviceDispatchApiResponse {
  const response = requireObject(input, "device_dispatch_response_invalid");
  requireExactKeys(response, [
    "apiVersion",
    "operation",
    "resolution",
    "schemaVersion",
  ]);
  if (
    response.schemaVersion !== "crewon.device-dispatch-response.v0" ||
    response.apiVersion !== DEVICE_DISPATCH_API_VERSION
  ) {
    throw new ContractValidationError("device_dispatch_api_unsupported");
  }
  const operation = parseOperation(response.operation);
  const resolution = parseDeviceGatewayDispatchResolution(response.resolution);
  requireBoundedJson(
    response,
    MAX_RESPONSE_BYTES,
    "device_dispatch_response_too_large",
  );
  return {
    schemaVersion: "crewon.device-dispatch-response.v0",
    apiVersion: DEVICE_DISPATCH_API_VERSION,
    operation,
    resolution,
  };
}

export function parseDeviceDispatchApiError(
  input: unknown,
): DeviceDispatchApiError {
  const error = requireObject(input, "device_dispatch_error_invalid");
  requireExactKeys(error, ["apiVersion", "code", "retryable", "schemaVersion"]);
  if (
    error.schemaVersion !== "crewon.device-dispatch-error.v0" ||
    error.apiVersion !== DEVICE_DISPATCH_API_VERSION ||
    typeof error.code !== "string" ||
    !/^[a-z0-9_.:-]{1,128}$/.test(error.code) ||
    typeof error.retryable !== "boolean"
  ) {
    throw new ContractValidationError("device_dispatch_error_invalid");
  }
  return structuredClone(error) as DeviceDispatchApiError;
}

export function parseDeviceGatewayDispatchResolution(
  input: unknown,
): DeviceGatewayDispatchResolution {
  const resolution = requireObject(input, "device_dispatch_resolution_invalid");
  const executionId = requireOpaqueId(
    resolution.executionId,
    "device_execution_id_invalid",
  );
  switch (resolution.status) {
    case "completed": {
      requireExactKeys(resolution, [
        "executionId",
        "output",
        "providerReceiptId",
        "status",
        "terminal",
      ]);
      const receiptId = requireOpaqueId(
        resolution.providerReceiptId,
        "device_receipt_id_invalid",
      );
      const terminal = parseTerminal(
        resolution.terminal,
        "execution.completed",
      );
      if (
        !Array.isArray(resolution.output) ||
        resolution.output.length > MAX_OUTPUT_EVENTS
      ) {
        throw new ContractValidationError("device_dispatch_output_invalid");
      }
      const output = resolution.output.map((event) =>
        parseOutputEvent(event, executionId, receiptId),
      );
      requireTerminalIdentity(terminal, executionId, receiptId);
      return {
        status: "completed",
        executionId,
        providerReceiptId: receiptId,
        terminal,
        output,
      };
    }
    case "failed": {
      requireExactKeys(resolution, [
        "executionId",
        "providerReceiptId",
        "status",
        "terminal",
      ]);
      const receiptId = requireOpaqueId(
        resolution.providerReceiptId,
        "device_receipt_id_invalid",
      );
      const terminal = parseTerminal(resolution.terminal, "execution.failed");
      requireTerminalIdentity(terminal, executionId, receiptId);
      return {
        status: "failed",
        executionId,
        providerReceiptId: receiptId,
        terminal,
      };
    }
    case "canceled": {
      requireExactKeys(resolution, [
        "executionId",
        "providerReceiptId",
        "status",
        "terminal",
      ]);
      const receiptId = requireOpaqueId(
        resolution.providerReceiptId,
        "device_receipt_id_invalid",
      );
      const terminal = parseTerminal(resolution.terminal, "execution.canceled");
      requireTerminalIdentity(terminal, executionId, receiptId);
      return {
        status: "canceled",
        executionId,
        providerReceiptId: receiptId,
        terminal,
      };
    }
    case "unknownOutcome": {
      requireExactKeys(resolution, [
        "executionId",
        "providerReceiptId",
        "status",
        "terminal",
      ]);
      const receiptId =
        resolution.providerReceiptId === null
          ? null
          : requireOpaqueId(
              resolution.providerReceiptId,
              "device_receipt_id_invalid",
            );
      const terminal =
        resolution.terminal === null
          ? null
          : parseTerminal(resolution.terminal, "execution.unknown_outcome");
      if (terminal !== null) {
        requireTerminalIdentity(terminal, executionId, terminal.receiptId);
        if (
          receiptId !== null &&
          receiptId !== terminal.receiptId &&
          receiptId !== terminal.data.providerReceiptId
        ) {
          throw new ContractValidationError(
            "device_dispatch_resolution_identity_mismatch",
          );
        }
      }
      return {
        status: "unknownOutcome",
        executionId,
        providerReceiptId: receiptId,
        terminal,
      };
    }
    default:
      throw new ContractValidationError("device_dispatch_status_invalid");
  }
}

function parseOperation(value: unknown): DeviceDispatchOperation {
  if (!DEVICE_DISPATCH_OPERATIONS.includes(value as DeviceDispatchOperation)) {
    throw new ContractValidationError("device_dispatch_operation_invalid");
  }
  return value as DeviceDispatchOperation;
}

function parseOutputEvent(
  input: unknown,
  executionId: string,
  receiptId: string,
): Extract<DeviceExecutionEvent, { type: "execution.output" }> {
  const event = parseDeviceExecutionEvent(input);
  if (
    event.type !== "execution.output" ||
    event.executionId !== executionId ||
    event.receiptId !== receiptId
  ) {
    throw new ContractValidationError(
      "device_dispatch_resolution_identity_mismatch",
    );
  }
  return event;
}

function parseTerminal<T extends DeviceExecutionEvent["type"]>(
  input: unknown,
  expectedType: T,
): Extract<DeviceExecutionEvent, { type: T }> {
  const event = parseDeviceExecutionEvent(input);
  if (event.type !== expectedType) {
    throw new ContractValidationError("device_dispatch_terminal_mismatch");
  }
  return event as Extract<DeviceExecutionEvent, { type: T }>;
}

function requireTerminalIdentity(
  terminal: DeviceExecutionEvent,
  executionId: string,
  receiptId: string,
): void {
  if (
    terminal.executionId !== executionId ||
    terminal.receiptId !== receiptId
  ) {
    throw new ContractValidationError(
      "device_dispatch_resolution_identity_mismatch",
    );
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
    throw new ContractValidationError("device_dispatch_fields_invalid");
  }
}

function requireOpaqueId(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(value)
  ) {
    throw new ContractValidationError(code);
  }
  return value;
}

function requireBoundedJson(
  value: unknown,
  maxBytes: number,
  code: string,
): void {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new ContractValidationError(code);
  }
  if (new TextEncoder().encode(encoded).byteLength > maxBytes) {
    throw new ContractValidationError(code);
  }
}
