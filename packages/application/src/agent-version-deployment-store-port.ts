export type AgentVersionDeployment = Readonly<{
  schemaVersion: "crewon.agent-version-deployment.v0";
  tenantId: string;
  agentVersionId: string;
  contentDigest: string;
  materializationDigest: string;
  authorityId: string;
  workspaceBindingId: string | null;
  deployedAt: string;
}>;

export type AgentVersionDeploymentCandidate = Omit<
  AgentVersionDeployment,
  "deployedAt"
>;

/** Immutable deployment authority binding one published version to one runtime materialization. */
export interface AgentVersionDeploymentStore {
  loadAgentVersionDeployment(input: {
    tenantId: string;
    agentVersionId: string;
  }): Promise<AgentVersionDeployment | null>;
}
