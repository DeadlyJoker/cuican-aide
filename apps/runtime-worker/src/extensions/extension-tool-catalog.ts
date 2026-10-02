import {
  extensionToolName,
  parseExtensionManifest,
  type ExtensionManifest,
  type WorkflowValueSchema,
} from "@crewon/domain";
import type { ToolDefinition, ToolJsonValue } from "@crewon/tool-broker";

/** Model catalog only. Manifest metadata never grants permission or supplies an implementation. */
export function extensionToolDefinitions(
  input: ExtensionManifest,
): readonly ToolDefinition[] {
  const manifest = parseExtensionManifest(input);
  return manifest.tools.map((tool) => ({
    schemaVersion: "crewon.tool-definition.v0",
    kind: "function",
    name: extensionToolName(manifest.pluginId, tool.operationId),
    description: tool.description,
    execution: tool.execution,
    inputSchema: modelSchema(tool.inputSchema),
  }));
}

/** Workflow's null constraint sentinels are host metadata, not JSON Schema enum/bound values. */
function modelSchema(
  schema: WorkflowValueSchema,
): Record<string, ToolJsonValue> {
  switch (schema.type) {
    case "string":
      return {
        type: schema.type,
        maxLength: schema.maxLength,
        ...(schema.enum === null ? {} : { enum: [...schema.enum] }),
      };
    case "number":
    case "integer":
      return {
        type: schema.type,
        ...(schema.minimum === null ? {} : { minimum: schema.minimum }),
        ...(schema.maximum === null ? {} : { maximum: schema.maximum }),
      };
    case "boolean":
      return { type: schema.type };
    case "array":
      return {
        type: schema.type,
        items: modelSchema(schema.items),
        maxItems: schema.maxItems,
      };
    case "object":
      return {
        type: schema.type,
        properties: Object.fromEntries(
          Object.entries(schema.properties).map(([name, value]) => [
            name,
            modelSchema(value),
          ]),
        ),
        required: [...schema.required],
        additionalProperties: false,
      };
  }
}
