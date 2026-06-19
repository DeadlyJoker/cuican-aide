import type { Thread } from "@crewon-protocol/v2/Thread";

import type { AppServerClient } from "../../app-server/appServer";
import type { NoticeState } from "../appRuntimeState";
import type {
  CapabilityPanel,
  CapabilityPanelItem,
} from "../../capability/capabilityPanelTypes";
import type {
  AgentConfig,
  ArtifactItem,
  LibraryPanel,
  OfficeWorkspace,
} from "../../domain/crewonDomain";
import { decideAppOfficeApproval } from "../../domain/domainOfficeBackend";
import {
  upsertOfficeArtifact as upsertBackendOfficeArtifact,
} from "../../domain/domainOfficeBackend";
import type { Locale, ToolId } from "../../i18n";
import {
  agentCapabilityToggledPanel,
  agentConfigUpdatedPanel,
} from "../../agent-config/agentConfigPanel";
import {
  ensureBackendToolThreadAction,
  recordBackendToolEventAction,
} from "../../backend/backendToolThreadActions";
import { saveAgentConfigAction } from "../../library/libraryAgentSaveActions";
import {
  handleOfficeApprovalDecisionAction,
  type OfficeApprovalDecision,
} from "../../office/officeApprovalActions";
import { handleOfficeArtifactAction } from "../../office/officeArtifactActions";

type StateSetter<T> = (updater: (current: T) => T) => void;
type LibraryPanelSetter = (
  panelOrUpdater:
    | LibraryPanel
    | null
    | ((panel: LibraryPanel | null) => LibraryPanel | null),
) => void;
type CapabilityPanelSetter = (
  panelOrUpdater:
    | CapabilityPanel
    | null
    | ((panel: CapabilityPanel | null) => CapabilityPanel | null),
) => void;

export type AppDomainActionHandlers = {
  ensureBackendToolThread: (
    serverName: string,
    toolName: string,
  ) => Promise<string | null>;
  handleApprovalDecision: (
    id: string,
    decision: OfficeApprovalDecision,
  ) => Promise<void>;
  handleOfficeArtifact: (artifact: ArtifactItem) => Promise<void>;
  recordBackendToolEvent: (
    threadId: string,
    title: string,
    body: string,
  ) => Promise<void>;
  saveAgentConfig: () => Promise<void>;
  toggleAgentCapability: (group: "mcp" | "skills", id: string) => void;
  updateAgentConfig: (patch: Partial<AgentConfig>) => void;
};

export type AppDomainActionHandlersParams = {
  busyToolId: ToolId | null;
  client: AppServerClient | null;
  ensureOfficeThread: (
    panel: LibraryPanel,
    workspaceOverride?: OfficeWorkspace,
    forceNew?: boolean,
  ) => Promise<string | null>;
  handleCapabilityPanelItem: (item: CapabilityPanelItem) => Promise<void>;
  isConnected: boolean;
  isMissingThreadError: (error: unknown) => boolean;
  libraryPanel: LibraryPanel | null;
  locale: Locale;
  resolveBackendCwd: () => Promise<string>;
  selectedThreadId: string | null;
  setActiveTurnByThread: StateSetter<Record<string, string>>;
  setBusyToolId: (toolId: ToolId | null) => void;
  setCapabilityDockOpen: (open: boolean) => void;
  setCapabilityPanel: CapabilityPanelSetter;
  setLibraryPanel: LibraryPanelSetter;
  setNotice: (notice: NoticeState | null) => void;
  setThreads: StateSetter<Thread[]>;
  startBackendDomainThread: (
    source: "agent" | "automation" | "office",
  ) => Promise<Thread | null>;
  threads: Thread[];
  uniqueOfficeArtifactId?: () => string;
  writeAgentConfig: (
    config: AgentConfig,
  ) => Promise<{ filePath: string; agentId?: string } | null>;
};

export function createAppDomainActionHandlers(
  params: AppDomainActionHandlersParams,
): AppDomainActionHandlers {
  return {
    ensureBackendToolThread: (serverName, toolName) =>
      ensureBackendToolThreadAction({
        locale: params.locale,
        renameThread: async (threadId, title) => {
          await params.client?.renameThread(threadId, title);
        },
        resolveBackendCwd: params.resolveBackendCwd,
        selectedThreadId: params.selectedThreadId,
        serverName,
        setThreadGoal: async (threadId, goal, tokenBudget) => {
          await params.client?.setThreadGoal(threadId, goal, tokenBudget);
        },
        setThreads: params.setThreads,
        startThread: (threadCwd, source) =>
          params.client?.startThread(threadCwd, source) ?? Promise.resolve(null),
        toolName,
      }),
    handleApprovalDecision: async (id, decision) => {
      await handleOfficeApprovalDecisionAction({
        decideOfficeApproval: (
          panel,
          workspace,
          threadId,
          approvalId,
          approvalDecision,
          message,
        ) =>
          decideAppOfficeApproval({
            approvalId,
            client: params.client,
            decision: approvalDecision,
            message,
            panel,
            resolveBackendCwd: params.resolveBackendCwd,
            threadId,
            workspace,
          }),
        decision,
        ensureOfficeThread: params.ensureOfficeThread,
        id,
        isConnected: params.isConnected,
        locale: params.locale,
        panel: params.libraryPanel,
        setLibraryPanel: params.setLibraryPanel,
        setNotice: params.setNotice,
      });
    },
    handleOfficeArtifact: async (artifact) => {
      await handleOfficeArtifactAction({
        artifact,
        busyToolId: params.busyToolId,
        client: params.client,
        ensureOfficeThread: params.ensureOfficeThread,
        handleDirectoryItem: params.handleCapabilityPanelItem,
        isConnected: params.isConnected,
        libraryPanel: params.libraryPanel,
        locale: params.locale,
        nowIso: () => new Date().toISOString(),
        resolveBackendCwd: params.resolveBackendCwd,
        setBusyToolId: params.setBusyToolId,
        setCapabilityDockOpen: params.setCapabilityDockOpen,
        setCapabilityPanel: (panel) => params.setCapabilityPanel(panel),
        setLibraryPanel: params.setLibraryPanel,
        setThreads: params.setThreads,
        uniqueId:
          params.uniqueOfficeArtifactId ??
          (() => `office-artifact-${Date.now()}`),
        upsertOfficeArtifact: (
          root,
          panel,
          workspace,
          threadId,
          savedArtifact,
          systemMessage,
        ) => {
          if (!params.client) {
            return Promise.resolve(null);
          }
          return upsertBackendOfficeArtifact(
            params.client,
            root,
            panel,
            workspace,
            threadId,
            savedArtifact,
            systemMessage,
          );
        },
      });
    },
    recordBackendToolEvent: async (threadId, title, body) => {
      await recordBackendToolEventAction({
        body,
        setActiveTurnByThread: params.setActiveTurnByThread,
        setThreads: params.setThreads,
        startTurn: (targetThreadId, text) =>
          params.client?.startTurn(targetThreadId, text) ??
          Promise.resolve(null),
        threadId,
        title,
      });
    },
    saveAgentConfig: async () => {
      await saveAgentConfigAction({
        config: params.libraryPanel?.agentConfig,
        isConnected: params.isConnected,
        isMissingThreadError: params.isMissingThreadError,
        locale: params.locale,
        readThread: (threadId) =>
          params.client?.readThread(threadId) ?? Promise.resolve(null),
        renameThread: async (threadId, name) => {
          await params.client?.renameThread(threadId, name);
        },
        setLibraryPanel: params.setLibraryPanel,
        setNotice: params.setNotice,
        setThreadGoal: async (threadId, goal, tokenBudget) => {
          await params.client?.setThreadGoal(threadId, goal, tokenBudget);
        },
        setThreads: params.setThreads,
        startAgentThread: () => params.startBackendDomainThread("agent"),
        startTurn: (threadId, text) =>
          params.client?.startTurn(threadId, text) ?? Promise.resolve(null),
        threads: params.threads,
        writeAgentConfig: params.writeAgentConfig,
      });
    },
    toggleAgentCapability: (group, id) => {
      params.setLibraryPanel((currentPanel) =>
        agentCapabilityToggledPanel(currentPanel, group, id),
      );
    },
    updateAgentConfig: (patch) => {
      params.setLibraryPanel((currentPanel) =>
        agentConfigUpdatedPanel(currentPanel, patch),
      );
    },
  };
}
