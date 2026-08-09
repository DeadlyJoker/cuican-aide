import type { AgentVersionDeploymentCandidate } from "./agent-version-deployment-store-port.ts";

export type AgentVersionReleaseBundle = Readonly<{
  schemaVersion: "crewon.agent-version-release-bundle.v0";
  tenantId: string;
  releaseId: string;
  manifestDigest: string;
  defaultAgentVersionId: string;
  deployments: readonly AgentVersionDeploymentCandidate[];
}>;

export type AgentVersionReleaseOperator = Readonly<{
  principalId: string;
  actorId: string;
  spaceId: string;
}>;

export type AgentVersionReleaseActivation = Readonly<{
  schemaVersion: "crewon.agent-version-release-activation.v0";
  tenantId: string;
  releaseId: string;
  activationId: string;
  previousReleaseId: string | null;
  operator: AgentVersionReleaseOperator;
  activatedAt: string;
}>;

export type ActiveAgentVersionRelease = Readonly<{
  bundle: AgentVersionReleaseBundle;
  activation: AgentVersionReleaseActivation;
}>;

export type ActivateAgentVersionReleaseResult = Readonly<{
  disposition: "activated" | "replayed";
  release: ActiveAgentVersionRelease;
}>;

/** Atomic release-bundle registration, operator audit and tenant active pointer. */
export interface AgentVersionReleaseStore {
  activateAgentVersionRelease(input: {
    bundle: AgentVersionReleaseBundle;
    activation: AgentVersionReleaseActivation;
    expectedActiveReleaseId: string | null;
  }): Promise<ActivateAgentVersionReleaseResult>;
  loadAgentVersionReleaseBundle(input: {
    tenantId: string;
    releaseId: string;
  }): Promise<AgentVersionReleaseBundle | null>;
  loadAgentVersionReleaseActivation(input: {
    tenantId: string;
    activationId: string;
  }): Promise<AgentVersionReleaseActivation | null>;
  loadActiveAgentVersionRelease(input: {
    tenantId: string;
  }): Promise<ActiveAgentVersionRelease | null>;
}
