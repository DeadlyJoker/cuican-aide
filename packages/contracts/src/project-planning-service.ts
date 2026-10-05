/** Public data only. A planning proposal never grants project or execution authority. */
export const PROJECT_PLANNING_CAPABILITIES_VERSION =
  "crewon.project-planning-capabilities.v1";
export const PROJECT_PLANNING_PROPOSAL_VERSION =
  "crewon.project-planning-proposal.v1";
export const PROJECT_PLANNING_MAX_BYTES = 8192;
export const PROJECT_PLANNING_TOOL_NAMES = Object.freeze({
  capabilities: "crewon_project_capabilities",
  propose: "crewon_project_propose",
} as const);
export type ProjectPlanningCapability = Readonly<{
  capabilityId: string;
  source: Readonly<{
    pluginId: string;
    publisherId: string;
    version: string;
    packageDigest: string;
    contributionId: string;
  }>;
  title: string;
  kind: "short-drama";
  stages: readonly ["brief", "outline", "script"];
  maximumEpisodes: 16;
  moduleAvailable: boolean;
  textPlansAvailable: boolean;
  executionReady: boolean;
}>;
export type ProjectPlanningProposalInput = Readonly<{
  capabilityId: string;
  title: string;
  briefText: string;
  instruction: string;
  start: "brief" | "outline";
  target: "brief" | "outline" | "script";
  episodeCount: number | null;
  adoption: "manual" | "whenUnchanged";
}>;
export type ProjectPlanningCapabilities = Readonly<{
  schemaVersion: typeof PROJECT_PLANNING_CAPABILITIES_VERSION;
  capabilities: readonly ProjectPlanningCapability[];
}>;
export type ProjectPlanningProposal = Readonly<{
  schemaVersion: typeof PROJECT_PLANNING_PROPOSAL_VERSION;
  kind: "newProject";
  capability: ProjectPlanningCapability;
  origin: Readonly<{ runId: string; threadId: string; callId: string }>;
  input: ProjectPlanningProposalInput;
}>;
