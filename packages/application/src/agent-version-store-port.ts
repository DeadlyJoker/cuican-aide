export type AgentVersionAsset = Readonly<{
  schemaVersion: "crewon.agent-version-asset.v0";
  tenantId: string;
  agentVersionId: string;
  contentDigest: string;
  definitionJson: string;
  createdAt: string;
}>;

export type RegisterAgentVersionResult = Readonly<{
  disposition: "registered" | "existing";
  asset: AgentVersionAsset;
}>;

/** Immutable AgentVersion definition authority; registered IDs are never updated. */
export interface AgentVersionStore {
  registerAgentVersion(
    asset: AgentVersionAsset,
  ): Promise<RegisterAgentVersionResult>;
  loadAgentVersion(input: {
    tenantId: string;
    agentVersionId: string;
  }): Promise<AgentVersionAsset | null>;
  listAgentVersions(input: {
    tenantId: string;
    afterAgentVersionId: string | null;
    limit: number;
  }): Promise<readonly AgentVersionAsset[]>;
}
