import type { Thread } from "@crewon-protocol/v2/Thread";

import type { AppServerClient } from "../../app-server/appServer";
import type { NoticeState } from "../appRuntimeState";
import type { BackendWorkspace } from "../../backend/backendWorkspace";
import type {
  AgentConfig,
  LibraryPanel,
  McpDetailAction,
  OfficeWorkspace,
  SkillFileAction,
} from "../../domain/crewonDomain";
import type { Locale } from "../../i18n";
import type { OfficeThreadResolution } from "../../office/officeThreadActions";
import {
  listBackendAutomationRuns,
  readBackendAgentConfig,
  readBackendAutomationConfig,
  readBackendOfficeConfig,
} from "../../library/libraryBackendConfigAccess";
import {
  createLibraryItemOpenHandlers,
  type LibraryItemOpenHandlersParams,
} from "../../library/libraryItemOpenHandlers";
import type { LibraryItemOpenHandlers } from "../../library/libraryItemActionFlow";

type LibraryPanelSetter =
  LibraryItemOpenHandlersParams["agentConfig"]["setLibraryPanel"];
type ThreadSetter = (updater: (currentThreads: Thread[]) => Thread[]) => void;

export function createAppLibraryItemOpenHandlers(params: {
  client: AppServerClient | null;
  createBackendAgentConfig: () => Promise<AgentConfig>;
  ensureOfficeThread: (
    panel: LibraryPanel,
    workspaceOverride?: OfficeWorkspace,
    forceNew?: boolean,
  ) => Promise<OfficeThreadResolution | null>;
  isConnected: boolean;
  isUnsupportedRpcError: (error: unknown) => boolean;
  locale: Locale;
  openAgentsLibrary: () => Promise<void>;
  optionalBackendWorkspace: () => Promise<BackendWorkspace | null>;
  readAutomationRunItems: (
    threadId: string | null | undefined,
  ) => Promise<LibraryPanel["items"]>;
  refreshToolActionFromBackend: (
    action: McpDetailAction | SkillFileAction,
  ) => Promise<McpDetailAction | SkillFileAction>;
  setLibraryPanel: LibraryPanelSetter;
  setNotice: (notice: NoticeState | null) => void;
  setThreadGoal: (
    threadId: string,
    goal: string,
    tokenBudget?: number | null,
  ) => Promise<void>;
  setThreads: ThreadSetter;
  writeAgentConfig: (
    config: AgentConfig,
  ) => Promise<{ filePath: string; agentId?: string } | null>;
}): LibraryItemOpenHandlers {
  const readThread = (threadId: string) =>
    params.client?.readThread(threadId) ?? Promise.resolve(null);
  const startTurn = (threadId: string, text: string) =>
    params.client?.startTurn(threadId, text) ?? Promise.resolve(null);

  return createLibraryItemOpenHandlers({
    agentConfig: {
      isConnected: params.isConnected,
      locale: params.locale,
      readAgentConfig: (requestParams) =>
        readBackendAgentConfig(params.optionalBackendWorkspace, requestParams),
      readThread,
      setLibraryPanel: params.setLibraryPanel,
    },
    capabilityPreset: {
      locale: params.locale,
      setLibraryPanel: params.setLibraryPanel,
    },
    automationDetail: {
      isConnected: params.isConnected,
      listAutomationRuns: (threadId) =>
        listBackendAutomationRuns(params.optionalBackendWorkspace, threadId),
      locale: params.locale,
      readAutomationConfig: (requestParams) =>
        readBackendAutomationConfig(
          params.optionalBackendWorkspace,
          requestParams,
        ),
      readAutomationRunItems: params.readAutomationRunItems,
      setLibraryPanel: params.setLibraryPanel,
    },
    externalAgentImport: {
      createBackendAgentConfig: params.createBackendAgentConfig,
      importExternalAgentConfig: (item) =>
        params.client?.importExternalAgentConfig(item) ?? Promise.resolve(null),
      locale: params.locale,
      openAgentsLibrary: params.openAgentsLibrary,
      renameThread: async (threadId, name) => {
        await params.client?.renameThread(threadId, name);
      },
      setLibraryPanel: params.setLibraryPanel,
      setNotice: params.setNotice,
      setThreadGoal: params.setThreadGoal,
      setThreads: params.setThreads,
      startAgentThread: (threadCwd, source) =>
        params.client?.startThread(threadCwd, source) ?? Promise.resolve(null),
      startTurn,
      writeAgentConfig: params.writeAgentConfig,
    },
    mcpDetail: {
      isConnected: params.isConnected,
      listThreads: () =>
        params.client?.listThreads(false) ?? Promise.resolve([]),
      locale: params.locale,
      readThread,
      refreshToolAction: (action) =>
        params.refreshToolActionFromBackend(action) as Promise<McpDetailAction>,
      setLibraryPanel: params.setLibraryPanel,
    },
    officeDetail: {
      ensureOfficeThread: params.ensureOfficeThread,
      isConnected: params.isConnected,
      isUnsupportedRpcError: params.isUnsupportedRpcError,
      locale: params.locale,
      readOfficeConfig: (requestParams) =>
        readBackendOfficeConfig(params.optionalBackendWorkspace, requestParams),
      readThread,
      setLibraryPanel: params.setLibraryPanel,
    },
    plugin: {
      locale: params.locale,
      readPlugin: (pluginName, marketplacePath, remoteMarketplaceName) =>
        params.client?.readPlugin(
          pluginName,
          marketplacePath,
          remoteMarketplaceName,
        ) ?? Promise.resolve(null),
      setLibraryPanel: params.setLibraryPanel,
    },
    pluginSkill: {
      locale: params.locale,
      readPluginSkill: (remoteMarketplaceName, remotePluginId, skillName) =>
        params.client?.readPluginSkill(
          remoteMarketplaceName,
          remotePluginId,
          skillName,
        ) ?? Promise.resolve(null),
      setLibraryPanel: params.setLibraryPanel,
    },
    skillFile: {
      open: {
        locale: params.locale,
        readFile: (path) =>
          params.client?.readFile(path) ?? Promise.resolve(null),
        setLibraryPanel: params.setLibraryPanel,
      },
      refreshAction: (action) =>
        params.refreshToolActionFromBackend(action) as Promise<SkillFileAction>,
    },
  });
}
