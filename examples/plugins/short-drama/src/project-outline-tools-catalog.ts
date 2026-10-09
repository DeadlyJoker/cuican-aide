import type {
  PluginToolDefinition,
  PluginToolExecutionCommand,
  PluginToolExecutionPolicy,
  PluginToolRuntimeContext,
} from "@crewon/plugin-sdk/node";
import type { PluginJsonValue } from "@crewon/plugin-sdk/contracts";
import business from "../business.json" with { type: "json" };
import { canonical, sha256 } from "./catalog.js";
import {
  CREWON_PROJECT_OUTLINE_TOOLS_SERVICE,
  MAX_PROJECT_OUTLINE_TOOL_INPUT_BYTES,
  parseProjectOutlineToolCommand,
  parseProjectOutlineToolContextRequest,
} from "./project-outline-tools-service.js";
export const OUTLINE_CHANGE_TOOL = "crewon_short_drama__outline_change";
export const OUTLINE_CONTEXT_TOOL = "crewon_short_drama__outline_context";
export const OUTLINE_CONTEXT_OUTPUT_LIMIT = 16384;
export const OUTLINE_CHANGE_OUTPUT_LIMIT = 4096;
export const isOutlineTool = (name: string) =>
  name === OUTLINE_CHANGE_TOOL || name === OUTLINE_CONTEXT_TOOL;
export const outlineDefinitions: readonly PluginToolDefinition[] =
  business.tools
    .filter((tool) => tool.adapterId === CREWON_PROJECT_OUTLINE_TOOLS_SERVICE)
    .map((tool) => ({
      schemaVersion: "crewon.tool-definition.v0",
      kind: "function",
      name: "crewon_short_drama__" + tool.operationId,
      description: tool.description,
      execution: "serial",
      inputSchema: modelSchema(tool.inputSchema),
    }));
export function outlinePolicy(
  context: PluginToolRuntimeContext,
  approval: "none" | "perAction",
  kind: string,
  name: string,
): PluginToolExecutionPolicy | null {
  if (kind !== "function" || !isOutlineTool(name)) return null;
  const read = name === OUTLINE_CONTEXT_TOOL;
  const tool = business.tools.find(
    (tool) =>
      tool.operationId === (read ? "outline_context" : "outline_change") &&
      tool.adapterId === CREWON_PROJECT_OUTLINE_TOOLS_SERVICE,
  );
  if (
    !tool ||
    tool.effect !== (read ? "readOnly" : "mutation") ||
    tool.recovery !== (read ? "replaySafe" : "reconcilable") ||
    tool.capability !== (read ? "project.read" : "project.write")
  )
    throw new Error("short_drama_outline_catalog_invalid");
  const bindingId =
    "extension:" +
    sha256(
      canonical({
        configurationDigest: context.configuration.contentDigest,
        target: context.target,
      }),
    ).slice(7);
  return {
    effect: read ? "readOnly" : "mutation",
    recovery: read ? "replaySafe" : "reconcilable",
    resourceBindingId: bindingId,
    credentialBindingId: null,
    executionTarget: { kind: "control", bindingId },
    capability: read ? "project.read" : "project.write",
    approvalRequirement: approval,
    limits: {
      timeoutMs: 30000,
      maxOutputBytes: read
        ? OUTLINE_CONTEXT_OUTPUT_LIMIT
        : OUTLINE_CHANGE_OUTPUT_LIMIT,
      maxArtifactBytes: read
        ? OUTLINE_CONTEXT_OUTPUT_LIMIT
        : OUTLINE_CHANGE_OUTPUT_LIMIT,
    },
  };
}
export function outlineRequest(
  context: PluginToolRuntimeContext,
  approval: "none" | "perAction",
  command: PluginToolExecutionCommand,
) {
  const policy = outlinePolicy(context, approval, command.kind, command.name),
    intent = command.actionIntent;
  if (
    !policy ||
    context.run.source !== null ||
    command.runId !== context.run.runId ||
    intent.runId !== command.runId ||
    intent.segmentId !== command.segmentId ||
    intent.callId !== command.callId ||
    intent.tool.kind !== command.kind ||
    intent.tool.name !== command.name ||
    intent.tool.inputDigest !== sha256(command.input) ||
    intent.policySnapshotId !== context.target.policySnapshotId ||
    intent.workspaceBindingId !== context.target.workspaceBindingId ||
    Object.entries(policy).some(
      ([key, value]) =>
        canonical(value) !== canonical(intent[key as keyof typeof intent]),
    ) ||
    Buffer.byteLength(command.input) > MAX_PROJECT_OUTLINE_TOOL_INPUT_BYTES
  )
    throw new Error("short_drama_outline_command_mismatch");
  return command.name === OUTLINE_CONTEXT_TOOL
    ? {
        operation: "outline_context" as const,
        request: parseProjectOutlineToolContextRequest(
          JSON.parse(command.input),
        ),
      }
    : {
        operation: "outline_change" as const,
        request: parseProjectOutlineToolCommand(JSON.parse(command.input)),
      };
}
function modelSchema(
  input: unknown,
): Readonly<Record<string, PluginJsonValue>> {
  const raw = input as Record<string, unknown>,
    result: Record<string, PluginJsonValue> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null && ["enum", "minimum", "maximum"].includes(key))
      continue;
    if (key === "properties")
      result.properties = Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([name, child]) => [name, modelSchema(child)]),
      );
    else if (key === "items") result.items = modelSchema(value);
    else if (key === "required" || key === "enum")
      result[key] = [...(value as string[])].sort();
    else result[key] = value as PluginJsonValue;
  }
  return result;
}
