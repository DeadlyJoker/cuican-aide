import { ContractValidationError } from "./contract-validation-error.ts";
import { parsePluginUiJsonValue } from "./plugin-ui-json.ts";
import { MAX_PROJECT_TEXT_RESPONSE_BYTES } from "./project-text-control-types.ts";
import { creativeControlTitle } from "./creative-project-control-support.ts";
export function projectTextControlFailure(): never {
  throw new ContractValidationError("project_text_control_contract_invalid");
}
export function projectTextControlCopy(input: unknown): unknown {
  try {
    return parsePluginUiJsonValue(input, {
      maxBytes: MAX_PROJECT_TEXT_RESPONSE_BYTES,
    });
  } catch {
    return projectTextControlFailure();
  }
}
export function projectTextControlRecord(
  input: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    projectTextControlFailure();
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    projectTextControlFailure();
  return Object.fromEntries(
    fields.map((field) => {
      const property = Object.getOwnPropertyDescriptor(input, field);
      if (!property?.enumerable || !("value" in property))
        projectTextControlFailure();
      return [field, property.value];
    }),
  );
}
export function projectTextControlQuery(
  input: unknown,
  fields: readonly string[],
): Record<string, string> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    projectTextControlFailure();
  return Object.fromEntries(
    Reflect.ownKeys(input).map((key) => {
      if (typeof key !== "string" || !fields.includes(key))
        projectTextControlFailure();
      const property = Object.getOwnPropertyDescriptor(input, key);
      if (
        !property?.enumerable ||
        !("value" in property) ||
        typeof property.value !== "string"
      )
        projectTextControlFailure();
      return [key, property.value];
    }),
  );
}
export function projectTextControlNumber(input: unknown, minimum = 1): number {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < minimum
  )
    projectTextControlFailure();
  return input;
}
export function projectTextControlQueryNumber(
  input: unknown,
  minimum = 1,
): number {
  if (typeof input !== "string" || !/^(?:0|[1-9][0-9]{0,15})$/u.test(input))
    projectTextControlFailure();
  return projectTextControlNumber(Number(input), minimum);
}
export function projectTextControlText(
  input: unknown,
  maximumBytes: number,
  allowEmpty = false,
): string {
  if (
    typeof input !== "string" ||
    (!allowEmpty && !input.trim()) ||
    input.length > maximumBytes ||
    new TextEncoder().encode(input).byteLength > maximumBytes ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input)
  )
    projectTextControlFailure();
  for (const point of input)
    if (point.codePointAt(0)! >= 0xd800 && point.codePointAt(0)! <= 0xdfff)
      projectTextControlFailure();
  return input;
}
export function projectTextControlTitle(input: unknown): string {
  try {
    return creativeControlTitle(input);
  } catch {
    return projectTextControlFailure();
  }
}
export function projectTextControlId(input: unknown): string {
  const value = projectTextControlText(input, 512);
  if (
    value.length > 128 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    value === "." ||
    value === ".."
  )
    projectTextControlFailure();
  return value;
}
export function projectTextControlDigest(input: unknown): string {
  if (typeof input !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(input))
    projectTextControlFailure();
  return input;
}
export function projectTextControlTimestamp(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length !== 24 ||
    !Number.isFinite(Date.parse(input)) ||
    new Date(input).toISOString() !== input
  )
    projectTextControlFailure();
  return input;
}
export function projectTextControlArray(
  input: unknown,
  minimum: number,
  maximum: number,
): readonly unknown[] {
  if (!Array.isArray(input) || input.length < minimum || input.length > maximum)
    projectTextControlFailure();
  return input;
}
