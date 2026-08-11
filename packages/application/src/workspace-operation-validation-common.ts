export function validateWorkspaceListEntry(input: unknown): Readonly<{
  name: string;
  kind: "file" | "directory";
}> {
  if (
    !hasExactKeys(input, ["kind", "name"]) ||
    (input.kind !== "file" && input.kind !== "directory") ||
    typeof input.name !== "string"
  ) {
    throw workspaceStoreError("workspace_operation_entry_invalid");
  }
  const bytes = new TextEncoder().encode(input.name);
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > WORKSPACE_OPERATION_LIMITS.maxNameBytes ||
    input.name === "." ||
    input.name === ".." ||
    /[\\/\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input.name)
  ) {
    throw workspaceStoreError("workspace_operation_entry_invalid");
  }
  return { name: input.name, kind: input.kind };
}

export function requireRawByteOrder(
  entries: readonly Readonly<{ name: string }>[],
): void {
  for (let index = 1; index < entries.length; index += 1) {
    if (compareBytes(entries[index - 1]!.name, entries[index]!.name) >= 0) {
      throw workspaceStoreError("workspace_operation_entries_unsorted");
    }
  }
}

export function compareBytes(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.byteLength - rightBytes.byteLength;
}

export function idempotency(input: IdempotencyDescriptor): void {
  if (
    !hasExactKeys(input, ["key", "requestFingerprint", "scope"]) ||
    typeof input.scope !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(input.scope) ||
    typeof input.key !== "string" ||
    input.key.length < 1 ||
    input.key.length > 256 ||
    !/^sha256:[0-9a-f]{64}$/u.test(input.requestFingerprint)
  ) {
    throw workspaceStoreError("workspace_operation_idempotency_invalid");
  }
}

export function opaqueId(input: unknown): string {
  if (
    typeof input !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(input)
  ) {
    throw workspaceStoreError("workspace_operation_identity_invalid");
  }
  return input;
}

export function boundedIdentity(input: unknown, maximum = 512): string {
  if (
    typeof input !== "string" ||
    input.trim().length === 0 ||
    input !== input.trim() ||
    new TextEncoder().encode(input).byteLength > maximum ||
    /[\0\r\n]/u.test(input)
  ) {
    throw workspaceStoreError("workspace_operation_identity_invalid");
  }
  return input;
}

export function digest(input: unknown): string {
  if (typeof input !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(input)) {
    throw workspaceStoreError("workspace_operation_digest_invalid");
  }
  return input;
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
    throw workspaceStoreError("workspace_operation_limits_invalid");
  }
  return Number(input);
}

export function positiveInteger(input: unknown): number {
  if (!Number.isSafeInteger(input) || Number(input) < 1) {
    throw workspaceStoreError("workspace_operation_revision_invalid");
  }
  return Number(input);
}

export function hasExactKeys(
  input: unknown,
  expected: readonly string[],
): input is Record<string, unknown> {
  if (!isPlainObject(input)) return false;
  const actual = Object.keys(input).sort();
  const sorted = [...expected].sort();
  return (
    actual.length === sorted.length &&
    actual.every((key, index) => key === sorted[index])
  );
}

export function isPlainObject(
  input: unknown,
): input is Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}

export function workspaceStoreError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
import type { IdempotencyDescriptor } from "./run-store-port.ts";
import { WORKSPACE_OPERATION_LIMITS } from "./workspace-operation-store-port.ts";
