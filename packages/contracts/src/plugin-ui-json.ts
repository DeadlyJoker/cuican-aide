import { ContractValidationError } from "./contract-validation-error.ts";

export type PluginUiJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly PluginUiJsonValue[]
  | Readonly<{ [key: string]: PluginUiJsonValue }>;

export class PluginUiContractError extends ContractValidationError {
  constructor(code: string) {
    super(code);
    this.name = "PluginUiContractError";
  }
}

export function pluginUiFailure(code: string): never {
  throw new PluginUiContractError(code);
}

/** Detached JSON only: getters, hooks, custom prototypes and sparse arrays are not evaluated. */
export function parsePluginUiJsonValue(
  input: unknown,
  options: Readonly<{ maxBytes?: number }> = {},
): PluginUiJsonValue {
  const maxBytes = options.maxBytes ?? 65536;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 65536)
    pluginUiFailure("plugin_ui_json_limit_invalid");
  return copyBoundedJsonValue(input, maxBytes);
}

/** Internal contract helper; deliberately absent from package entrypoints. */
export function copyBoundedJsonValue(
  input: unknown,
  maxBytes: number,
): PluginUiJsonValue {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 128 * 1024)
    pluginUiFailure("plugin_ui_json_limit_invalid");
  const ancestors = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  function charge(size: number): void {
    bytes += size;
    if (bytes > maxBytes) pluginUiFailure("plugin_ui_json_bytes_exceeded");
  }
  function quotedString(value: string): void {
    // UTF-16 length is a lower bound for the encoded content. Reject before scanning a long
    // key/string, and never allocate an encoded string merely to discover its excess size.
    if (value.length + 2 > maxBytes - bytes)
      pluginUiFailure("plugin_ui_json_bytes_exceeded");
    charge(2);
    for (let i = 0; i < value.length; i++) {
      const unit = value.charCodeAt(i);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = value.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff))
          pluginUiFailure("plugin_ui_json_invalid");
        charge(4);
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        pluginUiFailure("plugin_ui_json_invalid");
      } else if (unit === 0x22 || unit === 0x5c) {
        charge(2);
      } else if (unit < 0x20) {
        charge([0x08, 0x09, 0x0a, 0x0c, 0x0d].includes(unit) ? 2 : 6);
      } else {
        charge(unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3);
      }
    }
  }
  function visit(value: unknown, depth: number): PluginUiJsonValue {
    if (++nodes > 8192 || depth > 16)
      pluginUiFailure("plugin_ui_json_complexity_exceeded");
    if (value === null || typeof value === "boolean") {
      charge(value === null || value === true ? 4 : 5);
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) pluginUiFailure("plugin_ui_json_invalid");
      charge(JSON.stringify(value).length);
      return value;
    }
    if (typeof value === "string") {
      if (value.length > maxBytes) pluginUiFailure("plugin_ui_json_invalid");
      quotedString(value);
      return value;
    }
    if (typeof value !== "object") pluginUiFailure("plugin_ui_json_invalid");
    if (ancestors.has(value)) pluginUiFailure("plugin_ui_json_cycle");
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype)
          pluginUiFailure("plugin_ui_json_invalid");
        const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
        if (!Number.isSafeInteger(length) || length > 8192)
          pluginUiFailure("plugin_ui_json_complexity_exceeded");
        const keys = Reflect.ownKeys(value);
        if (keys.length !== length + 1)
          pluginUiFailure("plugin_ui_json_invalid");
        charge(2);
        const copied: PluginUiJsonValue[] = [];
        for (let i = 0; i < length; i++) {
          if (i !== 0) charge(1);
          copied.push(visit(dataValue(value, String(i)), depth + 1));
        }
        return Object.freeze(copied);
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null)
        pluginUiFailure("plugin_ui_json_invalid");
      const keys = Reflect.ownKeys(value);
      if (keys.length > 8192)
        pluginUiFailure("plugin_ui_json_complexity_exceeded");
      charge(2);
      const entries = keys.map((key, index) => {
        if (typeof key !== "string") pluginUiFailure("plugin_ui_json_invalid");
        if (index !== 0) charge(1);
        quotedString(key);
        charge(1);
        return [key, visit(dataValue(value, key), depth + 1)] as const;
      });
      return Object.freeze(Object.fromEntries(entries));
    } finally {
      ancestors.delete(value);
    }
  }
  const copied = visit(input, 0);
  if (new TextEncoder().encode(JSON.stringify(copied)).byteLength > maxBytes)
    pluginUiFailure("plugin_ui_json_bytes_exceeded");
  return copied;
}

export function pluginUiFields(
  input: unknown,
  fields: readonly string[],
): Readonly<Record<string, unknown>> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    pluginUiFailure("plugin_ui_object_invalid");
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    pluginUiFailure("plugin_ui_object_invalid");
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    pluginUiFailure("plugin_ui_fields_invalid");
  return Object.freeze(
    Object.fromEntries(fields.map((field) => [field, dataValue(input, field)])),
  );
}

function dataValue(input: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, name);
  if (!descriptor?.enumerable || !("value" in descriptor))
    pluginUiFailure("plugin_ui_data_property_required");
  return descriptor.value;
}
