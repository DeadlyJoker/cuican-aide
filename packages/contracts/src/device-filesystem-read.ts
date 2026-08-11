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
