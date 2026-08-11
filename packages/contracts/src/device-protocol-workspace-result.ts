import { ContractValidationError } from "./contract-validation-error.ts";
import { DEVICE_WORKSPACE_LIST_HARD_LIMITS } from "./device-protocol-workspace.ts";

export type DeviceWorkspaceListResult = Readonly<{
  schemaVersion: "crewon.workspace-list-result.v0";
  executionId: string;
  actionDigest: string;
  commandDigest: string;
  entries: readonly Readonly<{
    name: string;
    kind: "file" | "directory";
  }>[];
  truncated: boolean;
}>;

export function parseDeviceWorkspaceListResult(
  input: unknown,
  expected: Readonly<{
    executionId: string;
    actionDigest: string;
    commandDigest: string;
    maxEntries: number;
    maxNameBytes: number;
    maxOutputBytes: number;
  }>,
): DeviceWorkspaceListResult {
  const result = requireObject(input, "device_workspace_result_invalid");
  requireExactKeys(result, [
    "actionDigest",
    "commandDigest",
    "entries",
    "executionId",
    "schemaVersion",
    "truncated",
  ]);
  if (
    result.schemaVersion !== "crewon.workspace-list-result.v0" ||
    typeof result.truncated !== "boolean" ||
    !Array.isArray(result.entries) ||
    result.entries.length > expected.maxEntries ||
    result.entries.length > DEVICE_WORKSPACE_LIST_HARD_LIMITS.maxEntries
  ) {
    throw new ContractValidationError("device_workspace_result_invalid");
  }
  requireOpaqueId(result.executionId, "device_execution_id_invalid");
  requireDigest(result.actionDigest, "device_action_digest_invalid");
  requireDigest(result.commandDigest, "device_command_digest_invalid");
  if (
    result.executionId !== expected.executionId ||
    result.actionDigest !== expected.actionDigest ||
    result.commandDigest !== expected.commandDigest
  ) {
    throw new ContractValidationError(
      "device_workspace_result_identity_mismatch",
    );
  }
  const entries = result.entries.map((entry) =>
    parseWorkspaceListEntry(entry, expected.maxNameBytes),
  );
  for (let index = 1; index < entries.length; index += 1) {
    if (
      compareBytes(
        utf8(entries[index - 1]!.name),
        utf8(entries[index]!.name),
      ) >= 0
    ) {
      throw new ContractValidationError("device_workspace_result_invalid");
    }
  }
  const parsed: DeviceWorkspaceListResult = {
    schemaVersion: "crewon.workspace-list-result.v0",
    executionId: result.executionId,
    actionDigest: result.actionDigest,
    commandDigest: result.commandDigest,
    entries,
    truncated: result.truncated,
  };
  requireBoundedJson(
    parsed,
    Math.min(
      expected.maxOutputBytes,
      DEVICE_WORKSPACE_LIST_HARD_LIMITS.maxOutputBytes,
    ),
    "device_workspace_result_too_large",
  );
  return parsed;
}

function parseWorkspaceListEntry(
  input: unknown,
  maximumNameBytes: number,
): DeviceWorkspaceListResult["entries"][number] {
  const entry = requireObject(input, "device_workspace_result_invalid");
  requireExactKeys(entry, ["kind", "name"]);
  if (
    typeof entry.name !== "string" ||
    (entry.kind !== "file" && entry.kind !== "directory")
  ) {
    throw new ContractValidationError("device_workspace_result_invalid");
  }
  const encoded = utf8(entry.name);
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
  } catch {
    throw new ContractValidationError("device_workspace_entry_name_invalid");
  }
  if (
    encoded.byteLength < 1 ||
    encoded.byteLength > maximumNameBytes ||
    encoded.byteLength > DEVICE_WORKSPACE_LIST_HARD_LIMITS.maxNameBytes ||
    decoded !== entry.name ||
    entry.name === "." ||
    entry.name === ".." ||
    /[\\/\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(entry.name)
  ) {
    throw new ContractValidationError("device_workspace_entry_name_invalid");
  }
  return { name: entry.name, kind: entry.kind };
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

function requireOpaqueId(
  value: unknown,
  code: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)
  ) {
    throw new ContractValidationError(code);
  }
}

function requireDigest(value: unknown, code: string): asserts value is string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
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

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.byteLength - right.byteLength;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
