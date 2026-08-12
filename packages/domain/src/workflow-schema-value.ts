import { WorkflowVersionError } from "./workflow-version-error.ts";
import type { WorkflowValueSchema } from "./workflow-schema.ts";

export type WorkflowSchemaValue =
  | null
  | boolean
  | number
  | string
  | WorkflowSchemaValueArray
  | WorkflowSchemaValueObject;

export interface WorkflowSchemaValueArray
  extends ReadonlyArray<WorkflowSchemaValue> {}

export interface WorkflowSchemaValueObject {
  readonly [key: string]: WorkflowSchemaValue;
}

/** Validates and freezes an isolated value against the bounded Workflow schema subset. */
export function validateWorkflowSchemaValue(
  input: unknown,
  schema: WorkflowValueSchema,
): WorkflowSchemaValue {
  return validate(input, schema);
}

function validate(
  input: unknown,
  schema: WorkflowValueSchema,
): WorkflowSchemaValue {
  switch (schema.type) {
    case "string":
      if (
        typeof input !== "string" ||
        byteLength(input) > schema.maxLength ||
        (schema.enum !== null && !schema.enum.includes(input))
      ) {
        mismatch();
      }
      return input;
    case "number":
    case "integer":
      if (
        typeof input !== "number" ||
        !Number.isFinite(input) ||
        (schema.type === "integer" && !Number.isSafeInteger(input)) ||
        (schema.minimum !== null && input < schema.minimum) ||
        (schema.maximum !== null && input > schema.maximum)
      ) {
        mismatch();
      }
      return input;
    case "boolean":
      if (typeof input !== "boolean") mismatch();
      return input;
    case "array":
      if (!Array.isArray(input) || input.length > schema.maxItems) mismatch();
      return Object.freeze(input.map((item) => validate(item, schema.items)));
    case "object": {
      const record = requirePlainObject(input);
      const keys = Object.keys(record);
      if (
        schema.required.some((key) => !Object.hasOwn(record, key)) ||
        keys.some((key) => !Object.hasOwn(schema.properties, key))
      ) {
        mismatch();
      }
      return Object.freeze(
        Object.fromEntries(
          keys.map((key) => [
            key,
            validate(record[key], schema.properties[key]!),
          ]),
        ),
      );
    }
  }
}

function requirePlainObject(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    mismatch();
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) mismatch();
  return input as Record<string, unknown>;
}

function mismatch(): never {
  throw new WorkflowVersionError("workflow_value_schema_mismatch");
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
