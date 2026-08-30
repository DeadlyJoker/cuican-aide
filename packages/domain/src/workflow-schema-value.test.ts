import assert from "node:assert/strict";
import test from "node:test";

import { WorkflowVersionError } from "./workflow-version-error.ts";
import {
  validateWorkflowSchemaValue,
  type WorkflowSchemaValue,
} from "./workflow-schema-value.ts";
import type {
  WorkflowObjectSchema,
  WorkflowValueSchema,
} from "./workflow-schema.ts";

test("validates and isolates nested Workflow objects and arrays", () => {
  const input = { jobs: [{ name: "build", enabled: true }] };
  const result = validateWorkflowSchemaValue(input, {
    type: "object",
    properties: {
      jobs: {
        type: "array",
        maxItems: 2,
        items: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            name: { type: "string", maxLength: 16, enum: null },
          },
          required: ["enabled", "name"],
          additionalProperties: false,
        },
      },
    },
    required: ["jobs"],
    additionalProperties: false,
  });
  input.jobs[0]!.name = "mutated";
  assert.deepEqual(result, { jobs: [{ name: "build", enabled: true }] });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(
    Object.isFrozen((result as { jobs: readonly unknown[] }).jobs),
    true,
  );
  assert.equal(
    Object.isFrozen((result as { jobs: readonly object[] }).jobs[0]),
    true,
  );
});

test("uses UTF-8 bytes for string bounds and enforces enum values", () => {
  const bounded = { type: "string", maxLength: 4, enum: null } as const;
  assert.equal(validateWorkflowSchemaValue("界", bounded), "界");
  assertMismatch(() => validateWorkflowSchemaValue("界界", bounded));
  const enumerated = {
    type: "string",
    maxLength: 8,
    enum: ["safe", "fast"],
  } as const;
  assert.equal(validateWorkflowSchemaValue("safe", enumerated), "safe");
  assertMismatch(() => validateWorkflowSchemaValue("other", enumerated));
  assertMismatch(() => validateWorkflowSchemaValue("\ud800", bounded));
});

test("enforces safe integers and numeric minimum and maximum", () => {
  const integer = numeric("integer", null, null);
  assert.equal(validateWorkflowSchemaValue(7, integer), 7);
  for (const value of [1.5, Number.MAX_SAFE_INTEGER + 1])
    assertMismatch(() => validateWorkflowSchemaValue(value, integer));
  const number = numeric("number", -2, 2);
  assert.equal(validateWorkflowSchemaValue(1.5, number), 1.5);
  for (const value of [-3, 3, Number.NaN])
    assertMismatch(() => validateWorkflowSchemaValue(value, number));
});

test("rejects missing, additional, and wrong-typed object properties", () => {
  const schema = objectSchema({ count: numeric("integer", 0, 10) }, ["count"]);
  for (const value of [{}, { count: "1" }, { count: 1, extra: true }])
    assertMismatch(() => validateWorkflowSchemaValue(value, schema));
});

test("handles prototype-like own keys without inherited authority", () => {
  const properties = Object.fromEntries([
    ["__proto__", { type: "boolean" }],
    ["constructor", { type: "string", maxLength: 8, enum: null }],
  ]) as WorkflowObjectSchema["properties"];
  const schema = objectSchema(properties, ["__proto__", "constructor"]);
  const input = Object.fromEntries([
    ["__proto__", true],
    ["constructor", "safe"],
  ]);
  const result = validateWorkflowSchemaValue(input, schema) as Record<
    string,
    WorkflowSchemaValue
  >;
  assert.equal(Object.hasOwn(result, "__proto__"), true);
  assert.equal(result.__proto__, true);
  assert.equal(result.constructor, "safe");
  assertMismatch(() =>
    validateWorkflowSchemaValue(Object.create({ constructor: "safe" }), schema),
  );
});

function numeric(
  type: "number" | "integer",
  minimum: number | null,
  maximum: number | null,
): WorkflowValueSchema {
  return { type, minimum, maximum };
}

function objectSchema(
  properties: WorkflowObjectSchema["properties"],
  required: readonly string[],
): WorkflowObjectSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

function assertMismatch(action: () => unknown): void {
  assert.throws(
    action,
    (error: unknown) =>
      error instanceof WorkflowVersionError &&
      error.code === "workflow_value_schema_mismatch",
  );
}
