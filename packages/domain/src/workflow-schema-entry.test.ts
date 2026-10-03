import assert from "node:assert/strict";
import test from "node:test";
import {
  parseWorkflowObjectSchema,
  validateWorkflowSchemaValue,
} from "@crewon/domain/workflow-schema";

test("pure schema package entry exposes the same bounded parser and isolated value validator", () => {
  const schema = parseWorkflowObjectSchema({
    type: "object",
    properties: { organization: { type: "string", maxLength: 8, enum: null } },
    required: ["organization"],
    additionalProperties: false,
  });
  const input = { organization: "test" };
  const value = validateWorkflowSchemaValue(input, schema);
  input.organization = "later";
  assert.deepEqual(value, { organization: "test" });
  assert.equal(Object.isFrozen(value), true);
  assert.throws(() =>
    validateWorkflowSchemaValue({ organization: "too-long-value" }, schema),
  );
  assert.throws(() =>
    parseWorkflowObjectSchema({ ...schema, additionalProperties: true }),
  );
});
