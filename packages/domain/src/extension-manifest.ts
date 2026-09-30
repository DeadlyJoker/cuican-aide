import {
  parseWorkflowObjectSchema,
  type WorkflowObjectSchema,
} from "./workflow-schema.ts";
import {
  validateWorkflowSchemaValue,
  type WorkflowSchemaValue,
} from "./workflow-schema-value.ts";
import {
  copyExtensionJson,
  extensionArray,
  extensionFailure,
  extensionIdentifier,
  extensionLocalId,
  extensionRecord,
  extensionText,
  extensionUnique,
} from "./extension-validation.ts";
export { ExtensionManifestError } from "./extension-validation.ts";

export type ExtensionToolManifest = Readonly<{
  operationId: string;
  adapterId: string;
  description: string;
  inputSchema: WorkflowObjectSchema;
  outputSchema: WorkflowObjectSchema;
  execution: "serial" | "parallel";
  effect: "readOnly" | "mutation";
  recovery: "replaySafe" | "reconcilable";
  capability: string;
}>;

/** Trusted bundled declaration; executable implementations belong to the Worker. */
export type ExtensionManifest = Readonly<{
  schemaVersion: "crewon.extension-manifest.v0";
  hostApi: "crewon.extensions.v0";
  pluginId: string;
  version: string;
  title: string;
  description: string;
  task: Readonly<{ instructions: string; inputSchema: WorkflowObjectSchema }>;
  configurationSchema: WorkflowObjectSchema;
  credentialSlots: readonly Readonly<{ id: string; title: string }>[];
  tools: readonly ExtensionToolManifest[];
  resultViews: readonly ("text" | "externalOperation" | "externalResult")[];
}>;

export function parseExtensionManifest(input: unknown): ExtensionManifest {
  const value = extensionRecord(copyExtensionJson(input, 128 * 1024), [
    "schemaVersion",
    "hostApi",
    "pluginId",
    "version",
    "title",
    "description",
    "task",
    "configurationSchema",
    "credentialSlots",
    "tools",
    "resultViews",
  ]);
  if (
    value.schemaVersion !== "crewon.extension-manifest.v0" ||
    value.hostApi !== "crewon.extensions.v0"
  )
    extensionFailure("extension_host_incompatible");
  const pluginId = extensionIdentifier(value.pluginId);
  const version = extensionText(value.version, 32);
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(version))
    extensionFailure("extension_version_invalid");
  const task = extensionRecord(value.task, ["instructions", "inputSchema"]);
  const tools = extensionArray(value.tools, 1, 16, parseTool);
  extensionUnique(
    tools.map((tool) => tool.operationId),
    "extension_operation_duplicate",
  );
  tools.forEach((tool) => extensionToolName(pluginId, tool.operationId));
  const credentialSlots = extensionArray(
    value.credentialSlots,
    0,
    8,
    (input) => {
      const slot = extensionRecord(input, ["id", "title"]);
      return Object.freeze({
        id: extensionLocalId(slot.id),
        title: extensionText(slot.title, 160),
      });
    },
  );
  extensionUnique(
    credentialSlots.map((slot) => slot.id),
    "extension_credential_slot_duplicate",
  );
  const resultViews = extensionArray(value.resultViews, 1, 3, (view) => {
    if (
      view !== "text" &&
      view !== "externalOperation" &&
      view !== "externalResult"
    )
      extensionFailure("extension_result_view_invalid");
    return view;
  });
  extensionUnique(resultViews, "extension_result_view_duplicate");
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    hostApi: value.hostApi,
    pluginId,
    version,
    title: extensionText(value.title, 160),
    description: extensionText(value.description, 1_024),
    task: Object.freeze({
      instructions: extensionText(task.instructions, 4_000),
      inputSchema: schema(task.inputSchema),
    }),
    configurationSchema: schema(value.configurationSchema),
    credentialSlots,
    tools,
    resultViews,
  });
}

/** Model-compatible names; registry also rejects normalization collisions across plugins. */
export function extensionToolName(
  pluginId: string,
  operationId: string,
): string {
  const name = `${extensionIdentifier(pluginId).replace(/[.-]/gu, "_")}__${extensionLocalId(operationId)}`;
  if (name.length > 64) extensionFailure("extension_tool_name_limit");
  return name;
}

export function validateExtensionTaskInput(
  manifest: ExtensionManifest,
  input: unknown,
): WorkflowSchemaValue {
  return validateValue(
    input,
    manifest.task.inputSchema,
    "extension_task_input_invalid",
  );
}

export function validateExtensionConfiguration(
  manifest: ExtensionManifest,
  input: unknown,
): WorkflowSchemaValue {
  return validateValue(
    input,
    manifest.configurationSchema,
    "extension_configuration_invalid",
  );
}

function validateValue(
  input: unknown,
  valueSchema: WorkflowObjectSchema,
  code: string,
): WorkflowSchemaValue {
  try {
    return validateWorkflowSchemaValue(
      copyExtensionJson(input, 16 * 1024),
      valueSchema,
    );
  } catch {
    return extensionFailure(code);
  }
}

function schema(input: unknown): WorkflowObjectSchema {
  try {
    const parsed = parseWorkflowObjectSchema(input);
    if (new TextEncoder().encode(JSON.stringify(parsed)).length > 24 * 1024)
      extensionFailure("extension_schema_limit");
    return parsed;
  } catch {
    return extensionFailure("extension_schema_invalid");
  }
}

function parseTool(input: unknown): ExtensionToolManifest {
  const tool = extensionRecord(input, [
    "operationId",
    "adapterId",
    "description",
    "inputSchema",
    "outputSchema",
    "execution",
    "effect",
    "recovery",
    "capability",
  ]);
  if (
    (tool.execution !== "serial" && tool.execution !== "parallel") ||
    (tool.effect !== "readOnly" && tool.effect !== "mutation") ||
    (tool.recovery !== "replaySafe" && tool.recovery !== "reconcilable") ||
    (tool.effect === "mutation" && tool.recovery !== "reconcilable")
  )
    extensionFailure("extension_tool_policy_invalid");
  return Object.freeze({
    operationId: extensionLocalId(tool.operationId),
    adapterId: extensionIdentifier(tool.adapterId),
    description: extensionText(tool.description, 2_048),
    inputSchema: schema(tool.inputSchema),
    outputSchema: schema(tool.outputSchema),
    execution: tool.execution,
    effect: tool.effect,
    recovery: tool.recovery,
    capability: extensionIdentifier(tool.capability),
  });
}
