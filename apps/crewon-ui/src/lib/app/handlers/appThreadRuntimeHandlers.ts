import type { Thread } from "@crewon-protocol/v2/Thread";

import type {
  AppServerClient,
} from "../../app-server/appServer";
import type { ComposerImageInput } from "../../shared/composerImages";
import type { AppView } from "../appRouting";
import type { PendingComposerMention } from "../../shared/composerMentions";
import type { ConfirmHandler } from "../../shared/confirmHandler";
import type { NoticeState } from "../appRuntimeState";
import type { CapabilityPanel } from "../../capability/capabilityPanelTypes";
import type { Locale, ToolId } from "../../i18n";
import {
  agentPlatformThreadSource,
  type ThreadRuntimeSettings,
} from "../../thread/threadRuntimeSettings";
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
import { restoreAgentPlatformThread } from "../../thread/agentPlatformThreadHistory";
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
    threadSettings?: ThreadRuntimeSettings,
    workspaceCwd?: string | null,
  ) => Promise<Thread | null>;
  deleteArchivedThread: (thread: Thread) => Promise<void>;
  interruptActiveTurn: () => Promise<void>;
  renameThread: (thread: Thread) => Promise<void>;
  selectThread: (threadId: string) => Promise<void>;
  sendMessage: (
    text: string,
    threadSettings?: ThreadRuntimeSettings,
    images?: ComposerImageInput[],
  ) => Promise<void>;
  sendMessageInNewThread: (
    text: string,
    threadSettings?: ThreadRuntimeSettings,
    workspaceCwd?: string | null,
    images?: ComposerImageInput[],
  ) => Promise<void>;
  startDraftThread: () => void;
  startReview: () => Promise<void>;
  startSideChat: () => Promise<void>;
  toggleArchivedThreads: () => Promise<void>;
};

export type AppThreadRuntimeHandlersParams = {
  activeTurnId: string | null;
  busyToolId: ToolId | null;
  client: AppServerClient | null;
  confirm: ConfirmHandler;
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
    threadId:
      | string
      | null
      | ((currentThreadId: string | null) => string | null),
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
  const activeTurnId = params.activeTurnId;
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

  const createThread = (
    initialPrompt?: string,
    threadSource = "app_server",
    threadSettings?: ThreadRuntimeSettings,
    workspaceCwd?: string | null,
  ) =>
    createThreadAction({
      client: params.client,
      createDemoThread,
      initialPrompt,
      isConnected: params.isConnected,
      locale: params.locale,
      preserveThreadsAfterConnectionLoss:
        params.preserveThreadsAfterConnectionLoss,
      resolveBackendCwd: params.resolveBackendCwd,
      setNotice: params.setNotice,
      setSelectedThreadId: (threadId) => params.setSelectedThreadId(threadId),
      setSidebarOpen: params.setSidebarOpen,
      setThreads: params.setThreads,
      shouldAutoCloseSidebar: params.shouldAutoCloseSidebar,
      threadSettings,
      threadSource,
      workspaceCwd,
    });

  const sendMessageWithThreadContext = (
    text: string,
    threadSettings: ThreadRuntimeSettings | undefined,
    threadContext: {
      activeTurnId: string | null;
      selectedThread: Thread | null;
      selectedThreadId: string | null;
    },
    workspaceCwd?: string | null,
    images?: ComposerImageInput[],
  ) =>
    sendMessageAction({
      activeTurnId: threadContext.activeTurnId,
      client: params.client,
      createThread: (initialPrompt) =>
        createThread(
          initialPrompt,
          agentPlatformThreadSource(threadSettings?.agentPlatformAgentId) ??
            "app_server",
          threadSettings,
          workspaceCwd,
        ),
      demoResponse: params.demoResponse,
      isConnected: params.isConnected,
      isDemoPreview: params.isDemoPreview,
      isSending: params.isSending,
      locale: params.locale,
      pendingComposerMentions: params.pendingComposerMentions,
      preserveThreadsAfterConnectionLoss:
        params.preserveThreadsAfterConnectionLoss,
      selectedThread: threadContext.selectedThread,
      selectedThreadId: threadContext.selectedThreadId,
      setActiveTurnByThread: params.setActiveTurnByThread,
      setComposerFocusSignal: params.setComposerFocusSignal,
      setComposerValue: params.setComposerValue,
      setIsSending: params.setIsSending,
      setNotice: params.setNotice,
      setPendingComposerMentions: params.setPendingComposerMentions,
      setSelectedThreadId: (threadId) => params.setSelectedThreadId(threadId),
      setThreads: params.setThreads,
      text,
      images,
      threadSettings,
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
        activeTurnId,
        client: params.client,
        isConnected: params.isConnected,
        locale: params.locale,
        selectedThreadId: params.selectedThreadId,
        setActiveTurnByThread: params.setActiveTurnByThread,
        setIsSending: params.setIsSending,
        setNotice: params.setNotice,
        setThreads: params.setThreads,
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
    selectThread: async (threadId) => {
      await selectThreadAction({
        client: params.client,
        isConnected: params.isConnected,
        locale: params.locale,
        preserveThreadsAfterConnectionLoss:
          params.preserveThreadsAfterConnectionLoss,
        restoreThread: (thread) =>
          params.client
            ? restoreAgentPlatformThread({ client: params.client, thread })
            : Promise.resolve(thread),
        setAppView: params.setAppView,
        setInspectorOpen: params.setInspectorOpen,
        setNotice: params.setNotice,
        setSelectedThreadId: params.setSelectedThreadId,
        setSidebarOpen: params.setSidebarOpen,
        setThreads: params.setThreads,
        shouldAutoCloseSidebar: params.shouldAutoCloseSidebar,
        threadId,
      });
    },
    sendMessage: (text, threadSettings, images) =>
      sendMessageWithThreadContext(text, threadSettings, {
        activeTurnId,
        selectedThread: params.selectedThread,
        selectedThreadId: params.selectedThreadId,
      }, undefined, images),
    sendMessageInNewThread: (text, threadSettings, workspaceCwd, images) =>
      sendMessageWithThreadContext(
        text,
        threadSettings,
        {
          activeTurnId: null,
          selectedThread: null,
          selectedThreadId: null,
        },
        workspaceCwd,
        images,
      ),
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
