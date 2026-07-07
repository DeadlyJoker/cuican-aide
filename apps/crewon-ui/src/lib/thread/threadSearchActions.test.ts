import type { Thread } from "@crewon-protocol/v2/Thread";
import type { Turn } from "@crewon-protocol/v2/Turn";
import { describe, expect, it, vi } from "vitest";

import type { NoticeState } from "../shared/noticeState";
import { runThreadSearchEffectAction } from "./threadSearchActions";

function turn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: "turn-1",
    items: [],
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
    ...overrides,
  };
}

function thread(id: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id,
    sessionId: `${id}-session`,
    forkedFromId: null,
    parentThreadId: null,
    preview: id,
    ephemeral: false,
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    status: { type: "notLoaded" },
    path: null,
    cwd: "/repo",
    clientVersion: "test",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: id,
    turns: [],
    ...overrides,
  };
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
}

function state() {
  let selectedThreadId: string | null = "thread-1";
  return {
    isSearchingValues: [] as boolean[],
    notices: [] as Array<NoticeState | null>,
    selectedThreadId: () => selectedThreadId,
    setIsSearchingThreads(isSearching: boolean) {
      this.isSearchingValues.push(isSearching);
    },
    setNotice(notice: NoticeState | null) {
      this.notices.push(notice);
    },
    setSelectedThreadId(updater: (currentThreadId: string | null) => string | null) {
      selectedThreadId = updater(selectedThreadId);
    },
    setThreads(updater: (currentThreads: Thread[]) => Thread[]) {
      this.threads = updater(this.threads);
    },
    threads: [] as Thread[],
  };
}

describe("thread search actions", () => {
  it("uses demo threads in demo preview mode", () => {
    const captured = state();
    const showDemoThreads = vi.fn();

    const cleanup = runThreadSearchEffectAction({
      clearTimeout: () => {},
      client: null,
      currentRequestId: () => 1,
      isConnected: false,
      isDemoPreview: true,
      locale: "en",
      requestId: 1,
      searchTerm: "query",
      setIsSearchingThreads: captured.setIsSearchingThreads.bind(captured),
      setNotice: captured.setNotice.bind(captured),
      setSelectedThreadId: captured.setSelectedThreadId,
      setThreads: captured.setThreads.bind(captured),
      setTimeout,
      showArchivedThreads: false,
      showDemoThreads,
    });

    expect(cleanup).toBeUndefined();
    expect(captured.isSearchingValues).toEqual([false]);
    expect(showDemoThreads).toHaveBeenCalledOnce();
  });

  it("lists threads immediately when search is empty", async () => {
    const captured = state();

    runThreadSearchEffectAction({
      clearTimeout: () => {},
      client: {
        async listThreads(showArchived) {
          expect(showArchived).toBe(true);
          return [thread("thread-2")];
        },
        async searchThreads() {
          return [];
        },
      },
      currentRequestId: () => 2,
      isConnected: true,
      isDemoPreview: false,
      locale: "en",
      requestId: 2,
      searchTerm: "   ",
      setIsSearchingThreads: captured.setIsSearchingThreads.bind(captured),
      setNotice: captured.setNotice.bind(captured),
      setSelectedThreadId: captured.setSelectedThreadId,
      setThreads: captured.setThreads.bind(captured),
      setTimeout,
      showArchivedThreads: true,
      showDemoThreads: () => {},
    });
    await flushAsyncWork();

    expect(captured.threads.map((item) => item.id)).toEqual(["thread-2"]);
    expect(captured.selectedThreadId()).toBe("thread-2");
    expect(captured.isSearchingValues).toEqual([true, false]);
  });

  it("preserves loaded turns when empty search refreshes summary threads", async () => {
    const captured = state();
    const loadedTurn = turn();
    captured.threads = [thread("thread-1", { turns: [loadedTurn] })];

    runThreadSearchEffectAction({
      clearTimeout: () => {},
      client: {
        async listThreads() {
          return [thread("thread-1", { preview: "new summary" })];
        },
        async searchThreads() {
          return [];
        },
      },
      currentRequestId: () => 6,
      isConnected: true,
      isDemoPreview: false,
      locale: "en",
      requestId: 6,
      searchTerm: "",
      setIsSearchingThreads: captured.setIsSearchingThreads.bind(captured),
      setNotice: captured.setNotice.bind(captured),
      setSelectedThreadId: captured.setSelectedThreadId,
      setThreads: captured.setThreads.bind(captured),
      setTimeout,
      showArchivedThreads: false,
      showDemoThreads: () => {},
    });
    await flushAsyncWork();

    expect(captured.threads).toEqual([
      thread("thread-1", {
        preview: "new summary",
        turns: [loadedTurn],
      }),
    ]);
  });

  it("debounces searched threads and returns a cleanup", async () => {
    const captured = state();
    const timeoutHandlers: Array<() => void> = [];
    const clearTimeoutSpy = vi.fn();

    const cleanup = runThreadSearchEffectAction({
      clearTimeout: clearTimeoutSpy,
      client: {
        async listThreads() {
          return [];
        },
        async searchThreads(searchTerm, showArchived) {
          expect(searchTerm).toBe("demo");
          expect(showArchived).toBe(false);
          return [thread("search-result")];
        },
      },
      currentRequestId: () => 3,
      isConnected: true,
      isDemoPreview: false,
      locale: "en",
      requestId: 3,
      searchTerm: " demo ",
      setIsSearchingThreads: captured.setIsSearchingThreads.bind(captured),
      setNotice: captured.setNotice.bind(captured),
      setSelectedThreadId: captured.setSelectedThreadId,
      setThreads: captured.setThreads.bind(captured),
      setTimeout: (handler) => {
        timeoutHandlers.push(handler);
        return 10 as ReturnType<typeof setTimeout>;
      },
      showArchivedThreads: false,
      showDemoThreads: () => {},
    });

    expect(typeof cleanup).toBe("function");
    cleanup?.();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(10);

    timeoutHandlers[0]?.();
    await flushAsyncWork();
    expect(captured.threads.map((item) => item.id)).toEqual(["search-result"]);
  });

  it("ignores stale responses", async () => {
    const captured = state();

    runThreadSearchEffectAction({
      clearTimeout: () => {},
      client: {
        async listThreads() {
          return [thread("stale")];
        },
        async searchThreads() {
          return [];
        },
      },
      currentRequestId: () => 99,
      isConnected: true,
      isDemoPreview: false,
      locale: "en",
      requestId: 4,
      searchTerm: "",
      setIsSearchingThreads: captured.setIsSearchingThreads.bind(captured),
      setNotice: captured.setNotice.bind(captured),
      setSelectedThreadId: captured.setSelectedThreadId,
      setThreads: captured.setThreads.bind(captured),
      setTimeout,
      showArchivedThreads: false,
      showDemoThreads: () => {},
    });
    await flushAsyncWork();

    expect(captured.threads).toEqual([]);
    expect(captured.isSearchingValues).toEqual([true]);
  });

  it("surfaces current request failures", async () => {
    const captured = state();

    runThreadSearchEffectAction({
      clearTimeout: () => {},
      client: {
        async listThreads() {
          throw new Error("offline");
        },
        async searchThreads() {
          return [];
        },
      },
      currentRequestId: () => 5,
      isConnected: true,
      isDemoPreview: false,
      locale: "en",
      requestId: 5,
      searchTerm: "",
      setIsSearchingThreads: captured.setIsSearchingThreads.bind(captured),
      setNotice: captured.setNotice.bind(captured),
      setSelectedThreadId: captured.setSelectedThreadId,
      setThreads: captured.setThreads.bind(captured),
      setTimeout,
      showArchivedThreads: false,
      showDemoThreads: () => {},
    });
    await flushAsyncWork();

    expect(captured.notices[0]).toEqual({
      text: "offline",
      tone: "warning",
    });
    expect(captured.isSearchingValues).toEqual([true, false]);
  });
});
