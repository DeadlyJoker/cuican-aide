import {
  extensionCanonicalJson,
  extensionOpaqueId,
  type CreditScope,
} from "@crewon/domain";
import type { PluginCreditSettlementLocator } from "@crewon/application";
import { extensionStoreDigester } from "./extension-store-records.ts";
import type { SettlementRow } from "./plugin-credit-settlement-records.ts";

const code = "plugin_credit_settlement_record_invalid";
const SETTLEMENT_COLLECTION_LIMIT = 64;

export function indexed(
  row: SettlementRow,
  value: object,
  mapping: Readonly<Record<string, string>>,
): void {
  const state = value as Record<string, unknown>;
  for (const [column, key] of Object.entries(mapping)) {
    const expected = state[key],
      actual = row[column];
    if (
      typeof expected === "number"
        ? integer(actual) !== expected
        : column.endsWith("_at")
          ? nullableTimestamp(actual) !== nullableTimestamp(expected)
          : actual !== expected
    )
      fail("plugin_credit_settlement_indexed_identity_mismatch");
  }
}
export function indexedScope(row: SettlementRow, scope: CreditScope): void {
  indexed(row, scope, {
    tenant_id: "tenantId",
    principal_id: "principalId",
    pool_id: "poolId",
  });
}
export function runIdentity(
  value: object,
  locator: PluginCreditSettlementLocator,
): void {
  const state = value as Record<string, unknown>;
  if (state.tenantId !== locator.tenantId || state.runId !== locator.runId)
    fail("plugin_credit_settlement_run_identity_mismatch");
}
export function versions(rows: readonly SettlementRow[]): void {
  if (
    rows.length !== 1 ||
    integer(requiredRow(rows[0]).id, 1) !== 1 ||
    integer(requiredRow(rows[0]).version, 1) !== 1
  )
    fail("plugin_credit_settlement_schema_version_unsupported");
}
export function bounded(
  input: unknown,
): asserts input is readonly SettlementRow[] {
  if (
    !Array.isArray(input) ||
    input.length > SETTLEMENT_COLLECTION_LIMIT ||
    Reflect.ownKeys(input).length !== input.length + 1 ||
    Object.values(Object.getOwnPropertyDescriptors(input)).some(
      (descriptor) => !Object.hasOwn(descriptor, "value"),
    )
  )
    fail("plugin_credit_settlement_collection_overflow");
  for (const row of input) requiredRow(row);
}
export function record(
  input: unknown,
  keys?: readonly string[],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
  )
    fail();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(input).some((key) => typeof key !== "string") ||
    Object.values(descriptors).some(
      (descriptor) =>
        !Object.hasOwn(descriptor, "value") || !descriptor.enumerable,
    )
  )
    fail();
  const value = input as Record<string, unknown>;
  if (
    keys !== undefined &&
    Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")
  )
    fail();
  return value;
}
export function optionalRow(input: unknown): SettlementRow | undefined {
  return input === undefined ? undefined : record(input);
}
export function requiredRow(input: unknown): SettlementRow {
  if (input === undefined) fail("plugin_credit_settlement_evidence_missing");
  return record(input);
}
export function allowed(
  value: Record<string, unknown>,
  keys: readonly string[],
): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) fail();
}
export function integer(input: unknown, minimum = 0): number {
  if (
    typeof input !== "number" &&
    (typeof input !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(input))
  )
    fail();
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < minimum) fail();
  return value;
}
export function timestamp(input: unknown): string {
  const time =
    input instanceof Date
      ? Date.prototype.getTime.call(input)
      : typeof input === "string"
        ? Date.parse(input)
        : NaN;
  if (!Number.isFinite(time)) fail();
  return new Date(time).toISOString();
}
export function nullableTimestamp(input: unknown): string | null {
  return input === null ? null : timestamp(input);
}
export function queueTime(row: SettlementRow, column: string): string | null {
  if (Object.hasOwn(row, `${column}_ms`)) {
    const value = row[`${column}_ms`];
    return value === null ? null : timestamp(new Date(integer(value)));
  }
  return nullableTimestamp(row[column]);
}
export function nullableId(input: unknown): string | null {
  return input === null ? null : extensionOpaqueId(input);
}
export function ordered(start: unknown, updated: unknown, end: unknown): void {
  if (
    timestamp(start) > timestamp(updated) ||
    (end !== null && timestamp(end) !== timestamp(updated))
  )
    fail("plugin_credit_settlement_time_invalid");
}
export function unique(ids: readonly string[]): void {
  if (new Set(ids).size !== ids.length)
    fail("plugin_credit_settlement_duplicate_evidence");
}
export function sorted<T extends Record<string, unknown>>(
  values: T[],
  key: keyof T,
): readonly T[] {
  return Object.freeze(
    values.sort((left, right) =>
      String(left[key]) < String(right[key])
        ? -1
        : String(left[key]) > String(right[key])
          ? 1
          : 0,
    ),
  );
}
export function hash(value: unknown): string {
  return extensionStoreDigester.sha256(canonicalJson(value));
}
// Same sorted-object canonical representation as extensionCanonicalJson, with the larger
// existing durable Tool receipt bound. Raw output is hashed locally and never enters evidence.
export function canonicalJson(value: unknown): string {
  return JSON.stringify(json(value, 2 * 1024 * 1024));
}
export function same(left: unknown, right: unknown): void {
  if (extensionCanonicalJson(left) !== extensionCanonicalJson(right))
    fail("plugin_credit_settlement_identity_mismatch");
}
export function fail(error = code): never {
  throw new Error(error);
}

/** Detach bounded JSON without executing getters, inherited methods, or toJSON. */
export function json(input: unknown, maxBytes: number): unknown {
  if (typeof input === "string") {
    if (Buffer.byteLength(input) > maxBytes)
      fail("plugin_credit_settlement_json_limit");
    try {
      input = JSON.parse(input);
    } catch {
      fail();
    }
  }
  let nodes = 0,
    bytes = 0;
  const ancestors = new Set<object>();
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > 32768 || depth > 32)
      fail("plugin_credit_settlement_json_limit");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      bytes += Buffer.byteLength(value);
      if (bytes > maxBytes) fail("plugin_credit_settlement_json_limit");
      return value;
    }
    if (typeof value !== "object" || value === null || ancestors.has(value))
      fail();
    ancestors.add(value);
    let result: unknown;
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (
        value.length > 32768 ||
        Reflect.ownKeys(value).length !== value.length + 1 ||
        Object.values(descriptors).some(
          (entry) => !Object.hasOwn(entry, "value"),
        )
      )
        fail();
      result = Array.from({ length: value.length }, (_, index) =>
        visit(descriptors[String(index)]?.value, depth + 1),
      );
    } else {
      const object = record(value);
      if (Object.keys(object).length > 256) fail();
      result = Object.fromEntries(
        Object.keys(object)
          .sort()
          .map((key) => [visit(key, depth + 1), visit(object[key], depth + 1)]),
      );
    }
    ancestors.delete(value);
    return result;
  };
  const result = visit(input, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes)
    fail("plugin_credit_settlement_json_limit");
  return result;
}
