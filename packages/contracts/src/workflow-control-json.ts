import { ContractValidationError } from "./contract-validation-error.ts";
function fail(): never {
  throw new ContractValidationError("workflow_response_invalid");
}
function object(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail();
  return value as Record<string, unknown>;
}
/** Copy data properties before validation/serialization; never execute caller accessors or toJSON. */
export function captureWorkflowControlJson(
  value: unknown,
  maximumBytes: number,
  input = false,
): unknown {
  let nodes = 0,
    bytes = 0;
  const path = new Set<object>();
  const measure = (value: string, maximum = maximumBytes) => {
    if (value.length > maximum) fail();
    const size = new TextEncoder().encode(value).byteLength;
    if (size > maximum || (bytes += size) > maximumBytes) fail();
  };
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > (input ? 1024 : 300000) || depth > (input ? 8 : 40)) fail();
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) fail();
      return value;
    }
    if (typeof value === "string") {
      measure(value, input ? 8192 : maximumBytes);
      return value;
    }
    if (!value || typeof value !== "object" || path.has(value)) fail();
    path.add(value);
    const names = Reflect.ownKeys(value);
    let result: unknown;
    if (Array.isArray(value)) {
      if (
        value.length > (input ? 256 : 32768) ||
        names.length !== value.length + 1
      )
        fail();
      result = Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
          fail();
        return visit(descriptor.value, depth + 1);
      });
    } else {
      object(value);
      if (names.length > (input ? 256 : 32768)) fail();
      result = Object.fromEntries(
        names.map((key) => {
          if (typeof key !== "string") fail();
          measure(key, 8192);
          const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
          if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
            fail();
          return [key, visit(descriptor.value, depth + 1)];
        }),
      );
    }
    path.delete(value);
    return result;
  };
  const result = visit(value, 0);
  if (
    new TextEncoder().encode(JSON.stringify(result)).byteLength > maximumBytes
  )
    fail();
  return result;
}
