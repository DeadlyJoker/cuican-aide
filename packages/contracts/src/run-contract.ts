export const RUN_STATUSES = [
  "queued",
  "running",
  "waitingApproval",
  "suspended",
  "reconciling",
  "completed",
  "failed",
  "canceled",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export type RunIdentity = Readonly<{
  runId: string;
  threadId: string;
  tenantId: string;
  spaceId: string;
  createdByActorId: string;
  authorityId: string;
  runtimeGeneration: string;
  agentVersionId: string;
  policySnapshotId: string;
  workspaceBindingId: string | null;
}>;

export type RunBudget = Readonly<{
  maxModelCalls: number;
  maxToolCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
}>;

export type RunContract = Readonly<{
  schemaVersion: "crewon.run-contract.v0";
  identity: RunIdentity;
  budget: RunBudget;
  createdAt: string;
}>;
