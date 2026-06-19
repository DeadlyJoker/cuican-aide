import type { Thread } from "@crewon-protocol/v2/Thread";
import type { Turn } from "@crewon-protocol/v2/Turn";
import { describe, expect, it } from "vitest";

import type { NoticeState } from "../shared/noticeState";
import type {
  LibraryPanel,
  OfficeConfig,
  OfficeRunActivity,
  OfficeWorkspace,
} from "../domain/crewonDomain";
import {
  handleOfficeRunCancelAction,
  handleOfficeRunRetryAction,
} from "./officeRunActions";
import type { OfficeRunTurnRecord } from "./officeRunPanel";

type CapturedOfficeRunState = {
  activeTurns: Record<string, string>;
  libraryPanel: LibraryPanel | null;
  messagesSent: string[];
  notice: NoticeState | null;
  runRecords: Record<string, OfficeRunTurnRecord>;
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
    cwd: "/workspace",
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

function run(overrides: Partial<OfficeRunActivity> = {}): OfficeRunActivity {
  return {
    id: "run-1",
    title: "Summarize office",
    status: "running",
    threadId: "office-thread",
    turnId: "turn-1",
    requestText: "Summarize office",
    ...overrides,
  };
}

function activity(runs: OfficeRunActivity[] = [run()]) {
  return {
    trace: [],
    approvals: [],
    budget: [],
    budgetCapUsd: 0,
    artifacts: [],
    runs,
  };
}

function workspace(overrides: Partial<OfficeWorkspace> = {}): OfficeWorkspace {
  return {
    goal: "Coordinate work",
    threadId: "office-thread",
    backendStatus: "connected",
    members: [],
    messages: [],
    tasks: [],
    activity: activity(),
    ...overrides,
  };
}

function officeConfig(workspaceConfig: OfficeWorkspace): OfficeConfig {
  return {
    title: "Office",
    subtitle: "Workspace",
    workspace: workspaceConfig,
  };
}

function panel(workspaceConfig: OfficeWorkspace = workspace()): LibraryPanel {
  return {
    kind: "office",
    title: "Office",
    subtitle: "Workspace",
    items: [],
    workspace: workspaceConfig,
  };
}

function runResponse(config = officeConfig(workspace())) {
  return {
    filePath: "/offices/office.json",
    config,
    threadId: "office-thread",
    runId: "run-2",
    turn: turn({ id: "turn-2" }),
  };
}

function state(initialPanel: LibraryPanel | null = panel()): CapturedOfficeRunState {
  return {
    activeTurns: {},
    libraryPanel: initialPanel,
    messagesSent: [],
    notice: null,
    runRecords: {},
    threads: [thread()],
  };
}

describe("office run actions", () => {
  it("cancels backend office runs and updates the panel", async () => {
    const captured = state();
    const handled = await handleOfficeRunCancelAction({
      cancelOfficeRun: async () => officeConfig(workspace({ activity: activity([]) })),
      isConnected: true,
      locale: "en",
      panel: () => captured.libraryPanel,
      run: run(),
      setLibraryPanel: (updater) => {
        captured.libraryPanel = updater(captured.libraryPanel);
      },
      setNotice: (notice) => {
        captured.notice = notice;
      },
    });

    expect(handled).toBe(true);
    expect(captured.notice).toBeNull();
    expect(captured.libraryPanel?.workspace?.activity?.runs).toEqual([]);
  });

  it("warns when cancel is unavailable", async () => {
    const captured = state();
    const handled = await handleOfficeRunCancelAction({
      cancelOfficeRun: async () => null,
      isConnected: false,
      locale: "en",
      panel: () => captured.libraryPanel,
      run: run({ turnId: undefined }),
      setLibraryPanel: (updater) => {
        captured.libraryPanel = updater(captured.libraryPanel);
      },
      setNotice: (notice) => {
        captured.notice = notice;
      },
    });

    expect(handled).toBe(true);
    expect(captured.notice).toEqual({
      text: "Only active backend office runs can be canceled",
      tone: "warning",
    });
  });

  it("rolls back optimistic cancel state on failure", async () => {
    const captured = state();
    const handled = await handleOfficeRunCancelAction({
      cancelOfficeRun: async () => {
        throw new Error("cancel failed");
      },
      isConnected: true,
      locale: "en",
      panel: () => captured.libraryPanel,
      run: run(),
      setLibraryPanel: (updater) => {
        captured.libraryPanel = updater(captured.libraryPanel);
      },
      setNotice: (notice) => {
        captured.notice = notice;
      },
    });

    expect(handled).toBe(true);
    expect(captured.notice).toEqual({
      text: "cancel failed",
      tone: "warning",
    });
    expect(captured.libraryPanel?.workspace?.activity?.runs?.[0]?.status).toBe(
      "running",
    );
  });

  it("retries backend office runs and records the turn", async () => {
    const captured = state();
    const handled = await handleOfficeRunRetryAction({
      isConnected: true,
      locale: "en",
      panel: () => captured.libraryPanel,
      recordOfficeRunTurn: (turnId, record) => {
        captured.runRecords[turnId] = record;
      },
      retryOfficeRun: async () => ({
        cwd: "/workspace",
        response: runResponse(),
      }),
      run: run(),
      sendOfficeMessage: async (text) => {
        captured.messagesSent.push(text);
      },
      setActiveTurnByThread: (updater) => {
        captured.activeTurns = updater(captured.activeTurns);
      },
      setLibraryPanel: (updater) => {
        captured.libraryPanel = updater(captured.libraryPanel);
      },
      setNotice: (notice) => {
        captured.notice = notice;
      },
      setThreads: (updater) => {
        captured.threads = updater(captured.threads);
      },
      uniqueId: () => "retry-id",
    });

    expect(handled).toBe(true);
    expect(captured.messagesSent).toEqual([]);
    expect(captured.runRecords).toEqual({
      "turn-2": {
        config: runResponse().config,
        cwd: "/workspace",
        runId: "run-2",
        threadId: "office-thread",
      },
    });
    expect(captured.activeTurns).toEqual({ "office-thread": "turn-2" });
    expect(captured.threads[0]?.turns).toEqual([turn({ id: "turn-2" })]);
  });

  it("falls back to sending the office message when retry RPC is unsupported", async () => {
    const captured = state();
    const handled = await handleOfficeRunRetryAction({
      isConnected: true,
      locale: "en",
      panel: () => captured.libraryPanel,
      recordOfficeRunTurn: (turnId, record) => {
        captured.runRecords[turnId] = record;
      },
      retryOfficeRun: async () => ({ cwd: "/workspace", response: null }),
      run: run(),
      sendOfficeMessage: async (text) => {
        captured.messagesSent.push(text);
      },
      setActiveTurnByThread: (updater) => {
        captured.activeTurns = updater(captured.activeTurns);
      },
      setLibraryPanel: (updater) => {
        captured.libraryPanel = updater(captured.libraryPanel);
      },
      setNotice: (notice) => {
        captured.notice = notice;
      },
      setThreads: (updater) => {
        captured.threads = updater(captured.threads);
      },
      uniqueId: () => "retry-id",
    });

    expect(handled).toBe(true);
    expect(captured.messagesSent).toEqual(["Summarize office"]);
    expect(captured.runRecords).toEqual({});
  });

  it("sends retry text directly when disconnected", async () => {
    const captured = state();
    const handled = await handleOfficeRunRetryAction({
      isConnected: false,
      locale: "en",
      panel: () => captured.libraryPanel,
      recordOfficeRunTurn: (turnId, record) => {
        captured.runRecords[turnId] = record;
      },
      retryOfficeRun: async () => ({ cwd: "/workspace", response: runResponse() }),
      run: run(),
      sendOfficeMessage: async (text) => {
        captured.messagesSent.push(text);
      },
      setActiveTurnByThread: (updater) => {
        captured.activeTurns = updater(captured.activeTurns);
      },
      setLibraryPanel: (updater) => {
        captured.libraryPanel = updater(captured.libraryPanel);
      },
      setNotice: (notice) => {
        captured.notice = notice;
      },
      setThreads: (updater) => {
        captured.threads = updater(captured.threads);
      },
      uniqueId: () => "retry-id",
    });

    expect(handled).toBe(true);
    expect(captured.messagesSent).toEqual(["Summarize office"]);
  });
});
