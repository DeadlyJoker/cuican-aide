import type { Thread } from "@crewon-protocol/v2/Thread";
import type { TurnStartResponse } from "@crewon-protocol/v2/TurnStartResponse";

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
  upsertThread,
  upsertTurnInThread,
} from "./threadModel";
import {
  threadCreateFailureNotice,
  threadGuidanceAppendedNotice,
  threadInterruptFailureNotice,
  threadInterruptRequestedNotice,
  threadSendFailureNotice,
} from "./threadActionPresentation";
import { promptPreview } from "../shared/text";

type ThreadSource = string;
type ActiveTurnByThreadSetter = (
  updater: (current: Record<string, string>) => Record<string, string>,
) => void;
type ThreadListSetter = (updater: (current: Thread[]) => Thread[]) => void;

type ThreadMessageClient = {
  interruptTurn(threadId: string, turnId: string): Promise<unknown>;
  resumeThread(threadId: string): Promise<Thread>;
  startThread(cwd?: string, threadSource?: ThreadSource): Promise<Thread>;
  startTurn(
    threadId: string,
    text: string,
    mentions?: PendingComposerMention[],
  ): Promise<TurnStartResponse>;
  steerTurn(
    threadId: string,
    text: string,
    mentions?: PendingComposerMention[],
  ): Promise<{ turnId: string }>;
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
  client: Pick<ThreadMessageClient, "startThread"> | null | undefined;
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
  threadSource?: ThreadSource;
};

export type SendMessageActionParams = {
  activeTurnId: string | null;
  client:
    | Pick<ThreadMessageClient, "resumeThread" | "startTurn" | "steerTurn">
    | null
    | undefined;
  createThread: (initialPrompt?: string) => Promise<Thread | null>;
  demoResponse: string;
  isConnected: boolean;
  isDemoPreview: boolean;
  isSending: boolean;
  locale: Locale;
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
};

export type InterruptActiveTurnActionParams = {
  activeTurnId: string | null;
  client: Pick<ThreadMessageClient, "interruptTurn"> | null | undefined;
  isConnected: boolean;
  locale: Locale;
  selectedThreadId: string | null;
  setIsSending: (isSending: boolean) => void;
  setNotice: (notice: NoticeState | null) => void;
};

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
  threadSource = "app_server",
}: CreateThreadActionParams): Promise<Thread | null> {
  if (!isConnected) {
    return createDemoThread(initialPrompt);
  }

  try {
    const threadCwd = await resolveBackendCwd();
    const thread = await client?.startThread(threadCwd || undefined, threadSource);
    if (thread) {
      setThreads((current) => upsertThread(current, thread));
      setSelectedThreadId(thread.id);
      if (shouldAutoCloseSidebar()) {
        setSidebarOpen(false);
      }
      return thread;
    }
  } catch (error) {
    preserveThreadsAfterConnectionLoss();
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
}: SendMessageActionParams): Promise<void> {
  if (isSending) {
    return;
  }

  setIsSending(true);
  let thread = isDemoPreview ? null : selectedThread;

  try {
    if (activeTurnId && selectedThreadId && isConnected) {
      const response = await client?.steerTurn(
        selectedThreadId,
        text,
        pendingComposerMentions,
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
    const response = await client?.startTurn(
      turnThreadId,
      text,
      pendingComposerMentions,
    );
    if (response) {
      setPendingComposerMentions([]);
      setThreads((current) =>
        upsertTurnInThread(current, turnThreadId, response.turn),
      );
      setActiveTurnByThread((current) =>
        activeTurnByThreadAfterTurn(current, turnThreadId, response.turn),
      );
    }
  } catch (error) {
    setPendingComposerMentions([]);
    if (isConnected) {
      preserveThreadsAfterConnectionLoss();
    }
    setComposerValue(text);
    setComposerFocusSignal((signal) => signal + 1);
    setNotice(threadSendFailureNotice(error, locale));
  } finally {
    setIsSending(false);
  }
}

export async function interruptActiveTurnAction({
  activeTurnId,
  client,
  isConnected,
  locale,
  selectedThreadId,
  setIsSending,
  setNotice,
}: InterruptActiveTurnActionParams): Promise<void> {
  if (!selectedThreadId || !activeTurnId || !isConnected) {
    return;
  }

  setIsSending(true);
  try {
    await client?.interruptTurn(selectedThreadId, activeTurnId);
    setNotice(threadInterruptRequestedNotice(locale));
  } catch (error) {
    setNotice(threadInterruptFailureNotice(error, locale));
  } finally {
    setIsSending(false);
  }
}
