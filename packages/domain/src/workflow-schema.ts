import { WorkflowVersionError } from "./workflow-version-error.ts";

const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_SCHEMA_DEPTH = 16;
const MAX_SCHEMA_NODES = 4_096;
const MAX_SCHEMA_PROPERTIES = 64;

export type WorkflowValueSchema =
  | Readonly<{
      type: "string";
      maxLength: number;
      enum: readonly string[] | null;
    }>
  | Readonly<{
      type: "number" | "integer";
      minimum: number | null;
      maximum: number | null;
    }>
  | Readonly<{ type: "boolean" }>
  | Readonly<{
      type: "array";
      items: WorkflowValueSchema;
      maxItems: number;
    }>
  | WorkflowObjectSchema;

export type WorkflowObjectSchema = Readonly<{
  type: "object";
  properties: Readonly<Record<string, WorkflowValueSchema>>;
  required: readonly string[];
  additionalProperties: false;
}>;

/** Parses the bounded schema subset accepted by Workflow execution. */
export function parseWorkflowObjectSchema(
  input: unknown,
  code = "workflow_schema_invalid",
): WorkflowObjectSchema {
  const tracker = { nodes: 0 };
  const schema = parseSchema(input, code, 1, tracker);
  if (
    schema.type !== "object" ||
    byteLength(canonicalJson(schema)) > MAX_SCHEMA_BYTES
  ) {
    throw new WorkflowVersionError(code);
  }
  return deepFreeze(schema);
}

function parseSchema(
  input: unknown,
  code: string,
  depth: number,
  tracker: { nodes: number },
): WorkflowValueSchema {
  tracker.nodes += 1;
  if (depth > MAX_SCHEMA_DEPTH || tracker.nodes > MAX_SCHEMA_NODES) {
    throw new WorkflowVersionError(code);
  }
  const schema = requireObject(input, code);
  if (schema.type === "string") {
    requireExactKeys(schema, ["enum", "maxLength", "type"], code);
    const maxLength = requirePositiveInteger(schema.maxLength, 9_999, code);
    let enumValues: readonly string[] | null = null;
    if (schema.enum !== null) {
      if (
        !Array.isArray(schema.enum) ||
        schema.enum.length === 0 ||
        schema.enum.length > 64
      ) {
        throw new WorkflowVersionError(code);
      }
      enumValues = [
        ...new Set(
          schema.enum.map((value) => requireText(value, maxLength, code)),
        ),
      ].sort(compareUtf8);
      if (enumValues.length !== schema.enum.length) {
        throw new WorkflowVersionError(code);
      }
    }
    return { type: "string", maxLength, enum: enumValues };
  }
  if (schema.type === "number" || schema.type === "integer") {
    requireExactKeys(schema, ["maximum", "minimum", "type"], code);
    const minimum = optionalFiniteNumber(
      schema.minimum,
      schema.type === "integer",
      code,
    );
    const maximum = optionalFiniteNumber(
      schema.maximum,
      schema.type === "integer",
      code,
    );
    if (minimum !== null && maximum !== null && minimum > maximum) {
      throw new WorkflowVersionError(code);
    }
    return { type: schema.type, minimum, maximum };
  }
  if (schema.type === "boolean") {
    requireExactKeys(schema, ["type"], code);
    return { type: "boolean" };
  }
  if (schema.type === "array") {
    requireExactKeys(schema, ["items", "maxItems", "type"], code);
    return {
      type: "array",
      items: parseSchema(schema.items, code, depth + 1, tracker),
      maxItems: requirePositiveInteger(schema.maxItems, 1_024, code),
    };
  }
  if (schema.type !== "object") {
    throw new WorkflowVersionError(code);
  }
  requireExactKeys(
    schema,
    ["additionalProperties", "properties", "required", "type"],
    code,
  );
  if (schema.additionalProperties !== false) {
    throw new WorkflowVersionError(code);
  }
  const properties = requireObject(schema.properties, code);
  const names = Object.keys(properties).sort(compareUtf8);
  if (
    names.length > MAX_SCHEMA_PROPERTIES ||
    names.some((name) => !validPropertyName(name))
  ) {
    throw new WorkflowVersionError(code);
  }
  const normalizedEntries: [string, WorkflowValueSchema][] = [];
  for (const name of names) {
    normalizedEntries.push([
      name,
      parseSchema(properties[name], code, depth + 1, tracker),
    ]);
  }
  const normalized = Object.fromEntries(normalizedEntries);
  const required = parsePropertyNames(schema.required, code);
  if (required.some((name) => !Object.hasOwn(normalized, name))) {
    throw new WorkflowVersionError(code);
  }
  return {
    type: "object",
    properties: normalized,
    required,
    additionalProperties: false,
  };
}

function parsePropertyNames(input: unknown, code: string): readonly string[] {
  if (!Array.isArray(input) || input.length > MAX_SCHEMA_PROPERTIES) {
    throw new WorkflowVersionError(code);
  }
  const values = input.map((value) => {
    if (typeof value !== "string" || !validPropertyName(value)) {
      throw new WorkflowVersionError(code);
    }
    return value;
  });
  if (new Set(values).size !== values.length) {
    throw new WorkflowVersionError(code);
  }
  return values.sort(compareUtf8);
}

function requireObject(input: unknown, code: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new WorkflowVersionError(code);
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new WorkflowVersionError(code);
  }
  return input as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  code: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new WorkflowVersionError(code);
  }
}

function requirePositiveInteger(
  value: unknown,
  maximum: number,
  code: string,
): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 1 ||
    Number(value) > maximum
  ) {
    throw new WorkflowVersionError(code);
  }
  return Number(value);
}

function optionalFiniteNumber(
  value: unknown,
  integer: boolean,
  code: string,
): number | null {
  if (value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (integer && !Number.isSafeInteger(value))
  ) {
    throw new WorkflowVersionError(code);
  }
  return value;
}

function requireText(value: unknown, maxBytes: number, code: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    byteLength(value) > maxBytes ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new WorkflowVersionError(code);
  }
  return value;
}

function validPropertyName(value: string): boolean {
  return byteLength(value) <= 128 && /^[A-Za-z_][A-Za-z0-9_.-]*$/u.test(value);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareUtf8(left, right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}
