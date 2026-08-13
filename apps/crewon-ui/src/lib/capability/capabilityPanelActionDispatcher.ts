import type { Thread } from "@crewon-protocol/v2/Thread";
import type { ThreadGoal } from "@crewon-protocol/v2/ThreadGoal";

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
  createServerRequestActionHandlers,
  serverRequestActionForActionId,
  type ServerRequestActionHandlersParams,
} from "../server-request/serverRequestActions";
import {
  demoCapabilityActionPanel,
  demoThreadSettingsSavedPanel,
} from "../settings/settingsDemoPanels";
import {
  createTerminalActionHandlers,
  terminalActionForActionId,
  type TerminalActionHandlersParams,
} from "../terminal/terminalActions";
import {
  threadGoalActionForActionId,
  type ThreadGoalActionHandlersParams,
} from "../thread/threadGoalActions";
import {
  createThreadLifecycleActionHandlers,
  threadLifecycleActionForActionId,
  type ThreadLifecycleActionHandlersParams,
  type ThreadLifecycleClient,
} from "../thread/threadLifecycleActions";

type DispatcherClient = NonNullable<
  BackgroundTerminalActionHandlersParams["client"]
> &
  NonNullable<ContextThreadActionHandlersParams["client"]> &
  NonNullable<FilePanelActionHandlersParams["client"]> &
  NonNullable<PluginPanelActionHandlersParams["client"]> &
  NonNullable<ServerRequestActionHandlersParams["client"]> &
  NonNullable<TerminalActionHandlersParams["client"]> &
  NonNullable<ThreadGoalActionHandlersParams["client"]> &
  NonNullable<ThreadLifecycleActionHandlersParams["client"]>;

type PendingContextFile =
  ContextThreadActionHandlersParams["pendingContextFile"];

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
  threadLifecycleClient?: ThreadLifecycleClient | null;
  threadLifecycleConnected?: boolean;
  threadLifecycleControlConfigured?: boolean;
  confirm: ConfirmHandler;
  createThread: (initialPrompt?: string) => Promise<Thread | null>;
  cwd: string;
  fieldValue: (fieldId: string) => string;
  isConnected: boolean;
  isDemo: boolean;
  isDemoPreview: boolean;
  locale: Locale;
  loadBrowserApps: () => Promise<void> | void;
  handleSettingsAction?: (actionId: string) => boolean;
  openPluginPath: (path: string) => void;
  openThreadSettingsPanel: () => void;
  pendingApprovalRequest: PendingApprovalRequest | null;
  pendingContextFile: PendingContextFile;
  pendingDynamicToolRequest: PendingDynamicToolRequest | null;
  pendingExternalSecretRequest: PendingExternalSecretRequest | null;
  pendingMcpElicitationRequest: PendingMcpElicitationRequest | null;
  pendingUserInputRequest: PendingUserInputRequest | null;
  readWorkspaceFiles: () => Promise<void> | void;
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
    pendingApprovalRequest,
    pendingContextFile,
    pendingDynamicToolRequest,
    pendingExternalSecretRequest,
    pendingMcpElicitationRequest,
    pendingUserInputRequest,
    readWorkspaceFiles,
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
    setThreads,
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

  if (params.handleSettingsAction?.(actionId) === true) {
    return true;
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

  const threadLifecycleAction = threadLifecycleActionForActionId(actionId);
  if (threadLifecycleAction) {
    createThreadLifecycleActionHandlers({
      busyToolId,
      client:
        params.threadLifecycleClient === undefined
          ? client
          : params.threadLifecycleClient,
      confirm,
      isConnected: params.threadLifecycleConnected ?? isConnected,
      isDemo: params.threadLifecycleControlConfigured === true ? false : isDemo,
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
    setNotice({
      text:
        locale === "zh"
          ? "目标已迁移到对话输入框，请在那里编辑、暂停或清除。"
          : "Goals moved to the conversation composer. Edit, pause, or clear them there.",
      tone: "warning",
    });
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
