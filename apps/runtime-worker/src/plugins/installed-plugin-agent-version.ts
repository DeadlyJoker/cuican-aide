import {
  AgentVersionError,
  compileAgentVersion,
  parseCompiledAgentVersion,
  type CompiledAgentVersion,
} from "@crewon/agent-version";
import type { ContentDigester } from "@crewon/application";
import { extensionToolDefinitions } from "../extensions/extension-tool-catalog.ts";
import {
  assertInstalledPluginBusinessRegistration,
  type InstalledPluginBusinessRegistration,
} from "./installed-plugin-business-registration.ts";

/** The host selects the original model and execution authority; a plugin only adds its own tools and task instructions. */
export function compileInstalledPluginAgentVersion(input: {
  base: Readonly<{
    executionAuthority: "crewonKernel";
    version: CompiledAgentVersion;
  }>;
  registration: InstalledPluginBusinessRegistration;
  agentVersionId: string;
  runtimeGeneration: string;
  policySnapshotId: string;
  digester: ContentDigester;
}): CompiledAgentVersion {
  if (input.base.executionAuthority !== "crewonKernel")
    throw new AgentVersionError("installed_plugin_agent_authority_invalid");
  assertInstalledPluginBusinessRegistration(input.registration);
  const base = parseCompiledAgentVersion(
    JSON.stringify(input.base.version),
    input.digester,
  );
  if (input.agentVersionId === base.agentVersionId)
    throw new AgentVersionError("installed_plugin_agent_id_conflict");
  const tools = extensionToolDefinitions(input.registration.manifest);
  const names = new Set(tools.map((tool) => tool.name));
  if (base.tools.some((tool) => names.has(tool.name)))
    throw new AgentVersionError("installed_plugin_agent_tool_conflict");
  const task = input.registration.manifest.task.instructions;
  const instructions =
    base.instructions === null || base.instructions.length === 0
      ? task
      : base.instructions.includes(task)
        ? base.instructions
        : `${base.instructions}\n\n${task}`;
  return compileAgentVersion(
    {
      schemaVersion: "crewon.agent-version-source.v0",
      agentVersionId: input.agentVersionId,
      runtimeGeneration: input.runtimeGeneration,
      policySnapshotId: input.policySnapshotId,
      instructions,
      model: base.model,
      execution: base.execution,
      resources: base.resources,
      tools: [...base.tools, ...tools],
    },
    input.digester,
  );
}
