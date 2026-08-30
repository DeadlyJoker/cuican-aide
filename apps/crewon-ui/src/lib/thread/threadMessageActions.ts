import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { Turn } from "@crewon/app-server-protocol/v2/Turn";
import type { TurnStartResponse } from "@crewon/app-server-protocol/v2/TurnStartResponse";
import type { ReviewStartResponse } from "@crewon/app-server-protocol/v2/ReviewStartResponse";
import type { ReviewTarget } from "@crewon/app-server-protocol/v2/ReviewTarget";

import type { PendingComposerMention } from "../shared/composerMentions";
import {
  activeTurnByThreadAfterTurn,
  activeTurnByThreadAfterTurnId,
} from "./threadRuntimeState";
import type { NoticeState } from "../shared/noticeState";
import { createDemoTurn, createDraftDemoThread } from "../demo/demoData";
import type { Locale } from "../i18n";
import {
  appendTurnWithFallbackPreview,
  updateThreadInList,
  upsertThread,
  upsertTurnInThread,
} from "./threadModel";
import { removeRecordKey } from "../shared/recordState";
import {
  threadCreateFailureNotice,
  threadGuidanceAppendedNotice,
  threadInterruptFailureNotice,
  threadInterruptRequestedNotice,
  threadSendFailureNotice,
} from "./threadActionPresentation";
import type { ThreadRuntimeSettings } from "./threadRuntimeSettings";
import type { ThreadExecutionContext } from "@crewon/app-server-protocol/platform/v2/ThreadExecutionContext";
import { promptPreview } from "../shared/text";
import { AppServerRpcError } from "../app-server/appServer";
import type { ComposerImageInput } from "../shared/composerImages";

type ThreadSource = string;
type ActiveTurnByThreadSetter = (
  updater: (current: Record<string, string>) => Record<string, string>,
) => void;
type ThreadListSetter = (updater: (current: Thread[]) => Thread[]) => void;

type ThreadMessageClient = {
  interruptTurn(threadId: string, turnId: string): Promise<unknown>;
  readThread?(threadId: string): Promise<Thread>;
  resumeThread(threadId: string): Promise<Thread>;
  startThread(
    cwd?: string,
    threadSource?: ThreadSource,
    settings?: ThreadRuntimeSettings,
  ): Promise<Thread>;
  startThreadWithExecutionContext?(
    workspaceKey: string,
    cwd?: string,
    threadSource?: ThreadSource,
    settings?: ThreadRuntimeSettings,
  ): Promise<{
    thread: Thread;
    executionContext: ThreadExecutionContext | null;
  }>;
  deleteThread?(threadId: string): Promise<void>;
  startTurn(
    threadId: string,
    text: string,
    mentions?: PendingComposerMention[],
    settings?: ThreadRuntimeSettings,
    images?: ComposerImageInput[],
  ): Promise<TurnStartResponse>;
  startReview?(
    threadId: string,
    target?: ReviewTarget,
  ): Promise<ReviewStartResponse>;
  steerTurn(
    threadId: string,
    text: string,
    mentions?: PendingComposerMention[],
  ): Promise<{ turnId: string }>;
  updateThreadSettings?(
    threadId: string,
    settings: ThreadRuntimeSettings,
  ): Promise<void>;
};

export type ThreadExecutionContextPreparation = {
  workspaceKey: string;
  afterStart: (
    thread: Thread,
    executionContext: ThreadExecutionContext,
  ) => Promise<void>;
};

export type CreateDemoThreadActionParams = {
  initialPrompt?: string;
  locale: Locale;
  newDraftPreview: string;
  newDraftThread: string;
  setInspectorOpen: (open: boolean) => void;
  setSelectedThreadId: (threadId: string | null) => void;
  setSidebarOpen: (open: boolean) => void;
  setThreads: ThreadListSetter;
  shouldAutoCloseSidebar: () => boolean;
};

export type CreateThreadActionParams = {
  client:
    | Pick<
        ThreadMessageClient,
        "deleteThread" | "startThread" | "startThreadWithExecutionContext"
      >
    | null
    | undefined;
  createDemoThread: (initialPrompt?: string) => Thread;
  initialPrompt?: string;
  isConnected: boolean;
  locale: Locale;
  preserveThreadsAfterConnectionLoss: () => void;
  resolveBackendCwd: () => Promise<string | undefined>;
  setNotice: (notice: NoticeState | null) => void;
  setSelectedThreadId: (threadId: string | null) => void;
  setSidebarOpen: (open: boolean) => void;
  setThreads: ThreadListSetter;
  shouldAutoCloseSidebar: () => boolean;
  threadSettings?: ThreadRuntimeSettings;
  threadSource?: ThreadSource;
  workspaceCwd?: string | null;
  executionContextPreparation?: ThreadExecutionContextPreparation | null;
};

export type SendMessageActionParams = {
  activeTurnId: string | null;
  client:
    | Pick<
        ThreadMessageClient,
        | "readThread"
        | "resumeThread"
        | "startReview"
        | "startTurn"
        | "steerTurn"
        | "updateThreadSettings"
      >
    | null
    | undefined;
  createThread: (initialPrompt?: string) => Promise<Thread | null>;
  demoResponse: string;
  isConnected: boolean;
  isDemoPreview: boolean;
  isSending: boolean;
  locale: Locale;
  /**
   * Called only after startTurn atomically commits a Goal or Plan intent.
   * App wiring should compare-and-clear the matching visible composer choice.
   */
  onExecutionIntentCommitted?: (intent: "goal" | "plan") => void;
  pendingComposerMentions: PendingComposerMention[];
  preserveThreadsAfterConnectionLoss: () => void;
  selectedThread: Thread | null;
  selectedThreadId: string | null;
  setActiveTurnByThread: ActiveTurnByThreadSetter;
  setComposerFocusSignal: (updater: (signal: number) => number) => void;
  setComposerValue: (value: string) => void;
  setIsSending: (isSending: boolean) => void;
  setNotice: (notice: NoticeState | null) => void;
  setPendingComposerMentions: (mentions: PendingComposerMention[]) => void;
  setSelectedThreadId: (threadId: string | null) => void;
  setThreads: ThreadListSetter;
  text: string;
  images?: ComposerImageInput[];
  threadSettings?: ThreadRuntimeSettings;
};

export type InterruptActiveTurnActionParams = {
  activeTurnId: string | null;
  client:
    | Pick<ThreadMessageClient, "interruptTurn" | "readThread">
    | null
    | undefined;
  isConnected: boolean;
  locale: Locale;
  selectedThreadId: string | null;
  setActiveTurnByThread: ActiveTurnByThreadSetter;
  setIsSending: (isSending: boolean) => void;
  setNotice: (notice: NoticeState | null) => void;
  setThreads: ThreadListSetter;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textIncludesMentionToken(text: string, token: string): boolean {
  return new RegExp(`(^|\\s)${escapeRegExp(token)}(?=\\s|$)`).test(text);
}

export function visibleComposerMentionsForText(
  text: string,
  mentions: PendingComposerMention[],
): PendingComposerMention[] {
  return mentions.filter(
    (mention) =>
      !mention.token || textIncludesMentionToken(text, mention.token),
  );
}

export function createDemoThreadAction({
  initialPrompt,
  locale,
  newDraftPreview,
  newDraftThread,
  setInspectorOpen,
  setSelectedThreadId,
  setSidebarOpen,
  setThreads,
  shouldAutoCloseSidebar,
}: CreateDemoThreadActionParams): Thread {
  const demoThread = createDraftDemoThread({
    initialPrompt,
    locale,
    newDraftPreview,
    newDraftThread,
  });
  setThreads((current) => [demoThread, ...current]);
  setSelectedThreadId(demoThread.id);
  setInspectorOpen(false);
  if (shouldAutoCloseSidebar()) {
    setSidebarOpen(false);
  }
  return demoThread;
}

export async function createThreadAction({
  client,
  createDemoThread,
  initialPrompt,
  isConnected,
  locale,
  preserveThreadsAfterConnectionLoss,
  resolveBackendCwd,
  setNotice,
  setSelectedThreadId,
  setSidebarOpen,
  setThreads,
  shouldAutoCloseSidebar,
  threadSettings,
  threadSource = "app_server",
  workspaceCwd,
  executionContextPreparation,
}: CreateThreadActionParams): Promise<Thread | null> {
  if (!isConnected) {
    return createDemoThread(initialPrompt);
  }

  try {
    const threadCwd =
      workspaceCwd === undefined
        ? await resolveBackendCwd()
        : workspaceCwd?.trim() || undefined;
    let thread: Thread | undefined;
    if (executionContextPreparation) {
      const response = await client?.startThreadWithExecutionContext?.(
        executionContextPreparation.workspaceKey,
        threadCwd || undefined,
        threadSource,
        threadSettings,
      );
      if (!response?.executionContext) {
        throw new Error("Thread execution context was not created");
      }
      try {
        await executionContextPreparation.afterStart(
          response.thread,
          response.executionContext,
        );
      } catch (error) {
        await client?.deleteThread?.(response.thread.id).catch(() => undefined);
        throw error;
      }
      thread = response.thread;
    } else {
      thread = await client?.startThread(
        threadCwd || undefined,
        threadSource,
        threadSettings,
      );
    }
    if (thread) {
      setThreads((current) => upsertThread(current, thread));
      setSelectedThreadId(thread.id);
      if (shouldAutoCloseSidebar()) {
        setSidebarOpen(false);
      }
      return thread;
    }
  } catch (error) {
    if (isAppServerConnectionLoss(error)) {
      preserveThreadsAfterConnectionLoss();
    }
    setNotice(threadCreateFailureNotice(error, locale));
    return null;
  }

  return null;
}

export async function sendMessageAction({
  activeTurnId,
  client,
  createThread,
  demoResponse,
  isConnected,
  isDemoPreview,
  isSending,
  locale,
  onExecutionIntentCommitted,
  pendingComposerMentions,
  preserveThreadsAfterConnectionLoss,
  selectedThread,
  selectedThreadId,
  setActiveTurnByThread,
  setComposerFocusSignal,
  setComposerValue,
  setIsSending,
  setNotice,
  setPendingComposerMentions,
  setSelectedThreadId,
  setThreads,
  text,
  images = [],
  threadSettings,
}: SendMessageActionParams): Promise<void> {
  if (isSending) {
    return;
  }

  const visibleMentions = visibleComposerMentionsForText(
    text,
    pendingComposerMentions,
  );
  setIsSending(true);
  let thread = isDemoPreview ? null : selectedThread;
  let failedThreadId = selectedThreadId;
  let createdThreadForMessage = false;

  try {
    if (activeTurnId && selectedThreadId && isConnected) {
      const response = await client?.steerTurn(
        selectedThreadId,
        text,
        visibleMentions,
      );
      setPendingComposerMentions([]);
      if (response?.turnId) {
        setActiveTurnByThread((current) =>
          activeTurnByThreadAfterTurnId(
            current,
            selectedThreadId,
            response.turnId,
          ),
        );
      }
      setNotice(threadGuidanceAppendedNotice(locale));
      return;
    }

    if (!thread) {
      thread = await createThread(text);
      createdThreadForMessage = true;
    }

    if (!thread) {
      return;
    }

    const activeThread = thread;

    if (!isConnected) {
      const now = Math.floor(Date.now() / 1000);
      const turn = createDemoTurn({ text, responseText: demoResponse });
      setThreads((current) =>
        appendTurnWithFallbackPreview(
          current,
          activeThread.id,
          turn,
          promptPreview(text),
          now,
        ),
      );
      return;
    }

    const resumedThread =
      activeThread.status.type === "notLoaded"
        ? await client?.resumeThread(activeThread.id)
        : activeThread;

    if (resumedThread) {
      setThreads((current) => upsertThread(current, resumedThread));
      setSelectedThreadId(resumedThread.id);
    }

    const turnThreadId = (resumedThread ?? activeThread).id;
    failedThreadId = turnThreadId;
    if (threadSettings && !createdThreadForMessage) {
      await client?.updateThreadSettings?.(turnThreadId, threadSettings);
    }
    if (
      threadSettings?.scene?.sceneId === "code" &&
      threadSettings.scene.mode === "review"
    ) {
      const response = await client?.startReview?.(turnThreadId, {
        type: "custom",
        instructions: text,
      });
      if (!response) {
        throw new Error("代码审查服务不可用");
      }
      setPendingComposerMentions([]);
      setThreads((current) =>
        upsertTurnInThread(current, response.reviewThreadId, response.turn),
      );
      setSelectedThreadId(response.reviewThreadId);
      setActiveTurnByThread((current) =>
        activeTurnByThreadAfterTurn(
          current,
          response.reviewThreadId,
          response.turn,
        ),
      );
      return;
    }
    const response = await client?.startTurn(
      turnThreadId,
      text,
      visibleMentions,
      threadSettings,
      images,
    );
    if (response) {
      const committedIntent = threadSettings?.executionIntent;
      if (committedIntent === "goal" || committedIntent === "plan") {
        onExecutionIntentCommitted?.(committedIntent);
      }
      setPendingComposerMentions([]);
      setThreads((current) =>
        upsertTurnInThread(current, turnThreadId, response.turn),
      );
      setActiveTurnByThread((current) =>
        activeTurnByThreadAfterTurn(current, turnThreadId, response.turn),
      );
      void refreshThreadAfterTurnStart({
        client,
        setActiveTurnByThread,
        setThreads,
        threadId: turnThreadId,
        turnId: response.turn.id,
      });
    }
  } catch (error) {
    setPendingComposerMentions([]);
    if (isConnected && isAppServerConnectionLoss(error)) {
      preserveThreadsAfterConnectionLoss();
    }
    setComposerValue(text);
    setComposerFocusSignal((signal) => signal + 1);
    const targetThreadId = failedThreadId;
    if (!activeTurnId && targetThreadId) {
      const now = Math.floor(Date.now() / 1000);
      const errorMessage =
        error instanceof Error
          ? error.message
          : locale === "zh"
            ? "发送到模型失败"
            : "Unable to reach the model";
      const failedTurn: Turn = {
        id: `local-failed-${now}`,
        items: [
          {
            id: `local-failed-user-${now}`,
            type: "userMessage",
            clientId: null,
            content: [{ type: "text", text, text_elements: [] }],
          },
        ],
        itemsView: "full",
        status: "failed",
        error: {
          message: errorMessage,
          codexErrorInfo: null,
          additionalDetails: null,
        },
        startedAt: now,
        completedAt: now,
        durationMs: null,
      };
      setThreads((current) =>
        appendTurnWithFallbackPreview(
          current,
          targetThreadId,
          failedTurn,
          promptPreview(text),
          now,
        ),
      );
    }
    setNotice(threadSendFailureNotice(error, locale));
  } finally {
    setIsSending(false);
  }
}

function isAppServerConnectionLoss(error: unknown): boolean {
  if (!(error instanceof Error) || error instanceof AppServerRpcError) {
    return false;
  }
  return (
    error.message === "App-server is not connected" ||
    error.message === "App-server connection closed" ||
    error.message.startsWith("Unable to connect to ")
  );
}

async function refreshThreadAfterTurnStart({
  client,
  setActiveTurnByThread,
  setThreads,
  threadId,
  turnId,
}: {
  client: Pick<ThreadMessageClient, "readThread"> | null | undefined;
  setActiveTurnByThread: ActiveTurnByThreadSetter;
  setThreads: ThreadListSetter;
  threadId: string;
  turnId: string;
}): Promise<void> {
  if (!client?.readThread) {
    return;
  }

  const delaysMs = [250, 500, 1000, 1500, 2500, 4000];
  for (const delayMs of delaysMs) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const thread = await client.readThread(threadId).catch(() => null);
    if (!thread) {
      continue;
    }

    setThreads((current) => upsertThread(current, thread));
    const turn = thread.turns.find((candidate) => candidate.id === turnId);
    if (turn && turn.status !== "inProgress") {
      setActiveTurnByThread((current) => removeRecordKey(current, threadId));
      return;
    }
  }
}

export async function interruptActiveTurnAction({
  activeTurnId,
  client,
  isConnected,
  locale,
  selectedThreadId,
  setActiveTurnByThread,
  setIsSending,
  setNotice,
  setThreads,
}: InterruptActiveTurnActionParams): Promise<void> {
  if (!selectedThreadId || !activeTurnId || !isConnected) {
    return;
  }

  setIsSending(true);
  try {
    await client?.interruptTurn(selectedThreadId, activeTurnId);
    setActiveTurnByThread((current) =>
      removeRecordKey(current, selectedThreadId),
    );
    setThreads((current) =>
      updateThreadInList(current, selectedThreadId, (thread) => ({
        ...thread,
        turns: thread.turns.map((turn) =>
          turn.id === activeTurnId && turn.status === "inProgress"
            ? { ...turn, status: "interrupted" }
            : turn,
        ),
      })),
    );
    const refreshedThread = await client
      ?.readThread?.(selectedThreadId)
      .catch(() => null);
    const refreshedTurn = refreshedThread?.turns.find(
      (turn) => turn.id === activeTurnId,
    );
    if (refreshedThread && refreshedTurn?.status !== "inProgress") {
      setThreads((current) => upsertThread(current, refreshedThread));
    }
    setNotice(threadInterruptRequestedNotice(locale));
  } catch (error) {
    setNotice(threadInterruptFailureNotice(error, locale));
  } finally {
    setIsSending(false);
  }
}
