import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import { describe, expect, it } from "vitest";

import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import {
  createThreadLifecycleActionHandlers,
  threadLifecycleActionForActionId,
  type ThreadLifecycleActionHandlersParams,
} from "./threadLifecycleActions";

async function flushAsyncAction() {
  await Promise.resolve();
  await Promise.resolve();
}

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

function baseParams(
  overrides: Partial<ThreadLifecycleActionHandlersParams> = {},
): ThreadLifecycleActionHandlersParams {
  let panel: CapabilityPanel | null = {
    title: "Session settings",
    body: "Ready",
  };
  let threads = [thread()];
  let activeTurns: Record<string, string> = { "thread-1": "turn-1" };
  let streamingText: Record<string, string> = { "thread-1": "streaming" };
  return {
    busyToolId: null,
    client: {
      async compactThread() {},
      async readThread() {
        return thread({ updatedAt: 2 });
      },
      async rollbackThread() {
        return thread({ updatedAt: 3 });
      },
      async setThreadMemoryMode() {},
    },
    confirm: () => true,
    isConnected: true,
    isDemo: false,
    locale: "en",
    setActiveTurnByThread: (updater) => {
      activeTurns = updater(activeTurns);
    },
    setBusyToolId: () => {},
    setCapabilityPanel: (updater) => {
      panel = updater(panel);
    },
    setStreamingTextByThread: (updater) => {
      streamingText = updater(streamingText);
    },
    setThreads: (updater) => {
      threads = updater(threads);
    },
    threadId: "thread-1",
    ...overrides,
  };
}

describe("thread lifecycle actions", () => {
  it("maps thread lifecycle action ids", () => {
    expect(threadLifecycleActionForActionId("compact-thread")).toBe("compact");
    expect(threadLifecycleActionForActionId("rollback-thread")).toBe(
      "rollback",
    );
    expect(threadLifecycleActionForActionId("enable-thread-memory")).toBe(
      "memoryEnabled",
    );
    expect(threadLifecycleActionForActionId("disable-thread-memory")).toBe(
      "memoryDisabled",
    );
    expect(threadLifecycleActionForActionId("save-thread-goal")).toBeNull();
  });

  it("starts compact and refreshes the thread", async () => {
    let panel: CapabilityPanel | null = {
      title: "Session settings",
      body: "Ready",
    };
    let threads = [thread()];
    const compacted: string[] = [];
    const busyStates: Array<"sidechat" | null> = [];
    const handlers = createThreadLifecycleActionHandlers(
      baseParams({
        client: {
          async compactThread(threadId) {
            compacted.push(threadId);
          },
          async readThread(threadId) {
            return thread({ id: threadId, updatedAt: 2 });
          },
          async rollbackThread() {
            return thread();
          },
          async setThreadMemoryMode() {},
        },
        setBusyToolId: (toolId) => busyStates.push(toolId),
        setCapabilityPanel: (updater) => {
          panel = updater(panel);
        },
        setThreads: (updater) => {
          threads = updater(threads);
        },
      }),
    );

    handlers.compact();
    expect(panel).toMatchObject({
      body: "Starting context compaction...",
      error: undefined,
    });

    await flushAsyncAction();

    expect(compacted).toEqual(["thread-1"]);
    expect(threads[0]?.updatedAt).toBe(2);
    expect(busyStates).toEqual(["sidechat", null]);
    expect(panel).toMatchObject({
      body: "Context compaction started. It will appear in this session when complete.",
      error: undefined,
    });
  });

  it("rolls back a thread and clears active state", async () => {
    let panel: CapabilityPanel | null = {
      title: "Session settings",
      body: "Ready",
    };
    let threads = [thread()];
    let activeTurns: Record<string, string> = { "thread-1": "turn-1" };
    let streamingText: Record<string, string> = { "thread-1": "streaming" };
    const confirmations: string[] = [];
    const rolledBack: Array<{ numTurns?: number; threadId: string }> = [];
    const handlers = createThreadLifecycleActionHandlers(
      baseParams({
        client: {
          async compactThread() {},
          async readThread() {
            return thread();
          },
          async rollbackThread(threadId, numTurns) {
            rolledBack.push({ numTurns, threadId });
            return thread({ updatedAt: 3 });
          },
          async setThreadMemoryMode() {},
        },
        confirm: (message) => {
          confirmations.push(message);
          return true;
        },
        setActiveTurnByThread: (updater) => {
          activeTurns = updater(activeTurns);
        },
        setCapabilityPanel: (updater) => {
          panel = updater(panel);
        },
        setStreamingTextByThread: (updater) => {
          streamingText = updater(streamingText);
        },
        setThreads: (updater) => {
          threads = updater(threads);
        },
      }),
    );

    handlers.rollback();
    await flushAsyncAction();

    expect(confirmations).toEqual([
      "Rollback removes the last turn from this session history, but does not revert file changes. Continue?",
    ]);
    expect(rolledBack).toEqual([{ numTurns: 1, threadId: "thread-1" }]);
    expect(threads[0]?.updatedAt).toBe(3);
    expect(activeTurns).toEqual({});
    expect(streamingText).toEqual({});
    expect(panel).toMatchObject({
      body: "Rolled back the last turn in this session.",
      error: undefined,
    });
  });

  it("does not rollback when confirmation is rejected", () => {
    let called = false;
    const handlers = createThreadLifecycleActionHandlers(
      baseParams({
        client: {
          async compactThread() {},
          async readThread() {
            return thread();
          },
          async rollbackThread() {
            called = true;
            return thread();
          },
          async setThreadMemoryMode() {},
        },
        confirm: () => false,
      }),
    );

    handlers.rollback();

    expect(called).toBe(false);
  });

  it("updates memory mode", async () => {
    let panel: CapabilityPanel | null = {
      title: "Session settings",
      body: "Ready",
    };
    const updates: Array<{ mode: string; threadId: string }> = [];
    const handlers = createThreadLifecycleActionHandlers(
      baseParams({
        client: {
          async compactThread() {},
          async readThread() {
            return thread();
          },
          async rollbackThread() {
            return thread();
          },
          async setThreadMemoryMode(threadId, mode) {
            updates.push({ mode, threadId });
          },
        },
        setCapabilityPanel: (updater) => {
          panel = updater(panel);
        },
      }),
    );

    handlers.memoryEnabled();
    await flushAsyncAction();

    expect(updates).toEqual([{ mode: "enabled", threadId: "thread-1" }]);
    expect(panel).toMatchObject({
      body: "Memory mode enabled.",
      error: undefined,
    });
  });

  it("shows demo feedback without backend calls", () => {
    let panel: CapabilityPanel | null = {
      title: "Session settings",
      body: "Ready",
    };
    let called = false;
    const handlers = createThreadLifecycleActionHandlers(
      baseParams({
        client: {
          async compactThread() {
            called = true;
          },
          async readThread() {
            return thread();
          },
          async rollbackThread() {
            return thread();
          },
          async setThreadMemoryMode() {},
        },
        isDemo: true,
        setCapabilityPanel: (updater) => {
          panel = updater(panel);
        },
      }),
    );

    handlers.compact();

    expect(called).toBe(false);
    expect(panel).toMatchObject({
      body: "Context compaction started (demo). With app-server connected this calls thread/compact/start.",
      error: undefined,
    });
  });
});
