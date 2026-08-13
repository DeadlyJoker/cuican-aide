import type { Thread } from "@crewon-protocol/v2/Thread";

import type { ComposerImageInput } from "../../shared/composerImages";
import type { AppView } from "../appRouting";
import type { PendingComposerMention } from "../../shared/composerMentions";
import type { ConfirmHandler } from "../../shared/confirmHandler";
import type { NoticeState } from "../appRuntimeState";
import type { CapabilityPanel } from "../../capability/capabilityPanelTypes";
import type { Locale, ToolId } from "../../i18n";
import {
  type CommandExecutionIntent,
  type ThreadRuntimeSettings,
} from "../../thread/threadRuntimeSettings";
import {
  archiveThreadAction,
  clearAssistantThreadAction,
  deleteArchivedThreadAction,
  renameThreadAction,
  selectThreadAction,
  startDraftThreadAction,
  toggleArchivedThreadsAction,
  type ArchiveThreadActionParams,
  type ClearAssistantThreadActionParams,
  type DeleteArchivedThreadActionParams,
  type RenameThreadActionParams,
  type SelectThreadActionParams,
  type ToggleArchivedThreadsActionParams,
} from "../../thread/threadListActions";
import {
  createDemoThreadAction,
  createThreadAction,
  interruptActiveTurnAction,
  sendMessageAction,
  type CreateThreadActionParams,
  type InterruptActiveTurnActionParams,
  type SendMessageActionParams,
} from "../../thread/threadMessageActions";
import type { ThreadExecutionContextPreparation } from "../../thread/threadMessageActions";
import {
  startReviewAction,
  startSideChatAction,
  type StartReviewActionParams,
  type StartSideChatActionParams,
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

type AppThreadRuntimeClient = NonNullable<ArchiveThreadActionParams["client"]> &
  NonNullable<ClearAssistantThreadActionParams["client"]> &
  NonNullable<CreateThreadActionParams["client"]> &
  NonNullable<DeleteArchivedThreadActionParams["client"]> &
  NonNullable<InterruptActiveTurnActionParams["client"]> &
  NonNullable<RenameThreadActionParams["client"]> &
  NonNullable<SelectThreadActionParams["client"]> &
  NonNullable<SendMessageActionParams["client"]> &
  NonNullable<StartReviewActionParams["client"]> &
  NonNullable<StartSideChatActionParams["client"]> &
  NonNullable<ToggleArchivedThreadsActionParams["client"]>;

export type AppThreadRuntimeHandlers = {
  archiveThread: (thread: Thread) => Promise<void>;
  clearAssistantThread: (thread: Thread) => Promise<void>;
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
  sendMessageToThread: (
    text: string,
    thread: Thread,
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
  activeTurnByThread?: Record<string, string>;
  activeTurnId: string | null;
  busyToolId: ToolId | null;
  client: AppThreadRuntimeClient | null;
  confirm: ConfirmHandler;
  demoResponse: string;
  getShowArchivedThreads: () => boolean;
  isConnected: boolean;
  isDemo: boolean;
  isDemoPreview: boolean;
  isSending: boolean;
  locale: Locale;
  onExecutionIntentCommitted?: (
    intent: Exclude<CommandExecutionIntent, "none">,
  ) => void;
  newDraftPreview: string;
  newDraftThread: string;
  pendingComposerMentions: PendingComposerMention[];
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
  prepareThreadExecutionContext?: () => ThreadExecutionContextPreparation | null;
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
    threadSource = "control-api",
    threadSettings?: ThreadRuntimeSettings,
    workspaceCwd?: string | null,
  ) =>
    createThreadAction({
      client: params.client,
      createDemoThread,
      initialPrompt,
      isConnected: params.isConnected,
      locale: params.locale,
      resolveBackendCwd: params.resolveBackendCwd,
      setNotice: params.setNotice,
      setSelectedThreadId: (threadId) => params.setSelectedThreadId(threadId),
      setSidebarOpen: params.setSidebarOpen,
      setThreads: params.setThreads,
      shouldAutoCloseSidebar: params.shouldAutoCloseSidebar,
      threadSettings,
      threadSource,
      workspaceCwd,
      executionContextPreparation:
        params.prepareThreadExecutionContext?.() ?? null,
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
          threadSettings?.threadSource ?? "control-api",
          threadSettings,
          workspaceCwd,
        ),
      demoResponse: params.demoResponse,
      isConnected: params.isConnected,
      isDemoPreview: params.isDemoPreview,
      isSending: params.isSending,
      locale: params.locale,
      onExecutionIntentCommitted: params.onExecutionIntentCommitted,
      pendingComposerMentions: params.pendingComposerMentions,
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
    clearAssistantThread: (thread) =>
      clearAssistantThreadAction({
        client: params.client,
        confirm: params.confirm,
        isConnected: params.isConnected,
        locale: params.locale,
        setNotice: params.setNotice,
        setSelectedThreadId: params.setSelectedThreadId,
        setThreads: params.setThreads,
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
      sendMessageWithThreadContext(
        text,
        threadSettings,
        {
          activeTurnId,
          selectedThread: params.selectedThread,
          selectedThreadId: params.selectedThreadId,
        },
        undefined,
        images,
      ),
    sendMessageToThread: (text, thread, threadSettings, images) => {
      params.setSelectedThreadId(thread.id);
      return sendMessageWithThreadContext(
        text,
        threadSettings,
        {
          activeTurnId:
            params.activeTurnByThread?.[thread.id] ??
            thread.turns.find((turn) => turn.status === "inProgress")?.id ??
            null,
          selectedThread: thread,
          selectedThreadId: thread.id,
        },
        undefined,
        images,
      );
    },
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
