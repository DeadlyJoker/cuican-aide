import type { ExternalAgentConfigMigrationItem } from "@crewon-protocol/v2/ExternalAgentConfigMigrationItem";

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
  actions?: LibraryPanelAction[];
  body?: string;
  fields?: LibraryPanelField[];
  items: LibraryItem[];
  error?: string;
  workspace?: OfficeWorkspace;
  agentConfig?: AgentConfig;
  knowledge?: KnowledgeData;
};

export type LibraryPanelField = {
  id: string;
  label: string;
  placeholder?: string;
  value: string;
};

export type LibraryPanelAction = {
  id:
    | "call-mcp-tool"
    | "create-agent"
    | "create-automation"
    | "create-knowledge-memory"
    | "create-mcp"
    | "create-office"
    | "create-skill"
    | "delete-config-file"
    | "delete-mcp-config"
    | "install-plugin"
    | "open-knowledge-file"
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
    | "save-mcp-draft"
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
  automationConfig?: AutomationConfig;
  automationConfigPath?: string;
  automationTitle?: string;
  automationThreadId?: string;
  automationPrompt?: string;
  threadId?: string;
  skillEnabled?: boolean;
  skillName?: string;
  skillPath?: string;
  skillConfigPath?: string;
  knowledgePath?: string;
  knowledgeTitle?: string;
  knowledgeKind?: "file" | "directory";
  tone?: "danger" | "primary";
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
  agentId?: string;
  name: string;
  role: string;
  glyph: string;
  accent: LibraryAccent;
  status: string;
  online?: boolean;
};

export type OfficeMessage = {
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
};

export type OfficeWorkspace = {
  goal: string;
  threadId?: string;
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
  trigger?: { type: "manual" | "schedule" | "event" | "file"; [key: string]: unknown };
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
};

export type ActivityData = {
  trace: TraceStep[];
  approvals: ApprovalRequest[];
  budget: BudgetRow[];
  budgetCapUsd: number;
  artifacts: ArtifactItem[];
};

export type KnowledgeEntry = {
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
  accent?: LibraryAccent;
  badge?: { label: string; tone?: LibraryBadgeTone };
  tags?: string[];
  action?:
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
      }
    | {
        type: "external-agent-import";
        item: ExternalAgentConfigMigrationItem;
      };
};

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
