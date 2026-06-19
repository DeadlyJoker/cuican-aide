import type { Thread } from "@crewon-protocol/v2/Thread";
import { describe, expect, it, vi } from "vitest";

import {
  pollLoadedThreadIdsAction,
  preserveThreadsAfterConnectionLossAction,
  retryConnectionAction,
  runConnectionBootstrapEffectAction,
  showDemoThreadsAction,
  switchToDemoThreadsAction,
} from "./appConnectionActions";
import type { ConnectionState, NoticeState } from "./appRuntimeState";
import type { AccountStatus } from "./appStatusTypes";

function thread(id: string): Thread {
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
    cwd: "/tmp/project",
    clientVersion: "0.1.0",
    source: "appServer",
    threadSource: "app_server",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: id,
    turns: [],
  };
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
}

function accountStatus(): AccountStatus {
  return {
    account: null,
    requiresOpenaiAuth: false,
  };
}

type TestConnectionClient = {
  close(): void;
  connect(): Promise<unknown>;
  getAccount(): Promise<AccountStatus>;
  listThreads(showArchived: boolean): Promise<Thread[]>;
};

describe("app connection actions", () => {
  it("resets connection state when retrying", () => {
    let connectionState: ConnectionState = "demo";
    let notice: NoticeState | null = { text: "lost", tone: "warning" };
    let streamingTextByThread: Record<string, string> = { thread: "partial" };
    let connectionAttempt = 2;
    const client = { close: vi.fn() };

    retryConnectionAction({
      client,
      setConnectionAttempt: (updater) => {
        connectionAttempt = updater(connectionAttempt);
      },
      setConnectionState: (state) => {
        connectionState = state;
      },
      setNotice: (nextNotice) => {
        notice = nextNotice;
      },
      setStreamingTextByThread: (nextStreamingText) => {
        streamingTextByThread = nextStreamingText;
      },
    });

    expect(client.close).toHaveBeenCalledOnce();
    expect(connectionState).toBe("connecting");
    expect(notice).toBeNull();
    expect(streamingTextByThread).toEqual({});
    expect(connectionAttempt).toBe(3);
  });

  it("connects, loads threads, selects the first thread, and refreshes account status", async () => {
    const serverThreads = [thread("thread-1"), thread("thread-2")];
    const account = accountStatus();
    let connectionState: ConnectionState = "connecting";
    let notice: NoticeState | null = { text: "old", tone: "warning" };
    let selectedThreadId: string | null = null;
    let threads: Thread[] = [];
    let refreshedAccount: AccountStatus | null = null;
    let currentClient: TestConnectionClient | null = null;
    const listedArchived: boolean[] = [];

    runConnectionBootstrapEffectAction({
      createClient: () => ({
        close: vi.fn(),
        async connect() {},
        async getAccount() {
          return account;
        },
        async listThreads(showArchived) {
          listedArchived.push(showArchived);
          return serverThreads;
        },
      }),
      currentClient: () => currentClient,
      isDemoPreview: false,
      preserveThreadsAfterConnectionLoss: () => {},
      setAccountStatus: (status) => {
        refreshedAccount = status;
      },
      setClient: (client) => {
        currentClient = client;
      },
      setConnectionState: (state) => {
        connectionState = state;
      },
      setNotice: (nextNotice) => {
        notice = nextNotice;
      },
      setSelectedThreadId: (threadId) => {
        selectedThreadId = threadId;
      },
      setThreads: (nextThreads) => {
        threads = nextThreads;
      },
      showArchivedThreads: true,
      showDemoThreads: () => {},
      switchToDemoThreads: () => {},
    });
    await flushAsyncWork();
    await flushAsyncWork();

    expect(listedArchived).toEqual([true]);
    expect(connectionState).toBe("connected");
    expect(notice).toBeNull();
    expect(threads).toEqual(serverThreads);
    expect(selectedThreadId).toBe("thread-1");
    expect(refreshedAccount).toEqual(account);
  });

  it("keeps demo threads after a successful demo preview connection", async () => {
    const actions: string[] = [];

    runConnectionBootstrapEffectAction({
      createClient: () => ({
        close: vi.fn(),
        async connect() {},
        async getAccount() {
          return accountStatus();
        },
        async listThreads() {
          return [thread("server-thread")];
        },
      }),
      currentClient: () => null,
      isDemoPreview: true,
      preserveThreadsAfterConnectionLoss: () => {},
      setAccountStatus: () => {},
      setClient: () => {},
      setConnectionState: () => {
        actions.push("connected");
      },
      setNotice: () => {},
      setSelectedThreadId: () => {
        actions.push("selected-server-thread");
      },
      setThreads: () => {
        actions.push("set-server-threads");
      },
      showArchivedThreads: false,
      showDemoThreads: () => {
        actions.push("show-demo");
      },
      switchToDemoThreads: (showConnectionNotice = true) => {
        actions.push(`switch-demo:${showConnectionNotice}`);
      },
    });
    await flushAsyncWork();
    await flushAsyncWork();

    expect(actions).toEqual(["switch-demo:false", "connected", "show-demo"]);
  });

  it("falls back after connection failure", async () => {
    const fallbacks: Array<boolean | undefined> = [];

    runConnectionBootstrapEffectAction({
      createClient: () => ({
        close: vi.fn(),
        async connect() {
          throw new Error("offline");
        },
        async getAccount() {
          return accountStatus();
        },
        async listThreads() {
          return [];
        },
      }),
      currentClient: () => null,
      isDemoPreview: false,
      preserveThreadsAfterConnectionLoss: (showConnectionNotice) => {
        fallbacks.push(showConnectionNotice);
      },
      setAccountStatus: () => {},
      setClient: () => {},
      setConnectionState: () => {},
      setNotice: () => {},
      setSelectedThreadId: () => {},
      setThreads: () => {},
      showArchivedThreads: false,
      showDemoThreads: () => {},
      switchToDemoThreads: () => {},
    });
    await flushAsyncWork();

    expect(fallbacks).toEqual([true]);
  });

  it("closes the client and ignores connection results after cleanup", async () => {
    let resolveConnect: () => void = () => {};
    const close = vi.fn();
    const states: ConnectionState[] = [];

    const cleanup = runConnectionBootstrapEffectAction({
      createClient: () => ({
        close,
        connect() {
          return new Promise<void>((resolve) => {
            resolveConnect = resolve;
          });
        },
        async getAccount() {
          return accountStatus();
        },
        async listThreads() {
          return [thread("thread-1")];
        },
      }),
      currentClient: () => null,
      isDemoPreview: false,
      preserveThreadsAfterConnectionLoss: () => {},
      setAccountStatus: () => {},
      setClient: () => {},
      setConnectionState: (state) => {
        states.push(state);
      },
      setNotice: () => {},
      setSelectedThreadId: () => {},
      setThreads: () => {},
      showArchivedThreads: false,
      showDemoThreads: () => {},
      switchToDemoThreads: () => {},
    });

    cleanup();
    resolveConnect();
    await flushAsyncWork();
    await flushAsyncWork();

    expect(close).toHaveBeenCalledOnce();
    expect(states).toEqual([]);
  });

  it("ignores connection loss callbacks from stale clients", () => {
    let onConnectionLost: () => void = () => {};
    let currentClient: TestConnectionClient | null = null;
    let fallbackCount = 0;
    const staleClient: TestConnectionClient = {
      close: vi.fn(),
      async connect() {},
      async getAccount() {
        return accountStatus();
      },
      async listThreads() {
        return [];
      },
    };

    runConnectionBootstrapEffectAction({
      createClient: (callback) => {
        onConnectionLost = callback;
        return staleClient;
      },
      currentClient: () => currentClient,
      isDemoPreview: false,
      preserveThreadsAfterConnectionLoss: () => {
        fallbackCount += 1;
      },
      setAccountStatus: () => {},
      setClient: () => {
        currentClient = {
          ...staleClient,
          close: vi.fn(),
        };
      },
      setConnectionState: () => {},
      setNotice: () => {},
      setSelectedThreadId: () => {},
      setThreads: () => {},
      showArchivedThreads: false,
      showDemoThreads: () => {},
      switchToDemoThreads: () => {},
    });

    onConnectionLost();

    expect(fallbackCount).toBe(0);
  });

  it("clears loaded thread ids while disconnected", () => {
    let loadedThreadIds = ["thread-1"];

    const cleanup = pollLoadedThreadIdsAction({
      clearInterval: vi.fn(),
      client: null,
      isConnected: false,
      setInterval: vi.fn(),
      setLoadedThreadIds: (threadIds) => {
        loadedThreadIds = threadIds;
      },
    });

    expect(cleanup).toBeUndefined();
    expect(loadedThreadIds).toEqual([]);
  });

  it("refreshes loaded thread ids immediately and on an interval", async () => {
    const intervalHandlers: Array<() => void> = [];
    const clearInterval = vi.fn();
    const loadedThreadIds: string[][] = [];
    const responses = [["thread-1"], ["thread-1", "thread-2"]];

    const cleanup = pollLoadedThreadIdsAction({
      clearInterval,
      client: {
        async listLoadedThreadIds() {
          return responses.shift() ?? [];
        },
      },
      isConnected: true,
      setInterval: (handler) => {
        intervalHandlers.push(handler);
        return 20 as ReturnType<typeof setInterval>;
      },
      setLoadedThreadIds: (threadIds) => {
        loadedThreadIds.push(threadIds);
      },
    });

    await flushAsyncWork();
    intervalHandlers[0]?.();
    await flushAsyncWork();
    cleanup?.();

    expect(loadedThreadIds).toEqual([
      ["thread-1"],
      ["thread-1", "thread-2"],
    ]);
    expect(clearInterval).toHaveBeenCalledWith(20);
  });

  it("clears loaded thread ids when refresh fails", async () => {
    let loadedThreadIds = ["thread-1"];

    pollLoadedThreadIdsAction({
      clearInterval: vi.fn(),
      client: {
        async listLoadedThreadIds() {
          throw new Error("offline");
        },
      },
      isConnected: true,
      setInterval: vi.fn(),
      setLoadedThreadIds: (threadIds) => {
        loadedThreadIds = threadIds;
      },
    });
    await flushAsyncWork();

    expect(loadedThreadIds).toEqual([]);
  });

  it("ignores loaded thread refreshes after cleanup", async () => {
    let resolveThreadIds: (threadIds: string[]) => void = () => {};
    let loadedThreadIds = ["old"];

    const cleanup = pollLoadedThreadIdsAction({
      clearInterval: vi.fn(),
      client: {
        listLoadedThreadIds() {
          return new Promise<string[]>((resolve) => {
            resolveThreadIds = resolve;
          });
        },
      },
      isConnected: true,
      setInterval: vi.fn(),
      setLoadedThreadIds: (threadIds) => {
        loadedThreadIds = threadIds;
      },
    });

    cleanup?.();
    resolveThreadIds(["thread-1"]);
    await flushAsyncWork();

    expect(loadedThreadIds).toEqual(["old"]);
  });

  it("shows demo threads and selects the first thread", () => {
    const demoThreads = [thread("demo-1"), thread("demo-2")];
    let selectedThreadId: string | null = "old";
    let threads: Thread[] = [];
    let streamingTextByThread: Record<string, string> = { old: "partial" };

    showDemoThreadsAction({
      demoThreads,
      setSelectedThreadId: (threadId) => {
        selectedThreadId = threadId;
      },
      setStreamingTextByThread: (nextStreamingText) => {
        streamingTextByThread = nextStreamingText;
      },
      setThreads: (nextThreads) => {
        threads = nextThreads;
      },
    });

    expect(threads).toEqual(demoThreads);
    expect(selectedThreadId).toBe("demo-1");
    expect(streamingTextByThread).toEqual({});
  });

  it("switches to demo mode with an optional notice", () => {
    let connectionState: ConnectionState = "connecting";
    let notice: NoticeState | null = null;

    switchToDemoThreadsAction({
      connectionLostMessage: "Connection lost",
      demoThreads: [thread("demo-1")],
      setConnectionState: (state) => {
        connectionState = state;
      },
      setNotice: (nextNotice) => {
        notice = nextNotice;
      },
      setSelectedThreadId: () => {},
      setStreamingTextByThread: () => {},
      setThreads: () => {},
    });

    expect(connectionState).toBe("demo");
    expect(notice).toEqual({ text: "Connection lost", tone: "warning" });
  });

  it("preserves existing threads after connection loss", () => {
    let threads: Thread[] = [thread("existing")];
    let selectedThreadId: string | null = "existing";
    let streamingTextByThread: Record<string, string> = { existing: "partial" };

    preserveThreadsAfterConnectionLossAction({
      connectionLostMessage: "Connection lost",
      currentThreads: threads,
      demoThreads: [thread("demo-1")],
      setConnectionState: () => {},
      setNotice: () => {},
      setSelectedThreadId: (threadId) => {
        selectedThreadId = threadId;
      },
      setStreamingTextByThread: (nextStreamingText) => {
        streamingTextByThread = nextStreamingText;
      },
      setThreads: (nextThreads) => {
        threads = nextThreads;
      },
    });

    expect(threads).toEqual([thread("existing")]);
    expect(selectedThreadId).toBe("existing");
    expect(streamingTextByThread).toEqual({});
  });

  it("falls back to demo threads after connection loss with no threads", () => {
    let selectedThreadId: string | null = null;
    let threads: Thread[] = [];

    preserveThreadsAfterConnectionLossAction({
      connectionLostMessage: "Connection lost",
      currentThreads: threads,
      demoThreads: [thread("demo-1")],
      setConnectionState: () => {},
      setNotice: () => {},
      setSelectedThreadId: (threadId) => {
        selectedThreadId = threadId;
      },
      setStreamingTextByThread: () => {},
      setThreads: (nextThreads) => {
        threads = nextThreads;
      },
      showConnectionNotice: false,
    });

    expect(threads).toEqual([thread("demo-1")]);
    expect(selectedThreadId).toBe("demo-1");
  });
});
