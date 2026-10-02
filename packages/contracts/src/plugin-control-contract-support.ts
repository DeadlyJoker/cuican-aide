import { ContractValidationError } from "./contract-validation-error.ts";

export function pluginControlFail(
  code = "plugin_control_contract_invalid",
): never {
  throw new ContractValidationError(code);
}

/** Query objects may use Fastify's parser-owned prototype; only their own data is copied. */
export function pluginControlRecord(
  input: unknown,
  fields: readonly string[],
  options: Readonly<{ optional?: readonly string[]; query?: boolean }> = {},
): Readonly<Record<string, unknown>> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    pluginControlFail();
  const prototype = Object.getPrototypeOf(input);
  if (!options.query && prototype !== Object.prototype && prototype !== null)
    pluginControlFail();
  const keys = Reflect.ownKeys(input);
  if (
    keys.length > fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    pluginControlFail();
  const values: [string, unknown][] = [];
  for (const field of fields) {
    const property = Object.getOwnPropertyDescriptor(input, field);
    if (!property) {
      if (options.optional?.includes(field)) continue;
      pluginControlFail();
    }
    if (!property.enumerable || !Object.hasOwn(property, "value"))
      pluginControlFail();
    values.push([field, property.value]);
  }
  return Object.freeze(Object.fromEntries(values));
}

export function pluginControlOpaqueId(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length < 1 ||
    input.length > 128 ||
    input !== input.trim() ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input)
  )
    pluginControlFail("plugin_control_id_invalid");
  for (const point of input) {
    const code = point.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff)
      pluginControlFail("plugin_control_id_invalid");
  }
  return input;
}
export function pluginControlRevision(input: unknown): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1)
    pluginControlFail("plugin_control_revision_invalid");
  return input;
}
export function pluginControlLimit(input: unknown): number {
  const limit = pluginControlRevision(input);
  if (limit > 50) pluginControlFail("plugin_control_limit_invalid");
  return limit;
}
export function pluginControlTimestamp(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length !== 24 ||
    !Number.isFinite(Date.parse(input)) ||
    new Date(input).toISOString() !== input
  )
    pluginControlFail("plugin_control_timestamp_invalid");
  return input;
}
export function pluginControlVersion(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length > 128 ||
    !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(
      input,
    )
  )
    pluginControlFail("plugin_control_version_invalid");
  return input;
}
export function pluginControlArray(
  input: unknown,
  maximum: number,
): readonly unknown[] {
  if (!Array.isArray(input) || input.length > maximum) pluginControlFail();
  return input;
}

/** Exact encoded JSON bounds and detached immutable data; no getters or serialization hooks run. */
export function copyPluginControlJson(
  input: unknown,
  limits: Readonly<{ maxBytes: number; maxNodes?: number }>,
): unknown {
  const maxNodes = limits.maxNodes ?? 8192;
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  const charge = (size: number) => {
    bytes += size;
    if (bytes > limits.maxBytes)
      pluginControlFail("plugin_control_json_bytes_exceeded");
  };
  const quoted = (value: string) => {
    if (value.length + 2 > limits.maxBytes - bytes)
      pluginControlFail("plugin_control_json_bytes_exceeded");
    charge(2);
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) pluginControlFail();
        charge(4);
      } else if (code >= 0xdc00 && code <= 0xdfff) pluginControlFail();
      else if (code === 0x22 || code === 0x5c) charge(2);
      else if (code < 0x20) charge([8, 9, 10, 12, 13].includes(code) ? 2 : 6);
      else charge(code < 0x80 ? 1 : code < 0x800 ? 2 : 3);
    }
  };
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > maxNodes || depth > 24)
      pluginControlFail("plugin_control_json_complexity_exceeded");
    if (value === null || typeof value === "boolean") {
      charge(value === null || value === true ? 4 : 5);
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) pluginControlFail();
      charge(JSON.stringify(value).length);
      return value;
    }
    if (typeof value === "string") {
      quoted(value);
      return value;
    }
    if (typeof value !== "object" || ancestors.has(value)) pluginControlFail();
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
        if (
          Object.getPrototypeOf(value) !== Array.prototype ||
          !Number.isSafeInteger(length) ||
          length > maxNodes ||
          Reflect.ownKeys(value).length !== length + 1
        )
          pluginControlFail();
        charge(2);
        const result: unknown[] = [];
        for (let i = 0; i < length; i++) {
          const property = Object.getOwnPropertyDescriptor(value, String(i));
          if (!property?.enumerable || !Object.hasOwn(property, "value"))
            pluginControlFail();
          if (i > 0) charge(1);
          result.push(visit(property.value, depth + 1));
        }
        return Object.freeze(result);
      }
      const prototype = Object.getPrototypeOf(value);
      const keys = Reflect.ownKeys(value);
      if (
        (prototype !== Object.prototype && prototype !== null) ||
        keys.length > maxNodes
      )
        pluginControlFail();
      charge(2);
      const entries = keys.map((key, index) => {
        if (typeof key !== "string") pluginControlFail();
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (!property?.enumerable || !Object.hasOwn(property, "value"))
          pluginControlFail();
        if (index > 0) charge(1);
        quoted(key);
        charge(1);
        return [key, visit(property.value, depth + 1)] as const;
      });
      return Object.freeze(Object.fromEntries(entries));
    } finally {
      ancestors.delete(value);
    }
  };
  return visit(input, 0);
}
