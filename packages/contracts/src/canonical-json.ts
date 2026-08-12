/** Canonicalizes a bounded plain JSON value with deterministic code-unit key ordering. */
export function canonicalJsonValue(value: unknown): string {
  return JSON.stringify(stabilize(value, new WeakSet<object>(), 0));
}

function stabilize(
  value: unknown,
  ancestors: WeakSet<object>,
  depth: number,
): unknown {
  if (depth > 32) throw invalid();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (!isWellFormedUnicode(value)) throw invalid();
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid();
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw invalid();
    ancestors.add(value);
    const result = value.map((item) => stabilize(item, ancestors, depth + 1));
    ancestors.delete(value);
    return result;
  }
  if (!isPlainObject(value) || ancestors.has(value)) throw invalid();
  ancestors.add(value);
  const result = Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => {
        if (!isWellFormedUnicode(key) || value[key] === undefined)
          throw invalid();
        return [key, stabilize(value[key], ancestors, depth + 1)];
      }),
  );
  ancestors.delete(value);
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function invalid(): TypeError {
  return new TypeError("canonical_json_invalid");
}
