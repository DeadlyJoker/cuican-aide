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
  PROJECT_TOOL_OPERATIONS,
  type ProjectToolsMethod,
} from "./project-tools-service.js";
import {
  PROJECT_ASSET_TOOL_OPERATIONS,
  type ProjectAssetToolMethod,
} from "./project-asset-tools-service.js";
export const PROJECT_ASSET_CONTEXT_TOOL =
  "crewon_short_drama__asset_context_read";
export function assetMethod(name: string): ProjectAssetToolMethod | null {
  for (const [method, operation] of Object.entries(
    PROJECT_ASSET_TOOL_OPERATIONS,
  ))
    if (name === "crewon_short_drama__" + operation)
      return method as ProjectAssetToolMethod;
  return null;
}
export function projectMethod(name: string): ProjectToolsMethod | null {
  for (const [method, operation] of Object.entries(PROJECT_TOOL_OPERATIONS))
    if (name === "crewon_short_drama__" + operation)
      return method as ProjectToolsMethod;
  return null;
}
export const projectDefinitions: readonly PluginToolDefinition[] =
  business.tools
    .filter((tool) =>
      [
        "crewon.project-tools",
        "crewon.project-context",
        "crewon.project-asset-tools",
        "crewon.project-asset-context",
      ].includes(tool.adapterId),
    )
    .map((tool) => ({
      schemaVersion: "crewon.tool-definition.v0",
      kind: "function",
      name: "crewon_short_drama__" + tool.operationId,
      description: tool.description,
      execution: "serial",
      inputSchema: modelSchema(tool.inputSchema),
    }));
export function projectPolicy(
  context: PluginToolRuntimeContext,
  approval: "none" | "perAction",
  kind: string,
  name: string,
): PluginToolExecutionPolicy | null {
  if (
    kind !== "function" ||
    (!projectMethod(name) &&
      !assetMethod(name) &&
      name !== PROJECT_ASSET_CONTEXT_TOOL &&
      name !== "crewon_short_drama__project_context_read")
  )
    return null;
  const operation = business.tools.find(
    (tool) => "crewon_short_drama__" + tool.operationId === name,
  )!;
  const bindingId =
    "extension:" +
    sha256(
      canonical({
        configurationDigest: context.configuration.contentDigest,
        target: context.target,
      }),
    ).slice(7);
  return {
    effect: operation.effect as "mutation" | "readOnly",
    recovery: operation.recovery as "reconcilable" | "replaySafe",
    resourceBindingId: bindingId,
    credentialBindingId: null,
    executionTarget: { kind: "control", bindingId },
    capability: operation.capability,
    approvalRequirement: operation.effect === "mutation" ? approval : "none",
    limits: { timeoutMs: 30000, maxOutputBytes: 8192, maxArtifactBytes: 8192 },
  };
}
export function projectRequest(
  context: PluginToolRuntimeContext,
  approval: "none" | "perAction",
  command: PluginToolExecutionCommand,
): { method: ProjectToolsMethod; request: Record<string, unknown> } {
  const method = projectMethod(command.name);
  if (!method) throw new Error("short_drama_project_command_mismatch");
  const value = projectCommandInput(context, approval, command);
  if (method === "listProjects" && !Object.hasOwn(value, "after"))
    value.after = null;
  if (method === "saveScriptCandidate" && !Object.hasOwn(value, "outline"))
    value.outline = null;
  return { method, request: value };
}

export function projectCommandInput(
  context: PluginToolRuntimeContext,
  approval: "none" | "perAction",
  command: PluginToolExecutionCommand,
): Record<string, unknown> {
  const policy = projectPolicy(context, approval, command.kind, command.name),
    intent = command.actionIntent;
  if (
    !policy ||
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
    )
  )
    throw new Error("short_drama_project_command_mismatch");
  if (context.run.source !== null && policy.effect === "mutation")
    throw new Error("short_drama_query_project_mutation_forbidden");
  if (Buffer.byteLength(command.input) > 65536)
    throw new Error("short_drama_project_input_limit");
  const request: unknown = JSON.parse(command.input);
  if (!request || typeof request !== "object" || Array.isArray(request))
    throw new Error("short_drama_project_input_invalid");
  const value = request as Record<string, unknown>;
  return value;
}

/** Convert only the documented Workflow schema sentinels to model JSON Schema. */
function modelSchema(
  input: unknown,
): Readonly<Record<string, PluginJsonValue>> {
  const raw = input as Record<string, unknown>;
  const result: Record<string, PluginJsonValue> = {};
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
