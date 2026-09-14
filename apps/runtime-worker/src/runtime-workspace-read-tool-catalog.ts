import type { ToolDefinition, ToolRuntimePort } from "@crewon/tool-broker";
import { deliveryToolDefinitions } from "./delivery-tool-catalog.ts";

const WORKSPACE_READ_TOOL_DEFINITION: ToolDefinition = {
  schemaVersion: "crewon.tool-definition.v0",
  kind: "function",
  name: "read_file",
  description: "Read one bounded file.",
  execution: "parallel",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};

/** Returns the credential-free model catalog owned by native Workspace authority. */
export function workspaceReadToolDefinitions(): readonly ToolDefinition[] {
  return [structuredClone(WORKSPACE_READ_TOOL_DEFINITION)];
}

/** Composes release definitions while rejecting native catalog collisions. */
export function runtimeReleaseToolDefinitions(input: {
  toolRuntime?: ToolRuntimePort;
  nativeWorkspaceReadCatalog: "disabled" | "enabled";
  deliveryToolCatalog?: "disabled" | "enabled";
}): readonly ToolDefinition[] {
  const definitions = [
    ...structuredClone(input.toolRuntime?.definitions() ?? []),
  ];
  if (input.deliveryToolCatalog === "enabled") {
    for (const definition of deliveryToolDefinitions()) {
      if (
        definitions.some(
          (existing) =>
            existing.kind === definition.kind &&
            existing.name === definition.name,
        )
      )
        throw new Error("runtime_release_delivery_tool_collision");
      definitions.push(definition);
    }
    definitions.sort((left, right) =>
      `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`),
    );
  }
  if (input.nativeWorkspaceReadCatalog === "disabled") {
    return definitions;
  }
  const workspaceRead = workspaceReadToolDefinitions()[0]!;
  if (
    definitions.some(
      (definition) =>
        definition.kind === workspaceRead.kind &&
        definition.name === workspaceRead.name,
    )
  ) {
    throw new Error("runtime_release_workspace_read_tool_collision");
  }
  return [...definitions, workspaceRead].sort((left, right) =>
    `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`),
  );
}
