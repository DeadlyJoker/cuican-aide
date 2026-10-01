import {
  AgentVersionError,
  compileAgentVersion,
  parseCompiledAgentVersion,
  type CompiledAgentVersion,
} from "@crewon/agent-version";
import type { ContentDigester } from "@crewon/application";
import { comfyManifest } from "./comfyui-manifest.ts";
import { comfyToolDefinitions } from "./comfyui-tool-catalog.ts";

export type ComfyAgentVersionInput = Readonly<{
  /** Execution ownership comes from the host binding, not the compiled asset. */
  base: Readonly<{
    executionAuthority: "crewonKernel";
    version: CompiledAgentVersion;
  }>;
  agentVersionId: string;
  runtimeGeneration: string;
  policySnapshotId: string;
  digester: ContentDigester;
}>;

/** Compiles a separate, explicit plugin AgentVersion without replacing its base. */
export function compileComfyAgentVersion(
  input: ComfyAgentVersionInput,
): CompiledAgentVersion {
  if (input.base.executionAuthority !== "crewonKernel") {
    throw new AgentVersionError("comfy_agent_version_authority_invalid");
  }
  const base = parseCompiledAgentVersion(
    JSON.stringify(input.base.version),
    input.digester,
  );
  if (input.agentVersionId === base.agentVersionId) {
    throw new AgentVersionError("comfy_agent_version_id_conflict");
  }
  const tools = comfyToolDefinitions();
  const pluginToolNames = new Set(tools.map((tool) => tool.name));
  if (base.tools.some((tool) => pluginToolNames.has(tool.name))) {
    throw new AgentVersionError("comfy_agent_version_tool_conflict");
  }
  const taskInstructions = comfyManifest().task.instructions;
  const instructions =
    base.instructions === null || base.instructions.length === 0
      ? taskInstructions
      : base.instructions.includes(taskInstructions)
        ? base.instructions
        : `${base.instructions}\n\n${taskInstructions}`;
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
