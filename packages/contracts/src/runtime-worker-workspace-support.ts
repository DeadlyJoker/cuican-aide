import { ContractValidationError } from "./contract-validation-error.ts";
import {
  RUNTIME_WORKER_WORKSPACE_WIRE_LIMITS,
  RUNTIME_WORKER_WORKSPACE_API_VERSION,
  type RuntimeWorkerFrozenWorkspaceCommand,
  type RuntimeWorkerWorkspaceDeliveryLease,
  type RuntimeWorkerWorkspaceListLimits,
  type RuntimeWorkerWorkspacePhase,
  type RuntimeWorkerWorkspaceResolution,
} from "./runtime-worker-workspace-types.ts";

export function parseDeliveryLease(
  input: unknown,
): RuntimeWorkerWorkspaceDeliveryLease {
  const lease = object(input, "runtime_workspace_delivery_lease_invalid");
  exact(lease, [
    "attemptNumber",
    "epoch",
    "executionId",
    "expiresAt",
    "leaseId",
    "leasedAt",
    "ownerId",
    "phase",
    "schemaVersion",
  ]);
  if (lease.schemaVersion !== "crewon.workspace-delivery-lease.v0") {
    throw new ContractValidationError(
      "runtime_workspace_delivery_lease_invalid",
    );
  }
  const parsed: RuntimeWorkerWorkspaceDeliveryLease = {
    schemaVersion: "crewon.workspace-delivery-lease.v0",
    executionId: opaqueId(lease.executionId),
    attemptNumber: positiveInteger(lease.attemptNumber),
    phase: parsePhase(lease.phase),
    ownerId: identity(lease.ownerId),
    leaseId: opaqueId(lease.leaseId),
    epoch: positiveInteger(lease.epoch),
    leasedAt: timestamp(lease.leasedAt),
    expiresAt: timestamp(lease.expiresAt),
  };
  if (Date.parse(parsed.expiresAt) <= Date.parse(parsed.leasedAt)) {
    throw new ContractValidationError(
      "runtime_workspace_delivery_lease_invalid",
    );
  }
  return parsed;
}

export function parseResolution(
  input: unknown,
  expected: RuntimeWorkerFrozenWorkspaceCommand,
): RuntimeWorkerWorkspaceResolution {
  const resolution = object(input, "runtime_workspace_resolution_invalid");
  const common = {
    executionId: opaqueId(resolution.executionId),
    actionDigest: digest(resolution.actionDigest),
    commandDigest: digest(resolution.commandDigest),
  };
  if (
    common.executionId !== expected.executionId ||
    common.actionDigest !== expected.actionDigest ||
    common.commandDigest !== expected.commandDigest
  ) {
    throw new ContractValidationError("runtime_workspace_resolution_mismatch");
  }
  let parsed: RuntimeWorkerWorkspaceResolution;
  if (resolution.status === "completed") {
    exact(resolution, [
      "actionDigest",
      "commandDigest",
      "entries",
      "executionId",
      "providerReceiptId",
      "status",
      "truncated",
    ]);
    if (
      !Array.isArray(resolution.entries) ||
      typeof resolution.truncated !== "boolean"
    ) {
      throw new ContractValidationError("runtime_workspace_resolution_invalid");
    }
    const entries = resolution.entries.map((entry) =>
      parseEntry(entry, expected.limits.maxNameBytes),
    );
    if (entries.length > expected.limits.maxEntries) {
      throw new ContractValidationError("runtime_workspace_resolution_invalid");
    }
    requireSortedEntries(entries);
    parsed = {
      status: "completed",
      ...common,
      providerReceiptId: opaqueId(resolution.providerReceiptId),
      entries,
      truncated: resolution.truncated,
    };
  } else if (resolution.status === "failed") {
    exact(resolution, [
      "actionDigest",
      "code",
      "commandDigest",
      "executionId",
      "providerReceiptId",
      "retryable",
      "status",
    ]);
    if (typeof resolution.retryable !== "boolean") {
      throw new ContractValidationError("runtime_workspace_resolution_invalid");
    }
    parsed = {
      status: "failed",
      ...common,
      providerReceiptId: opaqueId(resolution.providerReceiptId),
      code: safeCode(resolution.code),
      retryable: resolution.retryable,
    };
  } else if (
    resolution.status === "canceled" ||
    resolution.status === "unknownOutcome"
  ) {
    exact(resolution, [
      "actionDigest",
      "commandDigest",
      "executionId",
      "providerReceiptId",
      "status",
    ]);
    parsed = {
      status: resolution.status,
      ...common,
      providerReceiptId:
        resolution.providerReceiptId === null
          ? null
          : opaqueId(resolution.providerReceiptId),
    };
  } else {
    throw new ContractValidationError("runtime_workspace_resolution_invalid");
  }
  bounded(
    parsed,
    expected.limits.maxOutputBytes,
    "runtime_workspace_resolution_too_large",
  );
  return parsed;
}

export function parseLimits(input: unknown): RuntimeWorkerWorkspaceListLimits {
  const limits = object(input, "runtime_workspace_limits_invalid");
  exact(limits, [
    "depth",
    "maxEntries",
    "maxNameBytes",
    "maxOutputBytes",
    "maxScannedEntries",
    "maxScannedNameBytes",
    "timeoutMs",
  ]);
  if (limits.depth !== 0) {
    throw new ContractValidationError("runtime_workspace_limits_invalid");
  }
  const parsed: RuntimeWorkerWorkspaceListLimits = {
    depth: 0,
    maxEntries: integer(
      limits.maxEntries,
      1,
      RUNTIME_WORKER_WORKSPACE_WIRE_LIMITS.maxEntries,
    ),
    maxNameBytes: integer(
      limits.maxNameBytes,
      1,
      RUNTIME_WORKER_WORKSPACE_WIRE_LIMITS.maxNameBytes,
    ),
    maxOutputBytes: integer(
      limits.maxOutputBytes,
      1,
      RUNTIME_WORKER_WORKSPACE_WIRE_LIMITS.maxOutputBytes,
    ),
    maxScannedEntries: integer(
      limits.maxScannedEntries,
      1,
      RUNTIME_WORKER_WORKSPACE_WIRE_LIMITS.maxScannedEntries,
    ),
    maxScannedNameBytes: integer(
      limits.maxScannedNameBytes,
      1,
      RUNTIME_WORKER_WORKSPACE_WIRE_LIMITS.maxScannedNameBytes,
    ),
    timeoutMs: integer(
      limits.timeoutMs,
      1,
      RUNTIME_WORKER_WORKSPACE_WIRE_LIMITS.maxTimeoutMs,
    ),
  };
  if (
    parsed.maxScannedEntries < parsed.maxEntries ||
    parsed.maxScannedNameBytes < parsed.maxNameBytes
  ) {
    throw new ContractValidationError("runtime_workspace_limits_invalid");
  }
  return parsed;
}

export function parseEntry(
  input: unknown,
  maximumBytes: number,
): RuntimeWorkerWorkspaceResolution extends infer _
  ? Readonly<{ name: string; kind: "file" | "directory" }>
  : never {
  const entry = object(input, "runtime_workspace_entry_invalid");
  exact(entry, ["kind", "name"]);
  if (
    typeof entry.name !== "string" ||
    (entry.kind !== "file" && entry.kind !== "directory")
  ) {
    throw new ContractValidationError("runtime_workspace_entry_invalid");
  }
  const bytes = utf8(entry.name);
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > maximumBytes ||
    entry.name === "." ||
    entry.name === ".." ||
    /[\\/\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(entry.name)
  ) {
    throw new ContractValidationError("runtime_workspace_entry_invalid");
  }
  return { name: entry.name, kind: entry.kind };
}

export function requireSortedEntries(
  entries: readonly Readonly<{ name: string }>[],
): void {
  for (let index = 1; index < entries.length; index += 1) {
    if (compareBytes(entries[index - 1]!.name, entries[index]!.name) >= 0) {
      throw new ContractValidationError("runtime_workspace_entries_unsorted");
    }
  }
}

export function compareBytes(left: string, right: string): number {
  const leftBytes = utf8(left);
  const rightBytes = utf8(right);
  const length = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.byteLength - rightBytes.byteLength;
}

export function envelope(
  input: Readonly<Record<string, unknown>>,
  schemaVersion: string,
  code: string,
): void {
  if (
    input.schemaVersion !== schemaVersion ||
    input.apiVersion !== RUNTIME_WORKER_WORKSPACE_API_VERSION
  ) {
    throw new ContractValidationError(code);
  }
}

export function parsePhase(input: unknown): RuntimeWorkerWorkspacePhase {
  if (input !== "execute" && input !== "reconcile" && input !== "cancel") {
    throw new ContractValidationError("runtime_workspace_phase_invalid");
  }
  return input;
}

export function object(input: unknown, code: string): Record<string, unknown> {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
  ) {
    throw new ContractValidationError(code);
  }
  return input as Record<string, unknown>;
}

export function exact(
  input: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(input).sort();
  const sorted = [...expected].sort();
  if (
    actual.length !== sorted.length ||
    actual.some((key, index) => key !== sorted[index])
  ) {
    throw new ContractValidationError("runtime_workspace_fields_invalid");
  }
}

export function opaqueId(input: unknown): string {
  if (
    typeof input !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(input)
  ) {
    throw new ContractValidationError("runtime_workspace_identity_invalid");
  }
  return input;
}

export function identity(input: unknown, maximumBytes = 512): string {
  if (
    typeof input !== "string" ||
    input.trim().length === 0 ||
    input !== input.trim() ||
    utf8(input).byteLength > maximumBytes ||
    /[\0\r\n]/u.test(input)
  ) {
    throw new ContractValidationError("runtime_workspace_identity_invalid");
  }
  return input;
}

export function digest(input: unknown): string {
  if (typeof input !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(input)) {
    throw new ContractValidationError("runtime_workspace_digest_invalid");
  }
  return input;
}

export function safeCode(input: unknown): string {
  if (typeof input !== "string" || !/^[a-z0-9_.:-]{1,128}$/u.test(input)) {
    throw new ContractValidationError("runtime_workspace_code_invalid");
  }
  return input;
}

export function positiveInteger(input: unknown): number {
  if (!Number.isSafeInteger(input) || Number(input) < 1) {
    throw new ContractValidationError("runtime_workspace_integer_invalid");
  }
  return Number(input);
}

export function integer(
  input: unknown,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(input) ||
    Number(input) < minimum ||
    Number(input) > maximum
  ) {
    throw new ContractValidationError("runtime_workspace_integer_invalid");
  }
  return Number(input);
}

export function timestamp(input: unknown): string {
  if (typeof input !== "string") {
    throw new ContractValidationError("runtime_workspace_timestamp_invalid");
  }
  const parsed = Date.parse(input);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== input) {
    throw new ContractValidationError("runtime_workspace_timestamp_invalid");
  }
  return input;
}

export function bounded(
  input: unknown,
  maximumBytes: number,
  code: string,
): void {
  let bytes: Uint8Array;
  try {
    bytes = utf8(JSON.stringify(input));
  } catch {
    throw new ContractValidationError(code);
  }
  if (bytes.byteLength > maximumBytes) {
    throw new ContractValidationError(code);
  }
}

export function utf8(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}
