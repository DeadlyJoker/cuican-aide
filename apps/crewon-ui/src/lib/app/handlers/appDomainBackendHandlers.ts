import type { DomainConfigListResponse, AppServerClient } from "../../app-server/appServer";
import { resolvePreferredBackendCwd } from "../../backend/backendWorkspace";
import type {
  AgentConfig,
  AutomationConfig,
  KnowledgeData,
  LibraryItem,
  LibraryPanel,
  McpDetailAction,
  OfficeConfig,
  OfficeMember,
  OfficeMessage,
  OfficeWorkspace,
  SkillFileAction,
} from "../../domain/crewonDomain";
import {
  createAppBackendAgentConfig,
  loadAppAgentLibraryItems,
  writeAppAgentConfig,
} from "../../domain/domainAgentBackend";
import {
  appAutomationConfigRecordsToLibraryItems,
  readAppAutomationRunItems,
  runAppAutomationConfig,
  updateAppAutomationRun,
  writeAppAutomationConfig,
} from "../../domain/domainAutomationBackend";
import {
  listAppRecruitableAgentConfigs,
  readAppLatestOfficeConfig,
  readAppRecruitableAgentConfig,
} from "../../domain/domainCollaborationBackend";
import {
  readBackendKnowledgeData,
  writeBackendKnowledgeMemory,
} from "../../domain/domainKnowledgeBackend";
import {
  persistAppOfficeMember,
  persistAppOfficeMessage,
  persistAppOfficeWorkspace,
  writeAppOfficeConfig,
} from "../../domain/domainOfficeBackend";
import {
  loadAppToolLibraryItems,
  refreshAppToolActionFromBackend,
} from "../../domain/domainToolPersistence";
import type { Locale } from "../../i18n";
import { knowledgeMemoryThreadContext } from "../../library/libraryKnowledgeActions";

export type AppDomainBackendHandlers = {
  persistOfficeWorkspace: (
    panel: Pick<LibraryPanel, "title" | "subtitle">,
    workspace: OfficeWorkspace,
    threadId?: string | null,
  ) => Promise<string | null>;
  persistOfficeMessage: (
    panel: Pick<LibraryPanel, "title" | "subtitle">,
    workspaceBeforeMessage: OfficeWorkspace,
    message: OfficeMessage,
    text: string,
    threadId: string,
    fallbackWorkspace: OfficeWorkspace,
  ) => Promise<OfficeConfig | null>;
  persistOfficeMember: (
    panel: Pick<LibraryPanel, "title" | "subtitle">,
    workspaceBeforeMember: OfficeWorkspace,
    agentId: string | undefined,
    member: OfficeMember,
    threadId?: string | null,
  ) => Promise<OfficeConfig | null>;
  writeOfficeConfigFile: (config: OfficeConfig) => Promise<string | null>;
  writeAgentConfigFile: (
    config: AgentConfig,
  ) => Promise<{ filePath: string; agentId?: string } | null>;
  loadAgentLibraryItems: (cwd: string) => Promise<{ items: LibraryItem[] }>;
  writeAutomationConfigFile: (
    config: AutomationConfig,
  ) => Promise<string | null>;
  runAutomationConfig: (
    config: AutomationConfig,
    note: string | null,
    turnId: string | null,
  ) => Promise<{
    record: { runId: string; filePath: string } | null;
    warning: string | null;
  }>;
  updateAutomationRun: (
    filePath: string,
    status: string,
    completedAt: number | null,
  ) => Promise<void>;
  readAutomationRunItems: (
    threadId: string | null | undefined,
  ) => Promise<LibraryItem[]>;
  automationConfigRecordsToLibraryItems: (
    records: Array<
      Pick<
        DomainConfigListResponse<AutomationConfig>["data"][number],
        "filePath" | "savedAt" | "config"
      >
    >,
  ) => Promise<LibraryItem[]>;
  loadToolLibraryItems: (cwd: string) => Promise<LibraryItem[]>;
  refreshToolActionFromBackend: (
    action: McpDetailAction | SkillFileAction,
  ) => Promise<McpDetailAction | SkillFileAction>;
  readRecruitableAgentConfig: (
    existingMembers: OfficeMember[],
  ) => Promise<AgentConfig | null>;
  listRecruitableAgentConfigs: (
    existingMembers: OfficeMember[],
  ) => Promise<AgentConfig[]>;
  readLatestOfficeConfig: () => Promise<OfficeConfig | null>;
  createBackendAgentConfig: () => Promise<AgentConfig>;
  createBackendKnowledgeData: () => Promise<KnowledgeData>;
  writeKnowledgeMemory: () => Promise<string | null>;
  resolveBackendCwd: () => Promise<string>;
};

export function createAppDomainBackendHandlers(params: {
  client: AppServerClient | null;
  currentCwd: string;
  isConnected: boolean;
  isDemoPreview: boolean;
  locale: Locale;
  selectedThreadId: string | null;
  threads: Parameters<typeof knowledgeMemoryThreadContext>[0]["threads"];
}): AppDomainBackendHandlers {
  const resolveBackendCwd = () =>
    resolvePreferredBackendCwd({
      currentCwd: params.currentCwd,
      listThreads: () =>
        params.client?.listThreads(false) ?? Promise.resolve([]),
    });

  return {
    persistOfficeWorkspace: (panel, workspace, threadId) =>
      persistAppOfficeWorkspace({
        client: params.client,
        panel,
        resolveBackendCwd,
        threadId,
        workspace,
      }),
    persistOfficeMessage: (
      panel,
      workspaceBeforeMessage,
      message,
      text,
      threadId,
      fallbackWorkspace,
    ) =>
      persistAppOfficeMessage({
        client: params.client,
        fallbackWorkspace,
        locale: params.locale,
        message,
        panel,
        resolveBackendCwd,
        text,
        threadId,
        workspaceBeforeMessage,
      }),
    persistOfficeMember: (
      panel,
      workspaceBeforeMember,
      agentId,
      member,
      threadId,
    ) =>
      persistAppOfficeMember({
        agentId,
        client: params.client,
        member,
        panel,
        resolveBackendCwd,
        threadId,
        workspaceBeforeMember,
      }),
    writeOfficeConfigFile: (config) =>
      writeAppOfficeConfig({
        client: params.client,
        config,
        resolveBackendCwd,
      }),
    writeAgentConfigFile: (config) =>
      writeAppAgentConfig({
        client: params.client,
        config,
        resolveBackendCwd,
      }),
    loadAgentLibraryItems: (cwd) =>
      loadAppAgentLibraryItems({
        client: params.client,
        cwd,
        locale: params.locale,
      }),
    writeAutomationConfigFile: (config) =>
      writeAppAutomationConfig({
        client: params.client,
        config,
        resolveBackendCwd,
      }),
    runAutomationConfig: (config, note, turnId) =>
      runAppAutomationConfig({
        client: params.client,
        config,
        locale: params.locale,
        note,
        resolveBackendCwd,
        turnId,
      }),
    updateAutomationRun: (filePath, status, completedAt) =>
      updateAppAutomationRun({
        completedAt,
        client: params.client,
        filePath,
        resolveBackendCwd,
        status,
      }),
    readAutomationRunItems: (threadId) =>
      readAppAutomationRunItems({
        client: params.client,
        locale: params.locale,
        resolveBackendCwd,
        threadId,
      }),
    automationConfigRecordsToLibraryItems: (records) =>
      appAutomationConfigRecordsToLibraryItems({
        client: params.client,
        locale: params.locale,
        records,
        resolveBackendCwd,
      }),
    loadToolLibraryItems: (cwd) =>
      loadAppToolLibraryItems({
        client: params.client,
        cwd,
        locale: params.locale,
      }),
    refreshToolActionFromBackend: (action) =>
      refreshAppToolActionFromBackend({
        action,
        client: params.client,
        isConnected: params.isConnected,
        locale: params.locale,
        resolveBackendCwd,
      }),
    readRecruitableAgentConfig: (existingMembers) =>
      readAppRecruitableAgentConfig({
        client: params.client,
        existingMembers,
        isConnected: params.isConnected,
        resolveBackendCwd,
      }),
    listRecruitableAgentConfigs: (existingMembers) =>
      listAppRecruitableAgentConfigs({
        client: params.client,
        existingMembers,
        isConnected: params.isConnected,
        resolveBackendCwd,
      }),
    readLatestOfficeConfig: () =>
      readAppLatestOfficeConfig({
        client: params.client,
        isConnected: params.isConnected,
        resolveBackendCwd,
      }),
    createBackendAgentConfig: () =>
      createAppBackendAgentConfig({
        client: params.client,
        currentCwd: params.currentCwd,
        isConnected: params.isConnected,
        isDemoPreview: params.isDemoPreview,
        locale: params.locale,
        resolveBackendCwd,
        selectedThreadId: params.selectedThreadId,
      }),
    createBackendKnowledgeData: () =>
      readBackendKnowledgeData({
        client: params.client,
        locale: params.locale,
        resolveBackendCwd,
      }),
    writeKnowledgeMemory: () => {
      const threadContext = knowledgeMemoryThreadContext({
        selectedThreadId: params.selectedThreadId,
        threads: params.threads,
      });
      return writeBackendKnowledgeMemory({
        client: params.client,
        locale: params.locale,
        resolveBackendCwd,
        selectedThreadId: threadContext.selectedThreadId,
        selectedThreadTitle: threadContext.selectedThreadTitle,
      });
    },
    resolveBackendCwd,
  };
}
