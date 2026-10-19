import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { ThreadSelectionRead } from "./useThreadSelectionRead";

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
  assistantThreadClearConfirmMessage,
  assistantThreadClearFailureNotice,
  assistantThreadClearedNotice,
  assistantThreadClearUnavailableNotice,
  threadArchiveFailureNotice,
  threadDeleteArchivedConfirmMessage,
  threadDeletedNotice,
  threadDeleteFailureNotice,
  threadListFailureNotice,
  threadReadPreservedFailureNotice,
  threadRenameFailureNotice,
  threadRenamePromptLabel,
  workspaceArchiveConfirmMessage,
  workspaceArchiveFailureNotice,
  workspaceArchivedNotice,
  workspaceDeleteConfirmMessage,
  workspaceDeleteFailureNotice,
  workspaceDeletedNotice,
} from "./threadActionPresentation";

type ThreadListClient = {
  readonly managesThreadList?: boolean;
  archiveThread(threadId: string): Promise<unknown>;
  deleteThread(threadId: string): Promise<unknown>;
  listThreads(showArchived: boolean): Promise<Thread[]>;
  readThread(
    threadId: string,
    options?: { signal?: AbortSignal },
  ): Promise<Thread>;
  renameThread(threadId: string, name: string): Promise<unknown>;
  unarchiveThread(threadId: string): Promise<unknown>;
};

type ThreadListClientSlice<K extends keyof ThreadListClient> = Pick<
  ThreadListClient,
  K | "managesThreadList"
>;

type ThreadListSetter = (updater: (current: Thread[]) => Thread[]) => void;
type SelectedThreadSetter = (
  updater: string | null | ((currentThreadId: string | null) => string | null),
) => void;

export type SelectThreadActionParams = {
  runSelectionRead?: ThreadSelectionRead;
  client: ThreadListClientSlice<"readThread"> | null | undefined;
  isConnected: boolean;
  locale: Locale;
  preserveThreadsAfterConnectionLoss: () => void;
  restoreThread?: (thread: Thread) => Promise<Thread>;
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
  client: ThreadListClientSlice<"listThreads"> | null | undefined;
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
    | ThreadListClientSlice<"archiveThread" | "listThreads" | "unarchiveThread">
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
    | ThreadListClientSlice<"deleteThread" | "listThreads">
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

export type ClearAssistantThreadActionParams = {
  client:
    | ThreadListClientSlice<"deleteThread" | "listThreads">
    | null
    | undefined;
  confirm: ConfirmHandler;
  isConnected: boolean;
  locale: Locale;
  setNotice: (notice: NoticeState | null) => void;
  setSelectedThreadId: SelectedThreadSetter;
  setThreads: ThreadListSetter;
  thread: Thread;
};

export type RenameThreadActionParams = {
  client: ThreadListClientSlice<"renameThread"> | null | undefined;
  isConnected: boolean;
  locale: Locale;
  prompt: (message: string, defaultValue: string) => string | null;
  setNotice: (notice: NoticeState | null) => void;
  setThreads: ThreadListSetter;
  thread: Thread;
  untitledThreadLabel: string;
};

export async function selectThreadAction({
  runSelectionRead,
  client,
  isConnected,
  locale,
  preserveThreadsAfterConnectionLoss,
  restoreThread,
  setAppView,
  setInspectorOpen,
  setNotice,
  setSelectedThreadId,
  setSidebarOpen,
  setThreads,
  shouldAutoCloseSidebar,
  threadId,
}: SelectThreadActionParams): Promise<Thread | null> {
  setAppView("chat");
  setSelectedThreadId(threadId);
  setInspectorOpen(false);
  if (shouldAutoCloseSidebar()) {
    setSidebarOpen(false);
  }

  if (!isConnected) {
    return null;
  }

  let readSignal: AbortSignal | undefined;
  try {
    const load = async (signal?: AbortSignal) => {
      readSignal = signal;
      signal?.throwIfAborted();
      const thread = signal
        ? await client?.readThread(threadId, { signal })
        : await client?.readThread(threadId);
      signal?.throwIfAborted();
      if (!thread) return null;
      const restoredThread = restoreThread
        ? await restoreThread(thread).catch(() => thread)
        : thread;
      signal?.throwIfAborted();
      setThreads((current) => upsertThread(current, restoredThread));
      return restoredThread;
    };
    return await (runSelectionRead ? runSelectionRead(threadId, load) : load());
  } catch (error) {
    if (
      (readSignal?.aborted && readSignal.reason === error) ||
      // A newer Runtime read owns canonical publication. The retired selection
      // must neither overwrite it nor report a connection failure.
      (error instanceof Error &&
        error.message === "control_thread_projection_superseded") ||
      (!readSignal && error instanceof Error && error.name === "AbortError")
    )
      return null;
    preserveThreadsAfterConnectionLoss();
    setNotice(threadReadPreservedFailureNotice(error, locale));
  }
  return null;
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
  if (!client?.managesThreadList) setThreads(() => []);

  if (!isConnected || client?.managesThreadList) {
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
    if (client?.managesThreadList) {
      setSelectedThreadId((current) =>
        current === thread.id ? null : current,
      );
      return;
    }
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
    if (client?.managesThreadList) {
      setSelectedThreadId((current) =>
        current === thread.id ? null : current,
      );
      setNotice(threadDeletedNotice(title, locale));
      return;
    }
    setThreads(() => serverThreads ?? []);
    setSelectedThreadId((currentThreadId) =>
      selectedThreadIdAfterThreadList(currentThreadId, serverThreads),
    );
    setNotice(threadDeletedNotice(title, locale));
  } catch (error) {
    setNotice(threadDeleteFailureNotice(error, locale));
  }
}

export async function clearAssistantThreadAction({
  client,
  confirm,
  isConnected,
  locale,
  setNotice,
  setSelectedThreadId,
  setThreads,
  thread,
}: ClearAssistantThreadActionParams): Promise<void> {
  if (!isConnected || !client) {
    setNotice(assistantThreadClearUnavailableNotice(locale));
    return;
  }

  if (!(await confirm(assistantThreadClearConfirmMessage(locale)))) {
    return;
  }

  try {
    await client.deleteThread(thread.id);
    const serverThreads = await client.listThreads(false);
    if (client?.managesThreadList) {
      setSelectedThreadId((current) =>
        current === thread.id ? null : current,
      );
      setNotice(assistantThreadClearedNotice(locale));
      return;
    }
    setThreads(() => serverThreads);
    setSelectedThreadId((currentThreadId) =>
      selectedThreadIdAfterThreadList(currentThreadId, serverThreads),
    );
    setNotice(assistantThreadClearedNotice(locale));
  } catch (error) {
    setNotice(assistantThreadClearFailureNotice(error, locale));
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

export type ArchiveWorkspaceThreadsActionParams = {
  client:
    | ThreadListClientSlice<"archiveThread" | "listThreads" | "unarchiveThread">
    | null
    | undefined;
  confirm: ConfirmHandler;
  isConnected: boolean;
  locale: Locale;
  setNotice: (notice: NoticeState | null) => void;
  setSelectedThreadId: SelectedThreadSetter;
  setThreads: ThreadListSetter;
  showArchivedThreads: boolean;
  threads: Thread[];
  workspaceName: string;
};

export type DeleteWorkspaceThreadsActionParams = {
  client:
    | ThreadListClientSlice<"deleteThread" | "listThreads">
    | null
    | undefined;
  confirm: ConfirmHandler;
  isConnected: boolean;
  locale: Locale;
  setNotice: (notice: NoticeState | null) => void;
  setSelectedThreadId: SelectedThreadSetter;
  setThreads: ThreadListSetter;
  showArchivedThreads: boolean;
  threads: Thread[];
  workspaceName: string;
};

export async function archiveWorkspaceThreadsAction({
  client,
  confirm,
  isConnected,
  locale,
  setNotice,
  setSelectedThreadId,
  setThreads,
  showArchivedThreads,
  threads,
  workspaceName,
}: ArchiveWorkspaceThreadsActionParams): Promise<void> {
  const count = threads.length;
  if (count === 0) {
    return;
  }

  if (
    !(await confirm(
      workspaceArchiveConfirmMessage(workspaceName, count, locale),
    ))
  ) {
    return;
  }

  if (!isConnected) {
    for (const thread of threads) {
      removeThreadLocally(thread.id, setSelectedThreadId, setThreads);
    }
    return;
  }

  try {
    const archiveMethod = showArchivedThreads
      ? "unarchiveThread"
      : "archiveThread";
    await Promise.all(
      threads.map((thread) => client?.[archiveMethod]?.(thread.id)),
    );

    const serverThreads = await client?.listThreads(showArchivedThreads);
    if (client?.managesThreadList) {
      const changed = new Set(threads.map((thread) => thread.id));
      setSelectedThreadId((current) =>
        current !== null && changed.has(current) ? null : current,
      );
      setNotice(workspaceArchivedNotice(workspaceName, count, locale));
      return;
    }
    setThreads(() => serverThreads ?? []);
    setSelectedThreadId((currentThreadId) =>
      selectedThreadIdAfterThreadList(currentThreadId, serverThreads),
    );
    setNotice(workspaceArchivedNotice(workspaceName, count, locale));
  } catch (error) {
    setNotice(workspaceArchiveFailureNotice(error, locale));
  }
}

export async function deleteWorkspaceThreadsAction({
  client,
  confirm,
  isConnected,
  locale,
  setNotice,
  setSelectedThreadId,
  setThreads,
  showArchivedThreads,
  threads,
  workspaceName,
}: DeleteWorkspaceThreadsActionParams): Promise<void> {
  const count = threads.length;
  if (count === 0) {
    return;
  }

  if (
    !(await confirm(
      workspaceDeleteConfirmMessage(workspaceName, count, locale),
    ))
  ) {
    return;
  }

  if (!isConnected) {
    for (const thread of threads) {
      removeThreadLocally(thread.id, setSelectedThreadId, setThreads);
    }
    return;
  }

  try {
    await Promise.all(threads.map((thread) => client?.deleteThread(thread.id)));

    const serverThreads = await client?.listThreads(showArchivedThreads);
    if (client?.managesThreadList) {
      const changed = new Set(threads.map((thread) => thread.id));
      setSelectedThreadId((current) =>
        current !== null && changed.has(current) ? null : current,
      );
      setNotice(workspaceDeletedNotice(workspaceName, count, locale));
      return;
    }
    setThreads(() => serverThreads ?? []);
    setSelectedThreadId((currentThreadId) =>
      selectedThreadIdAfterThreadList(currentThreadId, serverThreads),
    );
    setNotice(workspaceDeletedNotice(workspaceName, count, locale));
  } catch (error) {
    setNotice(workspaceDeleteFailureNotice(error, locale));
  }
}
