import type { Thread } from "@crewon-protocol/v2/Thread";

import type { AppView } from "../shared/appView";
import type { PendingComposerMention } from "../shared/composerMentions";
import type { Locale } from "../i18n";
import type { ConnectionState } from "../shared/connectionState";
import type { NoticeState } from "../shared/noticeState";
import type { ConfirmHandler } from "../shared/confirmHandler";
import {
  removeThreadFromList,
  selectedThreadIdAfterThreadList,
  selectedThreadIdAfterThreadRemoval,
  threadTitle,
  updateThreadName,
  upsertThread,
} from "./threadModel";
import {
  threadArchiveFailureNotice,
  threadDeleteArchivedConfirmMessage,
  threadDeletedNotice,
  threadDeleteFailureNotice,
  threadListFailureNotice,
  threadReadPreservedFailureNotice,
  threadRenameFailureNotice,
  threadRenamePromptLabel,
} from "./threadActionPresentation";

type ThreadListClient = {
  archiveThread(threadId: string): Promise<unknown>;
  deleteThread(threadId: string): Promise<unknown>;
  listThreads(showArchived: boolean): Promise<Thread[]>;
  readThread(threadId: string): Promise<Thread>;
  renameThread(threadId: string, name: string): Promise<unknown>;
  unarchiveThread(threadId: string): Promise<unknown>;
};

type ThreadListSetter = (updater: (current: Thread[]) => Thread[]) => void;
type SelectedThreadSetter = (
  updater: string | null | ((currentThreadId: string | null) => string | null),
) => void;

export type SelectThreadActionParams = {
  client: Pick<ThreadListClient, "readThread"> | null | undefined;
  isConnected: boolean;
  locale: Locale;
  preserveThreadsAfterConnectionLoss: () => void;
  setAppView: (view: AppView) => void;
  setInspectorOpen: (open: boolean) => void;
  setNotice: (notice: NoticeState | null) => void;
  setSelectedThreadId: SelectedThreadSetter;
  setSidebarOpen: (open: boolean) => void;
  setThreads: ThreadListSetter;
  shouldAutoCloseSidebar: () => boolean;
  threadId: string;
};

export type StartDraftThreadActionParams = {
  setAppView: (view: AppView) => void;
  setComposerFocusSignal: (updater: (signal: number) => number) => void;
  setComposerValue: (value: string) => void;
  setInspectorOpen: (open: boolean) => void;
  setPendingComposerMentions: (mentions: PendingComposerMention[]) => void;
  setSelectedThreadId: SelectedThreadSetter;
  setSidebarOpen: (open: boolean) => void;
  shouldAutoCloseSidebar: () => boolean;
};

export type ToggleArchivedThreadsActionParams = {
  client: Pick<ThreadListClient, "listThreads"> | null | undefined;
  isConnected: boolean;
  locale: Locale;
  setNotice: (notice: NoticeState | null) => void;
  setSelectedThreadId: SelectedThreadSetter;
  setShowArchivedThreads: (showArchived: boolean) => void;
  setThreadSearchTerm: (term: string) => void;
  setThreads: ThreadListSetter;
  showArchivedThreads: boolean;
};

export type ArchiveThreadActionParams = {
  client:
    | Pick<ThreadListClient, "archiveThread" | "listThreads" | "unarchiveThread">
    | null
    | undefined;
  isConnected: boolean;
  locale: Locale;
  setNotice: (notice: NoticeState | null) => void;
  setSelectedThreadId: SelectedThreadSetter;
  setThreads: ThreadListSetter;
  showArchivedThreads: boolean;
  thread: Thread;
};

export type DeleteArchivedThreadActionParams = {
  client:
    | Pick<ThreadListClient, "deleteThread" | "listThreads">
    | null
    | undefined;
  confirm: ConfirmHandler;
  isConnected: boolean;
  locale: Locale;
  setNotice: (notice: NoticeState | null) => void;
  setSelectedThreadId: SelectedThreadSetter;
  setThreads: ThreadListSetter;
  showArchivedThreads: boolean;
  thread: Thread;
  untitledThreadLabel: string;
};

export type RenameThreadActionParams = {
  client: Pick<ThreadListClient, "renameThread"> | null | undefined;
  isConnected: boolean;
  locale: Locale;
  prompt: (message: string, defaultValue: string) => string | null;
  setNotice: (notice: NoticeState | null) => void;
  setThreads: ThreadListSetter;
  thread: Thread;
  untitledThreadLabel: string;
};

export async function selectThreadAction({
  client,
  isConnected,
  locale,
  preserveThreadsAfterConnectionLoss,
  setAppView,
  setInspectorOpen,
  setNotice,
  setSelectedThreadId,
  setSidebarOpen,
  setThreads,
  shouldAutoCloseSidebar,
  threadId,
}: SelectThreadActionParams): Promise<void> {
  setAppView("chat");
  setSelectedThreadId(threadId);
  setInspectorOpen(false);
  if (shouldAutoCloseSidebar()) {
    setSidebarOpen(false);
  }

  if (!isConnected) {
    return;
  }

  try {
    const thread = await client?.readThread(threadId);
    if (thread) {
      setThreads((current) => upsertThread(current, thread));
    }
  } catch (error) {
    preserveThreadsAfterConnectionLoss();
    setNotice(threadReadPreservedFailureNotice(error, locale));
  }
}

export function startDraftThreadAction({
  setAppView,
  setComposerFocusSignal,
  setComposerValue,
  setInspectorOpen,
  setPendingComposerMentions,
  setSelectedThreadId,
  setSidebarOpen,
  shouldAutoCloseSidebar,
}: StartDraftThreadActionParams): void {
  setAppView("chat");
  setSelectedThreadId(null);
  setInspectorOpen(false);
  setComposerValue("");
  setPendingComposerMentions([]);
  setComposerFocusSignal((signal) => signal + 1);
  if (shouldAutoCloseSidebar()) {
    setSidebarOpen(false);
  }
}

export async function toggleArchivedThreadsAction({
  client,
  isConnected,
  locale,
  setNotice,
  setSelectedThreadId,
  setShowArchivedThreads,
  setThreadSearchTerm,
  setThreads,
  showArchivedThreads,
}: ToggleArchivedThreadsActionParams): Promise<boolean> {
  const nextShowArchived = !showArchivedThreads;
  setShowArchivedThreads(nextShowArchived);
  setSelectedThreadId(null);
  setThreadSearchTerm("");
  setThreads(() => []);

  if (!isConnected) {
    return nextShowArchived;
  }

  try {
    const serverThreads = await client?.listThreads(nextShowArchived);
    setThreads(() => serverThreads ?? []);
    setSelectedThreadId(serverThreads?.[0]?.id ?? null);
  } catch (error) {
    setNotice(threadListFailureNotice(error, locale));
  }

  return nextShowArchived;
}

export async function archiveThreadAction({
  client,
  isConnected,
  locale,
  setNotice,
  setSelectedThreadId,
  setThreads,
  showArchivedThreads,
  thread,
}: ArchiveThreadActionParams): Promise<void> {
  if (!isConnected) {
    removeThreadLocally(thread.id, setSelectedThreadId, setThreads);
    return;
  }

  try {
    if (showArchivedThreads) {
      await client?.unarchiveThread(thread.id);
    } else {
      await client?.archiveThread(thread.id);
    }

    const serverThreads = await client?.listThreads(showArchivedThreads);
    setThreads(() => serverThreads ?? []);
    setSelectedThreadId((currentThreadId) =>
      selectedThreadIdAfterThreadList(currentThreadId, serverThreads),
    );
  } catch (error) {
    setNotice(threadArchiveFailureNotice(error, locale));
  }
}

export async function deleteArchivedThreadAction({
  client,
  confirm,
  isConnected,
  locale,
  setNotice,
  setSelectedThreadId,
  setThreads,
  showArchivedThreads,
  thread,
  untitledThreadLabel,
}: DeleteArchivedThreadActionParams): Promise<void> {
  const title = threadTitle(thread, untitledThreadLabel);
  if (!(await confirm(threadDeleteArchivedConfirmMessage(title, locale)))) {
    return;
  }

  if (!isConnected) {
    removeThreadLocally(thread.id, setSelectedThreadId, setThreads);
    return;
  }

  try {
    await client?.deleteThread(thread.id);
    const serverThreads = await client?.listThreads(showArchivedThreads);
    setThreads(() => serverThreads ?? []);
    setSelectedThreadId((currentThreadId) =>
      selectedThreadIdAfterThreadList(currentThreadId, serverThreads),
    );
    setNotice(threadDeletedNotice(title, locale));
  } catch (error) {
    setNotice(threadDeleteFailureNotice(error, locale));
  }
}

export async function renameThreadAction({
  client,
  isConnected,
  locale,
  prompt,
  setNotice,
  setThreads,
  thread,
  untitledThreadLabel,
}: RenameThreadActionParams): Promise<void> {
  const currentName = threadTitle(thread, untitledThreadLabel);
  const nextName = prompt(threadRenamePromptLabel(locale), currentName)?.trim();

  if (!nextName || nextName === currentName) {
    return;
  }

  if (!isConnected) {
    setThreads((current) => updateThreadName(current, thread.id, nextName));
    return;
  }

  try {
    await client?.renameThread(thread.id, nextName);
    setThreads((current) => updateThreadName(current, thread.id, nextName));
  } catch (error) {
    setNotice(threadRenameFailureNotice(error, locale));
  }
}

function removeThreadLocally(
  threadId: string,
  setSelectedThreadId: SelectedThreadSetter,
  setThreads: ThreadListSetter,
) {
  setThreads((current) => removeThreadFromList(current, threadId));
  setSelectedThreadId((currentThreadId) =>
    selectedThreadIdAfterThreadRemoval(currentThreadId, threadId),
  );
}
