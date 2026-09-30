export class ExtensionManifestError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "ExtensionManifestError";
    this.code = code;
  }
}

export function extensionFailure(code: string): never {
  throw new ExtensionManifestError(code);
}

export function extensionRecord(input: unknown, keys: readonly string[]) {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    extensionFailure("extension_object_invalid");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0"))
    extensionFailure("extension_manifest_fields_invalid");
  return value;
}

export function extensionText(input: unknown, maxBytes: number): string {
  if (
    typeof input !== "string" ||
    !input.trim() ||
    input.trim() !== input ||
    new TextEncoder().encode(input).length > maxBytes ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input)
  )
    extensionFailure("extension_text_invalid");
  return input;
}

export function extensionIdentifier(input: unknown): string {
  const value = extensionText(input, 48);
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/u.test(value))
    extensionFailure("extension_identifier_invalid");
  return value;
}

export function extensionLocalId(input: unknown): string {
  const value = extensionText(input, 24);
  if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u.test(value))
    extensionFailure("extension_local_id_invalid");
  return value;
}

export function extensionArray<T>(
  input: unknown,
  min: number,
  max: number,
  parse: (item: unknown) => T,
): readonly T[] {
  if (!Array.isArray(input) || input.length < min || input.length > max)
    extensionFailure("extension_collection_invalid");
  return Object.freeze(input.map(parse));
}

export function extensionUnique(values: readonly string[], code: string): void {
  if (new Set(values).size !== values.length) extensionFailure(code);
}

/** Bound traversal before serialization or schema parsing; never invoke accessors. */
export function copyExtensionJson(input: unknown, maxBytes: number): unknown {
  let nodes = 0;
  let textBytes = 0;
  const ancestors = new WeakSet<object>();
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > 8_192 || depth > 24) extensionFailure("extension_json_limit");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      for (const point of value) {
        const code = point.codePointAt(0)!;
        if (code >= 0xd800 && code <= 0xdfff)
          extensionFailure("extension_json_invalid");
      }
      textBytes += new TextEncoder().encode(value).length;
      if (textBytes > maxBytes) extensionFailure("extension_json_limit");
      return value;
    }
    if (value === null || typeof value !== "object" || ancestors.has(value))
      extensionFailure("extension_json_invalid");
    const prototype = Object.getPrototypeOf(value);
    if (
      !Array.isArray(value) &&
      prototype !== Object.prototype &&
      prototype !== null
    )
      extensionFailure("extension_json_invalid");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(value).some((key) => typeof key !== "string") ||
      Object.values(descriptors).some((item) => !Object.hasOwn(item, "value"))
    )
      extensionFailure("extension_json_invalid");
    ancestors.add(value);
    let result: unknown;
    if (Array.isArray(value)) {
      if (value.length > 8_192 || Object.keys(value).length !== value.length)
        extensionFailure("extension_json_invalid");
      result = Array.from({ length: value.length }, (_, index) =>
        visit(descriptors[String(index)]?.value, depth + 1),
      );
    } else {
      const keys = Object.keys(value);
      if (keys.length > 256 || keys.length !== Reflect.ownKeys(value).length)
        extensionFailure("extension_json_limit");
      result = Object.fromEntries(
        keys
          .sort()
          .map((key) => [
            visit(key, depth + 1),
            visit(descriptors[key]!.value, depth + 1),
          ]),
      );
    }
    ancestors.delete(value);
    return result;
  };
  const result = visit(input, 0);
  if (new TextEncoder().encode(JSON.stringify(result)).length > maxBytes)
    extensionFailure("extension_json_limit");
  return result;
}
