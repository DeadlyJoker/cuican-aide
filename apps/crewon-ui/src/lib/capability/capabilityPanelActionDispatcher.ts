import type { Thread } from "@crewon-protocol/v2/Thread";
import type { ThreadGoal } from "@crewon-protocol/v2/ThreadGoal";

import {
  accountActionForActionId,
  createAccountActionHandlers,
  type AccountActionHandlersParams,
} from "../account/accountActions";
import type { AccountStatus } from "../shared/statusTypes";
import type {
  PendingApprovalRequest,
  PendingDynamicToolRequest,
  PendingExternalSecretRequest,
  PendingMcpElicitationRequest,
  PendingUserInputRequest,
} from "../shared/pendingServerRequests";
import {
  backgroundTerminalActionForActionId,
  createBackgroundTerminalActionHandlers,
  type BackgroundTerminalActionHandlersParams,
} from "../terminal/backgroundTerminalActions";
import type { CapabilityPanel } from "./capabilityPanelTypes";
import type { ConfirmHandler } from "../shared/confirmHandler";
import {
  contextThreadActionForActionId,
  createContextThreadActionHandlers,
  type ContextThreadActionHandlersParams,
} from "../context/contextThreadActions";
import {
  createFilePanelActionHandlers,
  filePanelActionForActionId,
  type ActiveFileWatch,
  type FilePanelActionHandlersParams,
} from "../file/filePanelActions";
import type { Locale, ToolId } from "../i18n";
import type { NoticeState } from "../shared/noticeState";
import {
  handlePluginPanelAction,
  pluginPanelActionForActionId,
  type PluginPanelActionHandlersParams,
} from "../plugin/pluginPanelActions";
import {
  createRemoteControlActionHandlers,
  remoteControlActionForActionId,
  type RemoteControlActionHandlersParams,
} from "../remote/remoteControlActions";
import {
  createServerRequestActionHandlers,
  serverRequestActionForActionId,
  type ServerRequestActionHandlersParams,
} from "../server-request/serverRequestActions";
import {
  settingsRefreshActionForActionId,
  settingsSaveActionForActionId,
  type SettingsRefreshAction,
  type SettingsSaveAction,
} from "../settings/settingsActions";
import {
  demoCapabilityActionPanel,
  demoThreadSettingsSavedPanel,
} from "../settings/settingsDemoPanels";
import {
  handleSettingsRuntimeAction,
  settingsRuntimeActionForActionId,
  type SettingsRuntimeActionHandlersParams,
} from "../settings/settingsRuntimeActions";
import {
  createTerminalActionHandlers,
  terminalActionForActionId,
  type TerminalActionHandlersParams,
} from "../terminal/terminalActions";
import {
  createThreadGoalActionHandlers,
  threadGoalActionForActionId,
  type ThreadGoalActionHandlersParams,
} from "../thread/threadGoalActions";
import {
  createThreadLifecycleActionHandlers,
  threadLifecycleActionForActionId,
  type ThreadLifecycleActionHandlersParams,
} from "../thread/threadLifecycleActions";
import {
  createThreadSettingsActionHandlers,
  threadSettingsActionForActionId,
  type ThreadSettingsActionHandlersParams,
} from "../thread/threadSettingsActions";
import {
  createWorktreeSessionActionHandlers,
  worktreeSessionActionForActionId,
  type WorktreeSessionActionHandlersParams,
} from "../worktree/worktreeSessionActions";

type DispatcherClient =
  NonNullable<AccountActionHandlersParams["client"]> &
  NonNullable<BackgroundTerminalActionHandlersParams["client"]> &
  NonNullable<ContextThreadActionHandlersParams["client"]> &
  NonNullable<FilePanelActionHandlersParams["client"]> &
  NonNullable<PluginPanelActionHandlersParams["client"]> &
  NonNullable<RemoteControlActionHandlersParams["client"]> &
  NonNullable<ServerRequestActionHandlersParams["client"]> &
  NonNullable<SettingsRuntimeActionHandlersParams["client"]> &
  NonNullable<TerminalActionHandlersParams["client"]> &
  NonNullable<ThreadGoalActionHandlersParams["client"]> &
  NonNullable<ThreadLifecycleActionHandlersParams["client"]> &
  NonNullable<ThreadSettingsActionHandlersParams["client"]> &
  NonNullable<WorktreeSessionActionHandlersParams["client"]>;

type PendingContextFile = ContextThreadActionHandlersParams["pendingContextFile"];

type SetCapabilityPanel = (
  panelOrUpdater:
    | CapabilityPanel
    | null
    | ((currentPanel: CapabilityPanel | null) => CapabilityPanel | null),
) => void;

export type CapabilityPanelActionDispatcherParams = {
  actionId: string;
  activeFileWatch: ActiveFileWatch | null;
  busyToolId: ToolId | null;
  capabilityPanel: CapabilityPanel | null;
  client: DispatcherClient | null | undefined;
  confirm: ConfirmHandler;
  createThread: (initialPrompt?: string) => Promise<Thread | null>;
  cwd: string;
  fieldValue: (fieldId: string) => string;
  isConnected: boolean;
  isDemo: boolean;
  isDemoPreview: boolean;
  locale: Locale;
  loadBrowserApps: () => Promise<void> | void;
  openPluginPath: (path: string) => void;
  openThreadSettingsPanel: () => void;
  pendingApprovalRequest: PendingApprovalRequest | null;
  pendingContextFile: PendingContextFile;
  pendingDynamicToolRequest: PendingDynamicToolRequest | null;
  pendingExternalSecretRequest: PendingExternalSecretRequest | null;
  pendingMcpElicitationRequest: PendingMcpElicitationRequest | null;
  pendingUserInputRequest: PendingUserInputRequest | null;
  readWorkspaceFiles: () => Promise<void> | void;
  refreshAccountPanel: () => Promise<void> | void;
  refreshComputerControlSettingsPanel: () => Promise<void>;
  refreshEnvironmentSettingsPanel: () => Promise<void>;
  refreshMcpSettingsPanel: () => Promise<void>;
  refreshWorktreesSettingsPanel: () => Promise<void>;
  resolveBackendCwd: () => Promise<string | null | undefined>;
  selectedThread: Thread | null;
  selectedThreadId: string | null;
  setAccountStatus: (account: AccountStatus | null) => void;
  setActiveFileWatch: (watch: ActiveFileWatch | null) => void;
  setActiveTurnByThread: (
    updater: (current: Record<string, string>) => Record<string, string>,
  ) => void;
  setBusyToolId: (toolId: ToolId | null) => void;
  setCapabilityPanel: SetCapabilityPanel;
  setNotice: (notice: NoticeState) => void;
  setPendingApprovalRequest: (request: PendingApprovalRequest | null) => void;
  setPendingDynamicToolRequest: (
    request: PendingDynamicToolRequest | null,
  ) => void;
  setPendingExternalSecretRequest: (
    request: PendingExternalSecretRequest | null,
  ) => void;
  setPendingMcpElicitationRequest: (
    request: PendingMcpElicitationRequest | null,
  ) => void;
  setPendingUserInputRequest: (request: PendingUserInputRequest | null) => void;
  setSelectedThreadId: (threadId: string) => void;
  setStreamingTextByThread: (
    updater: (current: Record<string, string>) => Record<string, string>,
  ) => void;
  setThreadGoal: (goal: ThreadGoal | null) => void;
  setThreads: (updater: (currentThreads: Thread[]) => Thread[]) => void;
  settingsRefreshHandlers: Record<SettingsRefreshAction, () => void>;
  settingsSaveHandlers: Record<SettingsSaveAction, () => void>;
  terminalCommand: string;
  terminalProcessId: string | null;
  threadId: string | null;
  previewAwareThreadId: string | null;
};

export function handleCapabilityPanelActionDispatch(
  params: CapabilityPanelActionDispatcherParams,
): boolean {
  const {
    actionId,
    activeFileWatch,
    busyToolId,
    capabilityPanel,
    client,
    confirm,
    createThread,
    cwd,
    fieldValue,
    isConnected,
    isDemo,
    locale,
    loadBrowserApps,
    openPluginPath,
    openThreadSettingsPanel,
    pendingApprovalRequest,
    pendingContextFile,
    pendingDynamicToolRequest,
    pendingExternalSecretRequest,
    pendingMcpElicitationRequest,
    pendingUserInputRequest,
    previewAwareThreadId,
    readWorkspaceFiles,
    refreshAccountPanel,
    refreshComputerControlSettingsPanel,
    refreshEnvironmentSettingsPanel,
    refreshMcpSettingsPanel,
    refreshWorktreesSettingsPanel,
    resolveBackendCwd,
    selectedThread,
    selectedThreadId,
    setAccountStatus,
    setActiveFileWatch,
    setActiveTurnByThread,
    setBusyToolId,
    setCapabilityPanel,
    setNotice,
    setPendingApprovalRequest,
    setPendingDynamicToolRequest,
    setPendingExternalSecretRequest,
    setPendingMcpElicitationRequest,
    setPendingUserInputRequest,
    setSelectedThreadId,
    setStreamingTextByThread,
    setThreadGoal,
    setThreads,
    settingsRefreshHandlers,
    settingsSaveHandlers,
    terminalCommand,
    terminalProcessId,
    threadId,
  } = params;

  if (isDemo) {
    if (actionId === "save-thread-settings") {
      setCapabilityPanel((currentPanel) =>
        demoThreadSettingsSavedPanel(currentPanel, locale),
      );
      return true;
    }
    const demoActionPanel = demoCapabilityActionPanel(actionId, locale);
    if (demoActionPanel) {
      setCapabilityPanel(demoActionPanel);
      return true;
    }
  }

  const pluginPanelAction = pluginPanelActionForActionId(actionId);
  if (pluginPanelAction) {
    handlePluginPanelAction(
      {
        client,
        loadBrowserApps,
        locale,
        openPluginPath,
        setCapabilityPanel,
        setNotice,
      },
      pluginPanelAction,
    );
    return true;
  }

  const refreshAction = settingsRefreshActionForActionId(actionId);
  if (refreshAction) {
    settingsRefreshHandlers[refreshAction]();
    return true;
  }

  const saveAction = settingsSaveActionForActionId(actionId);
  if (saveAction) {
    settingsSaveHandlers[saveAction]();
    return true;
  }

  const threadSettingsAction = threadSettingsActionForActionId(actionId);
  if (threadSettingsAction) {
    createThreadSettingsActionHandlers({
      busyToolId,
      client,
      fieldValue,
      isConnected,
      isDemo,
      locale,
      selectedThread,
      setBusyToolId,
      setCapabilityPanel,
      setThreads,
      threadId,
    })[threadSettingsAction]();
    return true;
  }

  const worktreeSessionAction = worktreeSessionActionForActionId(actionId);
  if (worktreeSessionAction) {
    createWorktreeSessionActionHandlers({
      client,
      locale,
      refreshWorktreesSettingsPanel,
      resolveBackendCwd,
      selectedThreadId,
      setCapabilityPanel,
      setSelectedThreadId,
      setThreads,
    })[worktreeSessionAction]();
    return true;
  }

  const remoteControlAction = remoteControlActionForActionId(actionId);
  if (remoteControlAction) {
    createRemoteControlActionHandlers({
      client,
      fieldValue,
      locale,
      refreshComputerControlSettingsPanel,
      setCapabilityPanel,
      setNotice,
    })[remoteControlAction]();
    return true;
  }

  const settingsRuntimeAction = settingsRuntimeActionForActionId(actionId);
  if (settingsRuntimeAction) {
    handleSettingsRuntimeAction(
      {
        client,
        locale,
        refreshEnvironmentSettingsPanel,
        refreshMcpSettingsPanel,
        resolveBackendCwd,
        setCapabilityPanel,
        setNotice,
      },
      settingsRuntimeAction,
    );
    return true;
  }

  const threadLifecycleAction = threadLifecycleActionForActionId(actionId);
  if (threadLifecycleAction) {
    createThreadLifecycleActionHandlers({
      busyToolId,
      client,
      confirm,
      isConnected,
      isDemo,
      locale,
      setActiveTurnByThread,
      setBusyToolId,
      setCapabilityPanel,
      setStreamingTextByThread,
      setThreads,
      threadId,
    })[threadLifecycleAction]();
    return true;
  }

  const threadGoalAction = threadGoalActionForActionId(actionId);
  if (threadGoalAction) {
    createThreadGoalActionHandlers({
      busyToolId,
      client,
      createThread,
      fieldValue,
      isConnected,
      isDemo,
      locale,
      openThreadSettingsPanel,
      setBusyToolId,
      setCapabilityPanel,
      setThreadGoal,
      threadId: previewAwareThreadId,
    })[threadGoalAction]();
    return true;
  }

  const filePanelAction = filePanelActionForActionId(actionId);
  if (filePanelAction) {
    createFilePanelActionHandlers({
      activeFileWatch,
      busyToolId,
      capabilityPanel,
      client,
      cwd,
      fieldValue,
      isConnected,
      isDemo,
      locale,
      readWorkspaceFiles,
      resolveBackendCwd,
      setActiveFileWatch,
      setBusyToolId,
      setCapabilityPanel,
      setNotice,
    })[filePanelAction]();
    return true;
  }

  const contextThreadAction = contextThreadActionForActionId(actionId);
  if (contextThreadAction) {
    createContextThreadActionHandlers({
      busyToolId,
      client,
      createThread,
      isConnected,
      locale,
      pendingContextFile,
      selectedThread,
      setActiveTurnByThread,
      setBusyToolId,
      setCapabilityPanel,
      setNotice,
      setSelectedThreadId,
      setThreads,
      threadId,
    })[contextThreadAction]();
    return true;
  }

  const backgroundTerminalAction =
    backgroundTerminalActionForActionId(actionId);
  if (backgroundTerminalAction) {
    createBackgroundTerminalActionHandlers({
      client,
      isConnected,
      isDemo,
      locale,
      setBusyToolId,
      setCapabilityPanel,
      threadId,
    })[backgroundTerminalAction]();
    return true;
  }

  const terminalAction = terminalActionForActionId(actionId);
  if (terminalAction) {
    createTerminalActionHandlers({
      busyToolId,
      client,
      command: terminalCommand,
      confirm,
      isConnected,
      isDemo,
      locale,
      processId: terminalProcessId,
      setCapabilityPanel,
      setNotice,
      stdinValue: fieldValue("terminal-stdin"),
      threadId,
    })[terminalAction]();
    return true;
  }

  const accountAction = accountActionForActionId(actionId);
  if (accountAction) {
    createAccountActionHandlers({
      client,
      isConnected,
      locale,
      refreshAccountPanel,
      setAccountStatus,
      setCapabilityPanel,
    })[accountAction]();
    return true;
  }

  const serverRequestAction = serverRequestActionForActionId({
    actionId,
    pendingApprovalRequest,
    pendingDynamicToolRequest,
    pendingExternalSecretRequest,
    pendingMcpElicitationRequest,
    pendingUserInputRequest,
  });
  if (serverRequestAction) {
    createServerRequestActionHandlers({
      actionId,
      capabilityPanel,
      client,
      fieldValue,
      locale,
      pendingApprovalRequest,
      pendingDynamicToolRequest,
      pendingExternalSecretRequest,
      pendingMcpElicitationRequest,
      pendingUserInputRequest,
      setCapabilityPanel,
      setPendingApprovalRequest,
      setPendingDynamicToolRequest,
      setPendingExternalSecretRequest,
      setPendingMcpElicitationRequest,
      setPendingUserInputRequest,
    })[serverRequestAction]();
    return true;
  }

  return false;
}
