import { createHash } from "node:crypto";
import {
  compileAgentVersion,
  type CompiledAgentVersion,
} from "@crewon/agent-version";
import type { ToolDefinition } from "@crewon/tool-broker";

export const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
export const route = {
  authorityId: "authority",
  runtimeGeneration: "ts-v0",
  agentVersionId: "bootstrap",
  policySnapshotId: "policy",
  workspaceBindingId: null,
};
export function version(
  id: string,
  tools: readonly ToolDefinition[] = [],
): CompiledAgentVersion {
  return compileAgentVersion(
    {
      schemaVersion: "crewon.agent-version-source.v0",
      agentVersionId: id,
      runtimeGeneration: "ts-v0",
      policySnapshotId: "policy",
      instructions: "stable instructions",
      model: {
        adapterName: "fixture",
        adapterVersion: "1",
        modelId: "fixture-model",
        contextWindowTokens: 128000,
        autoCompactAtTokens: 96000,
      },
      execution: { maxToolRounds: 8, streamMaxRetries: 0 },
      resources: { workspaceRequired: false, governedContextDigest: null },
      tools,
    },
    digester,
  );
}
export function copyVersion(
  base: CompiledAgentVersion,
  id: string,
): CompiledAgentVersion {
  return compileAgentVersion(
    {
      schemaVersion: "crewon.agent-version-source.v0",
      agentVersionId: id,
      runtimeGeneration: base.runtimeGeneration,
      policySnapshotId: base.policySnapshotId,
      instructions: base.instructions,
      model: base.model,
      execution: base.execution,
      resources: base.resources,
      tools: base.tools,
    },
    digester,
  );
}
