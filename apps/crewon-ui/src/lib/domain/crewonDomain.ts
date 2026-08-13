import type { ExternalAgentConfigMigrationItem } from "@crewon-ui-model/v2/ExternalAgentConfigMigrationItem";

export type LibraryKind =
  | "plugins"
  | "tools"
  | "agents"
  | "office"
  | "automation"
  | "knowledge";

export type DomainConfigKind = "agent" | "automation" | "office" | "tool";

export type LibraryPanel = {
  kind: LibraryKind;
  title: string;
  subtitle: string;
  configPath?: string;
  workspaceCwd?: string;
  actions?: LibraryPanelAction[];
  body?: string;
  fields?: LibraryPanelField[];
  items: LibraryItem[];
  error?: string;
  workspace?: OfficeWorkspace;
  agentConfig?: AgentConfig;
  knowledge?: KnowledgeData;
  catalogMode?: "skillMcp" | "controlCapabilities" | "controlKnowledge";
};

export type LibraryPanelField = {
  id: string;
  label: string;
  placeholder?: string;
  value: string;
  options?: Array<{ label: string; value: string }>;
  secret?: boolean;
};

export type LibraryPanelAction = {
  id:
    | "call-mcp-tool"
    | "create-agent"
    | "create-automation"
    | "prepare-control-automation"
    | "submit-control-automation"
    | "create-knowledge-memory"
    | "submit-control-knowledge"
    | "create-mcp"
    | "create-office"
    | "create-skill"
    | "delete-config-file"
    | "delete-mcp-config"
    | "install-plugin"
    | "open-knowledge-file"
    | "open-control-knowledge"
    | "login-mcp-oauth"
    | "open-path"
    | "open-thread"
    | "read-mcp-resource"
    | "recruit-agent"
    | "refresh-knowledge"
    | "reset-memory"
    | "reload-plugins"
    | "reload-tools"
    | "run-automation"
    | "save-mcp-config"
    | "save-mcp-draft"
    | "save-skill-edit"
    | "save-skill-draft"
    | "toggle-skill"
    | "uninstall-plugin";
  label: string;
  marketplacePath?: string | null;
  pluginId?: string;
  pluginName?: string;
  remoteMarketplaceName?: string | null;
  mcpResourceServer?: string;
  mcpResourceUri?: string;
  mcpServerName?: string;
  mcpToolName?: string;
  pathToOpen?: string;
  pathKind?: "directory" | "file";
  domainConfigKind?: DomainConfigKind;
  agentConfig?: AgentConfig;
  automationConfig?: AutomationConfig;
  automationConfigPath?: string;
  automationTitle?: string;
  automationThreadId?: string;
  automationPrompt?: string;
  controlAutomationId?: string;
  controlAutomationRevision?: 1;
  threadId?: string;
  skillEnabled?: boolean;
  skillName?: string;
  skillPath?: string;
  skillConfigPath?: string;
  knowledgePath?: string;
  knowledgeTitle?: string;
  knowledgeKind?: "file" | "directory";
  tone?: "danger" | "primary";
  disabled?: boolean;
  disabledReason?: string;
};

export type LibraryAccent =
  | "blue"
  | "violet"
  | "amber"
  | "green"
  | "rose"
  | "cyan"
  | "slate";

export type LibraryBadgeTone =
  | "running"
  | "draft"
  | "planning"
  | "idle"
  | "warning";

export type OfficeMember = {
  memberId?: string;
  agentId?: string;
  name: string;
  role: string;
  glyph: string;
  accent: LibraryAccent;
  status: string;
  online?: boolean;
  runtime?: {
    threadId?: string | null;
    contextPolicy?: "isolated" | "forkLastN" | "sharedDigest" | string;
    forkTurns?: "none" | "all" | number | null;
    memoryScope?: "private" | "shared" | "privateAndShared" | string;
    lastRunId?: string | null;
  };
};

export type OfficeMessage = {
  clientUserMessageId?: string;
  clientOnly?: boolean;
  delegationId?: string;
  event?: string;
  runId?: string;
  author: string;
  glyph: string;
  accent: LibraryAccent;
  time: string;
  text: string;
  kind?: "message" | "task" | "system";
};

export type OfficeTask = {
  title: string;
  owner: string;
  status: "todo" | "doing" | "done";
  runId?: string;
};

export type OfficeWorkspace = {
  goal: string;
  threadId?: string;
  recordId?: string;
  recordRevision?: string;
  backendStatus?: "local" | "binding" | "connected" | "error";
  members: OfficeMember[];
  messages: OfficeMessage[];
  tasks: OfficeTask[];
  activity?: ActivityData;
};

export type AgentCapabilityOption = {
  id: string;
  name: string;
  glyph: string;
  accent: LibraryAccent;
  description: string;
  enabled: boolean;
};

export type AgentConfig = {
  agentId?: string;
  threadId?: string;
  name: string;
  glyph: string;
  accent: LibraryAccent;
  role: string;
  model: string;
  models: string[];
  permission: string;
  permissions: string[];
  systemPrompt: string;
  mcp: AgentCapabilityOption[];
  skills: AgentCapabilityOption[];
};

export type AgentConfigRecord = {
  version: 1;
  kind: "agent";
  savedAt: string;
  config: AgentConfig;
};

export type AutomationConfig = {
  threadId?: string;
  title: string;
  subtitle: string;
  body: string;
  prompt: string;
  trigger?: {
    type: "manual" | "schedule" | "event" | "file";
    [key: string]: unknown;
  };
  scope?: "personal" | "team" | string;
  delivery?: {
    destination: "scheduleCenter" | string;
    recipient: "owner" | string;
    recipientLabel: string;
    notifyOn: "always" | "failure" | "actionRequired" | string;
  };
  targetOffice?: OfficeConfig | null;
  executionAgent?: AgentConfig | null;
  enabled?: boolean;
  status?: "draft" | "enabled" | "disabled" | "needsAuth" | string;
  createdAt?: number;
  updatedAt?: number;
};

export type AutomationConfigRecord = {
  version: 1;
  kind: "automation";
  savedAt: string;
  config: AutomationConfig;
};

export type ToolConfigKind = "mcp" | "skill";

export type ToolConfig = {
  kind: ToolConfigKind;
  title: string;
  name: string;
  description?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  bearerTokenEnvVar?: string;
  path?: string;
  enabled?: boolean;
};

export type ToolConfigRecord = {
  version: 1;
  kind: "tool";
  savedAt: string;
  config: ToolConfig;
};

export type OfficeConfig = {
  title: string;
  subtitle: string;
  workspace: OfficeWorkspace;
};

export type OfficeConfigRecord = {
  version: 1;
  kind: "office";
  savedAt: string;
  config: OfficeConfig;
};

export type TraceStep = {
  time: string;
  actor: string;
  glyph: string;
  accent: LibraryAccent;
  action: string;
  detail: string;
  tokens?: number;
  status: "done" | "running" | "waiting";
};

export type ApprovalRequest = {
  id: string;
  actor: string;
  glyph: string;
  accent: LibraryAccent;
  action: string;
  detail: string;
  risk: "low" | "medium" | "high";
  time: string;
  decision?: "approved" | "denied";
};

export type BudgetRow = {
  name: string;
  glyph: string;
  accent: LibraryAccent;
  usedTokens: number;
  budgetTokens: number;
  costUsd: number;
};

export type ArtifactItem = {
  title: string;
  kind: string;
  glyph: string;
  accent: LibraryAccent;
  meta: string;
  path?: string;
  url?: string;
  contentSha256?: string;
  contentBytes?: number;
  contentSource?: "inline" | "file" | string;
  contentStatus?:
    | "fingerprinted"
    | "missing"
    | "notFile"
    | "outsideWorkspace"
    | "tooLarge"
    | "unreadable"
    | string;
  contentObservedAt?: string;
  contentError?: string;
  sourceType?: string;
  sourceThreadId?: string;
  sourceTurnId?: string;
  observedAt?: string;
  member?: string;
  agentId?: string;
  delegationId?: string;
};

export type OfficeMemoryRefActivity = {
  id: string;
  scope?: "office" | "member" | "project" | "user" | string;
  kind?:
    | "decision"
    | "fact"
    | "preference"
    | "lesson"
    | "artifact"
    | "runSummary"
    | string;
  content?: string;
  confidence?: "low" | "medium" | "high" | string;
  importance?: "low" | "medium" | "high" | string;
  status?: OfficeMemoryStatus | string;
  evidenceRefs?: OfficeMemoryEvidenceRef[];
  member?: string;
  agentId?: string;
};

export type OfficeMemoryStatus = "accepted" | "pending" | "rejected";

export type OfficeMemoryEvidenceRef = {
  runId: string | null;
  threadId: string | null;
  turnId: string | null;
};

export type OfficeMemoryRecord = {
  id: string;
  officeKey: string;
  scope: "office" | "member" | "project" | "user" | string;
  member: string | null;
  agentId: string | null;
  kind:
    | "decision"
    | "fact"
    | "preference"
    | "lesson"
    | "artifact"
    | "runSummary"
    | string;
  content: string;
  confidence: "low" | "medium" | "high" | string;
  importance: "low" | "medium" | "high" | string;
  status: OfficeMemoryStatus | string;
  evidenceRefs: OfficeMemoryEvidenceRef[];
  keywords: string[];
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  usageCount: number;
};

export type OfficeMemoryListResult = {
  data: OfficeMemoryRecord[];
  nextCursor: string | null;
};

export type OfficeMemberContextPreview = {
  runId: string;
  member: string;
  agentId: string;
  threadId: string;
  contextPolicy: string;
  memoryScope: string;
  agentProfile: string;
  sharedContext: string;
  memoryContext: string;
};

export type OfficeRunDelegationActivity = {
  id?: string;
  retryOf?: string;
  member?: string;
  agentId?: string;
  task?: string;
  status?: string;
  turnId?: string;
  threadId?: string;
  target?: string;
  targetKind?: "runtimeThread" | string;
  tool?: "followup_task" | "send_message" | "spawn_agent" | string;
  contextPolicy?: string;
  memoryScope?: string;
  agentPath?: string;
  dispatchMethod?: string;
  dispatchMode?: string;
  dispatchPolicy?: string;
  riskSeverity?: "low" | "medium" | "high" | string;
  approvalRequired?: boolean;
  requiresApproval?: boolean;
  manualDispatch?: boolean;
  approvalId?: string;
  completedAt?: string;
  resultPreview?: string;
  error?: string;
  updatedAt?: string;
  memoryRefs?: OfficeMemoryRefActivity[];
};

export type OfficeRunActivity = {
  id: string;
  title: string;
  status:
    | "queued"
    | "running"
    | "canceling"
    | "completed"
    | "failed"
    | "interrupted";
  threadId?: string;
  turnId?: string;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string;
  lastNotificationReason?: string;
  lastNotificationSourceThreadId?: string;
  lastNotificationSourceTurnId?: string;
  cancelRequestedAt?: string;
  requestText?: string;
  promptPreview?: string;
  resultPreview?: string;
  retryOf?: string;
  goal?: string;
  locale?: string;
  messageIntent?: "conversation" | "task" | string;
  loop?: {
    mode?: string;
    iteration?: number;
    maxIterations?: number;
    phase?: string;
    status?: string;
    cycle?: string[];
    memoryPolicy?: string;
    stopConditions?: Array<{
      condition?: string;
      met?: boolean;
    }>;
    metrics?: {
      iteration?: number;
      maxIterations?: number;
      retryBudgetRemaining?: number;
      acceptance?: {
        total?: number;
        passed?: number;
        failed?: number;
        pending?: number;
      };
      evidence?: {
        total?: number;
        verified?: number;
        blocked?: number;
      };
      verification?: {
        total?: number;
        passed?: number;
        failed?: number;
        pending?: number;
        runnablePending?: number;
        missingRunnablePending?: number;
      };
      risks?: {
        total?: number;
        high?: number;
        openHigh?: number;
      };
      delegations?: {
        total?: number;
        queued?: number;
        running?: number;
        completed?: number;
        failed?: number;
      };
      updatedAt?: string;
    };
    review?: {
      status?: "passed" | "blocked" | "needsReview" | "incomplete" | string;
      nextAction?: string;
      acceptance?: {
        total?: number;
        passed?: number;
        failed?: number;
        pending?: number;
      };
      evidence?: {
        total?: number;
        verified?: number;
        blocked?: number;
      };
      verification?: {
        total?: number;
        passed?: number;
        failed?: number;
        pending?: number;
        runnablePending?: number;
        missingRunnablePending?: number;
      };
      risks?: {
        total?: number;
        high?: number;
        openHigh?: number;
      };
      updatedAt?: string;
    };
  };
  memoryRefs?: OfficeMemoryRefActivity[];
  delegationRoutes?: Array<{
    member?: string;
    agentId?: string;
    threadId?: string;
    target?: string;
    targetKind?: "runtimeThread" | string;
    tool?: "followup_task" | "send_message" | "spawn_agent" | string;
    contextPolicy?: string;
    memoryScope?: string;
  }>;
  plan?: Array<{
    step: string;
    status?: "pending" | "inProgress" | "completed" | string;
  }>;
  acceptanceCriteria?: Array<{
    criterion: string;
    criterionId?: string;
    itemId?: string;
    status?: "pending" | "passed" | "failed" | string;
    evidence?: string;
    source?: string;
    verifiedByCheck?: string;
    verifiedByCheckItemId?: string;
    sourceType?: string;
    sourceThreadId?: string;
    sourceTurnId?: string;
    observedAt?: string;
    member?: string;
    agentId?: string;
    delegationId?: string;
  }>;
  verificationChecks?: Array<{
    check: string;
    criterion?: string;
    criterionId?: string;
    acceptanceId?: string;
    status?: "pending" | "passed" | "failed" | string;
    command?: string;
    automationId?: string;
    automationRunFilePath?: string;
    automationRunId?: string;
    automationThreadId?: string;
    automationTurnId?: string;
    retryOfAutomationTurnId?: string;
    automationStatus?: string;
    dispatchStatus?:
      | "queued"
      | "running"
      | "canceling"
      | "completed"
      | "failed"
      | string;
    artifact?: string;
    evidence?: string;
    error?: string;
    source?: string;
    evidenceKind?: "commandExecution" | string;
    itemId?: string;
    exitCode?: number;
    durationMs?: number;
    outputPreview?: string;
    outputSha256?: string;
    sourceType?: string;
    sourceThreadId?: string;
    sourceTurnId?: string;
    observedAt?: string;
    member?: string;
    agentId?: string;
    delegationId?: string;
  }>;
  evidence?: Array<{
    summary: string;
    status?: "observed" | "verified" | "blocked" | string;
    source?: string;
    sourceType?: string;
    sourceThreadId?: string;
    sourceTurnId?: string;
    observedAt?: string;
    evidenceKind?: "commandExecution" | "fileChange" | string;
    itemId?: string;
    command?: string;
    cwd?: string;
    exitCode?: number;
    durationMs?: number;
    outputPreview?: string;
    outputSha256?: string;
    changeCount?: number;
    changesSha256?: string;
    paths?: string[];
    url?: string;
    member?: string;
    agentId?: string;
    delegationId?: string;
  }>;
  risks?: Array<{
    summary: string;
    severity?: "low" | "medium" | "high" | string;
    mitigation?: string;
    owner?: string;
    sourceType?: string;
    sourceThreadId?: string;
    sourceTurnId?: string;
    observedAt?: string;
    member?: string;
    agentId?: string;
    delegationId?: string;
  }>;
  delegations?: OfficeRunDelegationActivity[];
  error?: string;
};

export type OfficeRunVerificationCheckActivity = NonNullable<
  OfficeRunActivity["verificationChecks"]
>[number];

export type ActivityData = {
  trace?: TraceStep[];
  approvals?: ApprovalRequest[];
  budget?: BudgetRow[];
  budgetCapUsd?: number;
  artifacts?: ArtifactItem[];
  runs?: OfficeRunActivity[];
};

export type KnowledgeEntry = {
  knowledgeId?: string;
  title: string;
  glyph: string;
  accent: LibraryAccent;
  kind: string;
  preview: string;
  meta: string;
  path?: string;
  threadId?: string;
  pinned?: boolean;
};

export type KnowledgeSource = {
  knowledgeId?: string;
  name: string;
  glyph: string;
  accent: LibraryAccent;
  status: "indexed" | "indexing" | "needs-auth";
  meta: string;
  path?: string;
  isDirectory?: boolean;
};

export type KnowledgeData = {
  memories: KnowledgeEntry[];
  sources: KnowledgeSource[];
};

export type LibraryItem = {
  title: string;
  meta: string;
  description?: string;
  section?: boolean;
  glyph?: string;
  logo?: string;
  accent?: LibraryAccent;
  badge?: { label: string; tone?: LibraryBadgeTone };
  tags?: string[];
  capabilityKind?: "mcp" | "skill";
  capabilityLocation?: "cloud" | "local";
  catalog?: boolean;
  action?:
    | {
        type: "capability-preset";
        presetId: string;
        presetKind: "mcp" | "skill";
      }
    | {
        type: "plugin";
        pluginName: string;
        marketplacePath?: string | null;
        remoteMarketplaceName?: string | null;
      }
    | {
        type: "skill-file";
        skillName: string;
        path: string;
        enabled?: boolean;
        configPath?: string;
      }
    | {
        type: "plugin-skill";
        skillName: string;
        remoteMarketplaceName: string;
        remotePluginId: string;
      }
    | {
        type: "mcp-detail";
        title: string;
        subtitle: string;
        body: string;
        authStatus?: string;
        configName?: string;
        config?: Record<
          string,
          import("@crewon-ui-model/serde_json/JsonValue").JsonValue
        >;
        resource?: {
          server: string;
          uri: string;
          label: string;
        };
        tool?: {
          server: string;
          name: string;
          label: string;
          inputSchema: string;
        };
        configPath?: string;
      }
    | {
        type: "office-detail";
        title: string;
        subtitle: string;
        body: string;
        items: LibraryItem[];
        workspace?: OfficeWorkspace;
        configPath?: string;
        workspaceCwd?: string;
      }
    | {
        type: "agent-config";
        config: AgentConfig;
        configPath?: string;
      }
    | {
        type: "automation-detail";
        title: string;
        subtitle: string;
        body: string;
        prompt: string;
        items?: LibraryItem[];
        threadId?: string;
        config?: AutomationConfig;
        configPath?: string;
        controlAutomationId?: string;
        controlAutomationRevision?: 1;
      }
    | {
        type: "external-agent-import";
        item: ExternalAgentConfigMigrationItem;
      };
};

export type LibraryItemAction = NonNullable<LibraryItem["action"]>;
export type McpDetailAction = Extract<
  LibraryItemAction,
  { type: "mcp-detail" }
>;
export type SkillFileAction = Extract<
  LibraryItemAction,
  { type: "skill-file" }
>;

export function officeConfigForThread(
  title: string,
  subtitle: string,
  workspace: OfficeWorkspace,
  threadId: string,
): OfficeConfig {
  return {
    title,
    subtitle,
    workspace: {
      ...workspace,
      threadId,
      backendStatus: "connected",
    },
  };
}
