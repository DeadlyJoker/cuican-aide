import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseWorkflowObjectSchema,
  type WorkflowObjectSchema,
} from "./workflow-schema.ts";

test("canonicalizes one bounded nested Workflow schema", () => {
  const schema = parseWorkflowObjectSchema({
    type: "object",
    properties: {
      targets: {
        type: "array",
        items: { type: "string", maxLength: 128, enum: ["web", "desktop"] },
        maxItems: 16,
      },
      priority: { type: "integer", minimum: 1, maximum: 5 },
      approved: { type: "boolean" },
    },
    required: ["targets", "approved", "priority"],
    additionalProperties: false,
  });

  assert.deepEqual(Object.keys(schema.properties), [
    "approved",
    "priority",
    "targets",
  ]);
  assert.deepEqual(schema.required, ["approved", "priority", "targets"]);
  assert.ok(Object.isFrozen(schema));
  assert.ok(Object.isFrozen(schema.properties));
  assert.ok(Object.isFrozen(schema.properties.targets));
});

test("canonicalizes enum values by UTF-8 bytes for Rust digest parity", () => {
  const schema = parseWorkflowObjectSchema({
    type: "object",
    properties: {
      value: {
        type: "string",
        maxLength: 8,
        enum: ["\u{10000}", "\uE000"],
      },
    },
    required: ["value"],
    additionalProperties: false,
  });

  assert.deepEqual(
    schema.properties.value.type === "string"
      ? schema.properties.value.enum
      : null,
    ["\uE000", "\u{10000}"],
  );
});

test("rejects injected, unbounded, missing and excessively nested schemas", () => {
  const base = emptyObjectSchema();
  let nested: WorkflowObjectSchema = base;
  for (let depth = 0; depth < 17; depth += 1) {
    nested = {
      type: "object",
      properties: { nested },
      required: ["nested"],
      additionalProperties: false,
    };
  }
  for (const candidate of [
    { ...base, unexpected: true },
    { ...base, additionalProperties: true },
    {
      ...base,
      properties: {
        value: { type: "string", maxLength: 128, enum: null },
      },
      required: ["missing"],
    },
    {
      ...base,
      properties: {
        value: { type: "string", maxLength: 0, enum: null },
      },
    },
    nested,
  ]) {
    assert.throws(
      () => parseWorkflowObjectSchema(candidate),
      hasCode("workflow_schema_invalid"),
    );
  }
});

test("rejects schema byte, property and total node limit violations", () => {
  const oversizedEnum = Array.from(
    { length: 64 },
    (_, index) => `${index.toString().padStart(2, "0")}-${"x".repeat(9_990)}`,
  );
  const tooManyProperties = Object.fromEntries(
    Array.from({ length: 65 }, (_, index) => [
      `property_${index.toString().padStart(2, "0")}`,
      { type: "boolean" },
    ]),
  );
  const tooManyNodes = Object.fromEntries(
    Array.from({ length: 64 }, (_, outer) => [
      `group_${outer.toString().padStart(2, "0")}`,
      {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 64 }, (_, inner) => [
            `value_${inner.toString().padStart(2, "0")}`,
            { type: "boolean" },
          ]),
        ),
        required: [],
        additionalProperties: false,
      },
    ]),
  );

  for (const candidate of [
    {
      ...emptyObjectSchema(),
      properties: {
        value: { type: "string", maxLength: 9_999, enum: oversizedEnum },
      },
    },
    {
      ...emptyObjectSchema(),
      properties: tooManyProperties,
    },
    {
      ...emptyObjectSchema(),
      properties: tooManyNodes,
    },
  ]) {
    assert.throws(
      () => parseWorkflowObjectSchema(candidate),
      hasCode("workflow_schema_invalid"),
    );
  }
});

test("treats prototype-like property names only as exact own properties", () => {
  assert.throws(
    () =>
      parseWorkflowObjectSchema({
        ...emptyObjectSchema(),
        required: ["constructor"],
      }),
    hasCode("workflow_schema_invalid"),
  );

  const schema = parseWorkflowObjectSchema(
    JSON.parse(`{
      "type": "object",
      "properties": {"__proto__": {"type": "boolean"}},
      "required": ["__proto__"],
      "additionalProperties": false
    }`),
  );
  assert.deepEqual(Object.keys(schema.properties), ["__proto__"]);
  assert.equal(Object.getPrototypeOf(schema.properties), Object.prototype);
  assert.equal(Object.hasOwn(schema.properties, "__proto__"), true);
});

function emptyObjectSchema(): WorkflowObjectSchema {
  return {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  };
}

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof Error && "code" in error && error.code === code;
}
