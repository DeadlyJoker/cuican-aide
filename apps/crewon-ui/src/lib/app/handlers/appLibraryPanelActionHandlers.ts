import type { Thread } from "@crewon-protocol/v2/Thread";

import type { AppServerClient } from "../../app-server/appServer";
import type { AppView } from "../appRouting";
import type { NoticeState } from "../appRuntimeState";
import type { ConfirmHandler } from "../../shared/confirmHandler";
import {
  automationWorkspaceUnavailableMessage,
  requireAppServerClient,
  type BackendWorkspace,
} from "../../backend/backendWorkspace";
import type { CapabilityPanelItem } from "../../capability/capabilityPanelTypes";
import type {
  AgentConfig,
  AutomationConfig,
  LibraryKind,
  LibraryPanel,
  LibraryPanelAction,
  OfficeMessage,
  ToolConfig,
} from "../../domain/crewonDomain";
import {
  deleteMcpToolConfigRecord,
  saveOrUpdateToolConfig,
  syncSkillToolConfig,
} from "../../domain/domainToolPersistence";
import {
  deleteDomainConfigFile,
  type OfficeConfigWriteResult,
} from "../../domain/domainPersistence";
import type { Locale } from "../../i18n";
import {
  createBackendAutomationConfig,
  listBackendAgentConfigs,
  listBackendOfficeConfigs,
  updateBackendAutomationConfig,
  updateBackendAutomationConfigPath,
} from "../../library/libraryBackendConfigAccess";
import {
  createLibraryPanelActionHandlers,
  type LibraryPanelActionHandlers,
} from "../../library/libraryPanelActionHandlers";
import { createDefaultAgentConfig } from "../../agent-config/agentConfigDefaults";
import { readCanonicalOfficeConfigForMutation } from "../../office/officeCanonicalConfig";
import type { OfficeRunTurnRecord } from "../../office/officeRunPanel";
import type { OfficeThreadResolution } from "../../office/officeThreadActions";

type LibraryPanelSetter = (
  panelOrUpdater:
    | LibraryPanel
    | null
    | ((panel: LibraryPanel | null) => LibraryPanel | null),
) => void;
type ThreadSetter = (updater: (currentThreads: Thread[]) => Thread[]) => void;

export type AppLibraryPanelActionHandlersParams = {
  action: LibraryPanelAction;
  client: AppServerClient | null;
  confirm: ConfirmHandler;
  createBackendAgentConfig: () => Promise<AgentConfig>;
  ensureBackendToolThread: (
    serverName: string,
    toolName: string,
  ) => Promise<string | null>;
  ensureOfficeThread: (
    panel: LibraryPanel,
    workspaceOverride?: NonNullable<LibraryPanel["workspace"]>,
    forceNew?: boolean,
  ) => Promise<OfficeThreadResolution | null>;
  handleCapabilityPanelItem: (
    item: CapabilityPanelItem,
  ) => Promise<void> | void;
  isConnected: boolean;
  isDemo: boolean;
  isDemoPreview: boolean;
  isMissingThreadError: (error: unknown) => boolean;
  isUnsupportedRpcError: (error: unknown) => boolean;
  libraryPanel: LibraryPanel | null;
  locale: Locale;
  openLibrary: (kind: LibraryKind) => Promise<void>;
  optionalBackendWorkspace: () => Promise<BackendWorkspace | null>;
  persistOfficeMember: Parameters<
    typeof createLibraryPanelActionHandlers
  >[0]["officeRecruit"]["persistOfficeMember"];
  readAutomationRunItems: Parameters<
    typeof createLibraryPanelActionHandlers
  >[0]["automationRun"]["readAutomationRunItems"];
  readLatestOfficeConfig: () => Promise<AutomationConfig["targetOffice"]>;
  readRecruitableAgentConfig: (
    existingMembers: NonNullable<LibraryPanel["workspace"]>["members"],
  ) => Promise<AgentConfig | null>;
  recordBackendToolEvent: (
    threadId: string,
    title: string,
    body: string,
  ) => Promise<void>;
  recordAutomationRunForTurn: (
    turnId: string,
    record: Parameters<
      typeof createLibraryPanelActionHandlers
    >[0]["automationRun"] extends { recordAutomationRunForTurn: infer T }
      ? T extends (turnId: string, record: infer R) => void
        ? R
        : never
      : never,
  ) => void;
  recordOfficeRunTurn: (turnId: string, record: OfficeRunTurnRecord) => void;
  requireBackendWorkspace: (errorMessage: string) => Promise<BackendWorkspace>;
  resolveBackendCwd: () => Promise<string>;
  runAutomationConfig: Parameters<
    typeof createLibraryPanelActionHandlers
  >[0]["automationRun"]["runAutomationConfig"];
  setAppView: (view: AppView) => void;
  setCapabilityDockOpen: (open: boolean) => void;
  setCapabilityPanel: (
    panelOrUpdater:
      | import("../../capability/capabilityPanelTypes").CapabilityPanel
      | null
      | ((
          currentPanel: import("../../capability/capabilityPanelTypes").CapabilityPanel | null,
        ) => import("../../capability/capabilityPanelTypes").CapabilityPanel | null),
  ) => void;
  setLibraryPanel: LibraryPanelSetter;
  setNotice: (notice: NoticeState | null) => void;
  setSelectedThreadId: (threadId: string | null) => void;
  setThreads: ThreadSetter;
  selectedThreadId: string | null;
  startBackendDomainThread: (
    source: "agent" | "automation",
  ) => Promise<Thread | null>;
  updateAutomationRun: Parameters<
    typeof createLibraryPanelActionHandlers
  >[0]["automationRun"]["updateAutomationRun"];
  writeAgentConfigFile: (
    config: AgentConfig,
  ) => Promise<{ filePath: string; agentId?: string } | null>;
  writeAutomationConfigFile: (
    config: AutomationConfig,
  ) => Promise<string | null>;
  writeKnowledgeMemory: () => Promise<string | null>;
  writeOfficeConfigFile: (
    config: NonNullable<AutomationConfig["targetOffice"]>,
  ) => Promise<OfficeConfigWriteResult | null>;
};

export function createAppLibraryPanelActionHandlers(
  params: AppLibraryPanelActionHandlersParams,
): LibraryPanelActionHandlers {
  const readThread = (threadId: string) =>
    params.client?.readThread(threadId) ?? Promise.resolve(null);
  const renameThread = async (threadId: string, title: string) => {
    await params.client?.renameThread(threadId, title);
  };
  const setThreadGoal = async (
    threadId: string,
    goal: string,
    tokenBudget?: number | null,
  ) => {
    await params.client?.setThreadGoal(threadId, goal, tokenBudget ?? null);
  };
  const startTurn = (threadId: string, text: string) =>
    params.client?.startTurn(threadId, text) ?? Promise.resolve(null);
  const startAutomationThread = () =>
    params.startBackendDomainThread("automation");
  const requireAutomationWorkspace = () =>
    params.requireBackendWorkspace(
      automationWorkspaceUnavailableMessage(params.locale),
    );

  return createLibraryPanelActionHandlers({
    action: params.action,
    agent: {
      createAgentConfig: params.createBackendAgentConfig,
      defaultAgentConfig: () => createDefaultAgentConfig(params.locale),
      locale: params.locale,
      setLibraryPanel: params.setLibraryPanel,
    },
    automationCreate: {
      createAutomationConfig: (createParams) =>
        createBackendAutomationConfig(requireAutomationWorkspace, createParams),
      isUnsupportedRpcError: params.isUnsupportedRpcError,
      libraryPanel: params.libraryPanel,
      listAgentConfigs: () =>
        listBackendAgentConfigs(requireAutomationWorkspace),
      listOfficeConfigs: () =>
        listBackendOfficeConfigs(requireAutomationWorkspace),
      locale: params.locale,
      now: () => new Date(),
      renameThread,
      setLibraryPanel: params.setLibraryPanel,
      setNotice: params.setNotice,
      setThreadGoal,
      setThreads: params.setThreads,
      startAutomationThread,
      startTurn,
      updateAutomationConfig: (filePath, config) =>
        updateBackendAutomationConfig(
          requireAutomationWorkspace,
          filePath,
          config,
        ),
      writeAutomationConfig: params.writeAutomationConfigFile,
    },
    automationRun: {
      isMissingThreadError: params.isMissingThreadError,
      latestAgent: () => params.readRecruitableAgentConfig([]),
      latestOffice: params.readLatestOfficeConfig,
      libraryPanel: params.libraryPanel,
      locale: params.locale,
      readAutomationRunItems: params.readAutomationRunItems,
      readThread,
      recordAutomationRunForTurn: params.recordAutomationRunForTurn,
      recordOfficeRunTurn: params.recordOfficeRunTurn,
      renameThread,
      runOfficeAutomation: async (automationConfig, text) => {
        const targetOffice = automationConfig.targetOffice;
        const officeThreadId = targetOffice?.workspace.threadId?.trim();
        if (!params.client || !targetOffice || !officeThreadId) {
          return null;
        }
        const cwd = await params.resolveBackendCwd();
        const officeConfig = (
          await readCanonicalOfficeConfigForMutation({
            client: params.client,
            cwd,
            reference: targetOffice,
          })
        ).config;
        const message: OfficeMessage = {
          author: automationConfig.title,
          glyph: "A",
          accent: "violet",
          time: new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
          text,
          kind: "task",
        };
        try {
          return {
            cwd,
            response: await params.client.runOfficeConfig(
              cwd,
              officeConfig,
              message,
              text,
              params.locale,
              officeThreadId,
              null,
            ),
          };
        } catch (error) {
          if (params.isUnsupportedRpcError(error)) {
            return null;
          }
          throw error;
        }
      },
      runAutomationConfig: params.runAutomationConfig,
      setLibraryPanel: params.setLibraryPanel,
      setNotice: params.setNotice,
      setThreads: params.setThreads,
      startAutomationThread,
      startTurn,
      updateAutomationConfig: (filePath, config) =>
        updateBackendAutomationConfigPath(
          params.optionalBackendWorkspace,
          filePath,
          config,
        ),
      updateAutomationRun: params.updateAutomationRun,
      writeAutomationConfig: params.writeAutomationConfigFile,
    },
    draft: {
      createSkill: (createParams) =>
        params.client?.createSkill(createParams) ?? Promise.resolve(null),
      fields: params.libraryPanel?.fields,
      locale: params.locale,
      now: () => new Date(),
      openToolsLibrary: () => params.openLibrary("tools"),
      reloadMcpServerConfig: async ({ name, config }) => {
        const client = requireAppServerClient(params.client, params.locale);
        await client.saveMcpServerConfig({ name, config, reload: true });
      },
      resolveBackendCwd: params.resolveBackendCwd,
      saveOrUpdateToolConfig: async (cwd, toolRecord) =>
        saveOrUpdateToolConfig(
          requireAppServerClient(params.client, params.locale),
          cwd,
          toolRecord as ToolConfig,
        ),
      setLibraryPanel: params.setLibraryPanel,
      setNotice: params.setNotice,
    },
    file: {
      getMetadata: (path) =>
        params.client?.getMetadata(path) ?? Promise.resolve(null),
      locale: params.locale,
      openCapabilityItem: (item) => {
        void params.handleCapabilityPanelItem(item);
      },
      readFile: (path) => params.client?.readFile(path) ?? Promise.resolve(null),
      setCapabilityDockOpen: params.setCapabilityDockOpen,
      setLibraryPanel: params.setLibraryPanel,
    },
    knowledge: {
      confirm: params.confirm,
      isConnected: params.isConnected,
      isDemo: params.isDemo,
      locale: params.locale,
      openKnowledgeLibrary: () => params.openLibrary("knowledge"),
      resetMemory: async () => {
        await params.client?.resetMemory();
      },
      setLibraryPanel: params.setLibraryPanel,
      setNotice: params.setNotice,
      writeKnowledgeMemory: params.writeKnowledgeMemory,
    },
    maintenance: {
      deleteDomainConfigFile: async (cwd, filePath, configKind) => {
        await deleteDomainConfigFile(
          requireAppServerClient(params.client, params.locale),
          cwd,
          filePath,
          configKind,
        );
      },
      deleteMcpServerConfig: async (serverName) => {
        await requireAppServerClient(
          params.client,
          params.locale,
        ).deleteMcpServerConfig({ name: serverName, reload: true });
      },
      deleteMcpToolConfigRecord: (cwd, serverName) =>
        deleteMcpToolConfigRecord(
          requireAppServerClient(params.client, params.locale),
          cwd,
          serverName,
        ),
      domainConfigCwd:
        params.libraryPanel?.kind === "office"
          ? params.libraryPanel.workspaceCwd
          : undefined,
      fallbackLibraryKind: params.libraryPanel?.kind ?? "agents",
      locale: params.locale,
      openLibrary: params.openLibrary,
      reloadMcpServers: async () => {
        await params.client?.reloadMcpServers();
      },
      resolveBackendCwd: params.resolveBackendCwd,
      onDomainConfigDeleted:
        params.libraryPanel?.kind === "office"
          ? () => params.setLibraryPanel(null)
          : undefined,
      setNotice: params.setNotice,
    },
    mcp: {
      callMcpTool: (threadId, serverName, toolName, args) =>
        params.client?.callMcpTool(threadId, serverName, toolName, args) ??
        Promise.resolve(null),
      ensureBackendToolThread: params.ensureBackendToolThread,
      libraryPanel: params.libraryPanel,
      locale: params.locale,
      readMcpResource: (serverName, uri, threadId) =>
        params.client?.readMcpResource(serverName, uri, threadId) ??
        Promise.resolve(null),
      recordBackendToolEvent: params.recordBackendToolEvent,
      resourceContextThreadId: params.isDemoPreview
        ? undefined
        : (params.selectedThreadId ?? undefined),
      setLibraryPanel: params.setLibraryPanel,
      startMcpOauthLogin: (serverName) =>
        params.client?.startMcpOauthLogin(serverName) ?? Promise.resolve(null),
    },
    office: {
      locale: params.locale,
      setNotice: params.setNotice,
    },
    officeRecruit: {
      ensureOfficeThread: params.ensureOfficeThread,
      isConnected: params.isConnected,
      isDemo: params.isDemo,
      isMissingThreadError: params.isMissingThreadError,
      libraryPanel: params.libraryPanel,
      locale: params.locale,
      persistOfficeMember: params.persistOfficeMember,
      readRecruitableAgentConfig: params.readRecruitableAgentConfig,
      setLibraryPanel: params.setLibraryPanel,
      setNotice: params.setNotice,
      setThreads: params.setThreads,
      startTurn,
    },
    plugin: {
      installPlugin: (pluginName, marketplacePath, remoteMarketplaceName) =>
        params.client?.installPlugin(
          pluginName,
          marketplacePath,
          remoteMarketplaceName,
        ) ?? Promise.resolve(null),
      locale: params.locale,
      openLibrary: params.openLibrary,
      setLibraryPanel: params.setLibraryPanel,
      uninstallPlugin: async (pluginId) => {
        await params.client?.uninstallPlugin(pluginId);
      },
    },
    skill: {
      locale: params.locale,
      openLibrary: params.openLibrary,
      resolveBackendCwd: params.resolveBackendCwd,
      setNotice: params.setNotice,
      syncSkillToolConfig: (cwd, skillAction, enabled, actionLocale) =>
        params.client
          ? syncSkillToolConfig(
              params.client,
              cwd,
              skillAction,
              enabled,
              actionLocale,
            )
          : Promise.resolve(null),
      writeSkillConfig: (writeParams) =>
        params.client?.writeSkillConfig(writeParams) ?? Promise.resolve(null),
    },
    thread: {
      locale: params.locale,
      readThread,
      setAppView: params.setAppView,
      setCapabilityPanel: params.setCapabilityPanel,
      setLibraryPanel: params.setLibraryPanel,
      setNotice: params.setNotice,
      setSelectedThreadId: params.setSelectedThreadId,
      setThreads: params.setThreads,
    },
  });
}
