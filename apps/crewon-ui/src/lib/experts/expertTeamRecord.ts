export type ExpertAgentType = "explorer" | "worker";

export type ExpertRole = {
  name: string;
  role: string;
  agentType: ExpertAgentType;
  instructions?: string | null;
};

export type ExpertTeamConfig = {
  expertsId: string;
  title: string;
  goal: string;
  leader: ExpertRole;
  experts: ExpertRole[];
  recordRevision: string;
  workspaceKey: string;
  ownerSubject: string;
  tenantId?: string | null;
  spaceId?: string | null;
};

/** Client projection of the app-server-owned Experts record. */
export type ExpertTeamRecordReference = {
  filePath: string;
  config: ExpertTeamConfig;
};
