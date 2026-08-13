import {
  parseAgentVersionAsset,
  type CompiledAgentVersion,
} from "@crewon/agent-version";
import type { AgentVersionAsset, ContentDigester } from "@crewon/application";
import type { AgentVersionView } from "@crewon/contracts/runtime";

export function projectAgentVersion(
  asset: AgentVersionAsset,
  digester: ContentDigester,
): AgentVersionView {
  return projectCompiledAgentVersion(
    parseAgentVersionAsset(asset, digester),
    asset.createdAt,
  );
}

export function projectCompiledAgentVersion(
  version: CompiledAgentVersion,
  createdAt: string,
): AgentVersionView {
  return {
    agentVersionId: version.agentVersionId,
    contentDigest: version.contentDigest,
    runtimeGeneration: version.runtimeGeneration,
    policySnapshotId: version.policySnapshotId,
    model: {
      adapterName: version.model.adapterName,
      adapterVersion: version.model.adapterVersion,
      modelId: version.model.modelId,
    },
    createdAt,
  };
}
