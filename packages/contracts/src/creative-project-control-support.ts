import { ContractValidationError } from "./contract-validation-error.ts";
import { parsePluginUiJsonValue } from "./plugin-ui-json.ts";
import { MAX_CREATIVE_PROJECT_RESPONSE_BYTES } from "./creative-project-control-types.ts";

export function creativeControlFailure(): never {
  throw new ContractValidationError(
    "creative_project_control_contract_invalid",
  );
}
export function creativeControlCopy(input: unknown): unknown {
  try {
    return parsePluginUiJsonValue(input, {
      maxBytes: MAX_CREATIVE_PROJECT_RESPONSE_BYTES,
    });
  } catch {
    return creativeControlFailure();
  }
}
export function creativeControlRecord(
  input: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
  )
    creativeControlFailure();
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    creativeControlFailure();
  return Object.fromEntries(
    fields.map((field) => {
      const own = Object.getOwnPropertyDescriptor(input, field);
      if (!own?.enumerable || !("value" in own)) creativeControlFailure();
      return [field, own.value];
    }),
  );
}
/** Fastify owns query prototypes; only own enumerable data properties are accepted. */
export function creativeControlQuery(
  input: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    creativeControlFailure();
  const keys = Reflect.ownKeys(input);
  if (
    keys.length > fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    creativeControlFailure();
  return Object.fromEntries(
    keys.map((key) => {
      const own = Object.getOwnPropertyDescriptor(input, key);
      if (
        !own?.enumerable ||
        !("value" in own) ||
        typeof own.value !== "string"
      )
        creativeControlFailure();
      return [key, own.value];
    }),
  );
}
export function creativeControlText(
  input: unknown,
  maximumUtf16: number,
): string {
  if (
    typeof input !== "string" ||
    input.length > maximumUtf16 ||
    !input.trim() ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input)
  )
    creativeControlFailure();
  for (const point of input) {
    const code = point.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) creativeControlFailure();
  }
  return input;
}
export function creativeControlId(input: unknown): string {
  const value = creativeControlText(input, 128);
  if (
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    value === "." ||
    value === ".."
  )
    creativeControlFailure();
  return value;
}
export function creativeControlTitle(input: unknown): string {
  const value = creativeControlText(input, 320);
  if (value.trim() !== value || [...value].length > 160)
    creativeControlFailure();
  return value;
}
export function creativeControlBrief(input: unknown): string {
  const value = creativeControlText(input, 8192);
  if (new TextEncoder().encode(value).byteLength > 8192)
    creativeControlFailure();
  return value;
}
export function creativeControlRevision(
  input: unknown,
  minimum: 0 | 1 = 1,
): number {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < minimum
  )
    creativeControlFailure();
  return input;
}
export function creativeControlQueryRevision(
  input: unknown,
  minimum: 0 | 1,
): number {
  if (typeof input !== "string" || !/^(?:0|[1-9][0-9]{0,15})$/u.test(input))
    creativeControlFailure();
  return creativeControlRevision(Number(input), minimum);
}
export function creativeControlTimestamp(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length !== 24 ||
    !Number.isFinite(Date.parse(input)) ||
    new Date(input).toISOString() !== input
  )
    creativeControlFailure();
  return input;
}
export function creativeControlDigest(input: unknown): string {
  if (typeof input !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(input))
    creativeControlFailure();
  return input;
}
export function creativeControlLimit(input: unknown): number {
  if (input === undefined) return 20;
  const value = creativeControlQueryRevision(input, 1);
  if (value > 50) creativeControlFailure();
  return value;
}
export function creativeControlArray(
  input: unknown,
  maximum: number,
): readonly unknown[] {
  if (!Array.isArray(input) || input.length > maximum) creativeControlFailure();
  return input;
}
/** Unicode scalar order agrees with UTF-8 binary storage order, including supplementary characters. */
export function creativeControlCompareIds(left: string, right: string): number {
  const a = [...left],
    b = [...right];
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}
