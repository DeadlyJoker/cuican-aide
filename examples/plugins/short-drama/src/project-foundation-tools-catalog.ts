import type {
  PluginToolDefinition,
  PluginToolExecutionCommand,
  PluginToolExecutionPolicy,
  PluginToolRuntimeContext,
} from "@crewon/plugin-sdk/node";
import type { PluginJsonValue } from "@crewon/plugin-sdk/contracts";
import {
  CREWON_PROJECT_FOUNDATION_TOOLS_SERVICE,
  MAX_PROJECT_FOUNDATION_TOOLS_INPUT_BYTES,
  PROJECT_FOUNDATION_TOOL_OPERATIONS,
  PROJECT_FOUNDATION_TOOL_RESPONSE_LIMITS,
  projectFoundationToolsCodec,
  type ProjectFoundationToolsMethod,
  type ProjectFoundationToolsRequest,
} from "@crewon/plugin-sdk/project-foundation-tools";
import business from "../business.json" with { type: "json" };
import { canonical, sha256 } from "./catalog.js";

export function foundationMethod(
  name: string,
): ProjectFoundationToolsMethod | null {
  for (const [method, operation] of Object.entries(
    PROJECT_FOUNDATION_TOOL_OPERATIONS,
  ))
    if (name === "crewon_short_drama__" + operation)
      return method as ProjectFoundationToolsMethod;
  return null;
}

/** Raw DTO limits belong to the codec; JSON string parts add escaping and scope guidance. */
export function foundationOutputLimit(
  method: ProjectFoundationToolsMethod,
): number {
  return PROJECT_FOUNDATION_TOOL_RESPONSE_LIMITS[
    PROJECT_FOUNDATION_TOOL_OPERATIONS[method]
  ] === 32768
    ? 66 * 1024
    : 24 * 1024;
}

export const foundationDefinitions: readonly PluginToolDefinition[] =
  business.tools
    .filter(
      (tool) => tool.adapterId === CREWON_PROJECT_FOUNDATION_TOOLS_SERVICE,
    )
    .map((tool) => ({
      schemaVersion: "crewon.tool-definition.v0",
      kind: "function",
      name: "crewon_short_drama__" + tool.operationId,
      description: tool.description,
      execution: "serial",
      inputSchema: modelSchema(tool.inputSchema),
    }));

export function foundationPolicy(
  context: PluginToolRuntimeContext,
  approval: "none" | "perAction",
  kind: string,
  name: string,
): PluginToolExecutionPolicy | null {
  const method = foundationMethod(name);
  if (kind !== "function" || method === null) return null;
  const operation = business.tools.find(
    (tool) =>
      tool.adapterId === CREWON_PROJECT_FOUNDATION_TOOLS_SERVICE &&
      tool.operationId === PROJECT_FOUNDATION_TOOL_OPERATIONS[method],
  );
  if (!operation) throw new Error("short_drama_foundation_catalog_missing");
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
    limits: {
      timeoutMs: 30000,
      maxOutputBytes: foundationOutputLimit(method),
      maxArtifactBytes: foundationOutputLimit(method),
    },
  };
}

export function foundationRequest(
  context: PluginToolRuntimeContext,
  approval: "none" | "perAction",
  command: PluginToolExecutionCommand,
): {
  method: ProjectFoundationToolsMethod;
  expected: ProjectFoundationToolsRequest;
} {
  const method = foundationMethod(command.name),
    policy = foundationPolicy(context, approval, command.kind, command.name),
    intent = command.actionIntent;
  if (
    !method ||
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
    throw new Error("short_drama_foundation_command_mismatch");
  if (context.run.source !== null && policy.effect === "mutation")
    throw new Error("short_drama_query_foundation_mutation_forbidden");
  if (
    Buffer.byteLength(command.input) > MAX_PROJECT_FOUNDATION_TOOLS_INPUT_BYTES
  )
    throw new Error("short_drama_foundation_input_limit");
  return {
    method,
    expected: projectFoundationToolsCodec.parseRequest({
      operation: PROJECT_FOUNDATION_TOOL_OPERATIONS[method],
      request: JSON.parse(command.input),
    }),
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
