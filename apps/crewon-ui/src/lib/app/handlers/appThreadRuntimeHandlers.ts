import type { Thread } from "@crewon-protocol/v2/Thread";

import type { AppServerClient } from "../../app-server/appServer";
import type { AppView } from "../appRouting";
import type { PendingComposerMention } from "../../shared/composerMentions";
import type { NoticeState } from "../appRuntimeState";
import type { CapabilityPanel } from "../../capability/capabilityPanelTypes";
import type { Locale, ToolId } from "../../i18n";
import {
  archiveThreadAction,
  deleteArchivedThreadAction,
  renameThreadAction,
  selectThreadAction,
  startDraftThreadAction,
  toggleArchivedThreadsAction,
} from "../../thread/threadListActions";
import {
  createDemoThreadAction,
  createThreadAction,
  interruptActiveTurnAction,
  sendMessageAction,
} from "../../thread/threadMessageActions";
import {
  startReviewAction,
  startSideChatAction,
} from "../../thread/threadToolActions";

type ThreadSetter = (updater: (currentThreads: Thread[]) => Thread[]) => void;
type ActiveTurnSetter = (
  updater: (current: Record<string, string>) => Record<string, string>,
) => void;
type SetCapabilityPanel = (
  panelOrUpdater:
    | CapabilityPanel
    | null
    | ((currentPanel: CapabilityPanel | null) => CapabilityPanel | null),
) => void;

export type AppThreadRuntimeHandlers = {
  archiveThread: (thread: Thread) => Promise<void>;
  createDemoThread: (initialPrompt?: string) => Thread;
  createThread: (
    initialPrompt?: string,
    threadSource?: string,
  ) => Promise<Thread | null>;
  deleteArchivedThread: (thread: Thread) => Promise<void>;
  interruptActiveTurn: () => Promise<void>;
  renameThread: (thread: Thread) => Promise<void>;
  selectThread: (threadId: string) => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  startDraftThread: () => void;
  startReview: () => Promise<void>;
  startSideChat: () => Promise<void>;
  toggleArchivedThreads: () => Promise<void>;
};

export type AppThreadRuntimeHandlersParams = {
  activeTurnId: string | null;
  busyToolId: ToolId | null;
  client: AppServerClient | null;
  confirm: (message: string) => boolean;
  demoResponse: string;
  getShowArchivedThreads: () => boolean;
  isConnected: boolean;
  isDemo: boolean;
  isDemoPreview: boolean;
  isSending: boolean;
  locale: Locale;
  newDraftPreview: string;
  newDraftThread: string;
  pendingComposerMentions: PendingComposerMention[];
  preserveThreadsAfterConnectionLoss: () => void;
  prompt: (message: string, defaultValue: string) => string | null;
  recordShowArchivedThreads: (showArchived: boolean) => void;
  resolveBackendCwd: () => Promise<string | undefined>;
  selectedThread: Thread | null;
  selectedThreadId: string | null;
  setActiveTurnByThread: ActiveTurnSetter;
  setAppView: (view: AppView) => void;
  setBusyToolId: (toolId: ToolId | null) => void;
  setCapabilityPanel: SetCapabilityPanel;
  setComposerFocusSignal: (updater: (signal: number) => number) => void;
  setComposerValue: (value: string) => void;
  setInspectorOpen: (open: boolean) => void;
  setIsSending: (isSending: boolean) => void;
  setNotice: (notice: NoticeState | null) => void;
  setPendingComposerMentions: (mentions: PendingComposerMention[]) => void;
  setSelectedThreadId: (
    threadId: string | null | ((currentThreadId: string | null) => string | null),
  ) => void;
  setShowArchivedThreads: (showArchived: boolean) => void;
  setSidebarOpen: (open: boolean) => void;
  setThreadSearchTerm: (term: string) => void;
  setThreads: ThreadSetter;
  shouldAutoCloseSidebar: () => boolean;
  untitledThreadLabel: string;
};

export function createAppThreadRuntimeHandlers(
  params: AppThreadRuntimeHandlersParams,
): AppThreadRuntimeHandlers {
  const createDemoThread = (initialPrompt?: string) =>
    createDemoThreadAction({
      initialPrompt,
      locale: params.locale,
      newDraftPreview: params.newDraftPreview,
      newDraftThread: params.newDraftThread,
      setInspectorOpen: params.setInspectorOpen,
      setSelectedThreadId: (threadId) => params.setSelectedThreadId(threadId),
      setSidebarOpen: params.setSidebarOpen,
      setThreads: params.setThreads,
      shouldAutoCloseSidebar: params.shouldAutoCloseSidebar,
    });

  const createThread = (initialPrompt?: string, threadSource = "app_server") =>
    createThreadAction({
      client: params.client,
      createDemoThread,
      initialPrompt,
      isConnected: params.isConnected,
      locale: params.locale,
      preserveThreadsAfterConnectionLoss: params.preserveThreadsAfterConnectionLoss,
      resolveBackendCwd: params.resolveBackendCwd,
      setNotice: params.setNotice,
      setSelectedThreadId: (threadId) => params.setSelectedThreadId(threadId),
      setSidebarOpen: params.setSidebarOpen,
      setThreads: params.setThreads,
      shouldAutoCloseSidebar: params.shouldAutoCloseSidebar,
      threadSource,
    });

  return {
    archiveThread: (thread) =>
      archiveThreadAction({
        client: params.client,
        isConnected: params.isConnected,
        locale: params.locale,
        setNotice: params.setNotice,
        setSelectedThreadId: params.setSelectedThreadId,
        setThreads: params.setThreads,
        showArchivedThreads: params.getShowArchivedThreads(),
        thread,
      }),
    createDemoThread,
    createThread,
    deleteArchivedThread: (thread) =>
      deleteArchivedThreadAction({
        client: params.client,
        confirm: params.confirm,
        isConnected: params.isConnected,
        locale: params.locale,
        setNotice: params.setNotice,
        setSelectedThreadId: params.setSelectedThreadId,
        setThreads: params.setThreads,
        showArchivedThreads: params.getShowArchivedThreads(),
        thread,
        untitledThreadLabel: params.untitledThreadLabel,
      }),
    interruptActiveTurn: () =>
      interruptActiveTurnAction({
        activeTurnId: params.activeTurnId,
        client: params.client,
        isConnected: params.isConnected,
        locale: params.locale,
        selectedThreadId: params.selectedThreadId,
        setIsSending: params.setIsSending,
        setNotice: params.setNotice,
      }),
    renameThread: (thread) =>
      renameThreadAction({
        client: params.client,
        isConnected: params.isConnected,
        locale: params.locale,
        prompt: params.prompt,
        setNotice: params.setNotice,
        setThreads: params.setThreads,
        thread,
        untitledThreadLabel: params.untitledThreadLabel,
      }),
    selectThread: (threadId) =>
      selectThreadAction({
        client: params.client,
        isConnected: params.isConnected,
        locale: params.locale,
        preserveThreadsAfterConnectionLoss:
          params.preserveThreadsAfterConnectionLoss,
        setAppView: params.setAppView,
        setInspectorOpen: params.setInspectorOpen,
        setNotice: params.setNotice,
        setSelectedThreadId: params.setSelectedThreadId,
        setSidebarOpen: params.setSidebarOpen,
        setThreads: params.setThreads,
        shouldAutoCloseSidebar: params.shouldAutoCloseSidebar,
        threadId,
      }),
    sendMessage: (text) =>
      sendMessageAction({
        activeTurnId: params.activeTurnId,
        client: params.client,
        createThread: (initialPrompt) => createThread(initialPrompt),
        demoResponse: params.demoResponse,
        isConnected: params.isConnected,
        isDemoPreview: params.isDemoPreview,
        isSending: params.isSending,
        locale: params.locale,
        pendingComposerMentions: params.pendingComposerMentions,
        preserveThreadsAfterConnectionLoss:
          params.preserveThreadsAfterConnectionLoss,
        selectedThread: params.selectedThread,
        selectedThreadId: params.selectedThreadId,
        setActiveTurnByThread: params.setActiveTurnByThread,
        setComposerFocusSignal: params.setComposerFocusSignal,
        setComposerValue: params.setComposerValue,
        setIsSending: params.setIsSending,
        setNotice: params.setNotice,
        setPendingComposerMentions: params.setPendingComposerMentions,
        setSelectedThreadId: (threadId) => params.setSelectedThreadId(threadId),
        setThreads: params.setThreads,
        text,
      }),
    startDraftThread: () => {
      startDraftThreadAction({
        setAppView: params.setAppView,
        setComposerFocusSignal: params.setComposerFocusSignal,
        setComposerValue: params.setComposerValue,
        setInspectorOpen: params.setInspectorOpen,
        setPendingComposerMentions: params.setPendingComposerMentions,
        setSelectedThreadId: params.setSelectedThreadId,
        setSidebarOpen: params.setSidebarOpen,
        shouldAutoCloseSidebar: params.shouldAutoCloseSidebar,
      });
    },
    startReview: () =>
      startReviewAction({
        busyToolId: params.busyToolId,
        client: params.client,
        createThread,
        isConnected: params.isConnected,
        isDemo: params.isDemo,
        isDemoPreview: params.isDemoPreview,
        locale: params.locale,
        preserveThreadsAfterConnectionLoss:
          params.preserveThreadsAfterConnectionLoss,
        selectedThread: params.selectedThread,
        setBusyToolId: params.setBusyToolId,
        setCapabilityPanel: params.setCapabilityPanel,
        setNotice: params.setNotice,
        setSelectedThreadId: (threadId) => params.setSelectedThreadId(threadId),
        setThreads: params.setThreads,
      }),
    startSideChat: () =>
      startSideChatAction({
        busyToolId: params.busyToolId,
        client: params.client,
        createThread,
        isConnected: params.isConnected,
        isDemo: params.isDemo,
        isDemoPreview: params.isDemoPreview,
        locale: params.locale,
        selectedThread: params.selectedThread,
        setBusyToolId: params.setBusyToolId,
        setCapabilityPanel: params.setCapabilityPanel,
        setSelectedThreadId: (threadId) => params.setSelectedThreadId(threadId),
        setThreads: params.setThreads,
      }),
    toggleArchivedThreads: async () => {
      const showArchived = await toggleArchivedThreadsAction({
        client: params.client,
        isConnected: params.isConnected,
        locale: params.locale,
        setNotice: params.setNotice,
        setSelectedThreadId: params.setSelectedThreadId,
        setShowArchivedThreads: params.setShowArchivedThreads,
        setThreadSearchTerm: params.setThreadSearchTerm,
        setThreads: params.setThreads,
        showArchivedThreads: params.getShowArchivedThreads(),
      });
      params.recordShowArchivedThreads(showArchived);
    },
  };
}
