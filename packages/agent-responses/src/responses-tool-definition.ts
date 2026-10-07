import type { ModelRequest } from "@crewon/agent-kernel";

export function toResponsesToolDefinition(
  definition: ModelRequest["tools"][number],
): Readonly<Record<string, unknown>> {
  return definition.kind === "function"
    ? {
        type: "function",
        name: definition.name,
        description: definition.description,
        parameters: definition.inputSchema,
        // Responses otherwise normalizes omitted fields into strict required fields.
        ...(hasOptionalProperties(definition.inputSchema)
          ? { strict: false }
          : {}),
      }
    : {
        type: "custom",
        name: definition.name,
        description: definition.description,
        format: { type: "text" },
      };
}

/** Inspect schema nodes only; never rewrite tool inputs or their authority-bearing schema. */
function hasOptionalProperties(schema: unknown, depth = 0): boolean {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema))
    return false;
  if (depth > 64) return true;
  const value = schema as Record<string, unknown>;
  const properties = value.properties;
  if (
    properties &&
    typeof properties === "object" &&
    !Array.isArray(properties)
  ) {
    const required = new Set(
      Array.isArray(value.required) ? value.required : [],
    );
    if (Object.keys(properties).some((key) => !required.has(key))) return true;
  }
  const children: unknown[] = [];
  for (const key of [
    "properties",
    "patternProperties",
    "$defs",
    "definitions",
    "dependentSchemas",
  ]) {
    const map = value[key];
    if (map && typeof map === "object" && !Array.isArray(map))
      children.push(...Object.values(map));
  }
  for (const key of [
    "items",
    "additionalProperties",
    "contains",
    "not",
    "if",
    "then",
    "else",
  ])
    children.push(value[key]);
  for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"])
    if (Array.isArray(value[key])) children.push(...value[key]);
  return children.some((child) => hasOptionalProperties(child, depth + 1));
}
