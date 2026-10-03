import { describe, expect, it } from "vitest";
import { parseWorkflowObjectSchema } from "@crewon/domain/workflow-schema";
import {
  copyPluginConfigurationDraft,
  createPluginConfigurationDraft,
  validatePluginConfigurationDraft,
  type PluginConfigurationDraft,
} from "./pluginConfigurationSchema";

const schema = parseWorkflowObjectSchema({
  type: "object",
  additionalProperties: false,
  properties: {
    label: { type: "string", maxLength: 20, enum: null },
    mode: { type: "string", maxLength: 20, enum: ["large", "small"] },
    count: { type: "integer", minimum: 1, maximum: 5 },
    ratio: { type: "number", minimum: null, maximum: null },
    enabled: { type: "boolean" },
    nested: {
      type: "object",
      additionalProperties: false,
      properties: { value: { type: "string", maxLength: 8, enum: null } },
      required: ["value"],
    },
    rows: {
      type: "array",
      maxItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        properties: { id: { type: "integer", minimum: null, maximum: null } },
        required: ["id"],
      },
    },
  },
  required: ["label", "mode", "count", "ratio", "enabled", "rows"],
});
const saved = {
  label: "名称",
  mode: "small",
  count: 3,
  ratio: 0.25,
  enabled: true,
  nested: { value: "kept" },
  rows: [{ id: 1 }],
};
function object(draft: PluginConfigurationDraft) {
  if (draft.type !== "object") throw new Error("expected_object");
  return draft;
}
function edit(
  name: string,
  value: PluginConfigurationDraft,
  included = true,
): PluginConfigurationDraft {
  const draft = object(createPluginConfigurationDraft(schema, saved));
  return { ...draft, fields: { ...draft.fields, [name]: { included, value } } };
}

describe("recursive configuration drafts using the public bounded Domain schema", () => {
  it("keeps legal prototype-shaped property names as own data and does not read inherited saved values", () => {
    const objectSchema = {
      type: "object",
      additionalProperties: false,
      properties: { value: { type: "string", maxLength: 8, enum: null } },
      required: ["value"],
    };
    const named = parseWorkflowObjectSchema({
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries([
        ["__proto__", objectSchema],
        ["constructor", { type: "string", maxLength: 8, enum: null }],
      ]),
      required: [],
    });
    const absent = createPluginConfigurationDraft(named, {});
    expect(object(absent).fields.__proto__!.included).toBe(false);
    expect(
      Object.entries(object(absent).fields).find(
        ([name]) => name === "constructor",
      )?.[1].included,
    ).toBe(false);
    const saved = Object.fromEntries([
      ["__proto__", { value: "own" }],
      ["constructor", "own"],
    ]);
    const result = validatePluginConfigurationDraft(
      named,
      createPluginConfigurationDraft(named, saved),
    );
    expect(result.valid && result.parameters).toEqual(saved);
    expect(result.valid && Object.hasOwn(result.parameters, "__proto__")).toBe(
      true,
    );
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });
  it("leaves optional objects absent and requires explicit numeric and enum input", () => {
    const draft = object(createPluginConfigurationDraft(schema));
    expect(draft.fields.nested!.included).toBe(false);
    expect(draft.fields.mode!.value).toEqual({ type: "string", value: "" });
    expect(draft.fields.count!.value).toEqual({ type: "integer", value: "" });
    const result = validatePluginConfigurationDraft(schema, draft);
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toContainEqual(["mode"]);
    expect(result.issues.map((issue) => issue.path)).toContainEqual(["count"]);
    expect(result.issues.map((issue) => issue.path)).not.toContainEqual([
      "nested",
      "value",
    ]);
  });

  it("roundtrips real saved nested objects and array items without a JSON editor or losing optional presence", () => {
    const draft = createPluginConfigurationDraft(schema, saved);
    const result = validatePluginConfigurationDraft(schema, draft);
    expect(result.valid && result.parameters).toEqual(saved);
    expect(Object.isFrozen(draft)).toBe(true);
    expect(Object.isFrozen(object(draft).fields.rows!.value)).toBe(true);
    expect(
      validatePluginConfigurationDraft(
        schema,
        edit(
          "nested",
          createPluginConfigurationDraft(schema.properties.nested!),
          false,
        ),
      ),
    ).toMatchObject({ valid: true, parameters: { rows: [{ id: 1 }] } });
    const without = validatePluginConfigurationDraft(
      schema,
      edit(
        "nested",
        createPluginConfigurationDraft(schema.properties.nested!),
        false,
      ),
    );
    expect(without.valid && Object.hasOwn(without.parameters, "nested")).toBe(
      false,
    );
  });

  it.each([
    "",
    " ",
    "0x10",
    "NaN",
    "Infinity",
    "1.5",
    "0",
    "6",
    "9007199254740993",
  ])(
    "rejects invalid integer text %j while preserving the entered draft",
    (text) => {
      const draft = edit("count", { type: "integer", value: text });
      expect(validatePluginConfigurationDraft(schema, draft)).toMatchObject({
        valid: false,
        issues: [{ path: ["count"], code: "invalid_number" }],
      });
      expect(object(draft).fields.count!.value).toEqual({
        type: "integer",
        value: text,
      });
    },
  );

  it("accepts bounded decimal/exponent numbers, validates Unicode bytes and enum membership", () => {
    expect(
      validatePluginConfigurationDraft(
        schema,
        edit("ratio", { type: "number", value: "-1.2e3" }),
      ),
    ).toMatchObject({ valid: true, parameters: { ratio: -1200 } });
    expect(
      validatePluginConfigurationDraft(
        schema,
        edit("label", { type: "string", value: "字".repeat(7) }),
      ),
    ).toMatchObject({
      valid: false,
      issues: [{ path: ["label"], code: "invalid_string" }],
    });
    expect(
      validatePluginConfigurationDraft(
        schema,
        edit("mode", { type: "string", value: "other" }),
      ),
    ).toMatchObject({
      valid: false,
      issues: [{ path: ["mode"], code: "invalid_string" }],
    });
  });

  it("reports precise nested required/type/array bounds rather than coercing a draft into valid parameters", () => {
    expect(
      validatePluginConfigurationDraft(
        schema,
        edit("count", { type: "integer", value: "3" }, false),
      ),
    ).toMatchObject({
      valid: false,
      issues: [{ path: ["count"], code: "required" }],
    });
    expect(
      validatePluginConfigurationDraft(
        schema,
        edit("enabled", { type: "string", value: "false" }),
      ),
    ).toMatchObject({
      valid: false,
      issues: [{ path: ["enabled"], code: "invalid_type" }],
    });
    const rowSchema = schema.properties.rows!;
    if (rowSchema.type !== "array") throw new Error("expected_array");
    expect(
      validatePluginConfigurationDraft(
        schema,
        edit("rows", {
          type: "array",
          items: [createPluginConfigurationDraft(rowSchema.items)],
        }),
      ),
    ).toMatchObject({
      valid: false,
      issues: [{ path: ["rows", 0, "id"], code: "invalid_number" }],
    });
    expect(
      validatePluginConfigurationDraft(
        schema,
        edit("rows", {
          type: "array",
          items: [1, 2, 3].map((id) =>
            createPluginConfigurationDraft(rowSchema.items, { id }),
          ),
        }),
      ),
    ).toMatchObject({
      valid: false,
      issues: [{ path: ["rows"], code: "max_items" }],
    });
  });

  it("captures a frozen independent draft and rejects accessors/sparse items without invoking them", () => {
    const original = JSON.parse(
      JSON.stringify(createPluginConfigurationDraft(schema, saved)),
    );
    const copied = object(copyPluginConfigurationDraft(schema, original));
    original.fields.label.value.value = "mutated";
    expect(copied.fields.label!.value).toEqual({
      type: "string",
      value: "名称",
    });
    expect(Object.isFrozen(copied.fields)).toBe(true);
    let calls = 0;
    Object.defineProperty(original.fields.label.value, "value", {
      get: () => {
        calls++;
        return "secret";
      },
      enumerable: true,
    });
    expect(() => copyPluginConfigurationDraft(schema, original)).toThrow();
    expect(calls).toBe(0);
    const array = schema.properties.rows!;
    expect(() =>
      copyPluginConfigurationDraft(array, {
        type: "array",
        items: new Array(1),
      }),
    ).toThrow();
  });

  it("bounds the final parameters to the real HTTP 16KiB limit and rejects unsupported schema/saved fields", () => {
    const large = parseWorkflowObjectSchema({
      type: "object",
      additionalProperties: false,
      required: ["a", "b"],
      properties: {
        a: { type: "string", maxLength: 9999, enum: null },
        b: { type: "string", maxLength: 9999, enum: null },
      },
    });
    const draft = createPluginConfigurationDraft(large, {
      a: "x".repeat(9000),
      b: "y".repeat(9000),
    });
    expect(validatePluginConfigurationDraft(large, draft)).toMatchObject({
      valid: false,
      issues: [{ path: [], code: "too_large" }],
    });
    expect(() =>
      createPluginConfigurationDraft(schema, {
        ...saved,
        secret: "not-in-schema",
      }),
    ).toThrow();
    expect(() =>
      parseWorkflowObjectSchema({
        type: "object",
        additionalProperties: true,
        properties: {},
        required: [],
      }),
    ).toThrow();
  });
});
