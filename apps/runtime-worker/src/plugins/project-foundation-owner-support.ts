import { createHash } from "node:crypto";
import { types } from "node:util";

export const foundationOwnerDigester = Object.freeze({
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
});

/** Read native own data only; a plugin accessor, Proxy or iterator is never authority. */
export function foundationOwnerNativeRecord(
  input: unknown,
): asserts input is object {
  if (
    input === null ||
    typeof input !== "object" ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    foundationOwnerDenied();
}

export function foundationOwnerData(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  foundationOwnerNativeRecord(input);
  if (Reflect.ownKeys(input).length !== keys.length) foundationOwnerDenied();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    const property = Object.getOwnPropertyDescriptor(input, key);
    if (
      typeof key !== "string" ||
      !keys.includes(key) ||
      !property?.enumerable ||
      !("value" in property)
    )
      foundationOwnerDenied();
    result[key] = property.value;
  }
  return result;
}

/** Bind trusted host ports once, without evaluating a replaced method getter. */
export function foundationOwnerBound<T extends Function>(
  input: unknown,
  key: string,
): T {
  if (input === null || typeof input !== "object" || types.isProxy(input))
    foundationOwnerDenied();
  for (
    let owner: object | null = input, depth = 0;
    owner !== null && depth < 16;
    owner = Object.getPrototypeOf(owner), depth++
  ) {
    const property = Object.getOwnPropertyDescriptor(owner, key);
    if (!property) continue;
    if (!("value" in property) || typeof property.value !== "function")
      foundationOwnerDenied();
    return property.value.bind(input) as T;
  }
  return foundationOwnerDenied();
}

export function foundationOwnerDenied(): never {
  throw new Error("plugin_project_foundation_tools_authority_denied");
}
