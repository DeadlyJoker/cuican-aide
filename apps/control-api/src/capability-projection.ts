import type { AgentVersionAsset, ContentDigester } from "@crewon/application";
import { parseAgentVersionAsset } from "@crewon/agent-version";
import type { CapabilitySummaryView } from "@crewon/contracts";

export type CapabilityProjection = Readonly<{
  key: string;
  value: CapabilitySummaryView;
}>;

/** Projects bounded public metadata; tool input schemas and version definitions stay private. */
export function projectCapabilities(
  assets: readonly AgentVersionAsset[],
  digester: ContentDigester,
): readonly CapabilityProjection[] {
  return assets
    .flatMap((asset) => {
      const version = parseAgentVersionAsset(asset, digester);
      return version.tools.map(
        (tool): CapabilityProjection => ({
          key: JSON.stringify([version.agentVersionId, tool.kind, tool.name]),
          value: {
            agentVersionId: version.agentVersionId,
            agentVersionDigest: version.contentDigest,
            kind: tool.kind,
            name: tool.name,
            description: tool.description,
            execution: tool.execution,
            inputFormat: tool.kind === "function" ? "jsonSchema" : "text",
          },
        }),
      );
    })
    .sort((left, right) =>
      left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
    );
}
