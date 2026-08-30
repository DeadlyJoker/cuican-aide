import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { Turn } from "@crewon/app-server-protocol/v2/Turn";
import { describe, expect, it } from "vitest";

import {
  ensureBackendToolThreadAction,
  recordBackendToolEventAction,
} from "./backendToolThreadActions";

function turn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: "turn-1",
    items: [],
    itemsView: "full",
    status: "inProgress",
    error: null,
    startedAt: 1,
    completedAt: null,
    durationMs: null,
    ...overrides,
  };
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
    cwd: "/repo",
    clientVersion: "test",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: "Untitled",
    turns: [],
    ...overrides,
  };
}

describe("backend tool thread actions", () => {
  it("reuses the selected backend thread", async () => {
    const threads = [thread()];
    const threadId = await ensureBackendToolThreadAction({
      locale: "en",
      renameThread: async () => {
        throw new Error("unexpected rename");
      },
      resolveBackendCwd: async () => "/repo",
      selectedThreadId: "thread-1",
      serverName: "github",
      setThreadGoal: async () => {
        throw new Error("unexpected goal");
      },
      setThreads: (updater) => {
        updater(threads);
      },
      startThread: async () => {
        throw new Error("unexpected start");
      },
      toolName: "search_issues",
    });

    expect(threadId).toBe("thread-1");
  });

  it("creates, names, and records a tool thread when no backend thread is selected", async () => {
    let threads: Thread[] = [];
    const renamed: Array<{ name: string; threadId: string }> = [];
    const goals: Array<{ goal: string; threadId: string; tokenBudget: number | null }> =
      [];

    const threadId = await ensureBackendToolThreadAction({
      locale: "en",
      renameThread: async (nextThreadId, name) => {
        renamed.push({ threadId: nextThreadId, name });
      },
      resolveBackendCwd: async () => "/repo",
      selectedThreadId: null,
      serverName: "github",
      setThreadGoal: async (nextThreadId, goal, tokenBudget) => {
        goals.push({ threadId: nextThreadId, goal, tokenBudget });
      },
      setThreads: (updater) => {
        threads = updater(threads);
      },
      startThread: async (cwd, source) =>
        thread({ id: "tool-thread", cwd, threadSource: source }),
      toolName: "search_issues",
    });

    expect(threadId).toBe("tool-thread");
    expect(renamed).toEqual([
      { threadId: "tool-thread", name: "Tool check · github.search_issues" },
    ]);
    expect(goals).toEqual([
      {
        threadId: "tool-thread",
        goal: "Verify backend MCP tool call result for github.search_issues.",
        tokenBudget: null,
      },
    ]);
    expect(threads).toEqual([
      thread({
        id: "tool-thread",
        cwd: "/repo",
        name: "Tool check · github.search_issues",
        threadSource: "tool",
      }),
    ]);
  });

  it("records backend tool events as turns", async () => {
    let activeTurns: Record<string, string> = {};
    let threads = [thread({ id: "tool-thread" })];

    const handled = await recordBackendToolEventAction({
      body: "Result body",
      setActiveTurnByThread: (updater) => {
        activeTurns = updater(activeTurns);
      },
      setThreads: (updater) => {
        threads = updater(threads);
      },
      startTurn: async (threadId, text) => {
        expect(threadId).toBe("tool-thread");
        expect(text).toBe("Record\n\nResult body");
        return { turn: turn({ id: "tool-turn" }) };
      },
      threadId: "tool-thread",
      title: "Record",
    });

    expect(handled).toBe(true);
    expect(activeTurns).toEqual({ "tool-thread": "tool-turn" });
    expect(threads[0]?.turns).toEqual([turn({ id: "tool-turn" })]);
  });

  it("skips event state updates when startTurn returns no response", async () => {
    let activeTurns: Record<string, string> = {};
    let threads = [thread({ id: "tool-thread" })];

    const handled = await recordBackendToolEventAction({
      body: "Result body",
      setActiveTurnByThread: (updater) => {
        activeTurns = updater(activeTurns);
      },
      setThreads: (updater) => {
        threads = updater(threads);
      },
      startTurn: async () => null,
      threadId: "tool-thread",
      title: "Record",
    });

    expect(handled).toBe(false);
    expect(activeTurns).toEqual({});
    expect(threads).toEqual([thread({ id: "tool-thread" })]);
  });
});
