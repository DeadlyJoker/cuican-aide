import type { Thread } from "@crewon-protocol/v2/Thread";
import { describe, expect, it } from "vitest";

import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import {
  createWorktreeSessionActionHandlers,
  worktreeSessionActionForActionId,
  type WorktreeSessionActionHandlersParams,
} from "./worktreeSessionActions";

async function flushAsyncAction() {
  await Promise.resolve();
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
  overrides: Partial<WorktreeSessionActionHandlersParams> = {},
): WorktreeSessionActionHandlersParams {
  let panel: CapabilityPanel | null = {
    title: "Worktrees",
    body: "Ready",
  };
  let threads = [thread()];
  let selectedThreadId = "thread-1";
  return {
    client: {
      async forkThread(threadId) {
        return { thread: thread({ id: `${threadId}-fork` }) };
      },
      async startThread(cwd, threadSource) {
        return thread({ cwd, id: `${threadSource}-thread` });
      },
    },
    locale: "en",
    refreshWorktreesSettingsPanel: async () => {},
    resolveBackendCwd: async () => "/repo",
    selectedThreadId,
    setCapabilityPanel: (updater) => {
      panel = updater(panel);
    },
    setSelectedThreadId: (threadId) => {
      selectedThreadId = threadId;
    },
    setThreads: (updater) => {
      threads = updater(threads);
    },
    ...overrides,
  };
}

describe("worktree session actions", () => {
  it("maps worktree action ids", () => {
    expect(worktreeSessionActionForActionId("create-worktree-session")).toBe(
      "create",
    );
    expect(worktreeSessionActionForActionId("fork-worktree")).toBe("fork");
    expect(worktreeSessionActionForActionId("refresh-worktrees")).toBeNull();
  });

  it("creates a worktree session and refreshes worktrees", async () => {
    let panel: CapabilityPanel | null = {
      title: "Worktrees",
      body: "Ready",
    };
    let selectedThreadId = "";
    let refreshed = false;
    let threads = [thread()];
    const started: Array<{ cwd: string; threadSource: string }> = [];
    const handlers = createWorktreeSessionActionHandlers(
      baseParams({
        client: {
          async forkThread(threadId) {
            return { thread: thread({ id: `${threadId}-fork` }) };
          },
          async startThread(cwd, threadSource) {
            started.push({ cwd, threadSource });
            return thread({ cwd, id: "worktree-thread" });
          },
        },
        refreshWorktreesSettingsPanel: async () => {
          refreshed = true;
        },
        setCapabilityPanel: (updater) => {
          panel = updater(panel);
        },
        setSelectedThreadId: (threadId) => {
          selectedThreadId = threadId;
        },
        setThreads: (updater) => {
          threads = updater(threads);
        },
      }),
    );

    handlers.create();
    await flushAsyncAction();

    expect(started).toEqual([{ cwd: "/repo", threadSource: "worktree" }]);
    expect(threads[0]?.id).toBe("worktree-thread");
    expect(selectedThreadId).toBe("worktree-thread");
    expect(refreshed).toBe(true);
    expect(panel).toMatchObject({
      body: "Creating workspace session...",
    });
  });

  it("forks the selected thread", async () => {
    let selectedThreadId = "";
    let threads = [thread()];
    const forked: string[] = [];
    const handlers = createWorktreeSessionActionHandlers(
      baseParams({
        client: {
          async forkThread(threadId) {
            forked.push(threadId);
            return { thread: thread({ id: "forked-thread" }) };
          },
          async startThread(cwd, threadSource) {
            return thread({ cwd, id: `${threadSource}-thread` });
          },
        },
        setSelectedThreadId: (threadId) => {
          selectedThreadId = threadId;
        },
        setThreads: (updater) => {
          threads = updater(threads);
        },
      }),
    );

    handlers.fork();
    await flushAsyncAction();

    expect(forked).toEqual(["thread-1"]);
    expect(threads[0]?.id).toBe("forked-thread");
    expect(selectedThreadId).toBe("forked-thread");
  });

  it("shows an error when workspace is missing", async () => {
    let panel: CapabilityPanel | null = {
      title: "Worktrees",
      body: "Ready",
    };
    const handlers = createWorktreeSessionActionHandlers(
      baseParams({
        resolveBackendCwd: async () => "",
        setCapabilityPanel: (updater) => {
          panel = updater(panel);
        },
      }),
    );

    handlers.create();
    await flushAsyncAction();

    expect(panel).toMatchObject({
      error: "No workspace path is available for creating a session.",
    });
  });

  it("shows an error when forking without a selected thread", async () => {
    let panel: CapabilityPanel | null = {
      title: "Worktrees",
      body: "Ready",
    };
    const handlers = createWorktreeSessionActionHandlers(
      baseParams({
        selectedThreadId: null,
        setCapabilityPanel: (updater) => {
          panel = updater(panel);
        },
      }),
    );

    handlers.fork();
    await flushAsyncAction();

    expect(panel).toMatchObject({
      error: "Select a conversation before forking.",
    });
  });
});
