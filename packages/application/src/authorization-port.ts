export type ActorContext = Readonly<{
  principalId: string;
  actorId: string;
  tenantId: string;
  spaceId: string;
}>;

export type RunAuthorizationAction =
  | "run:create"
  | "run:read"
  | "run:execute"
  | "run:cancel";

export type RunAuthorizationResource = Readonly<{
  kind: "run";
  tenantId: string;
  spaceId: string;
  threadId: string;
  runId: string | null;
}>;

export type ThreadAuthorizationAction =
  | "thread:create"
  | "thread:read"
  | "thread:message:append"
  | "thread:goal:read"
  | "thread:goal:write"
  | "thread:fork"
  | "thread:archive"
  | "thread:unarchive"
  | "thread:rename"
  | "thread:delete"
  | "thread:compact"
  | "thread:rollback"
  | "thread:workspace:read"
  | "thread:workspace:write"
  | "thread:audit:read";

export type ThreadAuthorizationResource = Readonly<{
  kind: "thread";
  tenantId: string;
  spaceId: string;
  threadId: string | null;
}>;

export type ToolApprovalAuthorizationAction =
  | "toolApproval:read"
  | "toolApproval:decide";

export type ToolApprovalAuthorizationResource = Readonly<{
  kind: "toolApproval";
  tenantId: string;
  spaceId: string;
  runId: string;
  approvalId: string;
}>;

export type AgentVersionAuthorizationAction =
  | "agentVersion:publish"
  | "agentVersion:deploy"
  | "agentVersion:read"
  | "agentVersion:list";

export type AgentVersionAuthorizationResource = Readonly<{
  kind: "agentVersion";
  tenantId: string;
  spaceId: string;
  agentVersionId: string | null;
}>;

export type WorkflowVersionAuthorizationAction =
  | "workflowVersion:publish"
  | "workflowVersion:read"
  | "workflowVersion:list";

export type WorkflowVersionAuthorizationResource = Readonly<{
  kind: "workflowVersion";
  tenantId: string;
  spaceId: string;
  workflowVersionId: string | null;
}>;

export type ArtifactAuthorizationAction = "artifact:read";

export type KnowledgeAuthorizationAction =
  | "knowledge:create"
  | "knowledge:read";

export type KnowledgeAuthorizationResource = Readonly<{
  kind: "knowledge";
  tenantId: string;
  spaceId: string;
  knowledgeId: string | null;
}>;

export type OfficeAuthorizationAction =
  | "office:create"
  | "office:read"
  | "office:list"
  | "office:run";

export type OfficeAuthorizationResource = Readonly<{
  kind: "office";
  tenantId: string;
  spaceId: string;
  officeId: string | null;
  officeVersionId: string | null;
}>;

export type ArtifactAuthorizationResource = Readonly<{
  kind: "artifact";
  tenantId: string;
  spaceId: string;
  artifactId: string;
  ownerActorId: string;
  runId: string;
}>;

export type ModelProviderSettingsAuthorizationAction =
  | "modelProviderSettings:read"
  | "modelProviderSettings:write"
  | "modelProviderSettings:probe";

export type ModelProviderSettingsAuthorizationResource = Readonly<{
  kind: "modelProviderSettings";
  tenantId: string;
  spaceId: string;
}>;

export type AuthorizationAction =
  | RunAuthorizationAction
  | ThreadAuthorizationAction
  | ToolApprovalAuthorizationAction
  | AgentVersionAuthorizationAction
  | WorkflowVersionAuthorizationAction
  | OfficeAuthorizationAction
  | ArtifactAuthorizationAction
  | KnowledgeAuthorizationAction
  | ModelProviderSettingsAuthorizationAction;

export type AuthorizationResource =
  | RunAuthorizationResource
  | ThreadAuthorizationResource
  | ToolApprovalAuthorizationResource
  | AgentVersionAuthorizationResource
  | WorkflowVersionAuthorizationResource
  | OfficeAuthorizationResource
  | ArtifactAuthorizationResource
  | KnowledgeAuthorizationResource
  | ModelProviderSettingsAuthorizationResource;

export type AuthorizationDecision =
  | Readonly<{ outcome: "allow" }>
  | Readonly<{ outcome: "deny"; reasonCode: string }>;

export interface AuthorizationPort {
  authorize(request: {
    actor: ActorContext;
    action: AuthorizationAction;
    resource: AuthorizationResource;
  }): Promise<AuthorizationDecision>;
}
