import type { Thread } from "@crewon-protocol/v2/Thread";
import type { Turn } from "@crewon-protocol/v2/Turn";
import { describe, expect, it } from "vitest";

import type { LibraryPanel, OfficeWorkspace } from "../domain/crewonDomain";
import {
  ensureOfficeThreadAction,
  type EnsureOfficeThreadActionParams,
} from "./officeThreadActions";

type CapturedOfficeThreadState = {
  libraryPanel: LibraryPanel | null;
  persisted: Array<{ threadId: string | null | undefined; workspaceGoal: string }>;
  renamed: Array<{ threadId: string; title: string }>;
  startedTurns: Array<{ text: string; threadId: string }>;
  threadGoals: Array<{ goal: string; threadId: string; tokenBudget: number | null }>;
  threads: Thread[];
};

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
    id: "office-thread",
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
    name: "Office",
    turns: [],
    ...overrides,
  };
}

function workspace(overrides: Partial<OfficeWorkspace> = {}): OfficeWorkspace {
  return {
    goal: "Coordinate office",
    threadId: "office-thread",
    backendStatus: "connected",
    members: [],
    messages: [],
    tasks: [],
    activity: {
      trace: [],
      approvals: [],
      budget: [],
      budgetCapUsd: 0,
      artifacts: [],
      runs: [],
    },
    ...overrides,
  };
}

function panel(workspaceConfig: OfficeWorkspace | null = workspace()): LibraryPanel {
  return {
    kind: "office",
    title: "Office",
    subtitle: "Workspace",
    items: [],
    workspace: workspaceConfig ?? undefined,
  };
}

function state(initialPanel: LibraryPanel | null = panel()): CapturedOfficeThreadState {
  return {
    libraryPanel: initialPanel,
    persisted: [],
    renamed: [],
    startedTurns: [],
    threadGoals: [],
    threads: [],
  };
}

function baseParams(
  captured: CapturedOfficeThreadState,
  overrides: Partial<EnsureOfficeThreadActionParams> = {},
): EnsureOfficeThreadActionParams {
  return {
    isConnected: true,
    isMissingThreadError: (error) =>
      error instanceof Error && error.message === "missing-thread",
    locale: "en",
    panel: captured.libraryPanel ?? panel(),
    persistOfficeWorkspace: async (_panel, targetWorkspace, threadId) => {
      captured.persisted.push({
        threadId,
        workspaceGoal: targetWorkspace.goal,
      });
      return threadId ? `/offices/${threadId}.json` : null;
    },
    readThread: async (threadId) => thread({ id: threadId }),
    renameThread: async (threadId, title) => {
      captured.renamed.push({ threadId, title });
    },
    setLibraryPanel: (updater) => {
      captured.libraryPanel = updater(captured.libraryPanel);
    },
    setThreadGoal: async (threadId, goal, tokenBudget) => {
      captured.threadGoals.push({ threadId, goal, tokenBudget });
    },
    setThreads: (updater) => {
      captured.threads = updater(captured.threads);
    },
    startOfficeThread: async () => thread({ id: "new-office-thread" }),
    startTurn: async (threadId, text) => {
      captured.startedTurns.push({ threadId, text });
      return { turn: turn({ id: `turn-${threadId}` }) };
    },
    ...overrides,
  };
}

describe("office thread actions", () => {
  it("returns the existing thread id while disconnected", async () => {
    const captured = state();
    const threadId = await ensureOfficeThreadAction(
      baseParams(captured, {
        isConnected: false,
      }),
    );

    expect(threadId).toBe("office-thread");
    expect(captured.persisted).toEqual([]);
    expect(captured.renamed).toEqual([]);
  });

  it("reuses a readable existing backend thread and refreshes panel state", async () => {
    const captured = state();
    const threadId = await ensureOfficeThreadAction(baseParams(captured));

    expect(threadId).toBe("office-thread");
    expect(captured.persisted).toEqual([
      { threadId: "office-thread", workspaceGoal: "Coordinate office" },
    ]);
    expect(captured.renamed).toEqual([]);
    expect(captured.libraryPanel?.workspace?.backendStatus).toBe("connected");
    expect(captured.libraryPanel?.workspace?.threadId).toBe("office-thread");
  });

  it("creates and binds a new office thread when the saved one is missing", async () => {
    const captured = state();
    const threadId = await ensureOfficeThreadAction(
      baseParams(captured, {
        readThread: async () => {
          throw new Error("missing-thread");
        },
      }),
    );

    expect(threadId).toBe("new-office-thread");
    expect(captured.renamed).toEqual([
      { threadId: "new-office-thread", title: "Office" },
    ]);
    expect(captured.threadGoals).toEqual([
      {
        threadId: "new-office-thread",
        goal: "Coordinate office",
        tokenBudget: null,
      },
    ]);
    expect(captured.persisted).toEqual([
      { threadId: "new-office-thread", workspaceGoal: "Coordinate office" },
    ]);
    expect(captured.startedTurns).toEqual([
      {
        threadId: "new-office-thread",
        text: [
          "Bind office: Office",
          "Backend record: /offices/new-office-thread.json",
          "Goal: Coordinate office",
        ].join("\n"),
      },
    ]);
    expect(captured.threads).toEqual([
      thread({ id: "new-office-thread", name: "Office" }),
    ]);
    expect(captured.libraryPanel?.workspace?.threadId).toBe("new-office-thread");
  });

  it("forces a new office thread even when the workspace has a thread id", async () => {
    const captured = state();
    const threadId = await ensureOfficeThreadAction(
      baseParams(captured, {
        forceNew: true,
      }),
    );

    expect(threadId).toBe("new-office-thread");
    expect(captured.persisted).toEqual([
      { threadId: "new-office-thread", workspaceGoal: "Coordinate office" },
    ]);
    expect(captured.renamed).toEqual([
      { threadId: "new-office-thread", title: "Office" },
    ]);
  });

  it("returns null without a workspace", async () => {
    const captured = state(panel(null));
    const threadId = await ensureOfficeThreadAction(baseParams(captured));

    expect(threadId).toBeNull();
    expect(captured.persisted).toEqual([]);
    expect(captured.threads).toEqual([]);
  });

  it("returns null when starting a new office thread fails", async () => {
    const captured = state();
    const threadId = await ensureOfficeThreadAction(
      baseParams(captured, {
        forceNew: true,
        startOfficeThread: async () => null,
      }),
    );

    expect(threadId).toBeNull();
    expect(captured.libraryPanel?.workspace?.backendStatus).toBe("binding");
    expect(captured.persisted).toEqual([]);
  });
});
