import { ApplicationError } from "./application-error.ts";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(stabilize(value, new WeakSet<object>(), 0));
}

function stabilize(
  value: unknown,
  ancestors: WeakSet<object>,
  depth: number,
): unknown {
  if (depth > 32) {
    throw invalidJson();
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw invalidJson();
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw invalidJson();
    }
    ancestors.add(value);
    const result = value.map((item) => stabilize(item, ancestors, depth + 1));
    ancestors.delete(value);
    return result;
  }
  if (!isPlainObject(value) || ancestors.has(value)) {
    throw invalidJson();
  }
  ancestors.add(value);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item === undefined) {
      throw invalidJson();
    }
    result[key] = stabilize(item, ancestors, depth + 1);
  }
  ancestors.delete(value);
  return result;
}

function invalidJson(): ApplicationError {
  return new ApplicationError("validation", "command_non_json_value");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
