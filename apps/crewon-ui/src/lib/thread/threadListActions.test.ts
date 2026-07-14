import type { Thread } from "@crewon-protocol/v2/Thread";
import { describe, expect, it } from "vitest";

import type { AppView } from "../shared/appView";
import type { NoticeState } from "../shared/noticeState";
import {
  archiveThreadAction,
  deleteArchivedThreadAction,
  renameThreadAction,
  selectThreadAction,
  startDraftThreadAction,
  toggleArchivedThreadsAction,
} from "./threadListActions";

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1",
    sessionId: "session-1",
    forkedFromId: null,
    parentThreadId: null,
    preview: "Preview",
    ephemeral: false,
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    status: { type: "idle" },
    path: null,
    cwd: "/workspace",
    clientVersion: "test",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
    ...overrides,
  };
}

function threadState(initialThreads: Thread[] = [thread()]) {
  let threads = initialThreads;
  let selectedThreadId: string | null = initialThreads[0]?.id ?? null;
  let notice: NoticeState | null = null;
  return {
    get notice() {
      return notice;
    },
    get selectedThreadId() {
      return selectedThreadId;
    },
    get threads() {
      return threads;
    },
    setNotice: (nextNotice: NoticeState | null) => {
      notice = nextNotice;
    },
    setSelectedThreadId: (
      updater: string | null | ((currentThreadId: string | null) => string | null),
    ) => {
      selectedThreadId =
        typeof updater === "function" ? updater(selectedThreadId) : updater;
    },
    setThreads: (updater: (currentThreads: Thread[]) => Thread[]) => {
      threads = updater(threads);
    },
  };
}

describe("thread list actions", () => {
  it("selects a thread and refreshes it from the backend", async () => {
    const state = threadState();
    let appView: AppView = "library";
    let inspectorOpen = true;
    let sidebarOpen = true;

    await selectThreadAction({
      client: {
        async readThread(threadId) {
          return thread({ id: threadId, updatedAt: 2 });
        },
      },
      isConnected: true,
      locale: "en",
      preserveThreadsAfterConnectionLoss: () => {},
      restoreThread: async (restoredThread) => ({
        ...restoredThread,
        name: "Restored",
      }),
      setAppView: (view) => {
        appView = view;
      },
      setInspectorOpen: (open) => {
        inspectorOpen = open;
      },
      setNotice: state.setNotice,
      setSelectedThreadId: state.setSelectedThreadId,
      setSidebarOpen: (open) => {
        sidebarOpen = open;
      },
      setThreads: state.setThreads,
      shouldAutoCloseSidebar: () => true,
      threadId: "thread-1",
    });

    expect(appView).toBe("chat");
    expect(inspectorOpen).toBe(false);
    expect(sidebarOpen).toBe(false);
    expect(state.selectedThreadId).toBe("thread-1");
    expect(state.threads[0]?.updatedAt).toBe(2);
    expect(state.threads[0]?.name).toBe("Restored");
  });

  it("preserves local threads when selecting fails", async () => {
    const state = threadState();
    let preserved = false;

    await selectThreadAction({
      client: {
        async readThread() {
          throw new Error("offline");
        },
      },
      isConnected: true,
      locale: "en",
      preserveThreadsAfterConnectionLoss: () => {
        preserved = true;
      },
      setAppView: () => {},
      setInspectorOpen: () => {},
      setNotice: state.setNotice,
      setSelectedThreadId: state.setSelectedThreadId,
      setSidebarOpen: () => {},
      setThreads: state.setThreads,
      shouldAutoCloseSidebar: () => false,
      threadId: "thread-1",
    });

    expect(preserved).toBe(true);
    expect(state.notice).toEqual({
      text: "offline",
      tone: "warning",
    });
  });

  it("starts a draft thread locally", () => {
    let appView: AppView = "settings";
    let composerValue = "old";
    let focusSignal = 1;
    let inspectorOpen = true;
    let mentionCount = 1;
    let selectedThreadId: string | null = "thread-1";
    let sidebarOpen = true;

    startDraftThreadAction({
      setAppView: (view) => {
        appView = view;
      },
      setComposerFocusSignal: (updater) => {
        focusSignal = updater(focusSignal);
      },
      setComposerValue: (value) => {
        composerValue = value;
      },
      setInspectorOpen: (open) => {
        inspectorOpen = open;
      },
      setPendingComposerMentions: (mentions) => {
        mentionCount = mentions.length;
      },
      setSelectedThreadId: (nextThreadId) => {
        selectedThreadId =
          typeof nextThreadId === "function"
            ? nextThreadId(selectedThreadId)
            : nextThreadId;
      },
      setSidebarOpen: (open) => {
        sidebarOpen = open;
      },
      shouldAutoCloseSidebar: () => true,
    });

    expect(appView).toBe("chat");
    expect(composerValue).toBe("");
    expect(focusSignal).toBe(2);
    expect(inspectorOpen).toBe(false);
    expect(mentionCount).toBe(0);
    expect(selectedThreadId).toBeNull();
    expect(sidebarOpen).toBe(false);
  });

  it("toggles archived threads and selects the first returned thread", async () => {
    const state = threadState();
    let showArchived = false;
    let searchTerm = "old";
    const listed: boolean[] = [];

    const nextShowArchived = await toggleArchivedThreadsAction({
      client: {
        async listThreads(nextShowArchived) {
          listed.push(nextShowArchived);
          return [thread({ id: "archived-thread" })];
        },
      },
      isConnected: true,
      locale: "en",
      setNotice: state.setNotice,
      setSelectedThreadId: state.setSelectedThreadId,
      setShowArchivedThreads: (nextValue) => {
        showArchived = nextValue;
      },
      setThreadSearchTerm: (term) => {
        searchTerm = term;
      },
      setThreads: state.setThreads,
      showArchivedThreads: showArchived,
    });

    expect(nextShowArchived).toBe(true);
    expect(showArchived).toBe(true);
    expect(searchTerm).toBe("");
    expect(listed).toEqual([true]);
    expect(state.threads.map((item) => item.id)).toEqual(["archived-thread"]);
    expect(state.selectedThreadId).toBe("archived-thread");
  });

  it("archives a connected thread and reloads the current list", async () => {
    const state = threadState([thread(), thread({ id: "thread-2" })]);
    const archived: string[] = [];

    await archiveThreadAction({
      client: {
        async archiveThread(threadId) {
          archived.push(threadId);
        },
        async listThreads(showArchived) {
          expect(showArchived).toBe(false);
          return [thread({ id: "thread-2" })];
        },
        async unarchiveThread() {},
      },
      isConnected: true,
      locale: "en",
      setNotice: state.setNotice,
      setSelectedThreadId: state.setSelectedThreadId,
      setThreads: state.setThreads,
      showArchivedThreads: false,
      thread: thread(),
    });

    expect(archived).toEqual(["thread-1"]);
    expect(state.threads.map((item) => item.id)).toEqual(["thread-2"]);
    expect(state.selectedThreadId).toBe("thread-2");
  });

  it("removes a thread locally when archiving while disconnected", async () => {
    const state = threadState([thread(), thread({ id: "thread-2" })]);

    await archiveThreadAction({
      client: null,
      isConnected: false,
      locale: "en",
      setNotice: state.setNotice,
      setSelectedThreadId: state.setSelectedThreadId,
      setThreads: state.setThreads,
      showArchivedThreads: false,
      thread: thread(),
    });

    expect(state.threads.map((item) => item.id)).toEqual(["thread-2"]);
    expect(state.selectedThreadId).toBeNull();
  });

  it("deletes a confirmed archived thread", async () => {
    const state = threadState([thread(), thread({ id: "thread-2" })]);
    const deleted: string[] = [];

    await deleteArchivedThreadAction({
      client: {
        async deleteThread(threadId) {
          deleted.push(threadId);
        },
        async listThreads() {
          return [thread({ id: "thread-2" })];
        },
      },
      confirm: () => true,
      isConnected: true,
      locale: "en",
      setNotice: state.setNotice,
      setSelectedThreadId: state.setSelectedThreadId,
      setThreads: state.setThreads,
      showArchivedThreads: true,
      thread: thread({ name: "Old Thread" }),
      untitledThreadLabel: "Untitled",
    });

    expect(deleted).toEqual(["thread-1"]);
    expect(state.threads.map((item) => item.id)).toEqual(["thread-2"]);
    expect(state.notice).toEqual({
      text: "Deleted session: Old Thread",
      tone: "success",
    });
  });

  it("does not delete when confirmation is rejected", async () => {
    const state = threadState();
    let deleted = false;

    await deleteArchivedThreadAction({
      client: {
        async deleteThread() {
          deleted = true;
        },
        async listThreads() {
          return [];
        },
      },
      confirm: () => false,
      isConnected: true,
      locale: "en",
      setNotice: state.setNotice,
      setSelectedThreadId: state.setSelectedThreadId,
      setThreads: state.setThreads,
      showArchivedThreads: true,
      thread: thread(),
      untitledThreadLabel: "Untitled",
    });

    expect(deleted).toBe(false);
    expect(state.threads).toEqual([thread()]);
  });

  it("renames a connected thread", async () => {
    const state = threadState([thread({ name: "Old" })]);
    const renamed: Array<{ name: string; threadId: string }> = [];

    await renameThreadAction({
      client: {
        async renameThread(threadId, name) {
          renamed.push({ name, threadId });
        },
      },
      isConnected: true,
      locale: "en",
      prompt: () => "New name",
      setNotice: state.setNotice,
      setThreads: state.setThreads,
      thread: thread({ name: "Old" }),
      untitledThreadLabel: "Untitled",
    });

    expect(renamed).toEqual([{ name: "New name", threadId: "thread-1" }]);
    expect(state.threads[0]?.name).toBe("New name");
  });
});
