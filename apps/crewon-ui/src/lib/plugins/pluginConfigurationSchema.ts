import {
  validateWorkflowSchemaValue,
  type WorkflowObjectSchema,
  type WorkflowValueSchema,
} from "@crewon/domain/workflow-schema";
import type { SaveExtensionConfigurationRequest } from "@crewon/contracts";

// The configuration HTTP contract accepts at most 8192 JSON nodes and 16KiB parameters.
const MAX_CONFIGURATION_VALUE_NODES = 8192;
const MAX_CONFIGURATION_PARAMETER_BYTES = 16 * 1024;
// Inactive fields may retain a previously edited value, with a separate bounded draft cache.
const MAX_CONFIGURATION_DRAFT_NODES = 8192;

export type PluginConfigurationDraft =
  | Readonly<{ type: "string"; value: string }>
  | Readonly<{ type: "number" | "integer"; value: string }>
  | Readonly<{ type: "boolean"; value: boolean }>
  | Readonly<{
      type: "object";
      fields: Readonly<
        Record<
          string,
          Readonly<{
            included: boolean;
            value: PluginConfigurationDraft | null;
          }>
        >
      >;
    }>
  | Readonly<{ type: "array"; items: readonly PluginConfigurationDraft[] }>;
export type PluginConfigurationDraftIssue = Readonly<{
  path: readonly (string | number)[];
  code:
    | "required"
    | "invalid_type"
    | "invalid_string"
    | "invalid_number"
    | "invalid_boolean"
    | "invalid_structure"
    | "max_items"
    | "too_large";
}>;
export type PluginConfigurationDraftValidation =
  | Readonly<{
      valid: true;
      parameters: SaveExtensionConfigurationRequest["parameters"];
      issues: readonly [];
    }>
  | Readonly<{
      valid: false;
      issues: readonly PluginConfigurationDraftIssue[];
    }>;

/** Empty numeric text and enum text require an explicit choice; optional fields stay absent. */
export function createPluginConfigurationDraft(
  schema: WorkflowValueSchema,
  value?: unknown,
): PluginConfigurationDraft {
  if (value !== undefined) value = validateWorkflowSchemaValue(value, schema);
  switch (schema.type) {
    case "string":
      return Object.freeze({
        type: schema.type,
        value: value === undefined ? "" : (value as string),
      });
    case "number":
    case "integer":
      return Object.freeze({
        type: schema.type,
        value: value === undefined ? "" : String(value),
      });
    case "boolean":
      return Object.freeze({
        type: schema.type,
        value: value === undefined ? false : (value as boolean),
      });
    case "array":
      return Object.freeze({
        type: schema.type,
        items: Object.freeze(
          value === undefined
            ? []
            : (value as readonly unknown[]).map((item) =>
                createPluginConfigurationDraft(schema.items, item),
              ),
        ),
      });
    case "object": {
      const saved = value as Record<string, unknown> | undefined;
      return Object.freeze({
        type: schema.type,
        fields: Object.freeze(
          Object.fromEntries(
            Object.entries(schema.properties).map(([name, child]) => {
              const included =
                saved === undefined
                  ? schema.required.includes(name)
                  : Object.hasOwn(saved, name);
              return [
                name,
                Object.freeze({
                  included,
                  value: included
                    ? createPluginConfigurationDraft(
                        child,
                        saved === undefined ? undefined : saved[name],
                      )
                    : null,
                }),
              ];
            }),
          ),
        ),
      });
    }
  }
}

/** Captures an isolated UI draft without executing caller-owned getters. */
export function copyPluginConfigurationDraft(
  schema: WorkflowValueSchema,
  draft: PluginConfigurationDraft,
): PluginConfigurationDraft {
  let nodes = 0;
  const copy = (
    schema: WorkflowValueSchema,
    input: unknown,
  ): PluginConfigurationDraft => {
    if (++nodes > MAX_CONFIGURATION_DRAFT_NODES)
      throw new Error("plugin_configuration_draft_too_large");
    const keys =
      schema.type === "object"
        ? ["type", "fields"]
        : schema.type === "array"
          ? ["type", "items"]
          : ["type", "value"];
    const value = record(input, keys);
    if (value.type !== schema.type)
      throw new Error("plugin_configuration_draft_invalid");
    switch (schema.type) {
      case "string":
      case "number":
      case "integer":
        if (typeof value.value !== "string")
          throw new Error("plugin_configuration_draft_invalid");
        return Object.freeze({ type: schema.type, value: value.value });
      case "boolean":
        if (typeof value.value !== "boolean")
          throw new Error("plugin_configuration_draft_invalid");
        return Object.freeze({ type: schema.type, value: value.value });
      case "object": {
        const fields = record(value.fields, Object.keys(schema.properties));
        return Object.freeze({
          type: "object",
          fields: Object.freeze(
            Object.fromEntries(
              Object.entries(schema.properties).map(([name, child]) => {
                const field = record(fields[name], ["included", "value"]);
                if (typeof field.included !== "boolean")
                  throw new Error("plugin_configuration_draft_invalid");
                if (field.included && field.value === null)
                  throw new Error("plugin_configuration_draft_invalid");
                return [
                  name,
                  Object.freeze({
                    included: field.included,
                    value:
                      field.value === null ? null : copy(child, field.value),
                  }),
                ];
              }),
            ),
          ),
        });
      }
      case "array": {
        if (
          !Array.isArray(value.items) ||
          value.items.length > schema.maxItems ||
          Reflect.ownKeys(value.items).length !== value.items.length + 1
        )
          throw new Error("plugin_configuration_draft_invalid");
        const items = Array.from({ length: value.items.length }, (_, index) => {
          const item = Object.getOwnPropertyDescriptor(
            value.items,
            String(index),
          );
          if (!item || !Object.hasOwn(item, "value"))
            throw new Error("plugin_configuration_draft_invalid");
          return copy(schema.items, item.value);
        });
        return Object.freeze({ type: "array", items: Object.freeze(items) });
      }
    }
  };
  return copy(schema, draft);
}

export function validatePluginConfigurationDraft(
  schema: WorkflowObjectSchema,
  draft: PluginConfigurationDraft,
): PluginConfigurationDraftValidation {
  const issues: PluginConfigurationDraftIssue[] = [];
  let nodes = 0;
  const issue = (
    path: readonly (string | number)[],
    code: PluginConfigurationDraftIssue["code"],
  ) => {
    if (issues.length < 64)
      issues.push(Object.freeze({ path: Object.freeze([...path]), code }));
  };
  const convert = (
    schema: WorkflowValueSchema,
    draft: PluginConfigurationDraft,
    path: readonly (string | number)[],
  ): unknown => {
    if (++nodes > MAX_CONFIGURATION_VALUE_NODES) {
      issue(path, "too_large");
      return undefined;
    }
    if (draft.type !== schema.type) {
      issue(path, "invalid_type");
      return undefined;
    }
    if (schema.type === "object" && draft.type === "object") {
      const result: Record<string, unknown> = Object.create(null);
      for (const [name, child] of Object.entries(schema.properties)) {
        const field = draft.fields[name];
        if (!field) {
          issue([...path, name], "invalid_structure");
          continue;
        }
        if (!field.included) {
          if (schema.required.includes(name))
            issue([...path, name], "required");
          continue;
        }
        if (field.value === null) {
          issue([...path, name], "invalid_structure");
          continue;
        }
        if (++nodes > MAX_CONFIGURATION_VALUE_NODES) {
          issue([...path, name], "too_large");
          continue;
        }
        result[name] = convert(child, field.value, [...path, name]);
      }
      if (
        Object.keys(draft.fields).some(
          (name) => !Object.hasOwn(schema.properties, name),
        )
      )
        issue(path, "invalid_structure");
      return result;
    }
    if (schema.type === "array" && draft.type === "array") {
      if (draft.items.length > schema.maxItems) issue(path, "max_items");
      return draft.items
        .slice(0, schema.maxItems)
        .map((item, index) => convert(schema.items, item, [...path, index]));
    }
    let value: unknown;
    let code: PluginConfigurationDraftIssue["code"];
    if (
      (schema.type === "number" || schema.type === "integer") &&
      (draft.type === "number" || draft.type === "integer")
    ) {
      const text = draft.value.trim();
      code = "invalid_number";
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(text)) {
        issue(path, code);
        return undefined;
      }
      value = Number(text);
    } else if (draft.type === "string") {
      value = draft.value;
      code = "invalid_string";
    } else if (draft.type === "boolean") {
      value = draft.value;
      code = "invalid_boolean";
    } else {
      issue(path, "invalid_structure");
      return undefined;
    }
    try {
      return validateWorkflowSchemaValue(value, schema);
    } catch {
      issue(path, code);
      return undefined;
    }
  };
  const value = convert(schema, draft, []);
  if (issues.length === 0) {
    try {
      const parameters = validateWorkflowSchemaValue(
        value,
        schema,
      ) as SaveExtensionConfigurationRequest["parameters"];
      if (
        new TextEncoder().encode(JSON.stringify(parameters)).byteLength >
        MAX_CONFIGURATION_PARAMETER_BYTES
      )
        issue([], "too_large");
      else
        return Object.freeze({
          valid: true,
          parameters,
          issues: Object.freeze([] as const),
        });
    } catch {
      issue([], "invalid_structure");
    }
  }
  return Object.freeze({ valid: false, issues: Object.freeze(issues) });
}

function record(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw new Error("plugin_configuration_draft_invalid");
  const own = Reflect.ownKeys(input);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new Error("plugin_configuration_draft_invalid");
  return Object.fromEntries(
    keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (
        !descriptor ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value")
      )
        throw new Error("plugin_configuration_draft_invalid");
      return [key, descriptor.value];
    }),
  );
}
